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
