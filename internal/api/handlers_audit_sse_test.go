package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jianxcao/pve-dash/internal/config"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
)

func TestAuthSetupReadOnlyAndAudit(t *testing.T) {
	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "setup_ro.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	key := bytes.Repeat([]byte{0x55}, 32)
	box, err := crypto.NewBox(key)
	if err != nil {
		t.Fatal(err)
	}
	auth := service.NewAuthService(st, key)
	auth.SetCryptoBox(box)
	pool := pve.NewPool(st, box)
	agg := service.NewAggregatorService(st, pool)
	console := pve.NewConsoleManager(pool)
	cfg := &config.Config{ReadOnly: true}

	srv := NewServer(cfg, st, box, auth, pool, agg, nil, console, nil, context.Background())
	router := srv.Router()

	// ReadOnly=true blocks initial setup with 403
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/setup", "", map[string]any{
		"username":    "admin",
		"displayName": "Admin",
		"password":    "admin12345",
	}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 on /auth/setup when ReadOnly=true, got %d %s", rr.Code, rr.Body.String())
	}
	if init, _ := auth.IsInitialized(context.Background()); init {
		t.Fatal("expected system to remain uninitialized when ReadOnly=true")
	}

	// ReadOnly=false allows initial setup and records user.setup audit log
	cfg.ReadOnly = false
	rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/setup", "", map[string]any{
		"username":    "admin",
		"displayName": "Admin",
		"password":    "admin12345",
	}, nil)
	if rr.Code != http.StatusCreated {
		t.Fatalf("expected 201 on /auth/setup, got %d %s", rr.Code, rr.Body.String())
	}
	logs, err := st.ListAuditLogs(context.Background(), 10)
	if err != nil || len(logs) != 1 || logs[0].Action != "user.setup" || logs[0].Username != "admin" {
		t.Fatalf("expected user.setup audit log for admin, got %+v (err=%v)", logs, err)
	}
}

