package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

type AlertEngine struct {
	store *store.Store
	box   *crypto.Box
	pool  *pve.Pool
	agg   *AggregatorService

	mu              sync.Mutex
	firstBreach     map[string]time.Time
	lastEvaluatedAt time.Time
	evaluating      bool

	// Cached slower probes (hardware SMART/temps & backup coverage)
	hwCache     map[string]cachedHW
	backupCache map[string]cachedBackupAudit
}

type cachedHW struct {
	data      *pve.NodeHardwareReport
	fetchedAt time.Time
}

type cachedBackupAudit struct {
	count     int
	names     []string
	fetchedAt time.Time
}

type metricSample struct {
	fingerprint  string
	instanceID   string
	instanceName string
	resourceType string
	resourceID   string
	resourceName string
	value        float64
	unit         string
	detail       string
}

func NewAlertEngine(st *store.Store, box *crypto.Box, pool *pve.Pool, agg *AggregatorService) *AlertEngine {
	return &AlertEngine{
		store:       st,
		box:         box,
		pool:        pool,
		agg:         agg,
		firstBreach: make(map[string]time.Time),
		hwCache:     make(map[string]cachedHW),
		backupCache: make(map[string]cachedBackupAudit),
	}
}

func (e *AlertEngine) Start(ctx context.Context) {
	go func() {
		// Short initial delay so server finishes booting before first poll
		select {
		case <-ctx.Done():
			return
		case <-time.After(4 * time.Second):
		}
		_, _ = e.EvaluateNow(ctx, false)

		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = e.EvaluateNow(ctx, false)
			}
		}
	}()
}

func (e *AlertEngine) LastEvaluatedAt() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.lastEvaluatedAt.IsZero() {
		return ""
	}
	return e.lastEvaluatedAt.UTC().Format(time.RFC3339)
}

type EvaluationResult struct {
	EvaluatedRules int    `json:"evaluatedRules"`
	ActiveAlerts   int    `json:"activeAlerts"`
	NewlyFired     int    `json:"newlyFired"`
	AutoResolved   int    `json:"autoResolved"`
	EvaluatedAt    string `json:"evaluatedAt"`
}

