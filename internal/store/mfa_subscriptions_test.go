package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func TestPhase5EventSubscriptionsAndRuleNotifyOnResolve(t *testing.T) {
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "phase5_subs.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer st.Close()
	ctx := context.Background()

	// 1. Default seeded alert rules must have NotifyOnResolve == true
	rules, err := st.ListAlertRules(ctx)
	if err != nil || len(rules) == 0 {
		t.Fatalf("ListAlertRules: len=%d err=%v", len(rules), err)
	}
	for _, r := range rules {
		if !r.NotifyOnResolve {
			t.Fatalf("expected seeded rule %q to default NotifyOnResolve=true", r.Name)
		}
	}

	// Custom rule with NotifyOnResolve=false persists and updates cleanly
	customRule := &AlertRule{
		ID:              "rule-no-resolve",
		Name:            "Silent Resolve Rule",
		Enabled:         true,
		Severity:        "warning",
		Metric:          "node_cpu",
		Operator:        "gte",
		Threshold:       85,
		CooldownMin:     15,
		NotifyOnResolve: false,
	}
	if err := st.CreateAlertRule(ctx, customRule); err != nil {
		t.Fatalf("CreateAlertRule: %v", err)
	}
	gotRule, err := st.GetAlertRule(ctx, customRule.ID)
	if err != nil || gotRule.NotifyOnResolve {
		t.Fatalf("expected NotifyOnResolve=false, got (%+v, %v)", gotRule, err)
	}
	customRule.NotifyOnResolve = true
	if err := st.UpdateAlertRule(ctx, customRule); err != nil {
		t.Fatalf("UpdateAlertRule: %v", err)
	}
	gotRule2, err := st.GetAlertRule(ctx, customRule.ID)
	if err != nil || !gotRule2.NotifyOnResolve {
		t.Fatalf("expected NotifyOnResolve=true after update, got (%+v, %v)", gotRule2, err)
	}

	// 2. All 8 event subscription categories are seeded idempotently
	subs, err := st.ListEventSubscriptions(ctx)
	if err != nil {
		t.Fatalf("ListEventSubscriptions: %v", err)
	}
	if len(subs) != 8 {
		t.Fatalf("expected 8 seeded event subscriptions, got %d", len(subs))
	}
	for _, sub := range subs {
		if sub.Enabled || sub.TriggerMode != "all" || len(sub.ChannelIDs) != 0 {
			t.Fatalf("unexpected initial seeded subscription state: %+v", sub)
		}
	}

	// 3. Reject invalid category or triggerMode
	if err := st.UpsertEventSubscriptions(ctx, []EventSubscription{{Category: "unknown.cat", Enabled: true, TriggerMode: "all"}}); err == nil {
		t.Fatal("expected invalid category error")
	}
	if err := st.UpsertEventSubscriptions(ctx, []EventSubscription{{Category: EventCatBackupOps, Enabled: true, TriggerMode: "bogus"}}); err == nil {
		t.Fatal("expected invalid triggerMode error")
	}

	// 4. Upsert valid subscriptions and verify channel-ID pruning on DeleteAlertChannel
	ch := &AlertChannel{
		ID:        "ch-notify-1",
		Name:      "Unified Notify",
		Type:      "notify",
		ConfigEnc: []byte("enc"),
		Enabled:   true,
	}
	if err := st.CreateAlertChannel(ctx, ch); err != nil {
		t.Fatalf("CreateAlertChannel: %v", err)
	}
	if err := st.UpsertEventSubscriptions(ctx, []EventSubscription{
		{
			Category:    EventCatBackupOps,
			Enabled:     true,
			TriggerMode: "failed_only",
			ChannelIDs:  []string{"ch-notify-1", "ch-other"},
		},
		{
			Category:    EventCatSecurityLoginAnomaly,
			Enabled:     true,
			TriggerMode: "all",
			ChannelIDs:  []string{"ch-notify-1"},
		},
	}); err != nil {
		t.Fatalf("UpsertEventSubscriptions: %v", err)
	}

	bSub, err := st.GetEventSubscription(ctx, EventCatBackupOps)
	if err != nil || !bSub.Enabled || bSub.TriggerMode != "failed_only" || len(bSub.ChannelIDs) != 2 {
		t.Fatalf("GetEventSubscription(backup.ops): (%+v, %v)", bSub, err)
	}

	if err := st.DeleteAlertChannel(ctx, "ch-notify-1"); err != nil {
		t.Fatalf("DeleteAlertChannel: %v", err)
	}
	bSubAfter, err := st.GetEventSubscription(ctx, EventCatBackupOps)
	if err != nil || len(bSubAfter.ChannelIDs) != 1 || bSubAfter.ChannelIDs[0] != "ch-other" {
		t.Fatalf("expected ch-notify-1 pruned from backup.ops subscription, got %+v (err=%v)", bSubAfter, err)
	}
	secSubAfter, err := st.GetEventSubscription(ctx, EventCatSecurityLoginAnomaly)
	if err != nil || len(secSubAfter.ChannelIDs) != 0 {
		t.Fatalf("expected ch-notify-1 pruned from security.login_anomaly subscription, got %+v (err=%v)", secSubAfter, err)
	}
}

