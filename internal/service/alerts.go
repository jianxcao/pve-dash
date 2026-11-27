package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

const defaultNotifyFailureBackoff = 2 * time.Minute

type AlertEngine struct {
	store *store.Store
	box   *crypto.Box
	pool  *pve.Pool
	agg   *AggregatorService

	mu               sync.Mutex
	firstBreach      map[string]time.Time
	lastEvaluatedAt  time.Time
	stopCtx          context.Context
	evalSF           singleflight.Group
	pendingForceSlow atomic.Bool
	wg               sync.WaitGroup

	// Async webhook dispatch state & per-(fingerprint, channelID) failure backoff
	notifySem      chan struct{}
	notifyBackoff  map[string]time.Time
	notifyInFlight map[string]bool
	failureBackoff time.Duration

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
		store:          st,
		box:            box,
		pool:           pool,
		agg:            agg,
		firstBreach:    make(map[string]time.Time),
		stopCtx:        context.Background(),
		notifySem:      make(chan struct{}, 4),
		notifyBackoff:  make(map[string]time.Time),
		notifyInFlight: make(map[string]bool),
		failureBackoff: defaultNotifyFailureBackoff,
		hwCache:        make(map[string]cachedHW),
		backupCache:    make(map[string]cachedBackupAudit),
	}
}

func (e *AlertEngine) Start(ctx context.Context) {
	e.mu.Lock()
	e.stopCtx = ctx
	e.mu.Unlock()

	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		// Short initial delay so server finishes booting before first poll
		select {
		case <-ctx.Done():
			return
		case <-time.After(4 * time.Second):
		}
		_ = e.store.PruneHistoricalRecords(ctx)
		_, _ = e.EvaluateNow(ctx, false)

		evalTicker := time.NewTicker(30 * time.Second)
		defer evalTicker.Stop()
		pruneTicker := time.NewTicker(6 * time.Hour)
		defer pruneTicker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-evalTicker.C:
				_, _ = e.EvaluateNow(ctx, false)
			case <-pruneTicker.C:
				_ = e.store.PruneHistoricalRecords(ctx)
			}
		}
	}()
}

// Wait blocks until the background alert loop and any in-flight async webhook notifications exit cleanly.
func (e *AlertEngine) Wait() {
	e.wg.Wait()
}

// ClearBreach resets sustained-duration and notification backoff tracking when an alert is manually resolved.
func (e *AlertEngine) ClearBreach(fingerprint string) {
	e.clearBreachStart(fingerprint)
	e.clearFingerprintBackoff(fingerprint)
}

// PurgeInstance evicts all cached probe/breach/backoff state for a deleted or reset instance,
// and resolves any lingering active alert events in SQLite for that instance.
func (e *AlertEngine) PurgeInstance(instanceID string) {
	if instanceID == "" {
		return
	}
	e.mu.Lock()
	for k := range e.hwCache {
		if strings.HasPrefix(k, instanceID+":") {
			delete(e.hwCache, k)
		}
	}
	delete(e.backupCache, instanceID)
	needleMid := ":" + instanceID + ":"
	needleSuffix := ":" + instanceID
	for fp := range e.firstBreach {
		if strings.Contains(fp, needleMid) || strings.HasSuffix(fp, needleSuffix) {
			delete(e.firstBreach, fp)
		}
	}
	for k := range e.notifyBackoff {
		if strings.Contains(k, needleMid) || strings.Contains(k, needleSuffix+"|") {
			delete(e.notifyBackoff, k)
		}
	}
	e.mu.Unlock()

	if e.store != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		active, err := e.store.ListActiveAlertEvents(ctx)
		if err == nil {
			for _, ev := range active {
				if ev.InstanceID == instanceID {
					_ = e.store.ResolveAlertEvent(ctx, ev.ID)
				}
			}
		}
	}
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
	if forceSlowProbes {
		e.pendingForceSlow.Store(true)
	}
	ch := e.evalSF.DoChan("eval", func() (any, error) {
		force := forceSlowProbes || e.pendingForceSlow.Swap(false)
		return e.evaluateOnce(force)
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return res.Val.(*EvaluationResult), nil
	}
}

func (e *AlertEngine) baseNotifyContext() context.Context {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.stopCtx != nil {
		return e.stopCtx
	}
	return context.Background()
}

