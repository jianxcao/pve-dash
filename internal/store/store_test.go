package store

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestCreateFirstAdminRaceAndAtomicRefreshConsume(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	var created atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			err := st.CreateFirstAdmin(ctx, &User{
				ID:           "u-" + string(rune('a'+idx)),
				Username:     "admin-" + string(rune('a'+idx)),
				DisplayName:  "Admin",
				PasswordHash: "hash",
				Role:         "admin",
				IsActive:     true,
			})
			if err == nil {
				created.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if created.Load() != 1 {
		t.Fatalf("expected exactly 1 admin created, got %d", created.Load())
	}

	// Find created user ID
	var uid string
	if err := st.db.QueryRow(`SELECT id FROM users LIMIT 1`).Scan(&uid); err != nil {
		t.Fatalf("query user: %v", err)
	}

	// Insert refresh session and race 6 concurrent ConsumeRefreshSession calls
	sess := &RefreshSession{
		ID:        "s1",
		UserID:    uid,
		TokenHash: "token-hash-1",
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(time.Hour),
	}
	if err := st.CreateRefreshSession(ctx, sess); err != nil {
		t.Fatalf("CreateRefreshSession: %v", err)
	}

	var consumed atomic.Int32
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := st.ConsumeRefreshSession(ctx, "token-hash-1"); err == nil {
				consumed.Add(1)
			}
		}()
	}
	wg.Wait()
	if consumed.Load() != 1 {
		t.Fatalf("expected refresh token consumed exactly once, got %d", consumed.Load())
	}
}

func TestDeleteAlertChannelPrunesDanglingRuleRefs(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	ch := &AlertChannel{ID: "ch1", Name: "Feishu", Type: "feishu", ConfigEnc: []byte("enc"), Enabled: true}
	if err := st.CreateAlertChannel(ctx, ch); err != nil {
		t.Fatalf("CreateAlertChannel: %v", err)
	}
	rule := &AlertRule{
		ID:          "r1",
		Name:        "Custom",
		Enabled:     true,
		Severity:    "warning",
		Metric:      "node_cpu",
		Operator:    "gte",
		Threshold:   90,
		CooldownMin: 30,
		ChannelIDs:  []string{"ch1", "ch2"},
	}
	if err := st.CreateAlertRule(ctx, rule); err != nil {
		t.Fatalf("CreateAlertRule: %v", err)
	}

	if err := st.DeleteAlertChannel(ctx, "ch1"); err != nil {
		t.Fatalf("DeleteAlertChannel: %v", err)
	}
	got, err := st.GetAlertRule(ctx, "r1")
	if err != nil {
		t.Fatalf("GetAlertRule: %v", err)
	}
	if len(got.ChannelIDs) != 1 || got.ChannelIDs[0] != "ch2" {
		t.Fatalf("expected dangling ch1 pruned, got %v", got.ChannelIDs)
	}
}