func (e *AlertEngine) EvaluateNow(ctx context.Context, forceSlowProbes bool) (*EvaluationResult, error) {
	e.mu.Lock()
	if e.evaluating {
		e.mu.Unlock()
		counts, _ := e.store.GetAlertSummaryCounts(ctx)
		active := 0
		if counts != nil {
			active = counts.ActiveCount
		}
		return &EvaluationResult{ActiveAlerts: active, EvaluatedAt: e.LastEvaluatedAt()}, nil
	}
	e.evaluating = true
	e.mu.Unlock()

	defer func() {
		e.mu.Lock()
		e.evaluating = false
		e.lastEvaluatedAt = time.Now()
		e.mu.Unlock()
	}()

	evalCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	rules, err := e.store.ListAlertRules(evalCtx)
	if err != nil {
		return nil, err
	}

	ov, err := e.agg.GetOverview(evalCtx, false)
	if err != nil {
		return nil, err
	}

	channels, _ := e.store.ListAlertChannels(evalCtx)
	channelByID := make(map[string]store.AlertChannel, len(channels))
	enabledChannels := make([]store.AlertChannel, 0, len(channels))
	for _, c := range channels {
		channelByID[c.ID] = c
		if c.Enabled {
			enabledChannels = append(enabledChannels, c)
		}
	}

	// Determine whether slower probes are needed by any enabled rule
	needHardware := false
	needBackup := false
	enabledRules := make([]store.AlertRule, 0, len(rules))
	for _, r := range rules {
		if !r.Enabled {
			continue
		}
		enabledRules = append(enabledRules, r)
		if r.Metric == "disk_health" || r.Metric == "disk_temp" || r.Metric == "cpu_temp" {
			needHardware = true
		}
		if r.Metric == "backup_uncovered" {
			needBackup = true
		}
	}

	hwReports := map[string]*pve.NodeHardwareReport{}
	if needHardware {
		hwReports = e.fetchHardwareReports(evalCtx, ov, forceSlowProbes)
	}
	backupAudits := map[string]cachedBackupAudit{}
	if needBackup {
		backupAudits = e.fetchBackupAudits(evalCtx, ov, forceSlowProbes)
	}

	now := time.Now()
	nowRFC := now.UTC().Format(time.RFC3339)
	breachingFPs := map[string]bool{}
	newlyFired := 0

	for _, rule := range enabledRules {
		samples := buildSamplesForRule(rule, ov, hwReports, backupAudits)
		for _, smp := range samples {
			if !matchesCondition(smp.value, rule.Operator, rule.Threshold) {
				e.clearBreachStart(smp.fingerprint)
				continue
			}

			breachingFPs[smp.fingerprint] = true
			firstAt := e.markBreachStart(smp.fingerprint, now)
			if rule.DurationSec > 0 && now.Sub(firstAt) < time.Duration(rule.DurationSec)*time.Second {
				continue
			}

			existing, err := e.store.GetActiveAlertByFingerprint(evalCtx, smp.fingerprint)
			if err != nil && err != store.ErrNotFound {
				continue
			}

			msg := formatAlertMessage(rule, smp)
			if existing == nil {
				ev := &store.AlertEvent{
					ID:           ulid.Make().String(),
					RuleID:       rule.ID,
					RuleName:     rule.Name,
					Fingerprint:  smp.fingerprint,
					Severity:     rule.Severity,
					Status:       "firing",
					InstanceID:   smp.instanceID,
					InstanceName: smp.instanceName,
					ResourceType: smp.resourceType,
					ResourceID:   smp.resourceID,
					ResourceName: smp.resourceName,
					Metric:       rule.Metric,
					CurrentValue: round1(smp.value),
					Threshold:    rule.Threshold,
					Unit:         smp.unit,
					Message:      msg,
					FiredAt:      nowRFC,
					LastSeenAt:   nowRFC,
				}
				if err := e.store.InsertAlertEvent(evalCtx, ev); err == nil {
					newlyFired++
					e.maybeNotify(evalCtx, rule, ev, "firing", channelByID, enabledChannels)
				}
			} else {
				_ = e.store.UpdateAlertEventHeartbeat(evalCtx, existing.ID, round1(smp.value), rule.Threshold, rule.Severity, rule.Name, msg, nowRFC)
				existing.CurrentValue = round1(smp.value)
				existing.Message = msg
				if existing.Status == "firing" && shouldRenotify(existing, rule, now) {
					e.maybeNotify(evalCtx, rule, existing, "firing", channelByID, enabledChannels)
				}
			}
		}
	}

	// Auto-resolve any previously active events whose condition is no longer breaching (or rule disabled)
	activeEvents, _ := e.store.ListActiveAlertEvents(evalCtx)
	ruleByID := make(map[string]store.AlertRule, len(rules))
	for _, r := range rules {
		ruleByID[r.ID] = r
	}
	autoResolved := 0
	for _, ev := range activeEvents {
		r, exists := ruleByID[ev.RuleID]
		if !exists || !r.Enabled || !breachingFPs[ev.Fingerprint] {
			if err := e.store.ResolveAlertEvent(evalCtx, ev.ID); err == nil {
				autoResolved++
				e.clearBreachStart(ev.Fingerprint)
				if exists && r.Enabled && ev.NotifyCount > 0 {
					e.maybeNotify(evalCtx, r, &ev, "resolved", channelByID, enabledChannels)
				}
			}
		}
	}

	counts, _ := e.store.GetAlertSummaryCounts(evalCtx)
	activeCount := 0
	if counts != nil {
		activeCount = counts.ActiveCount
	}
	return &EvaluationResult{
		EvaluatedRules: len(enabledRules),
		ActiveAlerts:   activeCount,
		NewlyFired:     newlyFired,
		AutoResolved:   autoResolved,
		EvaluatedAt:    nowRFC,
	}, nil
}

func (e *AlertEngine) markBreachStart(fp string, now time.Time) time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	if t, ok := e.firstBreach[fp]; ok {
		return t
	}
	e.firstBreach[fp] = now
	return now
}