func (e *AlertEngine) evaluateOnce(forceSlowProbes bool) (*EvaluationResult, error) {
	defer func() {
		e.mu.Lock()
		e.lastEvaluatedAt = time.Now()
		e.mu.Unlock()
	}()

	evalCtx, cancel := context.WithTimeout(e.baseNotifyContext(), 25*time.Second)
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
	observedFPs := map[string]bool{}
	breachingFPs := map[string]bool{}
	newlyFired := 0

	for _, rule := range enabledRules {
		samples := buildSamplesForRule(rule, ov, hwReports, backupAudits)
		for _, smp := range samples {
			observedFPs[smp.fingerprint] = true
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
					e.enqueueNotify(rule, ev, "firing", channelByID, enabledChannels)
				}
			} else {
				_ = e.store.UpdateAlertEventHeartbeat(evalCtx, existing.ID, round1(smp.value), rule.Threshold, rule.Severity, rule.Name, smp.resourceID, smp.resourceName, msg, nowRFC)
				existing.CurrentValue = round1(smp.value)
				existing.ResourceID = smp.resourceID
				existing.ResourceName = smp.resourceName
				existing.Message = msg
				if existing.Status == "firing" && shouldRenotify(existing, rule, now) {
					e.enqueueNotify(rule, existing, "firing", channelByID, enabledChannels)
				}
			}
		}
	}

	// Build authoritative live cluster inventory maps for zombie alert detection
	instByID := make(map[string]InstanceSnapshot, len(ov.Instances))
	for _, inst := range ov.Instances {
		instByID[inst.ID] = inst
	}
	liveNodes := make(map[string]bool, len(ov.Nodes))
	for _, n := range ov.Nodes {
		liveNodes[n.InstanceID+":"+n.Node] = true
	}
	liveGuests := make(map[string]UnifiedGuest, len(ov.Guests))
	for _, g := range ov.Guests {
		if !g.Template {
			liveGuests[fmt.Sprintf("%s:%s:%d", g.InstanceID, g.Type, g.VMID)] = g
		}
	}
	liveStorages := make(map[string]bool, len(ov.Storages))
	for _, st := range ov.Storages {
		liveStorages[fmt.Sprintf("%s:%s/%s", st.InstanceID, st.Node, st.Storage)] = true
	}
	enumeratedDiskNodes := make(map[string]bool, len(hwReports))
	liveDisks := make(map[string]bool)
	for key, rep := range hwReports {
		if rep == nil || !rep.DisksEnumerated {
			continue
		}
		enumeratedDiskNodes[key] = true
		for _, d := range rep.Disks {
			liveDisks[key+"/"+d.DevPath] = true
		}
	}

	activeEvents, _ := e.store.ListActiveAlertEvents(evalCtx)
	ruleByID := make(map[string]store.AlertRule, len(rules))
	for _, r := range rules {
		ruleByID[r.ID] = r
	}
	autoResolved := 0
	for _, ev := range activeEvents {
		r, exists := ruleByID[ev.RuleID]
		ruleInactive := !exists || !r.Enabled || r.Metric != ev.Metric ||
			(r.ScopeInstanceID != "" && r.ScopeInstanceID != ev.InstanceID) ||
			isEventOutOfRuleNodeScope(ev, r, liveGuests)
		observedHealthy := observedFPs[ev.Fingerprint] && !breachingFPs[ev.Fingerprint]
		orphanOrGone := isOrphanedActiveEvent(ev, r, instByID, liveNodes, liveGuests, liveStorages, enumeratedDiskNodes, liveDisks)

		if ruleInactive || observedHealthy || orphanOrGone {
			if err := e.store.ResolveAlertEvent(evalCtx, ev.ID); err == nil {
				autoResolved++
				e.clearBreachStart(ev.Fingerprint)
				e.clearFingerprintBackoff(ev.Fingerprint)
				if observedHealthy && !ruleInactive && ev.NotifyCount > 0 {
					evCopy := ev
					e.enqueueNotify(r, &evCopy, "resolved", channelByID, enabledChannels)
				}
			}
		}
	}

	// Evict stale breach/probe/backoff cache entries
	e.mu.Lock()
	for fp, at := range e.firstBreach {
		if !breachingFPs[fp] && time.Since(at) > 30*time.Minute {
			delete(e.firstBreach, fp)
		}
	}
	for k, until := range e.notifyBackoff {
		if now.After(until.Add(5 * time.Minute)) {
			delete(e.notifyBackoff, k)
		}
	}
	for k, v := range e.hwCache {
		if time.Since(v.fetchedAt) > 15*time.Minute {
			delete(e.hwCache, k)
		}
	}
	for k, v := range e.backupCache {
		if time.Since(v.fetchedAt) > 15*time.Minute {
			delete(e.backupCache, k)
		}
	}
	e.mu.Unlock()

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

