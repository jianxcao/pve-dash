package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
)

func TestRBACLiveDemotionSessionRevocationAndOperatorBoundaries(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	seedMockPVEInstance(t, srv, "inst-rbac", "9.1.0", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api2/json/nodes/pve/lxc/101/config":
			_, _ = w.Write([]byte(`{"data":{"mp0":"/etc/pve,mp=/mnt/host","mp1":"local-lvm:vm-101-disk-1,mp=/data"}}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api2/json/nodes/pve/termproxy":
			_, _ = w.Write([]byte(`{"data":{"port":5900,"ticket":"PVEVNC:FAKE","user":"root@pam"}}`))
		default:
			_, _ = w.Write([]byte(`{"data":null}`))
		}
	})

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
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/users", alicePair.AccessToken, nil, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer GET /users, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/audit", alicePair.AccessToken, nil, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer GET /audit, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/rules", alicePair.AccessToken, map[string]any{"name": "x"}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer POST /alerts/rules, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/preferences", alicePair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for viewer GET /preferences, got %d", rr.Code)
	}

	// 3. Operator blocked on admin-only hypervisor/infra routes & privileged guest passthrough keys
	bobPair, err := srv.auth.Login(context.Background(), "bob", "bob123456", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	adminOnlyForOperator := []struct {
		method string
		path   string
		body   any
	}{
		{http.MethodGet, "/api/v1/users", nil},
		{http.MethodPost, "/api/v1/config/export", map[string]any{"passphrase": "pass123456"}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/nodes/pve/console/session", map[string]any{"protocol": "xterm"}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/nodes/pve/power", map[string]any{"command": "reboot"}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/nodes/pve/networks", map[string]any{"iface": "vmbr9", "type": "bridge"}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/storage-configs", map[string]any{"storage": "dir1", "type": "dir", "path": "/mnt/dir1"}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/mappings/pci", map[string]any{"id": "gpu0", "map": []string{"node=pve,path=0000:00:02.0"}}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/firewall/rules", map[string]any{"type": "in", "action": "ACCEPT"}},
		{http.MethodPost, "/api/v1/instances/inst-rbac/nodes/pve/firewall/rules", map[string]any{"type": "in", "action": "ACCEPT"}},
		{http.MethodDelete, "/api/v1/alerts/rules/rule-1", nil},
	}
	for _, tc := range adminOnlyForOperator {
		if rr := doJSONReq(t, router, tc.method, tc.path, bobPair.AccessToken, tc.body, map[string]string{"X-Confirm-Target": "pve"}); rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for operator %s %s, got %d %s", tc.method, tc.path, rr.Code, rr.Body.String())
		}
	}

	// Operator blocked on hostpci0, args, hookscript, dev0..255, virtiofs0..9, /dev/ passthrough, and comma-smuggled delete
	blockedGuestPayloads := []map[string]any{
		{"values": map[string]string{"hostpci0": "0000:01:00.0,pcie=1"}},
		{"values": map[string]string{"args": "-cpu host"}},
		{"values": map[string]string{"hookscript": "local:snippets/root.sh"}},
		{"values": map[string]string{"usb0": "host=1234:5678"}},
		{"values": map[string]string{"virtiofs0": "shared-dir"}},
		{"values": map[string]string{"dev0": "mapping=dri-render"}},
		{"values": map[string]string{"mp0": "/dev/nvme0n1,mp=/mnt/raw"}},
		{"delete": []string{"hostpci0"}},
		{"delete": []string{"dev0"}},
		{"delete": []string{"virtiofs0"}},
		{"delete": []string{"description,hostpci0"}},
	}
	for _, p := range blockedGuestPayloads {
		if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-rbac/nodes/pve/qemu/100/config", bobPair.AccessToken, p, nil); rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for operator privileged guest config %+v, got %d %s", p, rr.Code, rr.Body.String())
		}
	}

	// Operator blocked from setting, overwriting, or deleting LXC host bind mounts (mp0..mp255 / rootfs starting with /)
	blockedLXCMountPayloads := []map[string]any{
		{"values": map[string]string{"mp2": "/etc/pve,mp=/mnt"}},
		{"values": map[string]string{"mp2": "mp=/mnt,volume=/etc/pve"}},
		{"values": map[string]string{"rootfs": "/,size=8G"}},
		{"delete": []string{"mp0"}},                                    // existing mp0 on LXC 101 is /etc/pve,mp=/mnt/host
		{"values": map[string]string{"mp0": "local-lvm:8,mp=/rebind"}}, // overwriting existing host bind mount
	}
	for _, p := range blockedLXCMountPayloads {
		if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-rbac/nodes/pve/lxc/101/config", bobPair.AccessToken, p, nil); rr.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for operator LXC bind mount mutation %+v, got %d %s", p, rr.Code, rr.Body.String())
		}
	}

	// Operator STILL allowed to manage storage-backed LXC mountpoints (mp1 = local-lvm:vm-101-disk-1,mp=/data)
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-rbac/nodes/pve/lxc/101/config", bobPair.AccessToken, map[string]any{
		"delete": []string{"mp1"},
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for operator deleting storage-backed LXC mp1, got %d %s", rr.Code, rr.Body.String())
	}

	// Demoting a secondary admin to operator immediately closes their open console sessions
	rrCharlie := doJSONReq(t, router, http.MethodPost, "/api/v1/users", adminPair.AccessToken, map[string]any{
		"username":    "charlie",
		"displayName": "Charlie Second Admin",
		"password":    "charlie12345",
		"role":        "admin",
	}, nil)
	if rrCharlie.Code != http.StatusCreated {
		t.Fatalf("create charlie admin failed: %d %s", rrCharlie.Code, rrCharlie.Body.String())
	}
	var charlie store.User
	_ = json.Unmarshal(rrCharlie.Body.Bytes(), &charlie)
	sessOut, err := srv.console.CreateSession(context.Background(), pve.CreateSessionInput{
		OwnerUserID: charlie.ID,
		InstanceID:  "inst-rbac",
		Node:        "pve",
		TargetType:  "node",
		Protocol:    "xterm",
	})
	if err != nil {
		t.Fatalf("create node console session for charlie failed: %v", err)
	}
	if rrDemote := doJSONReq(t, router, http.MethodPut, "/api/v1/users/"+charlie.ID, adminPair.AccessToken, map[string]any{
		"role": "operator",
	}, nil); rrDemote.Code != http.StatusOK {
		t.Fatalf("demote charlie to operator failed: %d %s", rrDemote.Code, rrDemote.Body.String())
	}
	charliePair, err := srv.auth.Login(context.Background(), "charlie", "charlie12345", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	wsReq := httptest.NewRequest(http.MethodGet, "/api/v1/ws/console/"+sessOut.SessionID+"?token="+charliePair.AccessToken, nil)
	rrWS := httptest.NewRecorder()
	router.ServeHTTP(rrWS, wsReq)
	if rrWS.Code != http.StatusUnauthorized || !strings.Contains(rrWS.Body.String(), "invalid or expired console session") {
		t.Fatalf("expected demoted admin's node console session invalidated (401), got %d %s", rrWS.Code, rrWS.Body.String())
	}

	// Operator STILL allowed on normal guest config update & guest-level firewall rules
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-rbac/nodes/pve/qemu/100/config", bobPair.AccessToken, map[string]any{
		"values": map[string]string{"cores": "4", "description": "updated by operator"},
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for operator safe guest config update, got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-rbac/nodes/pve/qemu/100/firewall/rules", bobPair.AccessToken, map[string]any{
		"type":   "in",
		"action": "ACCEPT",
		"proto":  "tcp",
		"dport":  "443",
	}, nil); rr.Code != http.StatusCreated {
		t.Fatalf("expected 201 for operator guest firewall rule create, got %d %s", rr.Code, rr.Body.String())
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
	alicePair2, err := srv.auth.Login(context.Background(), "alice", "alice12345", "ua", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/any/nodes/pve/query-url-metadata", alicePair2.AccessToken, map[string]any{"url": "https://mirror.example.com/test.iso"}, nil); rr.Code != http.StatusForbidden {
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

func TestEncryptedConfigExportImportRoundTrip(t *testing.T) {
	srvA, adminA, routerA := newTestAPIServer(t)

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
	srvB, adminB, routerB := newTestAPIServer(t)

	if rr := doJSONReq(t, routerB, http.MethodPost, "/api/v1/config/import", adminB.AccessToken, map[string]any{
		"bundle":     expResp.Bundle,
		"passphrase": "wrong-passphrase",
		"dryRun":     true,
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on wrong passphrase, got %d", rr.Code)
	}

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
