package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

type alertChannelDTO struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Type           string         `json:"type"`
	Enabled        bool           `json:"enabled"`
	ConfigPreview  map[string]any `json:"configPreview"`
	LastTestAt     string         `json:"lastTestAt,omitempty"`
	LastTestStatus string         `json:"lastTestStatus,omitempty"`
	LastTestError  string         `json:"lastTestError,omitempty"`
	CreatedAt      string         `json:"createdAt"`
	UpdatedAt      string         `json:"updatedAt"`
}

func (s *Server) toChannelDTO(ch store.AlertChannel) alertChannelDTO {
	var cfg service.ChannelConfig
	if raw, err := s.box.DecryptString(ch.ConfigEnc); err == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &cfg)
	}
	return alertChannelDTO{
		ID:             ch.ID,
		Name:           ch.Name,
		Type:           ch.Type,
		Enabled:        ch.Enabled,
		ConfigPreview:  service.MaskChannelConfig(ch.Type, cfg),
		LastTestAt:     ch.LastTestAt,
		LastTestStatus: ch.LastTestStatus,
		LastTestError:  ch.LastTestError,
		CreatedAt:      ch.CreatedAt,
		UpdatedAt:      ch.UpdatedAt,
	}
}

func (s *Server) handleAlertSummary(w http.ResponseWriter, r *http.Request) {
	counts, err := s.store.GetAlertSummaryCounts(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	lastEval := ""
	if s.alerts != nil {
		lastEval = s.alerts.LastEvaluatedAt()
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"activeCount":     counts.ActiveCount,
		"firingCount":     counts.FiringCount,
		"ackedCount":      counts.AckedCount,
		"criticalCount":   counts.CriticalCount,
		"warningCount":    counts.WarningCount,
		"infoCount":       counts.InfoCount,
		"rulesTotal":      counts.RulesTotal,
		"rulesEnabled":    counts.RulesEnabled,
		"channelsTotal":   counts.ChannelsTotal,
		"channelsEnabled": counts.ChannelsEnabled,
		"lastEvaluatedAt": lastEval,
	})
}

func (s *Server) handleListAlertEvents(w http.ResponseWriter, r *http.Request) {
	status := r.URL.Query().Get("status")
	severity := r.URL.Query().Get("severity")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	events, err := s.store.ListAlertEvents(r.Context(), status, severity, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": events})
}

func (s *Server) handleAckAlertEvent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "eventId")
	claims := getClaims(r)
	username := "admin"
	if claims != nil && claims.Username != "" {
		username = claims.Username
	}
	err := s.store.AckAlertEvent(r.Context(), id, username)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "告警记录不存在或已非触发状态")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:event:"+id, "alert.event.ack", id, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleResolveAlertEvent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "eventId")
	err := s.store.ResolveAlertEvent(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "告警记录不存在或已解决")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:event:"+id, "alert.event.resolve", id, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAckAllAlertEvents(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	username := "admin"
	if claims != nil && claims.Username != "" {
		username = claims.Username
	}
	n, err := s.store.AckAllFiringAlerts(r.Context(), username)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:events", "alert.event.ack_all", fmt.Sprintf("count=%d", n), "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "acknowledged": n})
}