func isEventOutOfRuleNodeScope(ev store.AlertEvent, rule store.AlertRule, liveGuests map[string]UnifiedGuest) bool {
	scopeNode := strings.TrimSpace(rule.ScopeNode)
	if scopeNode == "" {
		return false
	}
	switch ev.ResourceType {
	case "node":
		return ev.ResourceID != "" && ev.ResourceID != scopeNode
	case "storage", "disk":
		if slash := strings.IndexByte(ev.ResourceID, '/'); slash > 0 {
			return ev.ResourceID[:slash] != scopeNode
		}
	case "guest":
		if gType, vmid, ok := extractGuestIdentity(ev); ok {
			if g, gExists := liveGuests[fmt.Sprintf("%s:%s:%d", ev.InstanceID, gType, vmid)]; gExists {
				return g.Node != scopeNode
			}
		}
		if slash := strings.IndexByte(ev.ResourceID, '/'); slash > 0 {
			return ev.ResourceID[:slash] != scopeNode
		}
	}
	return false
}

func isOrphanedActiveEvent(
	ev store.AlertEvent,
	rule store.AlertRule,
	instByID map[string]InstanceSnapshot,
	liveNodes map[string]bool,
	liveGuests map[string]UnifiedGuest,
	liveStorages map[string]bool,
	enumeratedDiskNodes map[string]bool,
	liveDisks map[string]bool,
) bool {
	if ev.InstanceID == "" {
		return false
	}
	inst, exists := instByID[ev.InstanceID]
	if !exists || !inst.Enabled {
		return true
	}
	// Never resolve due to transient cluster offline state: only prune missing sub-resources when instance is online.
	if inst.State != "online" {
		return false
	}

	switch ev.ResourceType {
	case "guest":
		gType, vmid, ok := extractGuestIdentity(ev)
		if !ok {
			return true
		}
		g, gExists := liveGuests[fmt.Sprintf("%s:%s:%d", ev.InstanceID, gType, vmid)]
		if !gExists {
			return true
		}
		if (ev.Metric == "guest_cpu" || ev.Metric == "guest_mem") && g.Status != "running" {
			return true
		}
		if rule.ScopeNode != "" && g.Node != rule.ScopeNode {
			return true
		}
		// Auto-resolve legacy pre-migration fingerprints that still embedded node name
		expectedFP := fmt.Sprintf("%s:%s:guest:%s:%s:%d", ev.RuleID, ev.Metric, ev.InstanceID, gType, vmid)
		if ev.Fingerprint != expectedFP {
			return true
		}
	case "storage":
		if ev.ResourceID != "" && !liveStorages[ev.InstanceID+":"+ev.ResourceID] {
			return true
		}
	case "node":
		if ev.ResourceID != "" && !liveNodes[ev.InstanceID+":"+ev.ResourceID] {
			return true
		}
	case "disk":
		slash := strings.IndexByte(ev.ResourceID, '/')
		if slash <= 0 {
			return true
		}
		node := ev.ResourceID[:slash]
		nodeKey := ev.InstanceID + ":" + node
		if !liveNodes[nodeKey] {
			return true
		}
		// Standby HDDs remain present in rep.Disks (liveDisks == true) while physically removed disks do not.
		if enumeratedDiskNodes[nodeKey] && !liveDisks[ev.InstanceID+":"+ev.ResourceID] {
			return true
		}
	}
	return false
}