func TestPhase5StoreMFAPrimitivesAndListUsersFlags(t *testing.T) {
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "phase5_mfa.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer st.Close()
	ctx := context.Background()

	u := &User{
		ID:           "u-mfa-1",
		Username:     "opsadmin",
		DisplayName:  "Ops Admin",
		PasswordHash: "hash",
		Role:         "admin",
		IsActive:     true,
	}
	if err := st.CreateFirstAdmin(ctx, u); err != nil {
		t.Fatalf("CreateFirstAdmin: %v", err)
	}

	users0, err := st.ListUsers(ctx)
	if err != nil || len(users0) != 1 || users0[0].MFAEnabled || users0[0].TOTPEnabled || users0[0].PasskeyCount != 0 {
		t.Fatalf("initial ListUsers unexpected: %+v (err=%v)", users0, err)
	}

	// TOTP activation + atomic anti-replay step consumption
	if err := st.SetUserTOTPPending(ctx, u.ID, []byte("pending-enc")); err != nil {
		t.Fatalf("SetUserTOTPPending: %v", err)
	}
	if err := st.ActivateUserTOTP(ctx, u.ID, []byte("active-enc"), 50000); err != nil {
		t.Fatalf("ActivateUserTOTP: %v", err)
	}
	// Replay of step <= 50000 must fail; step 50001 succeeds once and rejects second attempt
	if ok, err := st.ConsumeTOTPStep(ctx, u.ID, 50000); err != nil || ok {
		t.Fatalf("expected replay step 50000 rejected, got ok=%v err=%v", ok, err)
	}
	if ok, err := st.ConsumeTOTPStep(ctx, u.ID, 50001); err != nil || !ok {
		t.Fatalf("expected step 50001 accepted, got ok=%v err=%v", ok, err)
	}
	if ok, err := st.ConsumeTOTPStep(ctx, u.ID, 50001); err != nil || ok {
		t.Fatalf("expected duplicate step 50001 rejected, got ok=%v err=%v", ok, err)
	}

	// Passkey CRUD + recovery codes
	cred := &WebAuthnCredential{
		ID:              "pk-1",
		UserID:          u.ID,
		Name:            "MacBook Touch ID",
		RPID:            "pve.example.com",
		CredentialID:    []byte{1, 2, 3, 4},
		PublicKeyCBOR:   []byte{0xa1, 0x01, 0x02},
		AttestationType: "none",
		BackupEligible:  true,
		BackupState:     true,
		Transports:      []string{"internal", "hybrid"},
	}
	if err := st.CreateWebAuthnCredential(ctx, cred); err != nil {
		t.Fatalf("CreateWebAuthnCredential: %v", err)
	}
	if err := st.ReplaceUserRecoveryCodes(ctx, u.ID, []string{"h1", "h2"}); err != nil {
		t.Fatalf("ReplaceUserRecoveryCodes: %v", err)
	}
	if ok, err := st.ConsumeUserRecoveryCode(ctx, u.ID, "h1"); err != nil || !ok {
		t.Fatalf("ConsumeUserRecoveryCode first use: ok=%v err=%v", ok, err)
	}
	if ok, err := st.ConsumeUserRecoveryCode(ctx, u.ID, "h1"); err != nil || ok {
		t.Fatalf("ConsumeUserRecoveryCode replay must fail: ok=%v err=%v", ok, err)
	}
	if rem, err := st.CountUnusedRecoveryCodes(ctx, u.ID); err != nil || rem != 1 {
		t.Fatalf("expected 1 unused recovery code, got %d (err=%v)", rem, err)
	}

	users1, err := st.ListUsers(ctx)
	if err != nil || !users1[0].MFAEnabled || !users1[0].TOTPEnabled || users1[0].PasskeyCount != 1 {
		t.Fatalf("expected MFAEnabled=true TOTPEnabled=true PasskeyCount=1, got %+v (err=%v)", users1, err)
	}

	// ClearAllUserMFA(..., true) clears TOTP + passkeys + recovery codes and bumps token_version
	if err := st.ClearAllUserMFA(ctx, u.ID, true); err != nil {
		t.Fatalf("ClearAllUserMFA: %v", err)
	}
	uAfter, err := st.GetUserByID(ctx, u.ID)
	if err != nil || uAfter.TokenVersion != 2 {
		t.Fatalf("expected TokenVersion=2 after admin MFA reset, got (%+v, %v)", uAfter, err)
	}
	users2, _ := st.ListUsers(ctx)
	if users2[0].MFAEnabled || users2[0].TOTPEnabled || users2[0].PasskeyCount != 0 {
		t.Fatalf("expected MFA flags cleared after ClearAllUserMFA, got %+v", users2[0])
	}
}