func (e *AlertEngine) clearBreachStart(fp string) {
	e.mu.Lock()
	delete(e.firstBreach, fp)
	e.mu.Unlock()
}

func (e *AlertEngine) fetchHardwareReports(ctx context.Context, ov *GlobalOverview, force bool) map[string]*pve.NodeHardwareReport {
	out := map[string]*pve.NodeHardwareReport{}

	for _, n := range ov.Nodes {
		if n.Status != "online" {
			continue
		}
		key := n.InstanceID + ":" + n.Node
		if !force {
			e.mu.Lock()
			cached, ok := e.hwCache[key]
			e.mu.Unlock()
			if ok && time.Since(cached.fetchedAt) < 5*time.Minute {
				out[key] = cached.data
				continue
			}
		}
		client, inst, err := e.pool.Get(ctx, n.InstanceID)
		if err != nil {
			continue
		}
		hwCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
		report, err := pve.CollectNodeHardware(hwCtx, client, n.InstanceID, n.Node, inst.SSHHost, force)
		cancel()
		if err != nil || report == nil {
			continue
		}
		e.mu.Lock()
		e.hwCache[key] = cachedHW{data: report, fetchedAt: time.Now()}
		e.mu.Unlock()
		out[key] = report
	}
	return out
}

func (e *AlertEngine) fetchBackupAudits(ctx context.Context, ov *GlobalOverview, force bool) map[string]cachedBackupAudit {
	out := map[string]cachedBackupAudit{}
	for _, inst := range ov.Instances {
		if inst.State != "online" {
			continue
		}
		if !force {
			e.mu.Lock()
			cached, ok := e.backupCache[inst.ID]
			e.mu.Unlock()
			if ok && time.Since(cached.fetchedAt) < 5*time.Minute {
				out[inst.ID] = cached
				continue
			}
		}
		client, _, err := e.pool.Get(ctx, inst.ID)
		if err != nil {
			continue
		}
		bCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
		guests, err := client.GetNotBackedUpGuests(bCtx)
		cancel()
		if err != nil {
			continue
		}
		names := make([]string, 0, len(guests))
		for _, g := range guests {
			if g.Name != "" {
				names = append(names, fmt.Sprintf("#%d %s", int(g.VMID), g.Name))
			} else {
				names = append(names, fmt.Sprintf("#%d", int(g.VMID)))
			}
		}
		entry := cachedBackupAudit{count: len(guests), names: names, fetchedAt: time.Now()}
		e.mu.Lock()
		e.backupCache[inst.ID] = entry
		e.mu.Unlock()
		out[inst.ID] = entry
	}
	return out
}

