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

// --- Resource Pools ---

func (s *Server) handleListPools(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	pools, err := cl.ListPools(r.Context())
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.CreatePool(r.Context(), body.PoolID, body.Comment)
	s.recordAudit(r, id, fmt.Sprintf("%s:pool:%s", id, body.PoolID), "pool.create", body.PoolID, "", err)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.DeletePool(r.Context(), poolID)
	s.recordAudit(r, id, fmt.Sprintf("%s:pool:%s", id, poolID), "pool.delete", poolID, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- 3-Tier Firewall (Cluster / Node / Guest) ---

var (
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

func resolveFirewallRoute(r *http.Request, scope string) (instanceID, scopePath, urn string, err error) {
	instanceID = chi.URLParam(r, "instanceId")
	switch scope {
	case "cluster":
		scopePath, err = pve.BuildFirewallScopePath("cluster", "", "", 0)
		urn = instanceID + ":cluster:firewall"
	case "node":
		node := urlParamDecoded(r, "node")
		if err = pve.ValidateNodeName(node); err != nil {
			return "", "", "", err
		}
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
			s.writePVEError(w, err)
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
			s.writePVEError(w, fmt.Errorf("读取防火墙选项失败: %w", optErr))
			return
		}
		if ruleErr != nil {
			s.writePVEError(w, fmt.Errorf("读取防火墙规则失败: %w", ruleErr))
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
			s.writePVEError(w, err)
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
			s.writePVEError(w, err)
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
			s.writePVEError(w, err)
			return
		}
		err = cl.CreateFirewallRule(r.Context(), scopePath, params)
		s.recordAudit(r, id, urn, "firewall.rule.create", fmt.Sprintf("%s %s %s", strings.TrimSpace(req.Type), strings.TrimSpace(req.Action), strings.TrimSpace(req.DPort)), "", err)
		if err != nil {
			s.writePVEError(w, err)
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
			s.writePVEError(w, err)
			return
		}
		err = cl.UpdateFirewallRule(r.Context(), scopePath, pos, params)
		s.recordAudit(r, id, urn, "firewall.rule.update", fmt.Sprintf("pos=%d", pos), "", err)
		if err != nil {
			s.writePVEError(w, err)
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
			s.writePVEError(w, err)
			return
		}
		err = cl.DeleteFirewallRule(r.Context(), scopePath, pos, digest)
		s.recordAudit(r, id, urn, "firewall.rule.delete", fmt.Sprintf("pos=%d", pos), "", err)
		if err != nil {
			s.writePVEError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// --- HA High Availability ---

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
		s.writePVEError(w, err)
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
		s.writePVEError(w, fmt.Errorf("读取 HA 高可用状态失败: %w", statusErr))
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.DeleteHAResource(r.Context(), sid)
	s.recordAudit(r, id, fmt.Sprintf("%s:ha:%s", id, sid), "ha.resource.delete", sid, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Cluster Hardware Resource Mappings (PCI / USB / Dir) ---

func (s *Server) handleListResourceMappings(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, fmt.Errorf("读取硬件资源映射失败: %w", pciErr))
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.DeleteResourceMapping(r.Context(), kind, mappingID)
	s.recordAudit(r, id, fmt.Sprintf("%s:mapping:%s:%s", id, kind, mappingID), "mapping.delete", fmt.Sprintf("%s/%s", kind, mappingID), "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