func TestUpdateUserRoleChangeRevokesSessionsAndImportConfigBatchSubscriptions(t *testing.T) {
	st, err := OpenSQLite(filepath.Join(t.TempDir(), "role_and_import.db"))
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer st.Close()
	ctx := context.Background()

	admin := &User{ID: "u-admin", Username: "admin", DisplayName: "Admin", PasswordHash: "h1", Role: "admin", IsActive: true}
	if err := st.CreateFirstAdmin(ctx, admin); err != nil {
		t.Fatal(err)
	}
	op := &User{ID: "u-op", Username: "ops", DisplayName: "Ops", PasswordHash: "h2", Role: "operator", IsActive: true}
	if err := st.CreateUser(ctx, op); err != nil {
		t.Fatal(err)
	}
	if err := st.CreateRefreshSession(ctx, &RefreshSession{
		ID:        "sess-op-1",
		UserID:    op.ID,
		TokenHash: "th-op-1",
		ExpiresAt: time.Now().Add(time.Hour),
		CreatedAt: time.Now(),
	}); err != nil {
		t.Fatal(err)
	}

	// Demoting operator -> viewer MUST increment token_version and delete refresh_sessions!
	demoted, err := st.UpdateUser(ctx, op.ID, "Ops", "viewer", true, "")
	if err != nil {
		t.Fatalf("UpdateUser role demotion: %v", err)
	}
	if demoted.TokenVersion != 2 || demoted.Role != "viewer" {
		t.Fatalf("expected TokenVersion=2 Role=viewer on role change, got %+v", demoted)
	}
	if _, err := st.GetRefreshSessionByHash(ctx, "th-op-1"); err != ErrNotFound {
		t.Fatalf("expected refresh session deleted on role change, got err=%v", err)
	}

	// ImportConfigBatch atomically upserts channels + rules + event subscriptions
	impChan := &AlertChannel{ID: "ch-imp", Name: "Imported Notify", Type: "notify", ConfigEnc: []byte("enc"), Enabled: true}
	impSubs := []EventSubscription{
		{Category: EventCatBackupOps, Enabled: true, TriggerMode: "failed_only", ChannelIDs: []string{"ch-imp"}},
		{Category: EventCatSecurityAccountChange, Enabled: true, TriggerMode: "all", ChannelIDs: []string{"ch-imp"}},
	}
	if err := st.ImportConfigBatch(ctx, nil, []*AlertChannel{impChan}, nil, impSubs...); err != nil {
		t.Fatalf("ImportConfigBatch with subscriptions: %v", err)
	}
	gotSub, err := st.GetEventSubscription(ctx, EventCatBackupOps)
	if err != nil || !gotSub.Enabled || gotSub.TriggerMode != "failed_only" || len(gotSub.ChannelIDs) != 1 || gotSub.ChannelIDs[0] != "ch-imp" {
		t.Fatalf("expected imported backup.ops subscription, got (%+v, %v)", gotSub, err)
	}
}

