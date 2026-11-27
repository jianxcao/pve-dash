package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"golang.org/x/sync/errgroup"
)

func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// --- Phase 4B: HA High Availability ---

var (
	allowedHAStates = map[string]bool{
		"started":  true,
		"stopped":  true,
		"enabled":  true,
		"disabled": true,
		"ignored":  true,
	}
	allowedHADeleteKeys = map[string]bool{
		"group":        true,
		"comment":      true,
		"max_restart":  true,
		"max_relocate": true,
		"state":        true,
	}
)

func (s *Server) handleGetHA(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	caps := pve.BuildCapabilities(&pve.VersionInfo{Version: inst.DetectedVersion}, inst.IsCluster)
	haMode := "groups"
	if caps.Features.HARules {
		haMode = "rules"
	}

	var (
		status    []pve.HAStatusItem
		resources []pve.HAResource
		groups    []pve.HAGroup
		rules     []pve.HARule
		statusErr error
		resErr    error
		groupErr  error
		ruleErr   error
	)

	var g errgroup.Group
	g.Go(func() error {
		status, statusErr = cl.GetHAStatus(r.Context())
		return nil
	})
	g.Go(func() error {
		resources, resErr = cl.ListHAResources(r.Context())
		return nil
	})
	if haMode == "rules" {
		g.Go(func() error {
			rules, ruleErr = cl.ListHARules(r.Context())
			return nil
		})
	} else {
		g.Go(func() error {
			groups, groupErr = cl.ListHAGroups(r.Context())
			return nil
		})
	}
	_ = g.Wait()

	if statusErr != nil && resErr != nil {
		writeErr(w, http.StatusBadGateway, "读取 HA 高可用状态失败: "+statusErr.Error())
		return
	}

	if status == nil {
		status = []pve.HAStatusItem{}
	}
	if resources == nil {
		resources = []pve.HAResource{}
	}
	if groups == nil {
		groups = []pve.HAGroup{}
	}
	if rules == nil {
		rules = []pve.HARule{}
	}

	sort.Slice(resources, func(i, j int) bool { return resources[i].SID < resources[j].SID })
	sort.Slice(groups, func(i, j int) bool { return groups[i].Group < groups[j].Group })
	sort.Slice(rules, func(i, j int) bool { return rules[i].Rule < rules[j].Rule })

	warnings := map[string]string{}
	if statusErr != nil {
		warnings["status"] = statusErr.Error()
	}
	if resErr != nil {
		warnings["resources"] = resErr.Error()
	}
	if groupErr != nil {
		warnings["groups"] = groupErr.Error()
	}
	if ruleErr != nil {
		warnings["rules"] = ruleErr.Error()
	}

	resp := map[string]any{
		"isCluster": inst.IsCluster,
		"haMode":    haMode,
		"status":    status,
		"resources": resources,
		"groups":    groups,
		"rules":     rules,
	}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, resp)
}

type haResourceReq struct {
	SID         string   `json:"sid"`
	State       string   `json:"state"`
	Group       string   `json:"group"`
	MaxRestart  *int     `json:"maxRestart"`
	MaxRelocate *int     `json:"maxRelocate"`
	Comment     string   `json:"comment"`
	Digest      string   `json:"digest"`
	Delete      []string `json:"delete"`
}

