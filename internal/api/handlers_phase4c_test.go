package api

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/jianxcao/pve-dash/internal/config"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
)

func newTestPhase4CServer(t *testing.T) (*Server, *service.TokenPair, http.Handler) {
	t.Helper()
	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test4c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	key := bytes.Repeat([]byte{0x42}, 32)
	box, err := crypto.NewBox(key)
	if err != nil {
		t.Fatal(err)
	}
	auth := service.NewAuthService(st, key)
	pool := pve.NewPool(st, box)
	agg := service.NewAggregatorService(st, pool)
	cfg := &config.Config{}

	srv := NewServer(cfg, st, box, auth, pool, agg, nil, nil, nil, context.Background())
	adminPair, err := auth.SetupAdminAndLogin(context.Background(), "admin", "Super Admin", "admin1234", "test", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return srv, adminPair, srv.Router()
}

func doJSONReq(t *testing.T, h http.Handler, method, path, bearer string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var buf bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&buf).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	req := httptest.NewRequest(method, path, &buf)
	req.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	return rr
}

func TestPhase4CRBACLiveDemotionAndSessionRevocation(t *testing.T) {
	srv, adminPair, router := newTestPhase4CServer(t)

	// 1. Admin creates a viewer and an operator
	rr := doJSONReq(t, router, http.MethodPost, "/api/v1/users", adminPair.AccessToken, map[string]any{
		"username":    "alice",
		"displayName": "Alice Viewer",
		"password":    "alice12345",
		"role":        "viewer",
	}, nil)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create viewer failed: %d %s", rr.Code, rr.Body.String())
	}
	var alice store.User
	_ = json.Unmarshal(rr.Body.Bytes(), &alice)

	rr = doJSONReq(t, router, http.MethodPost, "/api/v1/users", adminPair.AccessToken, map[string]any{
		"username":    "bob",
		"displayName": "Bob Ops",
		"password":    "bob123456",
		"role":        "operator",
	}, nil)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create operator failed: %d %s", rr.Code, rr.Body.String())
	}

	// 2. Viewer login & verify RBAC enforcement
	alicePair, err := srv.auth.Login(context.Background(), "alice", "alice12345", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	// Viewer blocked on admin-only GET /users & /audit
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/users", alicePair.AccessToken, nil, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer GET /users, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/audit", alicePair.AccessToken, nil, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer GET /audit, got %d", rr.Code)
	}
	// Viewer blocked on write endpoints (requireWritable)
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/rules", alicePair.AccessToken, map[string]any{"name": "x"}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer POST /alerts/rules, got %d", rr.Code)
	}
	// Viewer allowed on read endpoints & preferences
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/preferences", alicePair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for viewer GET /preferences, got %d", rr.Code)
	}

	// 3. Operator blocked on admin-only /users and /config/export
	bobPair, err := srv.auth.Login(context.Background(), "bob", "bob123456", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/users", bobPair.AccessToken, nil, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for operator GET /users, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/config/export", bobPair.AccessToken, map[string]any{"passphrase": "pass123456"}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for operator POST /config/export, got %d", rr.Code)
	}

	// 4. Instant session revocation kicks Alice's existing access JWT immediately
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/users/"+alice.ID+"/revoke-sessions", adminPair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("revoke sessions failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/auth/me", alicePair.AccessToken, nil, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected revoked access JWT rejected with 401, got %d", rr.Code)
	}

	// 5. Self password change keeps new token alive while invalidating old token
	rr = doJSONReq(t, router, http.MethodPost, "/api/v1/auth/change-password", bobPair.AccessToken, map[string]any{
		"currentPassword": "bob123456",
		"newPassword":     "bob-new-pass-99",
	}, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("change password failed: %d %s", rr.Code, rr.Body.String())
	}
	var cpResp struct {
		AccessToken string `json:"accessToken"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &cpResp)
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/auth/me", bobPair.AccessToken, nil, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected old bob token rejected after password change, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/auth/me", cpResp.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected new bob token accepted after password change, got %d", rr.Code)
	}

	// 6. Admin self-delete, self-password-reset via PUT, and self-revoke all blocked; delete viewer requires exact X-Confirm-Target
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/users/"+adminPair.User.ID, adminPair.AccessToken, map[string]any{
		"password": "bypassed-password-123",
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected self password reset via PUT blocked with 400, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/users/"+adminPair.User.ID+"/revoke-sessions", adminPair.AccessToken, nil, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected self revoke-sessions blocked with 400, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/any/nodes/pve/query-url-metadata", alicePair.AccessToken, map[string]any{"url": "http://169.254.169.254/"}, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected revoked viewer rejected on query-url-metadata, got %d", rr.Code)
	}
	// Re-login alice as viewer to verify 403 on query-url-metadata
	alicePair2, err := srv.auth.Login(context.Background(), "alice", "alice12345", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/any/nodes/pve/query-url-metadata", alicePair2.AccessToken, map[string]any{"url": "http://169.254.169.254/"}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected viewer blocked with 403 on query-url-metadata, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/users/"+adminPair.User.ID, adminPair.AccessToken, nil, map[string]string{"X-Confirm-Target": "admin"}); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected self-delete blocked with 400, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/users/"+alice.ID, adminPair.AccessToken, nil, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected missing confirm header rejected with 400, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/users/"+alice.ID, adminPair.AccessToken, nil, map[string]string{"X-Confirm-Target": "alice"}); rr.Code != http.StatusOK {
		t.Fatalf("expected delete alice succeed, got %d %s", rr.Code, rr.Body.String())
	}
}

func TestPhase4CEncryptedConfigExportImportRoundTrip(t *testing.T) {
	srvA, adminA, routerA := newTestPhase4CServer(t)

	// Seed an instance and a channel in Server A
	encSecret, _ := srvA.box.EncryptString("tok-secret-xyz")
	if err := srvA.store.SaveInstance(context.Background(), &store.PVEInstance{
		ID:             "inst-a1",
		Name:           "prod-cluster",
		GroupName:      "prod",
		Color:          "#38BDF8",
		AuthMode:       "token",
		TokenID:        "root@pam!dash",
		TokenSecretEnc: encSecret,
		TLSMode:        "tofu",
		Enabled:        true,
		Endpoints: []store.PVEEndpoint{
			{ID: "ep-1", InstanceID: "inst-a1", URL: "https://pve.example.com:8006", Priority: 10},
		},
	}, true); err != nil {
		t.Fatal(err)
	}
	encCh, _ := srvA.box.EncryptString(`{"url":"https://hooks.example.com/notify","secret":"whsec"}`)
	if err := srvA.store.CreateAlertChannel(context.Background(), &store.AlertChannel{
		ID:        "ch-1",
		Name:      "Ops Webhook",
		Type:      "webhook",
		ConfigEnc: encCh,
		Enabled:   true,
	}); err != nil {
		t.Fatal(err)
	}

	// Export from Server A
	rr := doJSONReq(t, routerA, http.MethodPost, "/api/v1/config/export", adminA.AccessToken, map[string]any{
		"passphrase": "backup-passphrase-2026",
	}, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("export failed: %d %s", rr.Code, rr.Body.String())
	}
	var expResp struct {
		Bundle *crypto.EncryptedBundle `json:"bundle"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &expResp); err != nil || expResp.Bundle == nil {
		t.Fatalf("invalid export response: %s", rr.Body.String())
	}

	// Import into a brand new Server B (different SQLite DB)
	srvB, adminB, routerB := newTestPhase4CServer(t)

	// Wrong passphrase fails
	if rr := doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     expResp.Bundle,
		"passphrase": "wrong-passphrase",
		"dryRun":     true,
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on wrong passphrase, got %d", rr.Code)
	}

	// Dry-run preview succeeds without persisting
	rr = doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     expResp.Bundle,
		"passphrase": "backup-passphrase-2026",
		"dryRun":     true,
	}, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("dry-run import failed: %d %s", rr.Code, rr.Body.String())
	}
	var dryResp struct {
		InstancesAdd []string `json:"instancesAdd"`
		ChannelsAdd  []string `json:"channelsAdd"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &dryResp)
	if len(dryResp.InstancesAdd) != 1 || dryResp.InstancesAdd[0] != "prod-cluster" || len(dryResp.ChannelsAdd) != 1 {
		t.Fatalf("unexpected dry-run diff: %+v", dryResp)
	}
	if insts, _ := srvB.store.ListInstances(context.Background()); len(insts) != 0 {
		t.Fatalf("dry-run should not write instances, found %d", len(insts))
	}

	// Real import persists instance + channel, and second import skips duplicates cleanly
	rr = doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     expResp.Bundle,
		"passphrase": "backup-passphrase-2026",
		"dryRun":     false,
	}, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("real import failed: %d %s", rr.Code, rr.Body.String())
	}
	instsB, _ := srvB.store.ListInstances(context.Background())
	if len(instsB) != 1 || instsB[0].Name != "prod-cluster" {
		t.Fatalf("expected imported prod-cluster, got %+v", instsB)
	}
	decSecret, err := srvB.box.DecryptString(instsB[0].TokenSecretEnc)
	if err != nil || decSecret != "tok-secret-xyz" {
		t.Fatalf("expected re-encrypted token secret preserved, got %q err=%v", decSecret, err)
	}

	// Second import skips already-existing items
	rr = doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     expResp.Bundle,
		"passphrase": "backup-passphrase-2026",
		"dryRun":     true,
	}, nil)
	var secondDry struct {
		InstancesAdd  []string `json:"instancesAdd"`
		InstancesSkip []string `json:"instancesSkip"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &secondDry)
	if len(secondDry.InstancesAdd) != 0 || len(secondDry.InstancesSkip) != 1 {
		t.Fatalf("expected duplicate instance skipped on second import, got %+v", secondDry)
	}

	// Reject dangling rule scopeInstanceName (prevents silent widening to all instances)
	badPayload, _ := json.Marshal(portableConfigPayload{
		ExportedAt: "2026-11-27T00:00:00Z",
		AlertRules: []portableRule{
			{
				Name:              "scoped-rule",
				Enabled:           true,
				Severity:          "warning",
				ScopeInstanceName: "nonexistent-cluster",
				Metric:            "node_cpu",
				Operator:          "gte",
				Threshold:         90,
			},
		},
	})
	badBundle, err := crypto.EncryptBundleWithPassphrase(badPayload, "backup-passphrase-2026")
	if err != nil {
		t.Fatal(err)
	}
	if rr := doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     badBundle,
		"passphrase": "backup-passphrase-2026",
		"dryRun":     true,
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected dangling scopeInstanceName rejected with 400, got %d %s", rr.Code, rr.Body.String())
	}

	// Reject malformed CA PEM in strict TLS mode
	badCertPayload, _ := json.Marshal(portableConfigPayload{
		ExportedAt: "2026-11-27T00:00:00Z",
		Instances: []portableInstance{
			{
				Name:      "bad-ca-inst",
				AuthMode:  "token",
				TLSMode:   "strict",
				CACertPEM: "not-a-pem-cert",
				Enabled:   true,
				Endpoints: []portableEndpoint{{URL: "https://pve2.example.com:8006", Priority: 10}},
			},
		},
	})
	badCertBundle, err := crypto.EncryptBundleWithPassphrase(badCertPayload, "backup-passphrase-2026")
	if err != nil {
		t.Fatal(err)
	}
	if rr := doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     badCertBundle,
		"passphrase": "backup-passphrase-2026",
		"dryRun":     true,
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected invalid caCertPem rejected with 400, got %d %s", rr.Code, rr.Body.String())
	}
}