func TestReadWritePoolNPlusOneCountsDeleteInstanceAndPrune(t *testing.T) {
	st := openTestStore(t)
	ctx := context.Background()

	if st.readDB == nil || st.readDB == st.db {
		t.Fatalf("expected file-backed SQLite Store to open distinct readDB pool")
	}

	// Memory & file: URI fallback checks
	memSt, err := OpenSQLite(":memory:")
	if err != nil {
		t.Fatalf("OpenSQLite(:memory:): %v", err)
	}
	if memSt.readDB != memSt.db {
		t.Fatalf("expected :memory: SQLite Store to fall back readDB = db")
	}
	_ = memSt.Close()

	uriMemSt, err := OpenSQLite("file:memtest1?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("OpenSQLite(file:...mode=memory): %v", err)
	}
	if uriMemSt.readDB != uriMemSt.db {
		t.Fatalf("expected file:...mode=memory SQLite Store to fall back readDB = db")
	}
	_ = uriMemSt.Close()

	uriFileSt, err := OpenSQLite("file:" + filepath.Join(t.TempDir(), "uri_file.db"))
	if err != nil {
		t.Fatalf("OpenSQLite(file:/path): %v", err)
	}
	if uriFileSt.readDB == nil || uriFileSt.readDB == uriFileSt.db {
		t.Fatalf("expected file:/path SQLite Store to open distinct readDB pool")
	}
	_ = uriFileSt.Close()

	// Save two instances: one with two ordered endpoints, one with zero endpoints
	inst1 := &PVEInstance{
		ID:        "inst-1",
		Name:      "cluster-a",
		GroupName: "prod",
		Color:     "#22C55E",
		AuthMode:  "token",
		TLSMode:   "insecure",
		Enabled:   true,
		Endpoints: []PVEEndpoint{
			{ID: "ep-b", InstanceID: "inst-1", NodeName: "n2", URL: "https://203.0.113.12:8006", Priority: 20, IsHealthy: true},
			{ID: "ep-a", InstanceID: "inst-1", NodeName: "n1", URL: "https://203.0.113.11:8006", Priority: 10, IsHealthy: true},
		},
	}
	inst2 := &PVEInstance{
		ID:        "inst-2",
		Name:      "cluster-b",
		GroupName: "prod",
		Color:     "#3B82F6",
		AuthMode:  "token",
		TLSMode:   "insecure",
		Enabled:   true,
	}
	if err := st.SaveInstance(ctx, inst1, true); err != nil {
		t.Fatalf("SaveInstance 1: %v", err)
	}
	if err := st.SaveInstance(ctx, inst2, true); err != nil {
		t.Fatalf("SaveInstance 2: %v", err)
	}

	list, err := st.ListInstances(ctx)
	if err != nil {
		t.Fatalf("ListInstances: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("expected 2 instances, got %d", len(list))
	}
	if len(list[0].Endpoints) != 2 || list[0].Endpoints[0].ID != "ep-a" || list[0].Endpoints[1].ID != "ep-b" {
		t.Fatalf("unexpected endpoints order for inst-1: %+v", list[0].Endpoints)
	}
	if list[1].Endpoints == nil || len(list[1].Endpoints) != 0 {
		t.Fatalf("expected non-nil empty []PVEEndpoint{} for inst-2, got %#v", list[1].Endpoints)
	}

	// Scoped rule & active event on inst-1 -> DeleteInstance must atomically clean both up
	scopedRule := &AlertRule{
		ID:              "rule-inst1",
		Name:            "Scoped CPU",
		Enabled:         true,
		Severity:        "critical",
		ScopeInstanceID: "inst-1",
		Metric:          "node_cpu",
		Operator:        "gte",
		Threshold:       80,
		CooldownMin:     15,
	}
	if err := st.CreateAlertRule(ctx, scopedRule); err != nil {
		t.Fatalf("CreateAlertRule: %v", err)
	}
	nowStr := time.Now().UTC().Format(time.RFC3339)
	activeEv := &AlertEvent{
		ID:          "ev-inst1",
		RuleID:      "rule-inst1",
		RuleName:    "Scoped CPU",
		Fingerprint: "rule-inst1:node_cpu:node:inst-1:n1",
		Severity:    "critical",
		Status:      "firing",
		InstanceID:  "inst-1",
		Metric:      "node_cpu",
		Message:     "high cpu",
		FiredAt:     nowStr,
		LastSeenAt:  nowStr,
	}
	if err := st.InsertAlertEvent(ctx, activeEv); err != nil {
		t.Fatalf("InsertAlertEvent: %v", err)
	}

	countsBefore, err := st.GetAlertSummaryCounts(ctx)
	if err != nil {
		t.Fatalf("GetAlertSummaryCounts: %v", err)
	}
	if countsBefore.FiringCount != 1 || countsBefore.CriticalCount != 1 || countsBefore.ActiveCount != 1 {
		t.Fatalf("unexpected summary counts before delete: %+v", countsBefore)
	}

	if err := st.DeleteInstance(ctx, "inst-1"); err != nil {
		t.Fatalf("DeleteInstance: %v", err)
	}
	if _, err := st.GetAlertRule(ctx, "rule-inst1"); err != ErrNotFound {
		t.Fatalf("expected scoped rule deleted with instance, got err=%v", err)
	}
	evAfter, err := st.GetAlertEventByID(ctx, "ev-inst1")
	if err != nil {
		t.Fatalf("GetAlertEventByID: %v", err)
	}
	if evAfter.Status != "resolved" {
		t.Fatalf("expected instance active alert resolved on DeleteInstance, got %q", evAfter.Status)
	}

	// Retention pruning: >90d audit logs & resolved alert events and expired sessions deleted
	oldTS := time.Now().UTC().Add(-95 * 24 * time.Hour).Format(time.RFC3339)
	if err := st.InsertAuditLog(ctx, &AuditLog{
		ID:        "aud-old",
		Username:  "admin",
		ClientIP:  "127.0.0.1",
		Action:    "test.old",
		Status:    "ok",
		CreatedAt: oldTS,
	}); err != nil {
		t.Fatalf("InsertAuditLog old: %v", err)
	}
	if err := st.InsertAuditLog(ctx, &AuditLog{
		ID:        "aud-new",
		Username:  "admin",
		ClientIP:  "127.0.0.1",
		Action:    "test.new",
		Status:    "ok",
		CreatedAt: nowStr,
	}); err != nil {
		t.Fatalf("InsertAuditLog new: %v", err)
	}
	if err := st.InsertAlertEvent(ctx, &AlertEvent{
		ID:          "ev-old-resolved",
		RuleID:      "r-old",
		RuleName:    "Old",
		Fingerprint: "fp-old",
		Severity:    "info",
		Status:      "resolved",
		Metric:      "node_cpu",
		Message:     "old",
		FiredAt:     oldTS,
		LastSeenAt:  oldTS,
		ResolvedAt:  oldTS,
	}); err != nil {
		t.Fatalf("InsertAlertEvent old: %v", err)
	}

	if err := st.PruneHistoricalRecords(ctx); err != nil {
		t.Fatalf("PruneHistoricalRecords: %v", err)
	}
	logs, err := st.ListAuditLogs(ctx, 50)
	if err != nil {
		t.Fatalf("ListAuditLogs: %v", err)
	}
	if len(logs) != 1 || logs[0].ID != "aud-new" {
		t.Fatalf("expected only recent audit log retained, got %+v", logs)
	}
	if _, err := st.GetAlertEventByID(ctx, "ev-old-resolved"); err != ErrNotFound {
		t.Fatalf("expected >90d resolved alert event pruned, got err=%v", err)
	}
	// Recent resolved event (ev-inst1) must still be retained
	if _, err := st.GetAlertEventByID(ctx, "ev-inst1"); err != nil {
		t.Fatalf("expected recent resolved alert event retained, got err=%v", err)
	}
}