func buildSamplesForRule(
	rule store.AlertRule,
	ov *GlobalOverview,
	hwReports map[string]*pve.NodeHardwareReport,
	backupAudits map[string]cachedBackupAudit,
) []metricSample {
	var out []metricSample

	matchInst := func(id string) bool {
		return rule.ScopeInstanceID == "" || rule.ScopeInstanceID == id
	}
	matchNode := func(node string) bool {
		return rule.ScopeNode == "" || rule.ScopeNode == node
	}

	switch rule.Metric {
	case "instance_offline":
		for _, inst := range ov.Instances {
			if !inst.Enabled || !matchInst(inst.ID) {
				continue
			}
			val := 0.0
			if inst.State != "online" {
				val = 1.0
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:inst:%s", rule.ID, inst.ID),
				instanceID:   inst.ID,
				instanceName: inst.Name,
				resourceType: "instance",
				resourceID:   inst.ID,
				resourceName: inst.Name,
				value:        val,
				detail:       inst.Error,
			})
		}
	case "node_offline":
		for _, n := range ov.Nodes {
			if !matchInst(n.InstanceID) || !matchNode(n.Node) {
				continue
			}
			val := 0.0
			if n.Status != "online" {
				val = 1.0
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:node:%s:%s", rule.ID, n.InstanceID, n.Node),
				instanceID:   n.InstanceID,
				instanceName: n.InstanceName,
				resourceType: "node",
				resourceID:   n.Node,
				resourceName: n.Node,
				value:        val,
			})
		}
	case "node_cpu":
		for _, n := range ov.Nodes {
			if n.Status != "online" || !matchInst(n.InstanceID) || !matchNode(n.Node) {
				continue
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:node:%s:%s", rule.ID, n.InstanceID, n.Node),
				instanceID:   n.InstanceID,
				instanceName: n.InstanceName,
				resourceType: "node",
				resourceID:   n.Node,
				resourceName: n.Node,
				value:        n.CPU * 100,
				unit:         "%",
			})
		}
	case "node_mem":
		for _, n := range ov.Nodes {
			if n.Status != "online" || n.MaxMem <= 0 || !matchInst(n.InstanceID) || !matchNode(n.Node) {
				continue
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:node:%s:%s", rule.ID, n.InstanceID, n.Node),
				instanceID:   n.InstanceID,
				instanceName: n.InstanceName,
				resourceType: "node",
				resourceID:   n.Node,
				resourceName: n.Node,
				value:        float64(n.Mem) * 100 / float64(n.MaxMem),
				unit:         "%",
			})
		}
	case "storage_usage":
		for _, st := range ov.Storages {
			if st.Status != "available" || st.MaxDisk <= 0 || !matchInst(st.InstanceID) || !matchNode(st.Node) {
				continue
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:storage:%s:%s:%s", rule.ID, st.InstanceID, st.Node, st.Storage),
				instanceID:   st.InstanceID,
				instanceName: st.InstanceName,
				resourceType: "storage",
				resourceID:   fmt.Sprintf("%s/%s", st.Node, st.Storage),
				resourceName: fmt.Sprintf("%s / %s", st.Node, st.Storage),
				value:        float64(st.Disk) * 100 / float64(st.MaxDisk),
				unit:         "%",
			})
		}
	case "guest_cpu":
		for _, g := range ov.Guests {
			if g.Template || g.Status != "running" || !matchInst(g.InstanceID) || !matchNode(g.Node) {
				continue
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:guest:%s:%s:%s:%d", rule.ID, g.InstanceID, g.Node, g.Type, g.VMID),
				instanceID:   g.InstanceID,
				instanceName: g.InstanceName,
				resourceType: "guest",
				resourceID:   fmt.Sprintf("%s/%s/%d", g.Node, g.Type, g.VMID),
				resourceName: fmt.Sprintf("#%d %s (%s)", g.VMID, g.Name, strings.ToUpper(g.Type)),
				value:        g.CPU * 100,
				unit:         "%",
			})
		}
	case "guest_mem":
		for _, g := range ov.Guests {
			if g.Template || g.Status != "running" || g.MaxMem <= 0 || !matchInst(g.InstanceID) || !matchNode(g.Node) {
				continue
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:guest:%s:%s:%s:%d", rule.ID, g.InstanceID, g.Node, g.Type, g.VMID),
				instanceID:   g.InstanceID,
				instanceName: g.InstanceName,
				resourceType: "guest",
				resourceID:   fmt.Sprintf("%s/%s/%d", g.Node, g.Type, g.VMID),
				resourceName: fmt.Sprintf("#%d %s (%s)", g.VMID, g.Name, strings.ToUpper(g.Type)),
				value:        float64(g.Mem) * 100 / float64(g.MaxMem),
				unit:         "%",
			})
		}
	case "disk_health":
		for _, n := range ov.Nodes {
			if !matchInst(n.InstanceID) || !matchNode(n.Node) {
				continue
			}
			rep := hwReports[n.InstanceID+":"+n.Node]
			if rep == nil {
				continue
			}
			for _, d := range rep.Disks {
				if d.HealthPct == nil {
					continue
				}
				ownerNote := "宿主机持有"
				if d.Passthrough && len(d.PassthroughGuests) > 0 {
					var gLabels []string
					for _, g := range d.PassthroughGuests {
						gLabels = append(gLabels, fmt.Sprintf("#%d %s", g.VMID, g.Name))
					}
					ownerNote = "直通至 " + strings.Join(gLabels, ", ")
				} else if d.Passthrough {
					ownerNote = "已配置直通"
				}
				reason := strings.Join(d.HealthReasons, "；")
				if reason != "" {
					ownerNote += " · " + reason
				}
				out = append(out, metricSample{
					fingerprint:  fmt.Sprintf("%s:disk:%s:%s:%s", rule.ID, n.InstanceID, n.Node, d.DevPath),
					instanceID:   n.InstanceID,
					instanceName: n.InstanceName,
					resourceType: "disk",
					resourceID:   fmt.Sprintf("%s/%s", n.Node, d.DevPath),
					resourceName: fmt.Sprintf("%s · %s (%s)", n.Node, d.DevPath, d.Model),
					value:        float64(*d.HealthPct),
					unit:         "%",
					detail:       ownerNote,
				})
			}
		}
	case "cpu_temp":
		for _, n := range ov.Nodes {
			if !matchInst(n.InstanceID) || !matchNode(n.Node) {
				continue
			}
			rep := hwReports[n.InstanceID+":"+n.Node]
			if rep == nil || rep.CPU.PackageTempC == nil {
				continue
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:cputemp:%s:%s", rule.ID, n.InstanceID, n.Node),
				instanceID:   n.InstanceID,
				instanceName: n.InstanceName,
				resourceType: "node",
				resourceID:   n.Node,
				resourceName: n.Node,
				value:        *rep.CPU.PackageTempC,
				unit:         "°C",
			})
		}
	case "disk_temp":
		for _, n := range ov.Nodes {
			if !matchInst(n.InstanceID) || !matchNode(n.Node) {
				continue
			}
			rep := hwReports[n.InstanceID+":"+n.Node]
			if rep == nil {
				continue
			}
			for _, d := range rep.Disks {
				if d.TempC == nil {
					continue
				}
				out = append(out, metricSample{
					fingerprint:  fmt.Sprintf("%s:disktemp:%s:%s:%s", rule.ID, n.InstanceID, n.Node, d.DevPath),
					instanceID:   n.InstanceID,
					instanceName: n.InstanceName,
					resourceType: "disk",
					resourceID:   fmt.Sprintf("%s/%s", n.Node, d.DevPath),
					resourceName: fmt.Sprintf("%s · %s (%s)", n.Node, d.DevPath, d.Model),
					value:        *d.TempC,
					unit:         "°C",
				})
			}
		}
	case "backup_uncovered":
		for _, inst := range ov.Instances {
			if inst.State != "online" || !matchInst(inst.ID) {
				continue
			}
			audit, ok := backupAudits[inst.ID]
			if !ok {
				continue
			}
			preview := strings.Join(audit.names, ", ")
			if len(audit.names) > 5 {
				preview = strings.Join(audit.names[:5], ", ") + fmt.Sprintf(" 等 %d 台", audit.count)
			}
			out = append(out, metricSample{
				fingerprint:  fmt.Sprintf("%s:backup:%s", rule.ID, inst.ID),
				instanceID:   inst.ID,
				instanceName: inst.Name,
				resourceType: "backup",
				resourceID:   inst.ID,
				resourceName: inst.Name,
				value:        float64(audit.count),
				unit:         "台",
				detail:       preview,
			})
		}
	}
	return out
}