func buildHAResourceParams(req haResourceReq, isCreate, allowGroup bool) (url.Values, error) {
	p := url.Values{}
	if isCreate {
		if err := pve.ValidateHASID(req.SID); err != nil {
			return nil, err
		}
		p.Set("sid", req.SID)
	}
	if st := strings.TrimSpace(req.State); st != "" {
		if !allowedHAStates[st] {
			return nil, fmt.Errorf("无效的 HA 目标状态 %q", st)
		}
		p.Set("state", st)
	}
	if grp := strings.TrimSpace(req.Group); grp != "" {
		if !allowGroup {
			return nil, fmt.Errorf("PVE 9.x 已使用 HA Rules 取代 HA Group，不支持设置 group 字段")
		}
		if err := pve.ValidateHAGroupName(grp); err != nil {
			return nil, err
		}
		p.Set("group", grp)
	}
	if req.MaxRestart != nil {
		if *req.MaxRestart < 0 || *req.MaxRestart > 10 {
			return nil, fmt.Errorf("maxRestart 必须在 0–10 之间")
		}
		p.Set("max_restart", strconv.Itoa(*req.MaxRestart))
	}
	if req.MaxRelocate != nil {
		if *req.MaxRelocate < 0 || *req.MaxRelocate > 10 {
			return nil, fmt.Errorf("maxRelocate 必须在 0–10 之间")
		}
		p.Set("max_relocate", strconv.Itoa(*req.MaxRelocate))
	}
	if cmt := strings.TrimSpace(req.Comment); cmt != "" {
		if hasControlChars(cmt) {
			return nil, fmt.Errorf("comment 不能包含换行或控制字符")
		}
		p.Set("comment", cmt)
	}
	if !isCreate && len(req.Delete) > 0 {
		var cleanDel []string
		seen := map[string]bool{}
		for _, k := range req.Delete {
			c := strings.TrimSpace(k)
			if c == "" {
				continue
			}
			if !allowedHADeleteKeys[c] {
				return nil, fmt.Errorf("不允许删除的 HA 字段 %q", c)
			}
			if c == "group" && !allowGroup {
				return nil, fmt.Errorf("PVE 9.x 不支持删除 group 字段")
			}
			if p.Has(c) {
				return nil, fmt.Errorf("字段 %q 不能同时设置和删除", c)
			}
			if !seen[c] {
				seen[c] = true
				cleanDel = append(cleanDel, c)
			}
		}
		if len(cleanDel) > 0 {
			p.Set("delete", strings.Join(cleanDel, ","))
		}
	}
	if !isCreate && len(p) == 0 {
		return nil, fmt.Errorf("未提供任何需要更新的 HA 资源字段")
	}
	if !isCreate && strings.TrimSpace(req.Digest) != "" {
		if hasControlChars(req.Digest) {
			return nil, fmt.Errorf("digest 不能包含换行或控制字符")
		}
		p.Set("digest", strings.TrimSpace(req.Digest))
	}
	return p, nil
}