func TestAlertChannelDecrypt500BarkDeviceKeyClearAndDeadChannelIDPruning(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	// 1. Bark channel: DeviceKey cleared when switching to embedded-key URL or clearDeviceKey=true
	rrBark := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/channels", adminPair.AccessToken, map[string]any{
		"name": "My Bark",
		"type": "bark",
		"config": map[string]any{
			"url":       "https://bark.example.com",
			"deviceKey": "legacy-device-key-9999",
		},
	}, nil)
	if rrBark.Code != http.StatusCreated {
		t.Fatalf("create bark channel failed: %d %s", rrBark.Code, rrBark.Body.String())
	}
	var barkDTO struct {
		ID            string         `json:"id"`
		ConfigPreview map[string]any `json:"configPreview"`
	}
	_ = json.Unmarshal(rrBark.Body.Bytes(), &barkDTO)
	if barkDTO.ConfigPreview["deviceKeyPreview"] == "" {
		t.Fatalf("expected initial bark deviceKeyPreview set, got %+v", barkDTO.ConfigPreview)
	}

	// Update with full embedded-key URL and blank deviceKey -> clears old DeviceKey!
	rrBarkUpd := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/channels/"+barkDTO.ID, adminPair.AccessToken, map[string]any{
		"config": map[string]any{
			"url":       "https://bark.example.com/embeddedKeyAbc1234",
			"deviceKey": "",
		},
	}, nil)
	if rrBarkUpd.Code != http.StatusOK {
		t.Fatalf("update bark channel failed: %d %s", rrBarkUpd.Code, rrBarkUpd.Body.String())
	}
	_ = json.Unmarshal(rrBarkUpd.Body.Bytes(), &barkDTO)
	if barkDTO.ConfigPreview["deviceKeyPreview"] != "" {
		t.Fatalf("expected bark DeviceKey cleared when switching to embedded-key URL, got %+v", barkDTO.ConfigPreview)
	}

	// 2. Corrupted / wrong-master-key ConfigEnc returns 500 on PUT instead of silently wiping config
	wrongBox, _ := crypto.NewBox(bytes.Repeat([]byte{0x99}, 32))
	badEnc, _ := wrongBox.EncryptString(`{"url":"https://hooks.example.com/x"}`)
	_ = srv.store.CreateAlertChannel(context.Background(), &store.AlertChannel{
		ID:        "ch-bad-enc",
		Name:      "Wrong Key Channel",
		Type:      "webhook",
		ConfigEnc: badEnc,
		Enabled:   true,
	})
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/channels/ch-bad-enc", adminPair.AccessToken, map[string]any{
		"name": "Renamed Without Rekey",
	}, nil); rr.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500 when DecryptString fails on channel update, got %d %s", rr.Code, rr.Body.String())
	}

	// 3. Alert rule & event subscription writes prune dead/nonexistent channel IDs and deduplicate valid ones
	rrRule := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/rules", adminPair.AccessToken, map[string]any{
		"name":       "Pruned Channels Rule",
		"severity":   "warning",
		"metric":     "node_cpu",
		"operator":   "gte",
		"threshold":  85,
		"channelIds": []string{barkDTO.ID, "dead-channel-ulid", barkDTO.ID},
	}, nil)
	if rrRule.Code != http.StatusCreated {
		t.Fatalf("create rule failed: %d %s", rrRule.Code, rrRule.Body.String())
	}
	var createdRule store.AlertRule
	_ = json.Unmarshal(rrRule.Body.Bytes(), &createdRule)
	if len(createdRule.ChannelIDs) != 1 || createdRule.ChannelIDs[0] != barkDTO.ID {
		t.Fatalf("expected dead/duplicate channelIds pruned on rule create, got %+v", createdRule.ChannelIDs)
	}

	rrRuleUpd := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/rules/"+createdRule.ID, adminPair.AccessToken, map[string]any{
		"channelIds": []string{"stale-deleted-id-1", "stale-deleted-id-2"},
	}, nil)
	if rrRuleUpd.Code != http.StatusOK {
		t.Fatalf("update rule failed: %d %s", rrRuleUpd.Code, rrRuleUpd.Body.String())
	}
	_ = json.Unmarshal(rrRuleUpd.Body.Bytes(), &createdRule)
	if len(createdRule.ChannelIDs) != 0 {
		t.Fatalf("expected all-dead channelIds pruned to [] on rule update, got %+v", createdRule.ChannelIDs)
	}

	rrSubUpd := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/subscriptions", adminPair.AccessToken, map[string]any{
		"items": []map[string]any{
			{
				"category":    "vm.lifecycle",
				"enabled":     true,
				"triggerMode": "all",
				"channelIds":  []string{"deleted-ulid", barkDTO.ID, barkDTO.ID},
			},
		},
	}, nil)
	if rrSubUpd.Code != http.StatusOK {
		t.Fatalf("update subscriptions failed: %d %s", rrSubUpd.Code, rrSubUpd.Body.String())
	}
	sub, err := srv.store.GetEventSubscription(context.Background(), "vm.lifecycle")
	if err != nil || len(sub.ChannelIDs) != 1 || sub.ChannelIDs[0] != barkDTO.ID {
		t.Fatalf("expected dead/duplicate channelIds pruned on subscription update, got %+v (err=%v)", sub, err)
	}
}

