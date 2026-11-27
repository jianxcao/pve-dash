package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

// --- Phase 4C: Multi-User RBAC, Session Control & Encrypted Config Backup/Restore ---

var (
	validUsernameRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{1,31}$`)
	validUserRoles     = map[string]bool{
		"admin":    true,
		"operator": true,
		"viewer":   true,
	}
)

func (s *Server) handleChangePassword(w http.ResponseWriter, r *http.Request) {
	if s.cfg.ReadOnly {
		writeErr(w, http.StatusForbidden, "server is running in read-only protection mode (PVE_DASH_READ_ONLY=true)")
		return
	}
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if len(body.NewPassword) < 8 || len(body.NewPassword) > 128 {
		writeErr(w, http.StatusBadRequest, "新密码长度须在 8–128 位之间")
		return
	}
	u, err := s.store.GetUserByID(r.Context(), claims.UserID)
	if err != nil || !u.IsActive {
		writeErr(w, http.StatusUnauthorized, "user not found")
		return
	}
	if !crypto.VerifyPassword(body.CurrentPassword, u.PasswordHash) {
		writeErr(w, http.StatusBadRequest, "当前密码不正确")
		return
	}
	newHash, err := crypto.HashPassword(body.NewPassword)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	freshUser, err := s.store.UpdateUserPassword(r.Context(), u.ID, newHash)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	// Terminate any open interactive WebSocket consoles bound to old sessions
	s.console.CloseUserSessions(u.ID)
	pair, err := s.auth.IssueTokensForUser(r.Context(), freshUser, r.UserAgent(), clientIP(r))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "密码已修改，但刷新当前会话失败，请重新登录")
		return
	}
	s.setAuthCookies(w, pair)
	s.recordAudit(r, "", "user:"+u.Username, "user.change_password", u.Username, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"accessToken": pair.AccessToken,
		"expiresIn":   pair.ExpiresIn,
	})
}

func (s *Server) handleListUsers(w http.ResponseWriter, r *http.Request) {
	items, err := s.store.ListUsers(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleCreateUser(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
		Role        string `json:"role"`
		IsActive    *bool  `json:"isActive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	username := strings.TrimSpace(body.Username)
	if !validUsernameRegex.MatchString(username) || strings.Contains(username, "..") {
		writeErr(w, http.StatusBadRequest, "用户名须为 2–32 位字母/数字/点/下划线/连字符，且以字母或数字开头")
		return
	}
	if len(body.Password) < 8 || len(body.Password) > 128 {
		writeErr(w, http.StatusBadRequest, "初始密码长度须在 8–128 位之间")
		return
	}
	role := strings.ToLower(strings.TrimSpace(body.Role))
	if role == "" {
		role = "viewer"
	}
	if !validUserRoles[role] {
		writeErr(w, http.StatusBadRequest, "角色必须为 admin、operator 或 viewer")
		return
	}
	displayName := strings.TrimSpace(body.DisplayName)
	if displayName == "" {
		displayName = username
	}
	if hasControlChars(displayName) {
		writeErr(w, http.StatusBadRequest, "显示名称不能包含控制字符")
		return
	}
	isActive := true
	if body.IsActive != nil {
		isActive = *body.IsActive
	}

	hash, err := crypto.HashPassword(body.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to hash password")
		return
	}
	u := &store.User{
		ID:           ulid.Make().String(),
		Username:     username,
		DisplayName:  displayName,
		PasswordHash: hash,
		Role:         role,
		IsActive:     isActive,
	}
	if err := s.store.CreateUserUnique(r.Context(), u); err != nil {
		if errors.Is(err, store.ErrDuplicateUsername) {
			writeErr(w, http.StatusConflict, fmt.Sprintf("用户名 %q 已存在", username))
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "user:"+u.Username, "user.create", fmt.Sprintf("%s role=%s", u.Username, u.Role), "", nil)
	writeJSON(w, http.StatusCreated, u)
}

func (s *Server) handleUpdateUser(w http.ResponseWriter, r *http.Request) {
	targetID := chi.URLParam(r, "userId")
	claims := getClaims(r)

	existing, err := s.store.GetUserByID(r.Context(), targetID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "用户不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	var body struct {
		DisplayName *string `json:"displayName"`
		Role        *string `json:"role"`
		IsActive    *bool   `json:"isActive"`
		Password    *string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	displayName := existing.DisplayName
	if body.DisplayName != nil {
		dn := strings.TrimSpace(*body.DisplayName)
		if dn == "" || hasControlChars(dn) {
			writeErr(w, http.StatusBadRequest, "显示名称无效")
			return
		}
		displayName = dn
	}
	role := existing.Role
	if body.Role != nil {
		rVal := strings.ToLower(strings.TrimSpace(*body.Role))
		if !validUserRoles[rVal] {
			writeErr(w, http.StatusBadRequest, "角色必须为 admin、operator 或 viewer")
			return
		}
		role = rVal
	}
	isActive := existing.IsActive
	if body.IsActive != nil {
		isActive = *body.IsActive
	}
	if claims != nil && claims.UserID == targetID {
		if role != "admin" || !isActive {
			writeErr(w, http.StatusBadRequest, "不能降级或停用当前正在登录的管理员账号")
			return
		}
		if body.Password != nil && *body.Password != "" {
			writeErr(w, http.StatusBadRequest, "修改本人密码请使用“修改当前账号密码”表单（需验证原密码）")
			return
		}
	}

	var newPassHash string
	if body.Password != nil && *body.Password != "" {
		if len(*body.Password) < 8 || len(*body.Password) > 128 {
			writeErr(w, http.StatusBadRequest, "重置密码长度须在 8–128 位之间")
			return
		}
		h, err := crypto.HashPassword(*body.Password)
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "failed to hash password")
			return
		}
		newPassHash = h
	}

	updated, err := s.store.UpdateUser(r.Context(), targetID, displayName, role, isActive, newPassHash)
	if errors.Is(err, store.ErrLastAdmin) {
		writeErr(w, http.StatusBadRequest, "系统至少需要保留一名活跃的管理员账号")
		return
	}
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "用户不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	if !updated.IsActive || newPassHash != "" || updated.Role == "viewer" {
		s.console.CloseUserSessions(targetID)
	}

	summary := fmt.Sprintf("%s role=%s active=%v", updated.Username, updated.Role, updated.IsActive)
	if newPassHash != "" {
		summary += " passwordReset=true"
	}
	s.recordAudit(r, "", "user:"+updated.Username, "user.update", summary, "", nil)
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) handleDeleteUser(w http.ResponseWriter, r *http.Request) {
	targetID := chi.URLParam(r, "userId")
	claims := getClaims(r)
	if claims != nil && claims.UserID == targetID {
		writeErr(w, http.StatusBadRequest, "不能删除当前正在登录的账号")
		return
	}
	target, err := s.store.GetUserByID(r.Context(), targetID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "用户不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != target.Username {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	err = s.store.DeleteUser(r.Context(), targetID)
	if errors.Is(err, store.ErrLastAdmin) {
		writeErr(w, http.StatusBadRequest, "系统至少需要保留一名活跃的管理员账号")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.console.CloseUserSessions(targetID)
	s.recordAudit(r, "", "user:"+target.Username, "user.delete", target.Username, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRevokeUserSessions(w http.ResponseWriter, r *http.Request) {
	targetID := chi.URLParam(r, "userId")
	if claims := getClaims(r); claims != nil && claims.UserID == targetID {
		writeErr(w, http.StatusBadRequest, "不能强制吊销当前正在登录的管理员自身会话，请使用退出登录或修改密码")
		return
	}
	target, err := s.store.GetUserByID(r.Context(), targetID)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "用户不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	removed, err := s.store.RevokeUserSessions(r.Context(), targetID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.console.CloseUserSessions(targetID)
	s.recordAudit(r, "", "user:"+target.Username, "user.revoke_sessions", fmt.Sprintf("%s sessions=%d", target.Username, removed), "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "revokedSessions": removed})
}

// --- Encrypted Config Export & Import ---

type portableEndpoint struct {
	NodeName        string `json:"nodeName"`
	URL             string `json:"url"`
	Priority        int    `json:"priority"`
	CertFingerprint string `json:"certFingerprint,omitempty"`
}

type portableInstance struct {
	Name           string             `json:"name"`
	GroupName      string             `json:"groupName"`
	Color          string             `json:"color"`
	AuthMode       string             `json:"authMode"`
	TokenID        string             `json:"tokenId,omitempty"`
	TokenSecret    string             `json:"tokenSecret,omitempty"`
	TicketUsername string             `json:"ticketUsername,omitempty"`
	TicketPassword string             `json:"ticketPassword,omitempty"`
	TLSMode        string             `json:"tlsMode"`
	CACertPEM      string             `json:"caCertPem,omitempty"`
	SSHHost        string             `json:"sshHost,omitempty"`
	Enabled        bool               `json:"enabled"`
	Endpoints      []portableEndpoint `json:"endpoints"`
}

type portableChannel struct {
	Name    string                `json:"name"`
	Type    string                `json:"type"`
	Enabled bool                  `json:"enabled"`
	Config  service.ChannelConfig `json:"config"`
}

type portableRule struct {
	Name              string   `json:"name"`
	Enabled           bool     `json:"enabled"`
	Severity          string   `json:"severity"`
	ScopeInstanceName string   `json:"scopeInstanceName,omitempty"`
	ScopeNode         string   `json:"scopeNode,omitempty"`
	Metric            string   `json:"metric"`
	Operator          string   `json:"operator"`
	Threshold         float64  `json:"threshold"`
	DurationSec       int      `json:"durationSec"`
	CooldownMin       int      `json:"cooldownMin"`
	ChannelNames      []string `json:"channelNames"`
	SilenceUntil      string   `json:"silenceUntil,omitempty"`
}

type portableConfigPayload struct {
	ExportedAt string             `json:"exportedAt"`
	Instances  []portableInstance `json:"instances"`
	Channels   []portableChannel  `json:"channels"`
	AlertRules []portableRule     `json:"alertRules"`
}

func (s *Server) handleExportConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Passphrase string `json:"passphrase"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if len(body.Passphrase) < 8 || len(body.Passphrase) > 128 {
		writeErr(w, http.StatusBadRequest, "备份加密口令长度须在 8–128 位之间")
		return
	}

	instances, err := s.store.ListInstances(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	channels, err := s.store.ListAlertChannels(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	rules, err := s.store.ListAlertRules(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	instIDToName := map[string]string{}
	pInstances := make([]portableInstance, 0, len(instances))
	for _, inst := range instances {
		instIDToName[inst.ID] = inst.Name
		var tokSec, tikPass string
		if len(inst.TokenSecretEnc) > 0 {
			var decErr error
			tokSec, decErr = s.box.DecryptString(inst.TokenSecretEnc)
			if decErr != nil {
				writeErr(w, http.StatusInternalServerError, fmt.Sprintf("解密实例 %q 的 Token Secret 失败（请检查 Master Key 是否一致）", inst.Name))
				return
			}
		}
		if len(inst.TicketPasswordEnc) > 0 {
			var decErr error
			tikPass, decErr = s.box.DecryptString(inst.TicketPasswordEnc)
			if decErr != nil {
				writeErr(w, http.StatusInternalServerError, fmt.Sprintf("解密实例 %q 的 Ticket 密码失败（请检查 Master Key 是否一致）", inst.Name))
				return
			}
		}
		eps := make([]portableEndpoint, 0, len(inst.Endpoints))
		for _, ep := range inst.Endpoints {
			eps = append(eps, portableEndpoint{
				NodeName:        ep.NodeName,
				URL:             ep.URL,
				Priority:        ep.Priority,
				CertFingerprint: ep.CertFingerprint,
			})
		}
		pInstances = append(pInstances, portableInstance{
			Name:           inst.Name,
			GroupName:      inst.GroupName,
			Color:          inst.Color,
			AuthMode:       inst.AuthMode,
			TokenID:        inst.TokenID,
			TokenSecret:    tokSec,
			TicketUsername: inst.TicketUsername,
			TicketPassword: tikPass,
			TLSMode:        inst.TLSMode,
			CACertPEM:      inst.CACertPEM,
			SSHHost:        inst.SSHHost,
			Enabled:        inst.Enabled,
			Endpoints:      eps,
		})
	}

	chanIDToName := map[string]string{}
	pChannels := make([]portableChannel, 0, len(channels))
	for _, ch := range channels {
		chanIDToName[ch.ID] = ch.Name
		var cfg service.ChannelConfig
		if len(ch.ConfigEnc) > 0 {
			raw, decErr := s.box.DecryptString(ch.ConfigEnc)
			if decErr != nil {
				writeErr(w, http.StatusInternalServerError, fmt.Sprintf("解密告警通道 %q 配置失败（请检查 Master Key 是否一致）", ch.Name))
				return
			}
			if raw != "" {
				if uErr := json.Unmarshal([]byte(raw), &cfg); uErr != nil {
					writeErr(w, http.StatusInternalServerError, fmt.Sprintf("解析告警通道 %q 配置失败: %v", ch.Name, uErr))
					return
				}
			}
		}
		pChannels = append(pChannels, portableChannel{
			Name:    ch.Name,
			Type:    ch.Type,
			Enabled: ch.Enabled,
			Config:  cfg,
		})
	}

	pRules := make([]portableRule, 0, len(rules))
	for _, rl := range rules {
		cNames := make([]string, 0, len(rl.ChannelIDs))
		for _, cid := range rl.ChannelIDs {
			if name, ok := chanIDToName[cid]; ok {
				cNames = append(cNames, name)
			}
		}
		pRules = append(pRules, portableRule{
			Name:              rl.Name,
			Enabled:           rl.Enabled,
			Severity:          rl.Severity,
			ScopeInstanceName: instIDToName[rl.ScopeInstanceID],
			ScopeNode:         rl.ScopeNode,
			Metric:            rl.Metric,
			Operator:          rl.Operator,
			Threshold:         rl.Threshold,
			DurationSec:       rl.DurationSec,
			CooldownMin:       rl.CooldownMin,
			ChannelNames:      cNames,
			SilenceUntil:      rl.SilenceUntil,
		})
	}

	payload := portableConfigPayload{
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
		Instances:  pInstances,
		Channels:   pChannels,
		AlertRules: pRules,
	}
	rawJSON, err := json.Marshal(payload)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	bundle, err := crypto.EncryptBundleWithPassphrase(rawJSON, body.Passphrase)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.recordAudit(r, "", "system:config", "config.export",
		fmt.Sprintf("instances=%d channels=%d rules=%d", len(pInstances), len(pChannels), len(pRules)), "", nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"bundle": bundle,
		"summary": map[string]int{
			"instances":  len(pInstances),
			"channels":   len(pChannels),
			"alertRules": len(pRules),
		},
	})
}

func (s *Server) handleImportConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Bundle     *crypto.EncryptedBundle `json:"bundle"`
		Passphrase string                  `json:"passphrase"`
		DryRun     bool                    `json:"dryRun"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if !body.DryRun && s.cfg.ReadOnly {
		writeErr(w, http.StatusForbidden, "server is running in read-only protection mode (PVE_DASH_READ_ONLY=true)")
		return
	}
	plain, err := crypto.DecryptBundleWithPassphrase(body.Bundle, body.Passphrase)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var payload portableConfigPayload
	if err := json.Unmarshal(plain, &payload); err != nil {
		writeErr(w, http.StatusBadRequest, "解密后的配置格式无效")
		return
	}

	existingInsts, err := s.store.ListInstances(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	existingChans, err := s.store.ListAlertChannels(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	existingRules, err := s.store.ListAlertRules(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}

	instNameToID := map[string]string{}
	for _, inst := range existingInsts {
		instNameToID[inst.Name] = inst.ID
	}
	chanNameToID := map[string]string{}
	for _, ch := range existingChans {
		chanNameToID[ch.Name] = ch.ID
	}
	existingRuleNames := map[string]bool{}
	for _, rl := range existingRules {
		existingRuleNames[rl.Name] = true
	}

	// Pre-validate EVERY new item before writing anything (atomic validation)
	var (
		toAddInstances []*store.PVEInstance
		toAddChannels  []*store.AlertChannel
		toAddRules     []*store.AlertRule
		instAddNames   = []string{}
		instSkipNames  = []string{}
		chanAddNames   = []string{}
		chanSkipNames  = []string{}
		ruleAddNames   = []string{}
		ruleSkipNames  = []string{}
	)

	seenNewInst := map[string]bool{}
	for _, pi := range payload.Instances {
		name := strings.TrimSpace(pi.Name)
		if name == "" {
			writeErr(w, http.StatusBadRequest, "备份中包含空名称的 PVE 实例")
			return
		}
		if _, exists := instNameToID[name]; exists || seenNewInst[name] {
			instSkipNames = append(instSkipNames, name)
			continue
		}
		en := pi.Enabled
		ip := &instancePayload{
			Name:           name,
			GroupName:      pi.GroupName,
			Color:          pi.Color,
			AuthMode:       pi.AuthMode,
			TokenID:        pi.TokenID,
			TokenSecret:    pi.TokenSecret,
			TicketUsername: pi.TicketUsername,
			TicketPassword: pi.TicketPassword,
			TLSMode:        pi.TLSMode,
			CACertPEM:      pi.CACertPEM,
			SSHHost:        pi.SSHHost,
			Enabled:        &en,
		}
		for _, ep := range pi.Endpoints {
			ip.Endpoints = append(ip.Endpoints, struct {
				ID              string `json:"id"`
				NodeName        string `json:"nodeName"`
				URL             string `json:"url"`
				Priority        int    `json:"priority"`
				CertFingerprint string `json:"certFingerprint"`
			}{
				NodeName:        ep.NodeName,
				URL:             ep.URL,
				Priority:        ep.Priority,
				CertFingerprint: ep.CertFingerprint,
			})
		}
		model, err := s.buildInstanceModel(nil, ip)
		if err != nil {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("实例 %q 校验失败: %v", name, err))
			return
		}
		seenNewInst[name] = true
		instNameToID[name] = model.ID
		toAddInstances = append(toAddInstances, model)
		instAddNames = append(instAddNames, name)
	}

	seenNewChan := map[string]bool{}
	for _, pc := range payload.Channels {
		name := strings.TrimSpace(pc.Name)
		chType := strings.ToLower(strings.TrimSpace(pc.Type))
		if name == "" || !validChannelTypes[chType] {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("告警通道 %q 类型无效", name))
			return
		}
		if _, exists := chanNameToID[name]; exists || seenNewChan[name] {
			chanSkipNames = append(chanSkipNames, name)
			continue
		}
		if err := validateChannelConfig(chType, pc.Config); err != nil {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("告警通道 %q 校验失败: %v", name, err))
			return
		}
		rawCfg, _ := json.Marshal(pc.Config)
		enc, err := s.box.EncryptString(string(rawCfg))
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "加密告警通道配置失败")
			return
		}
		ch := &store.AlertChannel{
			ID:        ulid.Make().String(),
			Name:      name,
			Type:      chType,
			ConfigEnc: enc,
			Enabled:   pc.Enabled,
		}
		seenNewChan[name] = true
		chanNameToID[name] = ch.ID
		toAddChannels = append(toAddChannels, ch)
		chanAddNames = append(chanAddNames, name)
	}

	seenNewRule := map[string]bool{}
	for _, pr := range payload.AlertRules {
		name := strings.TrimSpace(pr.Name)
		if name == "" || !validAlertMetrics[pr.Metric] {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("告警规则 %q 指标类型无效", name))
			return
		}
		if existingRuleNames[name] || seenNewRule[name] {
			ruleSkipNames = append(ruleSkipNames, name)
			continue
		}
		sev := pr.Severity
		if sev != "info" && sev != "warning" && sev != "critical" {
			sev = "warning"
		}
		op := pr.Operator
		if op != "gte" && op != "lte" && op != "eq" {
			op = "gte"
		}
		threshold := pr.Threshold
		if pr.Metric == "node_offline" || pr.Metric == "instance_offline" {
			op = "gte"
			threshold = 1
		}
		cooldown := pr.CooldownMin
		if cooldown < 1 {
			cooldown = 30
		}
		dur := pr.DurationSec
		if dur < 0 {
			dur = 0
		}
		scopeInstID := ""
		if scopeName := strings.TrimSpace(pr.ScopeInstanceName); scopeName != "" {
			resolvedID, ok := instNameToID[scopeName]
			if !ok {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("告警规则 %q 引用的实例 %q 不存在且不在备份中，已阻止以防扩大作用域", name, scopeName))
				return
			}
			scopeInstID = resolvedID
		}
		chIDs := []string{}
		for _, cn := range pr.ChannelNames {
			cleanCN := strings.TrimSpace(cn)
			if cleanCN == "" {
				continue
			}
			cid, ok := chanNameToID[cleanCN]
			if !ok {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("告警规则 %q 引用的告警通道 %q 不存在且不在备份中，已阻止以防误广播", name, cleanCN))
				return
			}
			chIDs = append(chIDs, cid)
		}
		rl := &store.AlertRule{
			ID:              ulid.Make().String(),
			Name:            name,
			Enabled:         pr.Enabled,
			Severity:        sev,
			ScopeInstanceID: scopeInstID,
			ScopeNode:       strings.TrimSpace(pr.ScopeNode),
			Metric:          pr.Metric,
			Operator:        op,
			Threshold:       threshold,
			DurationSec:     dur,
			CooldownMin:     cooldown,
			ChannelIDs:      chIDs,
			SilenceUntil:    strings.TrimSpace(pr.SilenceUntil),
		}
		seenNewRule[name] = true
		toAddRules = append(toAddRules, rl)
		ruleAddNames = append(ruleAddNames, name)
	}

	preview := map[string]any{
		"dryRun":        body.DryRun,
		"exportedAt":    payload.ExportedAt,
		"instancesAdd":  instAddNames,
		"instancesSkip": instSkipNames,
		"channelsAdd":   chanAddNames,
		"channelsSkip":  chanSkipNames,
		"rulesAdd":      ruleAddNames,
		"rulesSkip":     ruleSkipNames,
	}
	if body.DryRun {
		writeJSON(w, http.StatusOK, preview)
		return
	}

	if err := s.store.ImportConfigBatch(r.Context(), toAddInstances, toAddChannels, toAddRules); err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("原子写入导入配置失败: %v", err))
		return
	}
	for _, inst := range toAddInstances {
		if s.pool != nil {
			s.pool.Invalidate(inst.ID)
		}
	}
	if len(toAddInstances) > 0 && s.agg != nil {
		s.agg.InvalidateCache()
	}

	s.recordAudit(r, "", "system:config", "config.import",
		fmt.Sprintf("added instances=%d channels=%d rules=%d", len(toAddInstances), len(toAddChannels), len(toAddRules)), "", nil)
	preview["ok"] = true
	writeJSON(w, http.StatusOK, preview)
}