func (s *Server) handleEvaluateAlerts(w http.ResponseWriter, r *http.Request) {
	if s.alerts == nil {
		writeErr(w, http.StatusServiceUnavailable, "alert engine not initialized")
		return
	}
	force := r.URL.Query().Get("force") == "1" || r.URL.Query().Get("force") == "true"
	res, err := s.alerts.EvaluateNow(r.Context(), force)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Alert Rules ---

var validAlertMetrics = map[string]bool{
	"instance_offline": true,
	"node_offline":     true,
	"node_cpu":         true,
	"node_mem":         true,
	"storage_usage":    true,
	"guest_cpu":        true,
	"guest_mem":        true,
	"disk_health":      true,
	"disk_temp":        true,
	"cpu_temp":         true,
	"backup_uncovered": true,
}

func (s *Server) handleListAlertRules(w http.ResponseWriter, r *http.Request) {
	rules, err := s.store.ListAlertRules(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": rules})
}

type alertRuleReq struct {
	Name            string   `json:"name"`
	Enabled         *bool    `json:"enabled"`
	Severity        string   `json:"severity"`
	ScopeInstanceID string   `json:"scopeInstanceId"`
	ScopeNode       string   `json:"scopeNode"`
	Metric          string   `json:"metric"`
	Operator        string   `json:"operator"`
	Threshold       *float64 `json:"threshold"`
	DurationSec     *int     `json:"durationSec"`
	CooldownMin     *int     `json:"cooldownMin"`
	ChannelIDs      []string `json:"channelIds"`
	SilenceUntil    *string  `json:"silenceUntil"`
}

func (s *Server) handleCreateAlertRule(w http.ResponseWriter, r *http.Request) {
	var req alertRuleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "规则名称不能为空")
		return
	}
	if !validAlertMetrics[req.Metric] {
		writeErr(w, http.StatusBadRequest, "不支持的监控指标类型")
		return
	}
	sev := req.Severity
	if sev != "info" && sev != "warning" && sev != "critical" {
		sev = "warning"
	}
	op := req.Operator
	if op != "gte" && op != "lte" && op != "eq" {
		op = "gte"
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	threshold := 85.0
	if req.Threshold != nil {
		threshold = *req.Threshold
	}
	dur := 0
	if req.DurationSec != nil && *req.DurationSec >= 0 {
		dur = *req.DurationSec
	}
	cd := 30
	if req.CooldownMin != nil && *req.CooldownMin >= 1 {
		cd = *req.CooldownMin
	}
	silence := ""
	if req.SilenceUntil != nil {
		silence = strings.TrimSpace(*req.SilenceUntil)
	}

	rule := &store.AlertRule{
		ID:              ulid.Make().String(),
		Name:            req.Name,
		Enabled:         enabled,
		Severity:        sev,
		ScopeInstanceID: strings.TrimSpace(req.ScopeInstanceID),
		ScopeNode:       strings.TrimSpace(req.ScopeNode),
		Metric:          req.Metric,
		Operator:        op,
		Threshold:       threshold,
		DurationSec:     dur,
		CooldownMin:     cd,
		ChannelIDs:      req.ChannelIDs,
		SilenceUntil:    silence,
	}
	if err := s.store.CreateAlertRule(r.Context(), rule); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, rule.ScopeInstanceID, "alert:rule:"+rule.ID, "alert.rule.create", rule.Name+" ("+rule.Metric+")", "", nil)
	writeJSON(w, http.StatusCreated, rule)
}

func (s *Server) handleUpdateAlertRule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "ruleId")
	existing, err := s.store.GetAlertRule(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "告警规则不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var req alertRuleReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if strings.TrimSpace(req.Name) != "" {
		existing.Name = strings.TrimSpace(req.Name)
	}
	if req.Enabled != nil {
		existing.Enabled = *req.Enabled
	}
	if req.Severity == "info" || req.Severity == "warning" || req.Severity == "critical" {
		existing.Severity = req.Severity
	}
	if req.Metric != "" {
		if !validAlertMetrics[req.Metric] {
			writeErr(w, http.StatusBadRequest, "不支持的监控指标类型")
			return
		}
		existing.Metric = req.Metric
	}
	if req.Operator == "gte" || req.Operator == "lte" || req.Operator == "eq" {
		existing.Operator = req.Operator
	}
	if req.Threshold != nil {
		existing.Threshold = *req.Threshold
	}
	if req.DurationSec != nil && *req.DurationSec >= 0 {
		existing.DurationSec = *req.DurationSec
	}
	if req.CooldownMin != nil && *req.CooldownMin >= 1 {
		existing.CooldownMin = *req.CooldownMin
	}
	if req.ChannelIDs != nil {
		existing.ChannelIDs = req.ChannelIDs
	}
	if req.SilenceUntil != nil {
		existing.SilenceUntil = strings.TrimSpace(*req.SilenceUntil)
	}
	if req.ScopeInstanceID != "" || req.ScopeNode != "" || req.Name != "" {
		// Allow explicitly clearing scope when full edit payload is submitted
		if req.Name != "" {
			existing.ScopeInstanceID = strings.TrimSpace(req.ScopeInstanceID)
			existing.ScopeNode = strings.TrimSpace(req.ScopeNode)
		}
	}

	if err := s.store.UpdateAlertRule(r.Context(), existing); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, existing.ScopeInstanceID, "alert:rule:"+existing.ID, "alert.rule.update", existing.Name, "", nil)
	writeJSON(w, http.StatusOK, existing)
}

