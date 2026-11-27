package api

import (
	"encoding/json"
	"fmt"
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

// --- Phase 3: Node Network Management ---

type nodeNetworkReq struct {
	Iface           string `json:"iface"`
	Type            string `json:"type"` // bridge | bond | vlan | eth | OVSBridge
	CIDR            string `json:"cidr"`
	Gateway         string `json:"gateway"`
	CIDR6           string `json:"cidr6"`
	Gateway6        string `json:"gateway6"`
	Autostart       *bool  `json:"autostart"`
	BridgePorts     string `json:"bridgePorts"`
	BridgeVlanAware *bool  `json:"bridgeVlanAware"`
	Slaves          string `json:"slaves"`
	BondMode        string `json:"bondMode"`
	VlanRawDevice   string `json:"vlanRawDevice"`
	VlanID          *int   `json:"vlanId"`
	MTU             *int     `json:"mtu"`
	Comments        string   `json:"comments"`
	Delete          []string `json:"delete"`
}

func buildNetworkParams(req nodeNetworkReq, isCreate bool) (url.Values, error) {
	t := strings.TrimSpace(req.Type)
	if t == "" {
		return nil, fmt.Errorf("网络接口类型 (type) 不能为空")
	}
	p := url.Values{"type": {t}}
	if isCreate {
		if err := pve.ValidateIfaceName(req.Iface); err != nil {
			return nil, err
		}
		p.Set("iface", strings.TrimSpace(req.Iface))
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
	if strings.TrimSpace(req.BridgePorts) != "" {
		p.Set("bridge_ports", strings.TrimSpace(req.BridgePorts))
	}
	if req.BridgeVlanAware != nil && t == "bridge" {
		if *req.BridgeVlanAware {
			p.Set("bridge_vlan_aware", "1")
		} else {
			p.Set("bridge_vlan_aware", "0")
		}
	}
	if strings.TrimSpace(req.Slaves) != "" && t == "bond" {
		p.Set("slaves", strings.TrimSpace(req.Slaves))
	}
	if strings.TrimSpace(req.BondMode) != "" && t == "bond" {
		p.Set("bond_mode", strings.TrimSpace(req.BondMode))
	}
	if strings.TrimSpace(req.VlanRawDevice) != "" && t == "vlan" {
		p.Set("vlan-raw-device", strings.TrimSpace(req.VlanRawDevice))
	}
	if req.VlanID != nil && *req.VlanID > 0 && t == "vlan" {
		p.Set("vlan-id", strconv.Itoa(*req.VlanID))
	}
	if req.MTU != nil && *req.MTU >= 576 {
		p.Set("mtu", strconv.Itoa(*req.MTU))
	}
	if strings.TrimSpace(req.Comments) != "" {
		p.Set("comments", strings.TrimSpace(req.Comments)+"\n")
	}
	if !isCreate && len(req.Delete) > 0 {
		var cleanDel []string
		for _, k := range req.Delete {
			if c := strings.TrimSpace(k); c != "" {
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
	// Enrich member lists concurrently with bounded concurrency
	var g errgroup.Group
	g.SetLimit(6)
	for i := range pools {
		idx := i
		g.Go(func() error {
			if det, err := cl.GetPool(r.Context(), pools[idx].PoolID); err == nil && det != nil {
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
	writeJSON(w, http.StatusOK, map[string]any{"items": pools})
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
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.UpdatePool(r.Context(), poolID, body.Comment, body.VMs, body.Storage, body.Delete, body.AllowMove)
	summary := poolID
	if body.VMs != "" {
		actionWord := "add"
		if body.Delete {
			actionWord = "remove"
		}
		summary = fmt.Sprintf("%s (%s vms=%s)", poolID, actionWord, body.VMs)
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
		TargetNode string `json:"targetNode"`
		Online     bool   `json:"online"`
		Restart    bool   `json:"restart"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.TargetNode) == "" {
		writeErr(w, http.StatusBadRequest, "targetNode is required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.MigrateGuest(r.Context(), node, gtype, vmid, body.TargetNode, body.Online, body.Restart)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".migrate", fmt.Sprintf("%s -> %s", node, body.TargetNode), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleBatchGuestTags(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Mode    string   `json:"mode"` // add | remove | replace
		Tags    []string `json:"tags"`
		Targets []struct {
			InstanceID string `json:"instanceId"`
			Node       string `json:"node"`
			Type       string `json:"type"`
			VMID       int    `json:"vmid"`
		} `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if len(body.Targets) == 0 || len(body.Targets) > 100 {
		writeErr(w, http.StatusBadRequest, "targets must contain 1–100 guests")
		return
	}
	if body.Mode != "add" && body.Mode != "remove" && body.Mode != "replace" {
		body.Mode = "add"
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

	results := make([]batchResult, len(body.Targets))
	var g errgroup.Group
	g.SetLimit(6)
	var okCount int
	var countMu sync.Mutex

	for i, tgt := range body.Targets {
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
			nextTags := pve.MergeGuestTags(existingTags, body.Mode, body.Tags)
			var vals map[string]string
			var delKeys []string
			if nextTags == "" {
				delKeys = []string{"tags"}
			} else {
				vals = map[string]string{"tags": nextTags}
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
	s.agg.InvalidateCache()
	s.recordAudit(r, "", "guests:batch:tags", "guests.batch.tags", fmt.Sprintf("mode=%s tags=%s (%d/%d ok)", body.Mode, strings.Join(body.Tags, ","), okCount, len(body.Targets)), "", nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      okCount == len(body.Targets),
		"updated": okCount,
		"total":   len(body.Targets),
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
			opts    *pve.FirewallOptions
			rules   []pve.FirewallRule
			aliases []pve.FirewallAlias
			ipsets  []pve.FirewallIPSet
			groups  []pve.FirewallGroup
			optErr  error
			ruleErr error
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
				aliases, _ = cl.ListClusterFirewallAliases(r.Context())
				return nil
			})
			g.Go(func() error {
				ipsets, _ = cl.ListClusterFirewallIPSets(r.Context())
				return nil
			})
			g.Go(func() error {
				groups, _ = cl.ListClusterFirewallGroups(r.Context())
				return nil
			})
		}
		_ = g.Wait()

		if optErr != nil && ruleErr != nil {
			writeErr(w, http.StatusBadGateway, optErr.Error())
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
			DHCP        *bool  `json:"dhcp"`
			MACFilter   *bool  `json:"macfilter"`
			IPFilter    *bool  `json:"ipfilter"`
			LogLevelIn  string `json:"logLevelIn"`
			LogLevelOut string `json:"logLevelOut"`
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
		if body.PolicyIn != "" {
			p.Set("policy_in", body.PolicyIn)
		}
		if body.PolicyOut != "" {
			p.Set("policy_out", body.PolicyOut)
		}
		if body.PolicyFwd != "" && scope == "cluster" {
			p.Set("policy_forward", body.PolicyFwd)
		}
		if scope == "guest" {
			setBool("dhcp", body.DHCP)
			setBool("macfilter", body.MACFilter)
			setBool("ipfilter", body.IPFilter)
		}
		if body.LogLevelIn != "" && scope != "cluster" {
			p.Set("log_level_in", body.LogLevelIn)
		}
		if body.LogLevelOut != "" && scope != "cluster" {
			p.Set("log_level_out", body.LogLevelOut)
		}
		if len(p) == 0 {
			writeErr(w, http.StatusBadRequest, "no firewall options provided")
			return
		}

		cl, _, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
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
	Type    string `json:"type"`   // in | out | forward | group
	Action  string `json:"action"` // ACCEPT | DROP | REJECT | <group>
	Enable  *bool  `json:"enable"`
	Macro   string `json:"macro"`
	Proto   string `json:"proto"`
	Source  string `json:"source"`
	Dest    string `json:"dest"`
	SPort   string `json:"sport"`
	DPort   string `json:"dport"`
	Iface   string `json:"iface"`
	Log     string   `json:"log"`
	Comment string   `json:"comment"`
	Delete  []string `json:"delete"`
}

func buildFirewallRuleParams(req firewallRuleReq, isCreate bool) (url.Values, error) {
	p := url.Values{}
	if isCreate {
		if req.Type == "" || req.Action == "" {
			return nil, fmt.Errorf("type 和 action 不能为空")
		}
	}
	if req.Type != "" {
		p.Set("type", req.Type)
	}
	if req.Action != "" {
		p.Set("action", req.Action)
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
	for k, v := range map[string]string{
		"macro":   req.Macro,
		"proto":   req.Proto,
		"source":  req.Source,
		"dest":    req.Dest,
		"sport":   req.SPort,
		"dport":   req.DPort,
		"iface":   req.Iface,
		"log":     req.Log,
		"comment": req.Comment,
	} {
		if strings.TrimSpace(v) != "" {
			p.Set(k, strings.TrimSpace(v))
		}
	}
	if !isCreate && len(req.Delete) > 0 {
		var cleanDel []string
		for _, k := range req.Delete {
			if c := strings.TrimSpace(k); c != "" {
				cleanDel = append(cleanDel, c)
			}
		}
		if len(cleanDel) > 0 {
			p.Set("delete", strings.Join(cleanDel, ","))
		}
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
		params, err := buildFirewallRuleParams(req, true)
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
		s.recordAudit(r, id, urn, "firewall.rule.create", fmt.Sprintf("%s %s %s", req.Type, req.Action, req.DPort), "", err)
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
		params, err := buildFirewallRuleParams(req, false)
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
		cl, _, err := s.pool.Get(r.Context(), id)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		err = cl.DeleteFirewallRule(r.Context(), scopePath, pos)
		s.recordAudit(r, id, urn, "firewall.rule.delete", fmt.Sprintf("pos=%d", pos), "", err)
		if err != nil {
			writeErr(w, http.StatusBadGateway, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