func matchesCondition(val float64, op string, threshold float64) bool {
	switch op {
	case "lte":
		return val <= threshold
	case "eq":
		return math.Abs(val-threshold) < 1e-6
	default: // gte
		return val >= threshold
	}
}

func formatAlertMessage(rule store.AlertRule, smp metricSample) string {
	switch rule.Metric {
	case "instance_offline":
		if smp.detail != "" {
			return fmt.Sprintf("PVE 实例 %s 离线或 API 不可达：%s", smp.resourceName, smp.detail)
		}
		return fmt.Sprintf("PVE 实例 %s 离线或 API 不可达", smp.resourceName)
	case "node_offline":
		return fmt.Sprintf("节点 %s 状态异常（已离线）", smp.resourceName)
	case "disk_health":
		base := fmt.Sprintf("硬盘 %s 健康度降至 %.0f%%（阈值 ≤ %.0f%%）", smp.resourceName, smp.value, rule.Threshold)
		if smp.detail != "" {
			return base + " · " + smp.detail
		}
		return base
	case "disk_temp":
		return fmt.Sprintf("硬盘 %s 当前温度 %.0f°C（阈值 ≥ %.0f°C）", smp.resourceName, smp.value, rule.Threshold)
	case "backup_uncovered":
		base := fmt.Sprintf("集群 %s 有 %.0f 台 VM/LXC 未纳入定时备份计划", smp.resourceName, smp.value)
		if smp.detail != "" {
			return base + "：" + smp.detail
		}
		return base
	default:
		opSym := "≥"
		if rule.Operator == "lte" {
			opSym = "≤"
		}
		return fmt.Sprintf("%s 当前值 %.1f%s（阈值 %s %.1f%s）", smp.resourceName, smp.value, smp.unit, opSym, rule.Threshold, smp.unit)
	}
}

