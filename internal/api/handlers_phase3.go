package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"golang.org/x/sync/errgroup"
)

// --- Phase 3: Node Network Management ---

var (
	allowedNetworkTypes = map[string]bool{
		"bridge":     true,
		"bond":       true,
		"vlan":       true,
		"eth":        true,
		"alias":      true,
		"OVSBridge":  true,
		"OVSBond":    true,
		"OVSPort":    true,
		"OVSIntPort": true,
	}
	allowedNetworkDeleteKeys = map[string]bool{
		"cidr":              true,
		"gateway":           true,
		"cidr6":             true,
		"gateway6":          true,
		"address":           true,
		"netmask":           true,
		"address6":          true,
		"netmask6":          true,
		"bridge_ports":      true,
		"bridge_vlan_aware": true,
		"ovs_ports":         true,
		"slaves":            true,
		"bond_mode":         true,
		"vlan-raw-device":   true,
		"vlan-id":           true,
		"mtu":               true,
		"comments":          true,
		"autostart":         true,
	}
	validVMIDListRegex = regexp.MustCompile(`^[1-9]\d*(,[1-9]\d*)*$`)
	validFirewallGroup = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`)
	allowedLogLevels   = map[string]bool{
		"nolog": true, "emerg": true, "alert": true, "crit": true,
		"err": true, "warning": true, "notice": true, "info": true, "debug": true,
	}
	allowedFirewallDeleteKeys = map[string]bool{
		"macro": true, "proto": true, "source": true, "dest": true,
		"sport": true, "dport": true, "iface": true, "log": true,
		"comment": true, "icmp-type": true, "enable": true,
	}
)

type nodeNetworkReq struct {
	Iface           string   `json:"iface"`
	Type            string   `json:"type"` // bridge | bond | vlan | eth | OVSBridge ...
	CIDR            string   `json:"cidr"`
	Gateway         string   `json:"gateway"`
	CIDR6           string   `json:"cidr6"`
	Gateway6        string   `json:"gateway6"`
	Autostart       *bool    `json:"autostart"`
	BridgePorts     string   `json:"bridgePorts"`
	BridgeVlanAware *bool    `json:"bridgeVlanAware"`
	OVSPorts        string   `json:"ovsPorts"`
	Slaves          string   `json:"slaves"`
	BondMode        string   `json:"bondMode"`
	VlanRawDevice   string   `json:"vlanRawDevice"`
	VlanID          *int     `json:"vlanId"`
	MTU             *int     `json:"mtu"`
	Comments        string   `json:"comments"`
	Delete          []string `json:"delete"`
}

func buildNetworkParams(req nodeNetworkReq, isCreate bool) (url.Values, error) {
	t := strings.TrimSpace(req.Type)
	if !allowedNetworkTypes[t] {
		return nil, fmt.Errorf("不支持的网络接口类型 %q", req.Type)
	}
	p := url.Values{"type": {t}}
	if isCreate {
		if err := pve.ValidateIfaceName(req.Iface); err != nil {
			return nil, err
		}
		p.Set("iface", req.Iface)
	}
	if strings.TrimSpace(req.CIDR) != "" {
		p.Set("cidr", strings.TrimSpace(req.CIDR))
	}
	if strings.TrimSpace(req.Gateway) != "" {
		p.Set("gateway", strings.TrimSpace(req.Gateway))
	}
	if strings.TrimSpace(req.CIDR6) != "" {
		p.Set("cidr6", strings.TrimSpace(req.CIDR6))
	}
	if strings.TrimSpace(req.Gateway6) != "" {
		p.Set("gateway6", strings.TrimSpace(req.Gateway6))
	}
	if req.Autostart != nil {
		if *req.Autostart {
			p.Set("autostart", "1")
		} else {
			p.Set("autostart", "0")
		}
	}
	if t == "bridge" {
		if strings.TrimSpace(req.BridgePorts) != "" {
			p.Set("bridge_ports", strings.TrimSpace(req.BridgePorts))
		}
		if req.BridgeVlanAware != nil {
			if *req.BridgeVlanAware {
				p.Set("bridge_vlan_aware", "1")
			} else {
				p.Set("bridge_vlan_aware", "0")
			}
		}
	}
	if t == "OVSBridge" && strings.TrimSpace(req.OVSPorts) != "" {
		p.Set("ovs_ports", strings.TrimSpace(req.OVSPorts))
	}
	if t == "bond" {
		if strings.TrimSpace(req.Slaves) != "" {
			p.Set("slaves", strings.TrimSpace(req.Slaves))
		}
		if strings.TrimSpace(req.BondMode) != "" {
			p.Set("bond_mode", strings.TrimSpace(req.BondMode))
		}
	}
	if t == "vlan" {
		if strings.TrimSpace(req.VlanRawDevice) != "" {
			p.Set("vlan-raw-device", strings.TrimSpace(req.VlanRawDevice))
		}
		if req.VlanID != nil {
			if *req.VlanID < 1 || *req.VlanID > 4094 {
				return nil, fmt.Errorf("VLAN ID 必须在 1–4094 之间")
			}
			p.Set("vlan-id", strconv.Itoa(*req.VlanID))
		}
	}
	if req.MTU != nil {
		if *req.MTU < 1280 || *req.MTU > 65520 {
			return nil, fmt.Errorf("MTU 必须在 1280–65520 之间")
		}
		p.Set("mtu", strconv.Itoa(*req.MTU))
	}
	if strings.TrimSpace(req.Comments) != "" {
		p.Set("comments", strings.TrimSpace(req.Comments)+"\n")
	}
	if !isCreate && len(req.Delete) > 0 {
		var cleanDel []string
		seen := map[string]bool{}
		for _, k := range req.Delete {
			c := strings.TrimSpace(k)
			if c == "" {
				continue
			}
			if !allowedNetworkDeleteKeys[c] {
				return nil, fmt.Errorf("不允许删除的网络配置字段 %q", c)
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
	return p, nil
}

func (s *Server) handleCreateNodeNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var req nodeNetworkReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	params, err := buildNetworkParams(req, true)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.CreateNodeNetwork(r.Context(), node, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net:%s", id, node, req.Iface), "node.network.create", fmt.Sprintf("%s (%s)", req.Iface, req.Type), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleUpdateNodeNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	iface := urlParamDecoded(r, "iface")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateIfaceName(iface); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var req nodeNetworkReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	params, err := buildNetworkParams(req, false)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.UpdateNodeNetwork(r.Context(), node, iface, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net:%s", id, node, iface), "node.network.update", fmt.Sprintf("%s (%s)", iface, req.Type), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteNodeNetwork(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	iface := urlParamDecoded(r, "iface")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateIfaceName(iface); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != iface {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.DeleteNodeNetwork(r.Context(), node, iface)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net:%s", id, node, iface), "node.network.delete", iface, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleApplyNodeNetwork(w http.ResponseWriter, r *http.Request) {
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
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.ApplyNodeNetwork(r.Context(), node)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net", id, node), "node.network.apply", "ifreload", upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleRevertNodeNetwork(w http.ResponseWriter, r *http.Request) {
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
	err = cl.RevertNodeNetwork(r.Context(), node)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net", id, node), "node.network.revert", "revert staged changes", "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Phase 3: Resource Pools & Guest Migrate & Batch Tags ---

func (s *Server) handleListPools(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	pools, err := cl.ListPools(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	warnings := map[string]string{}
	var warnMu sync.Mutex
	var g errgroup.Group
	g.SetLimit(6)
	for i := range pools {
		idx := i
		g.Go(func() error {
			det, err := cl.GetPool(r.Context(), pools[idx].PoolID)
			if err != nil {
				pools[idx].Members = []pve.PoolMember{}
				warnMu.Lock()
				warnings[pools[idx].PoolID] = err.Error()
				warnMu.Unlock()
				return nil
			}
			if det != nil {
				pools[idx].Members = det.Members
				if pools[idx].Comment == "" {
					pools[idx].Comment = det.Comment
				}
			} else {
				pools[idx].Members = []pve.PoolMember{}
			}
			return nil
		})
	}
	_ = g.Wait()
	sort.Slice(pools, func(i, j int) bool { return pools[i].PoolID < pools[j].PoolID })
	resp := map[string]any{"items": pools}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleCreatePool(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	var body struct {
		PoolID  string `json:"poolid"`
		Comment string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := pve.ValidatePoolID(body.PoolID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.CreatePool(r.Context(), body.PoolID, body.Comment)
	s.recordAudit(r, id, fmt.Sprintf("%s:pool:%s", id, body.PoolID), "pool.create", body.PoolID, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleUpdatePool(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	poolID := urlParamDecoded(r, "poolId")
	if err := pve.ValidatePoolID(poolID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Comment   *string `json:"comment"`
		VMs       string  `json:"vms"`
		Storage   string  `json:"storage"`
		Delete    bool    `json:"delete"`
		AllowMove bool    `json:"allowMove"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	vmsClean := strings.TrimSpace(body.VMs)
	storageClean := strings.TrimSpace(body.Storage)
	if body.Comment == nil && vmsClean == "" && storageClean == "" {
		writeErr(w, http.StatusBadRequest, "至少需提供 comment、vms 或 storage 中的一项变更")
		return
	}
	if body.Delete && body.AllowMove {
		writeErr(w, http.StatusBadRequest, "delete 与 allowMove 不能同时启用")
		return
	}
	if body.Delete && vmsClean == "" && storageClean == "" {
		writeErr(w, http.StatusBadRequest, "移除成员时必须指定 vms 或 storage")
		return
	}
	if vmsClean != "" && !validVMIDListRegex.MatchString(vmsClean) {
		writeErr(w, http.StatusBadRequest, "vms 必须为逗号分隔的正整数 VMID 列表")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.UpdatePool(r.Context(), poolID, body.Comment, vmsClean, storageClean, body.Delete, body.AllowMove)
	var parts []string
	actionWord := "add"
	if body.Delete {
		actionWord = "remove"
	}
	if vmsClean != "" {
		parts = append(parts, fmt.Sprintf("%s vms=%s", actionWord, vmsClean))
	}
	if storageClean != "" {
		parts = append(parts, fmt.Sprintf("%s storage=%s", actionWord, storageClean))
	}
	if body.Comment != nil {
		parts = append(parts, "comment")
	}
	summary := poolID
	if len(parts) > 0 {
		summary = fmt.Sprintf("%s (%s)", poolID, strings.Join(parts, ", "))
	}
	s.recordAudit(r, id, fmt.Sprintf("%s:pool:%s", id, poolID), "pool.update", summary, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeletePool(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	poolID := urlParamDecoded(r, "poolId")
	if err := pve.ValidatePoolID(poolID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != poolID {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.DeletePool(r.Context(), poolID)
	s.recordAudit(r, id, fmt.Sprintf("%s:pool:%s", id, poolID), "pool.delete", poolID, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleMigrateGuest(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		TargetNode     string `json:"targetNode"`
		Online         bool   `json:"online"`
		Restart        bool   `json:"restart"`
		WithLocalDisks bool   `json:"withLocalDisks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	targetNode := strings.TrimSpace(body.TargetNode)
	if err := pve.ValidateNodeName(targetNode); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的目标节点名称")
		return
	}
	if targetNode == node {
		writeErr(w, http.StatusBadRequest, "目标节点不能与当前所在节点相同")
		return
	}
	if gtype == "lxc" && body.Online {
		writeErr(w, http.StatusBadRequest, "LXC 容器不支持在线热迁移，请使用 restart 模式")
		return
	}
	if gtype == "qemu" && body.Restart {
		writeErr(w, http.StatusBadRequest, "QEMU 虚拟机不支持 restart 参数，请使用 online 参数")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.MigrateGuest(r.Context(), node, gtype, vmid, targetNode, body.Online, body.Restart, body.WithLocalDisks)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".migrate", fmt.Sprintf("%s -> %s", node, targetNode), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleBatchGuestTags(w http.ResponseWriter, r *http.Request) {
	type targetItem struct {
		InstanceID string `json:"instanceId"`
		Node       string `json:"node"`
		Type       string `json:"type"`
		VMID       int    `json:"vmid"`
	}
	var body struct {
		Mode    string       `json:"mode"` // add | remove | replace
		Tags    []string     `json:"tags"`
		Targets []targetItem `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Mode != "add" && body.Mode != "remove" && body.Mode != "replace" {
		writeErr(w, http.StatusBadRequest, "mode 必须为 add、remove 或 replace")
		return
	}
	if len(body.Targets) == 0 || len(body.Targets) > 100 {
		writeErr(w, http.StatusBadRequest, "targets must contain 1–100 guests")
		return
	}
	cleanTags := make([]string, 0, len(body.Tags))
	for _, rawTag := range body.Tags {
		t := strings.TrimSpace(rawTag)
		if t == "" {
			continue
		}
		if err := pve.ValidateGuestTag(t); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		cleanTags = append(cleanTags, strings.ToLower(t))
	}
	if len(cleanTags) == 0 && body.Mode != "replace" {
		writeErr(w, http.StatusBadRequest, "add/remove 模式至少需提供一个有效标签")
		return
	}

	// Validate & deduplicate targets up-front to prevent concurrent read-modify-write races
	seenTargets := map[string]bool{}
	targets := make([]targetItem, 0, len(body.Targets))
	instSet := map[string]bool{}
	for _, t := range body.Targets {
		if strings.TrimSpace(t.InstanceID) == "" {
			writeErr(w, http.StatusBadRequest, "target instanceId is required")
			return
		}
		if err := pve.ValidateNodeName(t.Node); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if t.Type != "qemu" && t.Type != "lxc" {
			writeErr(w, http.StatusBadRequest, "target type must be qemu or lxc")
			return
		}
		if t.VMID <= 0 {
			writeErr(w, http.StatusBadRequest, "target vmid must be positive")
			return
		}
		key := fmt.Sprintf("%s:%s:%s:%d", t.InstanceID, t.Node, t.Type, t.VMID)
		if seenTargets[key] {
			continue
		}
		seenTargets[key] = true
		instSet[t.InstanceID] = true
		targets = append(targets, t)
	}

	type batchResult struct {
		InstanceID string `json:"instanceId"`
		Node       string `json:"node"`
		Type       string `json:"type"`
		VMID       int    `json:"vmid"`
		OK         bool   `json:"ok"`
		Tags       string `json:"tags,omitempty"`
		Error      string `json:"error,omitempty"`
	}

	results := make([]batchResult, len(targets))
	var g errgroup.Group
	g.SetLimit(6)
	var okCount int
	var countMu sync.Mutex

	for i, tgt := range targets {
		idx, t := i, tgt
		g.Go(func() error {
			res := batchResult{InstanceID: t.InstanceID, Node: t.Node, Type: t.Type, VMID: t.VMID}
			cl, _, err := s.pool.Get(r.Context(), t.InstanceID)
			if err != nil {
				res.Error = err.Error()
				results[idx] = res
				return nil
			}
			cfg, err := cl.GetGuestConfig(r.Context(), t.Node, t.Type, t.VMID)
			if err != nil {
				res.Error = err.Error()
				results[idx] = res
				return nil
			}
			existingTags, _ := cfg["tags"].(string)
			nextTags := pve.MergeGuestTags(existingTags, body.Mode, cleanTags)
			vals := map[string]string{}
			if digest, _ := cfg["digest"].(string); digest != "" {
				vals["digest"] = digest
			}
			var delKeys []string
			if nextTags == "" {
				delKeys = []string{"tags"}
			} else {
				vals["tags"] = nextTags
			}
			if err := cl.UpdateGuestConfig(r.Context(), t.Node, t.Type, t.VMID, vals, delKeys, nil); err != nil {
				res.Error = err.Error()
				results[idx] = res
				return nil
			}
			res.OK = true
			res.Tags = nextTags
			results[idx] = res
			countMu.Lock()
			okCount++
			countMu.Unlock()
			return nil
		})
	}
	_ = g.Wait()
	if okCount > 0 {
		s.agg.InvalidateCache()
	}
	auditInstID := ""
	if len(instSet) == 1 {
		for k := range instSet {
			auditInstID = k
		}
	}
	var auditErr error
	if okCount < len(targets) {
		auditErr = fmt.Errorf("%d/%d guests failed to update tags", len(targets)-okCount, len(targets))
	}
	s.recordAudit(r, auditInstID, "guests:batch:tags", "guests.batch.tags", fmt.Sprintf("mode=%s tags=%s (%d/%d ok)", body.Mode, strings.Join(cleanTags, ","), okCount, len(targets)), "", auditErr)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      okCount == len(targets),
		"updated": okCount,
		"total":   len(targets),
		"results": results,
	})
}

// --- Phase 3: 3-Tier Firewall (Cluster / Node / Guest) ---

func resolveFirewallRoute(r *http.Request, scope string) (instanceID, scopePath, urn string, err error) {
	instanceID = chi.URLParam(r, "instanceId")
	switch scope {
	case "cluster":
		scopePath, err = pve.BuildFirewallScopePath("cluster", "", "", 0)
		urn = instanceID + ":cluster:firewall"
	case "node":
		node := urlParamDecoded(r, "node")
		scopePath, err = pve.BuildFirewallScopePath("node", node, "", 0)
		urn = fmt.Sprintf("%s:node:%s:firewall", instanceID, node)
	case "guest":
		var node, gtype string
		var vmid int
		instanceID, node, gtype, vmid, err = parseGuestRoute(r)
		if err != nil {
			return "", "", "", err
		}
		scopePath, err = pve.BuildFirewallScopePath("guest", node, gtype, vmid)
		urn = fmt.Sprintf("%s:%s:%s:%d:firewall", instanceID, gtype, node, vmid)
	default:
		err = fmt.Errorf("unknown firewall scope")
	}
	return
}

func (s *Server) makeGetFirewallHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, scopePath, _, err := resolveFirewallRoute(r, scope)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		cl, _, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}

		var (
			opts     *pve.FirewallOptions
			rules    []pve.FirewallRule
			aliases  []pve.FirewallAlias
			ipsets   []pve.FirewallIPSet
			groups   []pve.FirewallGroup
			optErr   error
			ruleErr  error
			aliasErr error
			ipsetErr error
			groupErr error
		)

		var g errgroup.Group
		g.Go(func() error {
			opts, optErr = cl.GetFirewallOptions(r.Context(), scopePath)
			return nil
		})
		g.Go(func() error {
			rules, ruleErr = cl.ListFirewallRules(r.Context(), scopePath)
			return nil
		})
		if scope == "cluster" {
			g.Go(func() error {
				aliases, aliasErr = cl.ListClusterFirewallAliases(r.Context())
				return nil
			})
			g.Go(func() error {
				ipsets, ipsetErr = cl.ListClusterFirewallIPSets(r.Context())
				return nil
			})
			g.Go(func() error {
				groups, groupErr = cl.ListClusterFirewallGroups(r.Context())
				return nil
			})
		}
		_ = g.Wait()

		// Both options and rules are core firewall state — never silently mask failure of either as empty/disabled.
		if optErr != nil {
			writeErr(w, http.StatusBadGateway, "读取防火墙选项失败: "+optErr.Error())
			return
		}
		if ruleErr != nil {
			writeErr(w, http.StatusBadGateway, "读取防火墙规则失败: "+ruleErr.Error())
			return
		}
		if opts == nil {
			opts = &pve.FirewallOptions{}
		}
		if rules == nil {
			rules = []pve.FirewallRule{}
		}
		sort.Slice(rules, func(i, j int) bool { return int(rules[i].Pos) < int(rules[j].Pos) })

		resp := map[string]any{
			"scope":   scope,
			"options": opts,
			"rules":   rules,
		}
		if scope == "cluster" {
			if aliases == nil {
				aliases = []pve.FirewallAlias{}
			}
			if ipsets == nil {
				ipsets = []pve.FirewallIPSet{}
			}
			if groups == nil {
				groups = []pve.FirewallGroup{}
			}
			resp["aliases"] = aliases
			resp["ipsets"] = ipsets
			resp["groups"] = groups
			warnings := map[string]string{}
			if aliasErr != nil {
				warnings["aliases"] = aliasErr.Error()
			}
			if ipsetErr != nil {
				warnings["ipsets"] = ipsetErr.Error()
			}
			if groupErr != nil {
				warnings["groups"] = groupErr.Error()
			}
			if len(warnings) > 0 {
				resp["warnings"] = warnings
			}
		}
		writeJSON(w, http.StatusOK, resp)
	}
}

func (s *Server) makeUpdateFirewallOptionsHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, scopePath, urn, err := resolveFirewallRoute(r, scope)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		var body struct {
			Enable      *bool  `json:"enable"`
			PolicyIn    string `json:"policyIn"`
			PolicyOut   string `json:"policyOut"`
			PolicyFwd   string `json:"policyForward"`
			Ebtables    *bool  `json:"ebtables"`
			DHCP        *bool  `json:"dhcp"`
			NDP         *bool  `json:"ndp"`
			MACFilter   *bool  `json:"macfilter"`
			IPFilter    *bool  `json:"ipfilter"`
			LogLevelIn  string `json:"logLevelIn"`
			LogLevelOut string `json:"logLevelOut"`
			Digest      string `json:"digest"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		p := url.Values{}
		setBool := func(k string, v *bool) {
			if v == nil {
				return
			}
			if *v {
				p.Set(k, "1")
			} else {
				p.Set(k, "0")
			}
		}
		setBool("enable", body.Enable)

		validPolicy := func(v string) bool {
			return v == "ACCEPT" || v == "DROP" || v == "REJECT"
		}
		if polIn := strings.TrimSpace(body.PolicyIn); polIn != "" {
			if scope == "node" {
				writeErr(w, http.StatusBadRequest, "节点级防火墙不支持设置 policy_in")
				return
			}
			if !validPolicy(polIn) {
				writeErr(w, http.StatusBadRequest, "policyIn 必须为 ACCEPT、DROP 或 REJECT")
				return
			}
			p.Set("policy_in", polIn)
		}
		if polOut := strings.TrimSpace(body.PolicyOut); polOut != "" {
			if scope == "node" {
				writeErr(w, http.StatusBadRequest, "节点级防火墙不支持设置 policy_out")
				return
			}
			if !validPolicy(polOut) {
				writeErr(w, http.StatusBadRequest, "policyOut 必须为 ACCEPT、DROP 或 REJECT")
				return
			}
			p.Set("policy_out", polOut)
		}
		if polFwd := strings.TrimSpace(body.PolicyFwd); polFwd != "" {
			if scope != "cluster" {
				writeErr(w, http.StatusBadRequest, "仅集群级防火墙支持设置 policy_forward")
				return
			}
			if polFwd != "ACCEPT" && polFwd != "DROP" {
				writeErr(w, http.StatusBadRequest, "policyForward 必须为 ACCEPT 或 DROP")
				return
			}
			p.Set("policy_forward", polFwd)
		}
		if scope == "cluster" {
			setBool("ebtables", body.Ebtables)
		}
		if scope == "guest" {
			setBool("dhcp", body.DHCP)
			setBool("macfilter", body.MACFilter)
			setBool("ipfilter", body.IPFilter)
		}
		if scope != "cluster" {
			setBool("ndp", body.NDP)
		}
		if logIn := strings.TrimSpace(body.LogLevelIn); logIn != "" {
			if scope == "cluster" {
				writeErr(w, http.StatusBadRequest, "集群级防火墙不支持设置 log_level_in")
				return
			}
			if !allowedLogLevels[logIn] {
				writeErr(w, http.StatusBadRequest, "无效的 logLevelIn 值")
				return
			}
			p.Set("log_level_in", logIn)
		}
		if logOut := strings.TrimSpace(body.LogLevelOut); logOut != "" {
			if scope == "cluster" {
				writeErr(w, http.StatusBadRequest, "集群级防火墙不支持设置 log_level_out")
				return
			}
			if !allowedLogLevels[logOut] {
				writeErr(w, http.StatusBadRequest, "无效的 logLevelOut 值")
				return
			}
			p.Set("log_level_out", logOut)
		}
		if len(p) == 0 {
			writeErr(w, http.StatusBadRequest, "no firewall options provided")
			return
		}
		if d := strings.TrimSpace(body.Digest); d != "" {
			p.Set("digest", d)
		}

		cl, inst, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		// Guard policy_forward on PVE < 8.2 (introduced in PVE 8.2)
		if p.Has("policy_forward") && inst != nil && inst.DetectedVersion != "" {
			maj, min, _ := pve.ParseVersion(inst.DetectedVersion)
			if maj > 0 && (maj < 8 || (maj == 8 && min < 2)) {
				writeErr(w, http.StatusBadRequest, "policy_forward 仅支持 Proxmox VE 8.2 及以上版本")
				return
			}
		}
		err = cl.UpdateFirewallOptions(r.Context(), scopePath, p)
		s.recordAudit(r, id, urn, "firewall.options.update", p.Encode(), "", err)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type firewallRuleReq struct {
	Type    string   `json:"type"`   // in | out | forward | group
	Action  string   `json:"action"` // ACCEPT | DROP | REJECT | <group>
	Enable  *bool    `json:"enable"`
	Macro   string   `json:"macro"`
	Proto   string   `json:"proto"`
	Source  string   `json:"source"`
	Dest    string   `json:"dest"`
	SPort   string   `json:"sport"`
	DPort   string   `json:"dport"`
	Iface   string   `json:"iface"`
	Log     string   `json:"log"`
	Comment string   `json:"comment"`
	Digest  string   `json:"digest"`
	Delete  []string `json:"delete"`
}

func buildFirewallRuleParams(scope string, req firewallRuleReq, isCreate bool) (url.Values, error) {
	p := url.Values{}
	rType := strings.TrimSpace(req.Type)
	rAction := strings.TrimSpace(req.Action)

	if isCreate && (rType == "" || rAction == "") {
		return nil, fmt.Errorf("type 和 action 不能为空")
	}
	if rType != "" {
		if rType != "in" && rType != "out" && rType != "forward" && rType != "group" {
			return nil, fmt.Errorf("无效的防火墙规则方向/类型 %q", rType)
		}
		if rType == "forward" && scope == "guest" {
			return nil, fmt.Errorf("实例级防火墙不支持 forward 方向规则")
		}
		p.Set("type", rType)
	}
	if rAction != "" {
		if rType == "group" {
			if !validFirewallGroup.MatchString(rAction) {
				return nil, fmt.Errorf("无效的安全组名称 %q", rAction)
			}
		} else if rType != "" {
			upper := strings.ToUpper(rAction)
			if upper != "ACCEPT" && upper != "DROP" && upper != "REJECT" {
				return nil, fmt.Errorf("规则动作必须为 ACCEPT、DROP 或 REJECT")
			}
			rAction = upper
		}
		p.Set("action", rAction)
	}
	if req.Enable != nil {
		if *req.Enable {
			p.Set("enable", "1")
		} else {
			p.Set("enable", "0")
		}
	} else if isCreate {
		p.Set("enable", "1")
	}

	macro := strings.TrimSpace(req.Macro)
	proto := strings.TrimSpace(req.Proto)
	source := strings.TrimSpace(req.Source)
	dest := strings.TrimSpace(req.Dest)
	sport := strings.TrimSpace(req.SPort)
	dport := strings.TrimSpace(req.DPort)
	iface := strings.TrimSpace(req.Iface)
	logLv := strings.TrimSpace(req.Log)
	comment := strings.TrimSpace(req.Comment)

	if rType == "group" {
		if macro != "" || proto != "" || source != "" || dest != "" || sport != "" || dport != "" || logLv != "" {
			return nil, fmt.Errorf("安全组引用规则 (group) 不支持设置 macro/proto/source/dest/port/log 参数")
		}
	} else {
		if macro != "" && (proto != "" || sport != "" || dport != "") {
			return nil, fmt.Errorf("使用内置服务宏 (macro) 时不能同时指定 proto、sport 或 dport")
		}
		if logLv != "" && !allowedLogLevels[logLv] {
			return nil, fmt.Errorf("无效的日志级别 %q", logLv)
		}
	}

	for k, v := range map[string]string{
		"macro":   macro,
		"proto":   proto,
		"source":  source,
		"dest":    dest,
		"sport":   sport,
		"dport":   dport,
		"iface":   iface,
		"log":     logLv,
		"comment": comment,
	} {
		if v != "" {
			p.Set(k, v)
		}
	}

	if !isCreate && len(req.Delete) > 0 {
		var cleanDel []string
		seen := map[string]bool{}
		for _, k := range req.Delete {
			c := strings.TrimSpace(k)
			if c == "" {
				continue
			}
			if !allowedFirewallDeleteKeys[c] {
				return nil, fmt.Errorf("不允许删除的规则字段 %q", c)
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
		return nil, fmt.Errorf("未提供任何需要更新的规则字段")
	}
	if d := strings.TrimSpace(req.Digest); !isCreate && d != "" {
		p.Set("digest", d)
	}
	return p, nil
}

func (s *Server) makeCreateFirewallRuleHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, scopePath, urn, err := resolveFirewallRoute(r, scope)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		var req firewallRuleReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		params, err := buildFirewallRuleParams(scope, req, true)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		cl, _, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		err = cl.CreateFirewallRule(r.Context(), scopePath, params)
		s.recordAudit(r, id, urn, "firewall.rule.create", fmt.Sprintf("%s %s %s", strings.TrimSpace(req.Type), strings.TrimSpace(req.Action), strings.TrimSpace(req.DPort)), "", err)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
	}
}

func (s *Server) makeUpdateFirewallRuleHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, scopePath, urn, err := resolveFirewallRoute(r, scope)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		pos, err := strconv.Atoi(chi.URLParam(r, "pos"))
		if err != nil || pos < 0 {
			writeErr(w, http.StatusBadRequest, "invalid rule position")
			return
		}
		var req firewallRuleReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeErr(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		params, err := buildFirewallRuleParams(scope, req, false)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		cl, _, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		err = cl.UpdateFirewallRule(r.Context(), scopePath, pos, params)
		s.recordAudit(r, id, urn, "firewall.rule.update", fmt.Sprintf("pos=%d", pos), "", err)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

func (s *Server) makeDeleteFirewallRuleHandler(scope string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, scopePath, urn, err := resolveFirewallRoute(r, scope)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		pos, err := strconv.Atoi(chi.URLParam(r, "pos"))
		if err != nil || pos < 0 {
			writeErr(w, http.StatusBadRequest, "invalid rule position")
			return
		}
		digest := strings.TrimSpace(r.URL.Query().Get("digest"))
		cl, _, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		err = cl.DeleteFirewallRule(r.Context(), scopePath, pos, digest)
		s.recordAudit(r, id, urn, "firewall.rule.delete", fmt.Sprintf("pos=%d", pos), "", err)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