func (s *Server) handleDeleteAlertRule(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "ruleId")
	err := s.store.DeleteAlertRule(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "告警规则不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:rule:"+id, "alert.rule.delete", id, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Alert Notification Channels ---

var validChannelTypes = map[string]bool{
	"webhook":  true,
	"feishu":   true,
	"dingtalk": true,
	"wecom":    true,
	"telegram": true,
	"bark":     true,
}

type alertChannelReq struct {
	Name    string                `json:"name"`
	Type    string                `json:"type"`
	Enabled *bool                 `json:"enabled"`
	Config  service.ChannelConfig `json:"config"`
}

func (s *Server) handleListAlertChannels(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListAlertChannels(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]alertChannelDTO, 0, len(list))
	for _, ch := range list {
		out = append(out, s.toChannelDTO(ch))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleCreateAlertChannel(w http.ResponseWriter, r *http.Request) {
	var req alertChannelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Type = strings.ToLower(strings.TrimSpace(req.Type))
	if req.Name == "" {
		writeErr(w, http.StatusBadRequest, "通道名称不能为空")
		return
	}
	if !validChannelTypes[req.Type] {
		writeErr(w, http.StatusBadRequest, "不支持的通知通道类型")
		return
	}
	if err := validateChannelConfig(req.Type, req.Config); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	rawCfg, _ := json.Marshal(req.Config)
	enc, err := s.box.EncryptString(string(rawCfg))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "encrypt config failed")
		return
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	ch := &store.AlertChannel{
		ID:        ulid.Make().String(),
		Name:      req.Name,
		Type:      req.Type,
		ConfigEnc: enc,
		Enabled:   enabled,
	}
	if err := s.store.CreateAlertChannel(r.Context(), ch); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:channel:"+ch.ID, "alert.channel.create", ch.Name+" ("+ch.Type+")", "", nil)
	writeJSON(w, http.StatusCreated, s.toChannelDTO(*ch))
}

func (s *Server) handleUpdateAlertChannel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "channelId")
	existing, err := s.store.GetAlertChannel(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "通知通道不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	var req alertChannelReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json body")
		return
	}
	if strings.TrimSpace(req.Name) != "" {
		existing.Name = strings.TrimSpace(req.Name)
	}
	if req.Enabled != nil {
		existing.Enabled = *req.Enabled
	}
	if strings.TrimSpace(req.Type) != "" && validChannelTypes[strings.ToLower(strings.TrimSpace(req.Type))] {
		existing.Type = strings.ToLower(strings.TrimSpace(req.Type))
	}

	// Merge non-empty secret/URL updates with existing decrypted config so toggles don't wipe secrets
	var curCfg service.ChannelConfig
	if raw, decErr := s.box.DecryptString(existing.ConfigEnc); decErr == nil && raw != "" {
		_ = json.Unmarshal([]byte(raw), &curCfg)
	}
	changedCfg := false
	if strings.TrimSpace(req.Config.URL) != "" {
		curCfg.URL = strings.TrimSpace(req.Config.URL)
		changedCfg = true
	}
	if strings.TrimSpace(req.Config.Secret) != "" {
		curCfg.Secret = strings.TrimSpace(req.Config.Secret)
		changedCfg = true
	}
	if strings.TrimSpace(req.Config.BotToken) != "" {
		curCfg.BotToken = strings.TrimSpace(req.Config.BotToken)
		changedCfg = true
	}
	if strings.TrimSpace(req.Config.ChatID) != "" {
		curCfg.ChatID = strings.TrimSpace(req.Config.ChatID)
		changedCfg = true
	}
	if strings.TrimSpace(req.Config.ThreadID) != "" {
		curCfg.ThreadID = strings.TrimSpace(req.Config.ThreadID)
		changedCfg = true
	}
	if strings.TrimSpace(req.Config.DeviceKey) != "" {
		curCfg.DeviceKey = strings.TrimSpace(req.Config.DeviceKey)
		changedCfg = true
	}
	if req.Config.AtAll != curCfg.AtAll && (req.Name != "" || changedCfg) {
		curCfg.AtAll = req.Config.AtAll
		changedCfg = true
	}
	if changedCfg {
		rawCfg, _ := json.Marshal(curCfg)
		enc, encErr := s.box.EncryptString(string(rawCfg))
		if encErr != nil {
			writeErr(w, http.StatusInternalServerError, "encrypt config failed")
			return
		}
		existing.ConfigEnc = enc
	}

	if err := s.store.UpdateAlertChannel(r.Context(), existing); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:channel:"+existing.ID, "alert.channel.update", existing.Name, "", nil)
	writeJSON(w, http.StatusOK, s.toChannelDTO(*existing))
}

