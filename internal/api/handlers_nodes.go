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
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"golang.org/x/sync/errgroup"
)

// --- Node Status, Hardware, Power, Console & Tasks ---

func (s *Server) handleNodeStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	st, err := cl.GetNodeStatus(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	sensors := pve.ParseNodeSensors(st)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  st,
		"sensors": sensors,
	})
}

func (s *Server) handleNodeHardware(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	force := r.URL.Query().Get("refresh") == "1"
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	report, err := pve.CollectNodeHardware(r.Context(), cl, id, node, inst.SSHHost, force)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleNodeRRD(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	pts, err := cl.GetNodeRRD(r.Context(), node, r.URL.Query().Get("timeframe"), r.URL.Query().Get("cf"))
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if pts == nil {
		pts = []pve.RRDPoint{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": pts})
}

func (s *Server) handleNodePower(w http.ResponseWriter, r *http.Request) {
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
		Command string `json:"command"` // reboot | shutdown
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.NodePowerAction(r.Context(), node, body.Command)
	s.recordAudit(r, id, id+":node:"+node, "node."+body.Command, body.Command, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleNodeConsoleSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Protocol         string `json:"protocol"`
		FallbackUsername string `json:"fallbackUsername"`
		FallbackPassword string `json:"fallbackPassword"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Protocol == "" {
		body.Protocol = "xterm"
	}
	claims := getClaims(r)
	uid := ""
	if claims != nil {
		uid = claims.UserID
	}
	out, err := s.console.CreateSession(r.Context(), pve.CreateSessionInput{
		OwnerUserID:      uid,
		InstanceID:       id,
		Node:             node,
		TargetType:       "node",
		Protocol:         body.Protocol,
		FallbackUsername: body.FallbackUsername,
		FallbackPassword: body.FallbackPassword,
	})
	s.recordAudit(r, id, id+":node:"+node, "console."+body.Protocol, "node shell", "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// --- Node Network Management ---

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

func (s *Server) handleNodeNetworks(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, changes, err := cl.GetNodeNetworksWithChanges(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if items == nil {
		items = []pve.NodeNetworkIface{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Iface < items[j].Iface })
	writeJSON(w, http.StatusOK, map[string]any{
		"items":      items,
		"changes":    changes,
		"hasPending": strings.TrimSpace(changes) != "",
	})
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
		s.writePVEError(w, err)
		return
	}
	err = cl.CreateNodeNetwork(r.Context(), node, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net:%s", id, node, req.Iface), "node.network.create", fmt.Sprintf("%s (%s)", req.Iface, req.Type), "", err)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.UpdateNodeNetwork(r.Context(), node, iface, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net:%s", id, node, iface), "node.network.update", fmt.Sprintf("%s (%s)", iface, req.Type), "", err)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.DeleteNodeNetwork(r.Context(), node, iface)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net:%s", id, node, iface), "node.network.delete", iface, "", err)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.ApplyNodeNetwork(r.Context(), node)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net", id, node), "node.network.apply", "ifreload", upid, err)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.RevertNodeNetwork(r.Context(), node)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:net", id, node), "node.network.revert", "revert staged changes", "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Node Services, Syslog & APT ---

func (s *Server) handleNodeServices(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, err := cl.GetNodeServices(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if items == nil {
		items = []pve.NodeServiceItem{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Service < items[j].Service })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleNodeServiceAction(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	service := strings.TrimSpace(urlParamDecoded(r, "service"))
	if service == "" || strings.Contains(service, "..") || strings.Contains(service, "/") || hasControlChars(service) {
		writeErr(w, http.StatusBadRequest, "无效的服务名称")
		return
	}
	action := chi.URLParam(r, "action")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.ControlNodeService(r.Context(), node, service, action)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:service:%s", id, node, service), "node.service."+action, service, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleNodeSyslog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	service := r.URL.Query().Get("service")
	since := r.URL.Query().Get("since")
	until := r.URL.Query().Get("until")
	var hrs int
	if v, err := strconv.Atoi(r.URL.Query().Get("hours")); err == nil && v > 0 && v <= 720 {
		hrs = v
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	lines, err := cl.GetNodeSyslogWithOptions(r.Context(), node, pve.NodeSyslogOptions{
		Limit:   limit,
		Service: service,
		Since:   since,
		Until:   until,
		Hours:   hrs,
	})
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if lines == nil {
		lines = []pve.SyslogLine{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": lines})
}

func (s *Server) handleNodeAPTUpdates(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, err := cl.GetNodeAPTUpdates(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if items == nil {
		items = []pve.APTUpdatePkg{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Package < items[j].Package })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleNodeAPTRefresh(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.RefreshNodeAPT(r.Context(), node)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s", id, node), "node.apt.update", "apt-get update", upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleNodeAPTRepositories(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	res, err := cl.GetNodeAPTRepositories(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if res.Files == nil {
		res.Files = []map[string]any{}
	}
	if res.Errors == nil {
		res.Errors = []map[string]any{}
	}
	if res.Infos == nil {
		res.Infos = []map[string]any{}
	}
	if res.StandardRepos == nil {
		res.StandardRepos = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Node Disk Stacks (ZFS / LVM / LVM-Thin / Directory) & Ceph ---

func (s *Server) handleNodeDisksOverview(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}

	var (
		zfsPools []pve.ZFSPoolSummary
		lvmVGs   []pve.LVMVolumeGroup
		lvmThins []pve.LVMThinPool
		dirs     []pve.DirectoryMount
		zfsErr   error
		lvmErr   error
		thinErr  error
		dirErr   error
	)

	var g errgroup.Group
	g.Go(func() error {
		zfsPools, zfsErr = cl.ListNodeZFS(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		lvmVGs, lvmErr = cl.ListNodeLVM(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		lvmThins, thinErr = cl.ListNodeLVMThin(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		dirs, dirErr = cl.ListNodeDirectory(r.Context(), node)
		return nil
	})
	_ = g.Wait()

	if zfsErr != nil && lvmErr != nil && thinErr != nil && dirErr != nil {
		s.writePVEError(w, fmt.Errorf("读取宿主机磁盘栈失败: %w", lvmErr))
		return
	}

	// Best-effort enrich ZFS VDEV topology (bounded concurrency, up to 8 pools)
	if zfsErr == nil && len(zfsPools) > 0 {
		var zg errgroup.Group
		zg.SetLimit(4)
		limit := len(zfsPools)
		if limit > 8 {
			limit = 8
		}
		for i := 0; i < limit; i++ {
			idx := i
			zg.Go(func() error {
				if det, err := cl.GetNodeZFSDetail(r.Context(), node, zfsPools[idx].Name); err == nil && det != nil {
					zfsPools[idx].Scan = det.Scan
					zfsPools[idx].Errors = det.Errors
					zfsPools[idx].Children = det.Children
				}
				return nil
			})
		}
		_ = zg.Wait()
	}

	if zfsPools == nil {
		zfsPools = []pve.ZFSPoolSummary{}
	}
	if lvmVGs == nil {
		lvmVGs = []pve.LVMVolumeGroup{}
	}
	if lvmThins == nil {
		lvmThins = []pve.LVMThinPool{}
	}
	if dirs == nil {
		dirs = []pve.DirectoryMount{}
	}

	sort.Slice(zfsPools, func(i, j int) bool { return zfsPools[i].Name < zfsPools[j].Name })
	sort.Slice(lvmVGs, func(i, j int) bool { return lvmVGs[i].Name < lvmVGs[j].Name })
	sort.Slice(lvmThins, func(i, j int) bool { return lvmThins[i].Vg+"/"+lvmThins[i].Lv < lvmThins[j].Vg+"/"+lvmThins[i].Lv })
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Path < dirs[j].Path })

	warnings := map[string]string{}
	var warnMu sync.Mutex
	addWarn := func(k string, e error) {
		if e != nil {
			warnMu.Lock()
			warnings[k] = e.Error()
			warnMu.Unlock()
		}
	}
	addWarn("zfs", zfsErr)
	addWarn("lvm", lvmErr)
	addWarn("lvmthin", thinErr)
	addWarn("directory", dirErr)

	resp := map[string]any{
		"node":        node,
		"zfs":         zfsPools,
		"lvm":         lvmVGs,
		"lvmthin":     lvmThins,
		"directories": dirs,
	}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleNodeCeph(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	ov, err := cl.GetNodeCephOverview(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

// --- Node Certificates & ACME ---

func (s *Server) handleNodeCertificates(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, fmt.Errorf("读取节点 SSL 证书信息失败: %w", certErr))
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid, "action": action})
}

// --- Task Status, Log & Live SSE Tailing ---

func validateUPIDParam(upid string) error {
	if strings.TrimSpace(upid) == "" || strings.Contains(upid, "..") || hasControlChars(upid) {
		return errors.New("invalid task upid")
	}
	return nil
}

func (s *Server) handleTaskStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateUPIDParam(upid); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	st, err := cl.GetTaskStatus(r.Context(), node, upid)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleTaskLog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateUPIDParam(upid); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 500
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	lines, err := cl.GetTaskLog(r.Context(), node, upid, start, limit)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if lines == nil {
		lines = []pve.TaskLogLine{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": lines})
}

func (s *Server) handleTaskLogSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateUPIDParam(upid); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	cursor := 0
	ticker := time.NewTicker(1 * time.Second)
	pingTicker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	defer pingTicker.Stop()

	flushLogs := func() error {
		const pageLimit = 500
		for page := 0; page < 20; page++ {
			lines, logErr := cl.GetTaskLog(r.Context(), node, upid, cursor, pageLimit)
			if logErr != nil {
				return logErr
			}
			if len(lines) == 0 {
				break
			}
			prevCursor := cursor
			for _, l := range lines {
				// l.N is 1-based while PVE start is 0-based; setting cursor = l.N advances
				// to the exact next 0-based line index without skipping boundary lines.
				if l.N > cursor {
					cursor = l.N
				}
			}
			if b, err := json.Marshal(lines); err == nil {
				fmt.Fprintf(w, "event: log\ndata: %s\n\n", b)
				flusher.Flush()
			}
			if len(lines) < pageLimit || cursor <= prevCursor {
				break
			}
		}
		return nil
	}

	poll := func() bool {
		logErr := flushLogs()
		st, stErr := cl.GetTaskStatus(r.Context(), node, upid)
		if stErr == nil {
			if b, err := json.Marshal(st); err == nil {
				fmt.Fprintf(w, "event: status\ndata: %s\n\n", b)
				flusher.Flush()
			}
			if st.Status == "stopped" {
				// Perform final multi-page drain so lines emitted between GetTaskLog and GetTaskStatus are never dropped
				_ = flushLogs()
				fmt.Fprintf(w, "event: done\ndata: {\"exitstatus\":%q}\n\n", st.ExitStatus)
				flusher.Flush()
				return true
			}
		} else if logErr != nil {
			errJSON, _ := json.Marshal(map[string]string{"error": stErr.Error()})
			fmt.Fprintf(w, "event: taskerror\ndata: %s\n\n", errJSON)
			flusher.Flush()
			return true
		}
		return false
	}

	claims := getClaims(r)
	if poll() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.shutdownCtx.Done():
			return
		case <-pingTicker.C:
			if !s.isClaimsSessionValid(r.Context(), claims) {
				return
			}
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-ticker.C:
			if !s.isClaimsSessionValid(r.Context(), claims) {
				return
			}
			if poll() {
				return
			}
		}
	}
}

func (s *Server) handleStopTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validateUPIDParam(upid); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.StopTask(r.Context(), node, upid)
	s.recordAudit(r, id, id+":task:"+upid, "task.stop", upid, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