func TestSSETokenVersionRotationVsAccountDeactivation(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)
	ts := httptest.NewServer(router)
	defer ts.Close()

	// Create operator user
	rrCreate := doJSONReq(t, router, http.MethodPost, "/api/v1/users", adminPair.AccessToken, map[string]any{
		"username":    "sseuser",
		"displayName": "SSE User",
		"password":    "ssepass1234",
		"role":        "operator",
	}, nil)
	var sseUser store.User
	_ = json.Unmarshal(rrCreate.Body.Bytes(), &sseUser)

	// Case A: Own password change bumps token_version while user stays active -> SSE closes cleanly WITHOUT auth_expired!
	pairA, err := srv.auth.Login(context.Background(), "sseuser", "ssepass1234", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	respA, err := ts.Client().Get(ts.URL + "/api/v1/events/stream?interval=2&token=" + pairA.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	defer respA.Body.Close()

	// Rotate password so token_version increments while account remains active
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/change-password", pairA.AccessToken, map[string]any{
		"currentPassword": "ssepass1234",
		"newPassword":     "ssepass5678",
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("change password failed: %d %s", rr.Code, rr.Body.String())
	}

	var linesA []string
	scA := bufio.NewScanner(respA.Body)
	for scA.Scan() {
		linesA = append(linesA, scA.Text())
	}
	joinedA := strings.Join(linesA, "\n")
	if strings.Contains(joinedA, "event: auth_expired") {
		t.Fatalf("expected rotated active user SSE stream NOT to emit auth_expired, got:\n%s", joinedA)
	}

	// Case B: Admin deactivates user -> SSE stream MUST emit event: auth_expired!
	pairB, err := srv.auth.Login(context.Background(), "sseuser", "ssepass5678", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	respB, err := ts.Client().Get(ts.URL + "/api/v1/events/stream?interval=2&token=" + pairB.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	defer respB.Body.Close()

	time.AfterFunc(150*time.Millisecond, func() {
		_ = doJSONReq(t, router, http.MethodPut, "/api/v1/users/"+sseUser.ID, adminPair.AccessToken, map[string]any{
			"isActive": false,
		}, nil)
	})

	var linesB []string
	scB := bufio.NewScanner(respB.Body)
	for scB.Scan() {
		linesB = append(linesB, scB.Text())
	}
	joinedB := strings.Join(linesB, "\n")
	if !strings.Contains(joinedB, "event: auth_expired") {
		t.Fatalf("expected deactivated user SSE stream to emit auth_expired, got:\n%s", joinedB)
	}
}

func TestInstanceDeleteAuditNameConsoleTeardownAndGuestAuditCompleteness(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	seedMockPVEInstance(t, srv, "inst-del-1", "8.4.1", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api2/json/nodes/pve/qemu/100/sendkey":
			_, _ = w.Write([]byte(`{"data":null}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api2/json/nodes/pve/qemu/100/spiceproxy":
			_, _ = w.Write([]byte(`{"data":{"host":"198.51.100.50","type":"spice","password":"abc"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api2/json/nodes/pve/qemu/100/vncproxy":
			_, _ = w.Write([]byte(`{"data":{"port":5901,"ticket":"PVEVNC:TEST","user":"root@pam"}}`))
		default:
			_, _ = w.Write([]byte(`{"data":null}`))
		}
	})

	// 1. Guest sendkey, spice, and default-protocol console session record exact audit actions
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-del-1/nodes/pve/qemu/100/sendkey", adminPair.AccessToken, map[string]any{
		"key": "ctrl-alt-delete",
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("sendkey failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-del-1/nodes/pve/qemu/100/spice", adminPair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("spice failed: %d %s", rr.Code, rr.Body.String())
	}
	rrCons := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-del-1/nodes/pve/qemu/100/console/session", adminPair.AccessToken, map[string]any{}, nil)
	if rrCons.Code != http.StatusOK {
		t.Fatalf("guest console session failed: %d %s", rrCons.Code, rrCons.Body.String())
	}
	var sessResp struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(rrCons.Body.Bytes(), &sessResp)

	// 2. Delete instance tears down pending/active console sessions for inst-del-1 and records instance Name (not raw ID!)
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/instances/inst-del-1", adminPair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("delete instance failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/instances/inst-del-1", adminPair.AccessToken, nil, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 deleting already-deleted instance, got %d", rr.Code)
	}

	wsReq := httptest.NewRequest(http.MethodGet, "/api/v1/ws/console/"+sessResp.SessionID+"?token="+adminPair.AccessToken, nil)
	rrWS := httptest.NewRecorder()
	router.ServeHTTP(rrWS, wsReq)
	if rrWS.Code != http.StatusUnauthorized || !strings.Contains(rrWS.Body.String(), "invalid or expired console session") {
		t.Fatalf("expected console session invalidated after DeleteInstance, got %d %s", rrWS.Code, rrWS.Body.String())
	}

	logs, err := srv.store.ListAuditLogs(context.Background(), 20)
	if err != nil {
		t.Fatal(err)
	}
	actions := map[string]store.AuditLog{}
	for _, l := range logs {
		actions[l.Action] = l
	}
	for _, want := range []string{"qemu.sendkey", "console.spice", "console.vnc", "instance.delete"} {
		if _, ok := actions[want]; !ok {
			t.Fatalf("missing expected audit action %q in %+v", want, logs)
		}
	}
	if _, bad := actions["console."]; bad {
		t.Fatalf("found malformed trailing-dot console. audit action in %+v", logs)
	}
	delLog := actions["instance.delete"]
	if delLog.ResourceURN == "instance:inst-del-1" || !strings.HasPrefix(delLog.ResourceURN, "instance:") || delLog.PayloadSummary == "inst-del-1" {
		t.Fatalf("expected instance.delete audit log to record human instance Name instead of raw ID, got %+v", delLog)
	}
}