func (s *Server) handleDeleteAlertChannel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "channelId")
	err := s.store.DeleteAlertChannel(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "通知通道不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.recordAudit(r, "", "alert:channel:"+id, "alert.channel.delete", id, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleTestAlertChannel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "channelId")
	ch, err := s.store.GetAlertChannel(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "通知通道不存在")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	rawCfg, err := s.box.DecryptString(ch.ConfigEnc)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "解密通道配置失败")
		return
	}
	var cfg service.ChannelConfig
	if err := json.Unmarshal([]byte(rawCfg), &cfg); err != nil {
		writeErr(w, http.StatusInternalServerError, "解析通道配置失败")
		return
	}

	notice := service.AlertNotice{
		EventType:    "test",
		Severity:     "info",
		Title:        "PVE Dash 告警通道连通性测试",
		Message:      fmt.Sprintf("这是来自通道「%s」的测试通知，说明您的告警推送配置工作正常。", ch.Name),
		RuleName:     "手动连通性测试",
		ResourceName: "PVE Dash 控制平面",
		Timestamp:    time.Now().Format("2006-01-02 15:04:05"),
	}
	sendErr := service.DispatchNotification(r.Context(), ch.Type, cfg, notice)
	if sendErr != nil {
		_ = s.store.UpdateAlertChannelTestStatus(r.Context(), ch.ID, "error", sendErr.Error())
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "error": sendErr.Error()})
		return
	}
	_ = s.store.UpdateAlertChannelTestStatus(r.Context(), ch.ID, "ok", "")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func validateChannelConfig(channelType string, cfg service.ChannelConfig) error {
	switch channelType {
	case "telegram":
		if strings.TrimSpace(cfg.BotToken) == "" || strings.TrimSpace(cfg.ChatID) == "" {
			return errors.New("Telegram 通道需要填写 Bot Token 与 Chat ID")
		}
	case "bark":
		if strings.TrimSpace(cfg.URL) == "" && strings.TrimSpace(cfg.DeviceKey) == "" {
			return errors.New("Bark 通道需要填写推送 URL 或 Device Key")
		}
	default:
		if strings.TrimSpace(cfg.URL) == "" {
			return errors.New("请填写 Webhook URL")
		}
	}
	return nil
}