func shouldRenotify(ev *store.AlertEvent, rule store.AlertRule, now time.Time) bool {
	if ev.LastNotifiedAt == "" {
		return true
	}
	cooldown := rule.CooldownMin
	if cooldown <= 0 {
		cooldown = 30
	}
	last, err := time.Parse(time.RFC3339, ev.LastNotifiedAt)
	if err != nil {
		return true
	}
	return now.Sub(last) >= time.Duration(cooldown)*time.Minute
}

func isRuleSilenced(rule store.AlertRule, now time.Time) bool {
	if strings.TrimSpace(rule.SilenceUntil) == "" {
		return false
	}
	until, err := time.Parse(time.RFC3339, rule.SilenceUntil)
	if err != nil {
		return false
	}
	return now.Before(until)
}

func (e *AlertEngine) maybeNotify(
	ctx context.Context,
	rule store.AlertRule,
	ev *store.AlertEvent,
	eventType string,
	channelByID map[string]store.AlertChannel,
	enabledChannels []store.AlertChannel,
) {
	if eventType == "firing" && isRuleSilenced(rule, time.Now()) {
		return
	}
	var targets []store.AlertChannel
	if len(rule.ChannelIDs) > 0 {
		for _, id := range rule.ChannelIDs {
			if ch, ok := channelByID[id]; ok && ch.Enabled {
				targets = append(targets, ch)
			}
		}
	} else {
		targets = enabledChannels
	}
	if len(targets) == 0 {
		return
	}

	notice := AlertNotice{
		EventType:    eventType,
		Severity:     ev.Severity,
		Title:        ev.RuleName,
		Message:      ev.Message,
		RuleName:     ev.RuleName,
		InstanceName: ev.InstanceName,
		ResourceName: ev.ResourceName,
		Metric:       ev.Metric,
		CurrentValue: ev.CurrentValue,
		Threshold:    ev.Threshold,
		Unit:         ev.Unit,
		Timestamp:    time.Now().Format("2006-01-02 15:04:05"),
	}

	var errMsgs []string
	for _, ch := range targets {
		rawCfg, err := e.box.DecryptString(ch.ConfigEnc)
		if err != nil {
			errMsgs = append(errMsgs, fmt.Sprintf("%s: decrypt failed", ch.Name))
			continue
		}
		var cfg ChannelConfig
		if err := json.Unmarshal([]byte(rawCfg), &cfg); err != nil {
			errMsgs = append(errMsgs, fmt.Sprintf("%s: invalid config", ch.Name))
			continue
		}
		if err := DispatchNotification(ctx, ch.Type, cfg, notice); err != nil {
			slog.Warn("alert notification failed", "channel", ch.Name, "type", ch.Type, "err", err)
			errMsgs = append(errMsgs, fmt.Sprintf("%s: %s", ch.Name, err.Error()))
		}
	}
	_ = e.store.RecordAlertNotification(ctx, ev.ID, time.Now().UTC().Format(time.RFC3339), strings.Join(errMsgs, "; "))
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