func extractGuestIdentity(ev store.AlertEvent) (string, int64, bool) {
	// ResourceID is formatted as "node/type/vmid"
	if parts := strings.Split(ev.ResourceID, "/"); len(parts) == 3 {
		if vmid, err := strconv.ParseInt(parts[2], 10, 64); err == nil && (parts[1] == "qemu" || parts[1] == "lxc") {
			return parts[1], vmid, true
		}
	}
	// Fallback to fingerprint suffix "...:type:vmid"
	fpParts := strings.Split(ev.Fingerprint, ":")
	if len(fpParts) >= 2 {
		gType := fpParts[len(fpParts)-2]
		if vmid, err := strconv.ParseInt(fpParts[len(fpParts)-1], 10, 64); err == nil && (gType == "qemu" || gType == "lxc") {
			return gType, vmid, true
		}
	}
	return "", 0, false
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

func (e *AlertEngine) clearFingerprintBackoff(fp string) {
	prefix := fp + "|"
	e.mu.Lock()
	for k := range e.notifyBackoff {
		if strings.HasPrefix(k, prefix) {
			delete(e.notifyBackoff, k)
		}
	}
	e.mu.Unlock()
}

func (e *AlertEngine) fetchHardwareReports(ctx context.Context, ov *GlobalOverview, force bool) map[string]*pve.NodeHardwareReport {
	out := map[string]*pve.NodeHardwareReport{}
	var outMu sync.Mutex
	var g errgroup.Group
	g.SetLimit(4)

	for _, n := range ov.Nodes {
		n := n
		if n.Status != "online" {
			continue
		}
		key := n.InstanceID + ":" + n.Node
		if !force {
			e.mu.Lock()
			cached, ok := e.hwCache[key]
			e.mu.Unlock()
			if ok && time.Since(cached.fetchedAt) < 5*time.Minute {
				outMu.Lock()
				out[key] = cached.data
				outMu.Unlock()
				continue
			}
		}
		g.Go(func() error {
			client, inst, err := e.pool.Get(ctx, n.InstanceID)
			if err != nil {
				return nil
			}
			hwCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
			report, err := pve.CollectNodeAlertHardware(hwCtx, client, n.InstanceID, inst.SSHHost, n.Node, force)
			cancel()
			if err != nil || report == nil {
				return nil
			}
			e.mu.Lock()
			e.hwCache[key] = cachedHW{data: report, fetchedAt: time.Now()}
			e.mu.Unlock()
			outMu.Lock()
			out[key] = report
			outMu.Unlock()
			return nil
		})
	}
	_ = g.Wait()
	return out
}

func (e *AlertEngine) fetchBackupAudits(ctx context.Context, ov *GlobalOverview, force bool) map[string]cachedBackupAudit {
	out := map[string]cachedBackupAudit{}
	var outMu sync.Mutex
	var g errgroup.Group
	g.SetLimit(4)

	for _, inst := range ov.Instances {
		inst := inst
		if inst.State != "online" {
			continue
		}
		if !force {
			e.mu.Lock()
			cached, ok := e.backupCache[inst.ID]
			e.mu.Unlock()
			if ok && time.Since(cached.fetchedAt) < 5*time.Minute {
				outMu.Lock()
				out[inst.ID] = cached
				outMu.Unlock()
				continue
			}
		}
		g.Go(func() error {
			client, _, err := e.pool.Get(ctx, inst.ID)
			if err != nil {
				return nil
			}
			bCtx, cancel := context.WithTimeout(ctx, 8*time.Second)
			guests, err := client.GetNotBackedUpGuests(bCtx)
			cancel()
			if err != nil {
				return nil
			}
			names := make([]string, 0, len(guests))
			for _, gItem := range guests {
				if gItem.Name != "" {
					names = append(names, fmt.Sprintf("#%d %s", int(gItem.VMID), gItem.Name))
				} else {
					names = append(names, fmt.Sprintf("#%d", int(gItem.VMID)))
				}
			}
			entry := cachedBackupAudit{count: len(guests), names: names, fetchedAt: time.Now()}
			e.mu.Lock()
			e.backupCache[inst.ID] = entry
			e.mu.Unlock()
			outMu.Lock()
			out[inst.ID] = entry
			outMu.Unlock()
			return nil
		})
	}
	_ = g.Wait()
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
				fingerprint:  fmt.Sprintf("%s:%s:inst:%s", rule.ID, rule.Metric, inst.ID),
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
				fingerprint:  fmt.Sprintf("%s:%s:node:%s:%s", rule.ID, rule.Metric, n.InstanceID, n.Node),
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
				fingerprint:  fmt.Sprintf("%s:%s:node:%s:%s", rule.ID, rule.Metric, n.InstanceID, n.Node),
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
				fingerprint:  fmt.Sprintf("%s:%s:node:%s:%s", rule.ID, rule.Metric, n.InstanceID, n.Node),
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
				fingerprint:  fmt.Sprintf("%s:%s:storage:%s:%s:%s", rule.ID, rule.Metric, st.InstanceID, st.Node, st.Storage),
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
				fingerprint:  fmt.Sprintf("%s:%s:guest:%s:%s:%d", rule.ID, rule.Metric, g.InstanceID, g.Type, g.VMID),
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
				fingerprint:  fmt.Sprintf("%s:%s:guest:%s:%s:%d", rule.ID, rule.Metric, g.InstanceID, g.Type, g.VMID),
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
		switch rule.Operator {
		case "lte":
			opSym = "≤"
		case "eq":
			opSym = "="
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

func (e *AlertEngine) enqueueNotify(
	rule store.AlertRule,
	ev *store.AlertEvent,
	eventType string,
	channelByID map[string]store.AlertChannel,
	enabledChannels []store.AlertChannel,
) {
	now := time.Now()
	if eventType == "firing" && isRuleSilenced(rule, now) {
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

	fp := ev.Fingerprint
	evID := ev.ID
	var ready []store.AlertChannel

	e.mu.Lock()
	for _, ch := range targets {
		bKey := fp + "|" + ch.ID
		fKey := eventType + "|" + bKey
		if e.notifyInFlight[fKey] {
			continue
		}
		if eventType == "firing" {
			if until, ok := e.notifyBackoff[bKey]; ok && now.Before(until) {
				continue
			}
		}
		e.notifyInFlight[fKey] = true
		ready = append(ready, ch)
	}
	parentCtx := e.stopCtx
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	e.mu.Unlock()

	if len(ready) == 0 {
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
		Timestamp:    now.Format("2006-01-02 15:04:05"),
	}

	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		select {
		case e.notifySem <- struct{}{}:
			defer func() { <-e.notifySem }()
		case <-parentCtx.Done():
			e.clearInFlight(eventType, fp, ready)
			return
		}
		nCtx, cancel := context.WithTimeout(parentCtx, 15*time.Second)
		defer cancel()
		e.dispatchAsyncTargets(nCtx, evID, fp, eventType, notice, ready)
	}()
}

func (e *AlertEngine) clearInFlight(eventType, fp string, channels []store.AlertChannel) {
	e.mu.Lock()
	for _, ch := range channels {
		delete(e.notifyInFlight, eventType+"|"+fp+"|"+ch.ID)
	}
	e.mu.Unlock()
}

func (e *AlertEngine) dispatchAsyncTargets(
	ctx context.Context,
	evID, fp, eventType string,
	notice AlertNotice,
	targets []store.AlertChannel,
) {
	var errMsgs []string
	anySucceeded := false

	for _, ch := range targets {
		bKey := fp + "|" + ch.ID
		fKey := eventType + "|" + bKey

		var sendErr error
		rawCfg, err := e.box.DecryptString(ch.ConfigEnc)
		if err != nil {
			sendErr = fmt.Errorf("decrypt failed")
		} else {
			var cfg ChannelConfig
			if err := json.Unmarshal([]byte(rawCfg), &cfg); err != nil {
				sendErr = fmt.Errorf("invalid config")
			} else {
				sendErr = DispatchNotification(ctx, ch.Type, cfg, notice)
			}
		}

		e.mu.Lock()
		delete(e.notifyInFlight, fKey)
		if sendErr != nil {
			if eventType == "firing" {
				backoff := e.failureBackoff
				if backoff <= 0 {
					backoff = defaultNotifyFailureBackoff
				}
				e.notifyBackoff[bKey] = time.Now().Add(backoff)
			}
		} else {
			delete(e.notifyBackoff, bKey)
		}
		e.mu.Unlock()

		if sendErr != nil {
			slog.Warn("alert notification failed", "channel", ch.Name, "type", ch.Type, "err", sendErr)
			errMsgs = append(errMsgs, fmt.Sprintf("%s: %s", ch.Name, sendErr.Error()))
		} else {
			anySucceeded = true
		}
	}

	_ = e.store.RecordAlertNotification(ctx, evID, anySucceeded, time.Now().UTC().Format(time.RFC3339), strings.Join(errMsgs, "; "))
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