func (s *Server) handleCreateHAResource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	var req haResourceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	caps := pve.BuildCapabilities(&pve.VersionInfo{Version: inst.DetectedVersion}, inst.IsCluster)
	params, err := buildHAResourceParams(req, true, !caps.Features.HARules)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	err = cl.CreateHAResource(r.Context(), params)
	s.recordAudit(r, id, fmt.Sprintf("%s:ha:%s", id, req.SID), "ha.resource.create", req.SID, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleUpdateHAResource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	sid := urlParamDecoded(r, "sid")
	if err := pve.ValidateHASID(sid); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var req haResourceReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	caps := pve.BuildCapabilities(&pve.VersionInfo{Version: inst.DetectedVersion}, inst.IsCluster)
	params, err := buildHAResourceParams(req, false, !caps.Features.HARules)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	err = cl.UpdateHAResource(r.Context(), sid, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:ha:%s", id, sid), "ha.resource.update", sid, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteHAResource(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	sid := urlParamDecoded(r, "sid")
	if err := pve.ValidateHASID(sid); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != sid {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.DeleteHAResource(r.Context(), sid)
	s.recordAudit(r, id, fmt.Sprintf("%s:ha:%s", id, sid), "ha.resource.delete", sid, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Phase 4B: Node Certificates & ACME ---

func (s *Server) handleNodeCertificates(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	var (
		certs     []pve.NodeCertInfo
		accounts  []pve.ACMEAccount
		nodeCfg   map[string]any
		certErr   error
		acctErr   error
		nodeCfgEr error
	)

	var g errgroup.Group
	g.Go(func() error {
		certs, certErr = cl.GetNodeCertificates(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		accounts, acctErr = cl.ListACMEAccounts(r.Context())
		return nil
	})
	g.Go(func() error {
		nodeCfg, nodeCfgEr = cl.GetNodeConfig(r.Context(), node)
		return nil
	})
	_ = g.Wait()

	if certErr != nil {
		writeErr(w, http.StatusBadGateway, "读取节点 SSL 证书信息失败: "+certErr.Error())
		return
	}

	if accounts == nil {
		accounts = []pve.ACMEAccount{}
	}
	acmeAccount, acmeDomains := pve.ParseNodeACMEConfig(nodeCfg)
	sort.Slice(certs, func(i, j int) bool { return certs[i].Filename < certs[j].Filename })
	sort.Slice(accounts, func(i, j int) bool { return accounts[i].Name < accounts[j].Name })

	warnings := map[string]string{}
	if acctErr != nil {
		warnings["acmeAccounts"] = acctErr.Error()
	}
	if nodeCfgEr != nil {
		warnings["nodeConfig"] = nodeCfgEr.Error()
	}

	resp := map[string]any{
		"node":                  node,
		"certificates":          certs,
		"acmeAccounts":          accounts,
		"acmeAccountConfigured": acmeAccount,
		"acmeDomains":           acmeDomains,
	}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleRenewNodeACME(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != node {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	var body struct {
		Force bool   `json:"force"`
		Mode  string `json:"mode"` // "" | "auto" | "order" | "renew"
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil && !errors.Is(err, io.EOF) {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	mode := strings.TrimSpace(body.Mode)
	if mode != "" && mode != "auto" && mode != "order" && mode != "renew" {
		writeErr(w, http.StatusBadRequest, "mode 必须为 auto、order 或 renew")
		return
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	action := mode
	if action == "" || action == "auto" {
		// PVE PUT /certificates/acme/certificate only renews an existing custom cert (pveproxy-ssl.pem);
		// when absent, POST orders the initial ACME certificate.
		action = "order"
		if certs, certErr := cl.GetNodeCertificates(r.Context(), node); certErr == nil {
			for _, c := range certs {
				if c.Filename == "pveproxy-ssl.pem" {
					action = "renew"
					break
				}
			}
		}
	}
	var upid string
	if action == "order" {
		upid, err = cl.OrderNodeACMECert(r.Context(), node, body.Force)
	} else {
		upid, err = cl.RenewNodeACMECert(r.Context(), node, body.Force)
	}
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:cert:acme", id, node), "node.acme."+action, fmt.Sprintf("force=%v", body.Force), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid, "action": action})
}

// --- Phase 4B: Cluster Hardware Resource Mappings (PCI / USB / Dir) ---

func (s *Server) handleListResourceMappings(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	caps := pve.BuildCapabilities(&pve.VersionInfo{Version: inst.DetectedVersion}, inst.IsCluster)
	if inst.DetectedVersion != "" && !caps.Features.ResourceMappingPciUsb {
		writeJSON(w, http.StatusOK, map[string]any{
			"supported":   false,
			"supportsDir": false,
			"pci":         []pve.ResourceMappingItem{},
			"usb":         []pve.ResourceMappingItem{},
			"dir":         []pve.ResourceMappingItem{},
		})
		return
	}

	supportsDir := inst.DetectedVersion == "" || caps.Features.ResourceMappingDir
	var (
		pciItems []pve.ResourceMappingItem
		usbItems []pve.ResourceMappingItem
		dirItems []pve.ResourceMappingItem
		pciErr   error
		usbErr   error
		dirErr   error
	)

	var g errgroup.Group
	g.Go(func() error {
		pciItems, pciErr = cl.ListResourceMappings(r.Context(), "pci")
		return nil
	})
	g.Go(func() error {
		usbItems, usbErr = cl.ListResourceMappings(r.Context(), "usb")
		return nil
	})
	if supportsDir {
		g.Go(func() error {
			dirItems, dirErr = cl.ListResourceMappings(r.Context(), "dir")
			return nil
		})
	}
	_ = g.Wait()

	if pciErr != nil && usbErr != nil && (!supportsDir || dirErr != nil) {
		writeErr(w, http.StatusBadGateway, "读取硬件资源映射失败: "+pciErr.Error())
		return
	}

	if pciItems == nil {
		pciItems = []pve.ResourceMappingItem{}
	}
	if usbItems == nil {
		usbItems = []pve.ResourceMappingItem{}
	}
	if dirItems == nil {
		dirItems = []pve.ResourceMappingItem{}
	}
	sort.Slice(pciItems, func(i, j int) bool { return pciItems[i].ID < pciItems[j].ID })
	sort.Slice(usbItems, func(i, j int) bool { return usbItems[i].ID < usbItems[j].ID })
	sort.Slice(dirItems, func(i, j int) bool { return dirItems[i].ID < dirItems[j].ID })

	warnings := map[string]string{}
	var warnMu sync.Mutex
	addWarn := func(k string, e error) {
		if e != nil {
			warnMu.Lock()
			warnings[k] = e.Error()
			warnMu.Unlock()
		}
	}
	addWarn("pci", pciErr)
	addWarn("usb", usbErr)
	if supportsDir {
		addWarn("dir", dirErr)
	}

	resp := map[string]any{
		"supported":   true,
		"supportsDir": supportsDir,
		"pci":         pciItems,
		"usb":         usbItems,
		"dir":         dirItems,
	}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, resp)
}

type createMappingReq struct {
	ID                   string   `json:"id"`
	Description          string   `json:"description"`
	Map                  []string `json:"map"`
	Mdev                 *bool    `json:"mdev"`
	LiveMigrationCapable *bool    `json:"liveMigrationCapable"`
}

func buildCreateMappingParams(kind string, req createMappingReq) (url.Values, error) {
	if err := pve.ValidateMappingKind(kind); err != nil {
		return nil, err
	}
	if err := pve.ValidateMappingID(req.ID); err != nil {
		return nil, err
	}
	var cleanMaps []string
	for _, raw := range req.Map {
		m := strings.TrimSpace(raw)
		if m == "" {
			continue
		}
		if hasControlChars(m) {
			return nil, fmt.Errorf("映射条目不能包含换行或控制字符")
		}
		validNode := false
		for _, part := range strings.Split(m, ",") {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(part, "node=") {
				nodeVal := strings.TrimPrefix(part, "node=")
				if err := pve.ValidateNodeName(nodeVal); err != nil {
					return nil, fmt.Errorf("映射条目 %q 中的节点名无效: %w", m, err)
				}
				validNode = true
				break
			}
		}
		if !validNode {
			return nil, fmt.Errorf("映射条目 %q 必须包含有效的 node=<节点名> 字段", m)
		}
		cleanMaps = append(cleanMaps, m)
	}
	if len(cleanMaps) == 0 {
		return nil, fmt.Errorf("至少需提供一条节点设备映射条目 (map)")
	}
	if kind != "pci" && ((req.Mdev != nil && *req.Mdev) || (req.LiveMigrationCapable != nil && *req.LiveMigrationCapable)) {
		return nil, fmt.Errorf("mdev 与 liveMigrationCapable 仅适用于 PCI 资源映射")
	}
	p := url.Values{"id": {req.ID}}
	for _, m := range cleanMaps {
		p.Add("map", m)
	}
	if desc := strings.TrimSpace(req.Description); desc != "" {
		if hasControlChars(desc) {
			return nil, fmt.Errorf("description 不能包含换行或控制字符")
		}
		p.Set("description", desc)
	}
	if kind == "pci" {
		if req.Mdev != nil && *req.Mdev {
			p.Set("mdev", "1")
		}
		if req.LiveMigrationCapable != nil && *req.LiveMigrationCapable {
			p.Set("live-migration-capable", "1")
		}
	}
	return p, nil
}

func (s *Server) handleCreateResourceMapping(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	kind := chi.URLParam(r, "kind")
	if err := pve.ValidateMappingKind(kind); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var req createMappingReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	params, err := buildCreateMappingParams(kind, req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	caps := pve.BuildCapabilities(&pve.VersionInfo{Version: inst.DetectedVersion}, inst.IsCluster)
	if inst.DetectedVersion != "" {
		if !caps.Features.ResourceMappingPciUsb {
			writeErr(w, http.StatusBadRequest, "硬件资源映射仅支持 Proxmox VE 8.0 及以上版本")
			return
		}
		if kind == "dir" && !caps.Features.ResourceMappingDir {
			writeErr(w, http.StatusBadRequest, "目录资源映射 (dir) 仅支持 Proxmox VE 8.2 及以上版本")
			return
		}
	}
	err = cl.CreateResourceMapping(r.Context(), kind, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:mapping:%s:%s", id, kind, req.ID), "mapping.create", fmt.Sprintf("%s/%s", kind, req.ID), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleDeleteResourceMapping(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	kind := chi.URLParam(r, "kind")
	mappingID := urlParamDecoded(r, "mappingId")
	if err := pve.ValidateMappingKind(kind); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateMappingID(mappingID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != mappingID {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.DeleteResourceMapping(r.Context(), kind, mappingID)
	s.recordAudit(r, id, fmt.Sprintf("%s:mapping:%s:%s", id, kind, mappingID), "mapping.delete", fmt.Sprintf("%s/%s", kind, mappingID), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
