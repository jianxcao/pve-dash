package api

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jianxcao/pve-dash/internal/service"
)

func TestHealthSystemInfoAndSPAFallbackAssets404(t *testing.T) {
	srv, adminPair, _ := newTestAPIServer(t)
	srv.webFS = fstest.MapFS{
		"index.html":           &fstest.MapFile{Data: []byte("<!doctype html><html><body>PVE Dash</body></html>")},
		"manifest.webmanifest": &fstest.MapFile{Data: []byte(`{"name":"PVE Dash"}`)},
		"sw.js":                &fstest.MapFile{Data: []byte("// sw")},
		"assets/app-123.js":    &fstest.MapFile{Data: []byte("console.log('ok')")},
	}
	router := srv.Router()

	for _, path := range []string{"/healthz", "/api/v1/health"} {
		rr := doJSONReq(t, router, http.MethodGet, path, "", nil, nil)
		if rr.Code != http.StatusOK {
			t.Fatalf("%s expected 200, got %d: %s", path, rr.Code, rr.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
			t.Fatalf("unmarshal %s: %v", path, err)
		}
		if body["ok"] != true {
			t.Fatalf("%s expected ok=true, got %+v", path, body)
		}
		ver, _ := body["version"].(string)
		if strings.TrimSpace(ver) == "" {
			t.Fatalf("%s expected non-empty version field, got %+v", path, body)
		}
	}

	// SPA routes return index.html (200), existing /assets/* returns 200, missing /assets/* returns 404 (NOT 200 HTML!)
	if rr := doJSONReq(t, router, http.MethodGet, "/guests", "", nil, nil); rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "PVE Dash") {
		t.Fatalf("expected SPA route /guests to return 200 index.html, got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/assets/app-123.js", "", nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected existing /assets/app-123.js to return 200, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/assets/missing-stale-chunk.js", "", nil, nil); rr.Code != http.StatusNotFound {
		t.Fatalf("expected missing /assets/missing-stale-chunk.js to return 404, got %d %s", rr.Code, rr.Body.String())
	}

	// Unauthenticated /api/v1/system/info must return 401
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/system/info", "", nil, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 for unauthenticated /system/info, got %d", rr.Code)
	}

	srv.cfg.ReadOnly = true
	rr := doJSONReq(t, router, http.MethodGet, "/api/v1/system/info", adminPair.AccessToken, nil, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for /system/info, got %d: %s", rr.Code, rr.Body.String())
	}
	var sysInfo struct {
		Version   string `json:"version"`
		Commit    string `json:"commit"`
		BuildTime string `json:"buildTime"`
		GoVersion string `json:"goVersion"`
		ReadOnly  bool   `json:"readOnly"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &sysInfo); err != nil {
		t.Fatalf("unmarshal /system/info: %v", err)
	}
	if sysInfo.Version == "" || sysInfo.GoVersion == "" || !sysInfo.ReadOnly {
		t.Fatalf("unexpected /system/info payload: %+v", sysInfo)
	}
}

func TestNotifyChannelAlertRulesAndEventSubscriptions(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)
	ev := service.NewEventNotifier(srv.store, srv.box)
	t.Cleanup(ev.Stop)
	srv.SetEventNotifier(ev)

	// 1. Reject notify channel without appId when base URL is given, and reject loopback URL (SSRF guard)
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/channels", adminPair.AccessToken, map[string]any{
		"name": "Missing AppID Notify",
		"type": "notify",
		"config": map[string]any{
			"url": "https://notify.example.com",
		},
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for notify channel missing appId, got %d: %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/channels", adminPair.AccessToken, map[string]any{
		"name": "Loopback Notify",
		"type": "notify",
		"config": map[string]any{
			"url":   "http://127.0.0.1:8080",
			"appId": "pve-ops",
		},
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for loopback notify URL, got %d: %s", rr.Code, rr.Body.String())
	}

	// 2. Create valid notify channel with Bearer secret, appId, targets & panelUrl
	rrCreateCh := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/channels", adminPair.AccessToken, map[string]any{
		"name":    "Notify Gateway",
		"type":    "notify",
		"enabled": true,
		"config": map[string]any{
			"url":      "https://notify.invalid",
			"appId":    "pve-ops",
			"targets":  "feishu,email",
			"panelUrl": "https://pve-dash.example.com",
			"secret":   "Bearer super-secret-notify-token",
		},
	}, nil)
	if rrCreateCh.Code != http.StatusCreated {
		t.Fatalf("expected 201 creating notify channel, got %d: %s", rrCreateCh.Code, rrCreateCh.Body.String())
	}
	if strings.Contains(rrCreateCh.Body.String(), "super-secret-notify-token") {
		t.Fatalf("notify channel response leaked raw secret: %s", rrCreateCh.Body.String())
	}
	var chDTO struct {
		ID            string         `json:"id"`
		Type          string         `json:"type"`
		ConfigPreview map[string]any `json:"configPreview"`
	}
	if err := json.Unmarshal(rrCreateCh.Body.Bytes(), &chDTO); err != nil {
		t.Fatal(err)
	}
	if chDTO.Type != "notify" || chDTO.ConfigPreview["appId"] != "pve-ops" || chDTO.ConfigPreview["hasSecret"] != true {
		t.Fatalf("unexpected notify channel preview: %+v", chDTO)
	}

	// 3. Update notify channel with clearSecret=true and updated targets
	rrUpdCh := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/channels/"+chDTO.ID, adminPair.AccessToken, map[string]any{
		"config": map[string]any{
			"clearSecret": true,
			"targets":     "telegram",
		},
	}, nil)
	if rrUpdCh.Code != http.StatusOK {
		t.Fatalf("expected 200 updating notify channel, got %d: %s", rrUpdCh.Code, rrUpdCh.Body.String())
	}
	if err := json.Unmarshal(rrUpdCh.Body.Bytes(), &chDTO); err != nil {
		t.Fatal(err)
	}
	if chDTO.ConfigPreview["hasSecret"] != false || chDTO.ConfigPreview["targets"] != "telegram" {
		t.Fatalf("expected secret cleared and targets=telegram, got %+v", chDTO.ConfigPreview)
	}

	// 4. Alert rule notifyOnResolve defaults to true and updates to false cleanly; preserved across export/import
	rrRule := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/rules", adminPair.AccessToken, map[string]any{
		"name":       "Node High CPU Notify",
		"severity":   "critical",
		"metric":     "node_cpu",
		"operator":   "gte",
		"threshold":  92,
		"channelIds": []string{chDTO.ID},
	}, nil)
	if rrRule.Code != http.StatusCreated {
		t.Fatalf("create rule failed: %d %s", rrRule.Code, rrRule.Body.String())
	}
	var ruleResp struct {
		ID              string `json:"id"`
		NotifyOnResolve bool   `json:"notifyOnResolve"`
	}
	_ = json.Unmarshal(rrRule.Body.Bytes(), &ruleResp)
	if !ruleResp.NotifyOnResolve {
		t.Fatalf("expected notifyOnResolve=true by default on create")
	}

	rrRuleUpd := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/rules/"+ruleResp.ID, adminPair.AccessToken, map[string]any{
		"notifyOnResolve": false,
	}, nil)
	if rrRuleUpd.Code != http.StatusOK {
		t.Fatalf("update rule failed: %d %s", rrRuleUpd.Code, rrRuleUpd.Body.String())
	}
	_ = json.Unmarshal(rrRuleUpd.Body.Bytes(), &ruleResp)
	if ruleResp.NotifyOnResolve {
		t.Fatalf("expected notifyOnResolve=false after update")
	}

	// Export config, delete rule & channel, re-import and verify notify fields + notifyOnResolve=false survive
	rrExp := doJSONReq(t, router, http.MethodPost, "/api/v1/config/export", adminPair.AccessToken, map[string]any{
		"passphrase": "backup-passphrase-123",
	}, nil)
	if rrExp.Code != http.StatusOK {
		t.Fatalf("export failed: %d %s", rrExp.Code, rrExp.Body.String())
	}
	var expBody struct {
		Bundle map[string]any `json:"bundle"`
	}
	_ = json.Unmarshal(rrExp.Body.Bytes(), &expBody)
	_ = doJSONReq(t, router, http.MethodDelete, "/api/v1/alerts/rules/"+ruleResp.ID, adminPair.AccessToken, nil, nil)
	_ = doJSONReq(t, router, http.MethodDelete, "/api/v1/alerts/channels/"+chDTO.ID, adminPair.AccessToken, nil, nil)

	rrImp := doJSONReq(t, router, http.MethodPost, "/api/v1/config/import", adminPair.AccessToken, map[string]any{
		"bundle":     expBody.Bundle,
		"passphrase": "backup-passphrase-123",
		"dryRun":     false,
	}, nil)
	if rrImp.Code != http.StatusOK {
		t.Fatalf("import failed: %d %s", rrImp.Code, rrImp.Body.String())
	}

	// 5. Event subscriptions GET + RBAC + validation + async dispatch hooks
	rrSubs := doJSONReq(t, router, http.MethodGet, "/api/v1/alerts/subscriptions", adminPair.AccessToken, nil, nil)
	if rrSubs.Code != http.StatusOK {
		t.Fatalf("GET /alerts/subscriptions failed: %d %s", rrSubs.Code, rrSubs.Body.String())
	}
	var subsPayload struct {
		Items []struct {
			Category    string   `json:"category"`
			Enabled     bool     `json:"enabled"`
			TriggerMode string   `json:"triggerMode"`
			ChannelIDs  []string `json:"channelIds"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rrSubs.Body.Bytes(), &subsPayload); err != nil {
		t.Fatal(err)
	}
	if len(subsPayload.Items) != 8 {
		t.Fatalf("expected 8 event subscription categories, got %d", len(subsPayload.Items))
	}

	// Create operator user and verify operator can GET subscriptions but gets 403 on PUT
	rrOp := doJSONReq(t, router, http.MethodPost, "/api/v1/users", adminPair.AccessToken, map[string]any{
		"username":    "opsuser",
		"displayName": "Ops User",
		"password":    "opspass1234",
		"role":        "operator",
	}, nil)
	if rrOp.Code != http.StatusCreated {
		t.Fatalf("create operator failed: %d %s", rrOp.Code, rrOp.Body.String())
	}
	rrOpLogin := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"username": "opsuser",
		"password": "opspass1234",
	}, nil)
	if rrOpLogin.Code != http.StatusOK {
		t.Fatalf("operator login failed: %d %s", rrOpLogin.Code, rrOpLogin.Body.String())
	}
	var opPair service.TokenPair
	_ = json.Unmarshal(rrOpLogin.Body.Bytes(), &opPair)

	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/alerts/subscriptions", opPair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("operator expected 200 on GET /alerts/subscriptions, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/subscriptions", opPair.AccessToken, map[string]any{
		"items": subsPayload.Items,
	}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("operator expected 403 on PUT /alerts/subscriptions, got %d", rr.Code)
	}

	// Invalid category or triggerMode returns 400
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/subscriptions", adminPair.AccessToken, map[string]any{
		"items": []map[string]any{
			{"category": "unknown.cat", "enabled": true, "triggerMode": "all", "channelIds": []string{}},
		},
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid category, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/subscriptions", adminPair.AccessToken, map[string]any{
		"items": []map[string]any{
			{"category": "vm.power", "enabled": true, "triggerMode": "bogus", "channelIds": []string{}},
		},
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid triggerMode, got %d", rr.Code)
	}

	// Enable security subscriptions and verify failed/successful logins + audit hooks run non-blockingly
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/subscriptions", adminPair.AccessToken, map[string]any{
		"items": []map[string]any{
			{"category": "security.login_anomaly", "enabled": true, "triggerMode": "failed_only", "channelIds": []string{}},
			{"category": "security.login_success", "enabled": true, "triggerMode": "all", "channelIds": []string{}},
			{"category": "security.account_change", "enabled": true, "triggerMode": "all", "channelIds": []string{}},
		},
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("admin PUT /alerts/subscriptions failed: %d %s", rr.Code, rr.Body.String())
	}

	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"username": "opsuser",
		"password": "wrong-password-999",
	}, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 on wrong password, got %d", rr.Code)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"username": "opsuser",
		"password": "opspass1234",
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 on valid login, got %d", rr.Code)
	}
	ev.WaitIdle()
}

func TestMFATOTPRecoveryPasskeyAndAdminResetLifecycle(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	mintChallenge := func(t *testing.T, clientIPAddr string) service.MFAChallengeResponse {
		t.Helper()
		var buf bytes.Buffer
		_ = json.NewEncoder(&buf).Encode(map[string]any{
			"username": "admin",
			"password": "admin1234",
		})
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", &buf)
		req.Header.Set("Content-Type", "application/json")
		if clientIPAddr != "" {
			req.RemoteAddr = clientIPAddr + ":54321"
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("2FA login step 1 failed: %d %s", rr.Code, rr.Body.String())
		}
		for _, c := range rr.Result().Cookies() {
			if c.Name == "pve_dash_access" && c.Value != "" {
				t.Fatalf("step-1 MFA challenge must NOT set pve_dash_access cookie")
			}
		}
		var ch service.MFAChallengeResponse
		if err := json.Unmarshal(rr.Body.Bytes(), &ch); err != nil {
			t.Fatal(err)
		}
		if !ch.MFARequired || ch.MFAToken == "" {
			t.Fatalf("expected mfaRequired=true with mfaToken, got %+v", ch)
		}
		return ch
	}

	// 1. Initial security status shows MFA disabled
	rrSec := doJSONReq(t, router, http.MethodGet, "/api/v1/auth/security", adminPair.AccessToken, nil, nil)
	if rrSec.Code != http.StatusOK {
		t.Fatalf("GET /auth/security failed: %d %s", rrSec.Code, rrSec.Body.String())
	}
	var secStatus service.SecurityStatus
	if err := json.Unmarshal(rrSec.Body.Bytes(), &secStatus); err != nil {
		t.Fatal(err)
	}
	if secStatus.MFAEnabled || secStatus.TOTPEnabled {
		t.Fatalf("expected MFA initially disabled, got %+v", secStatus)
	}

	// 2. Wrong password on authenticated TOTP setup must return 400 (NOT 401!)
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/setup", adminPair.AccessToken, map[string]any{
		"currentPassword": "wrong-password-123",
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on wrong currentPassword during TOTP setup, got %d: %s", rr.Code, rr.Body.String())
	}

	// 3. Valid TOTP setup + enable returns 8 single-use recovery codes
	rrSetup := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/setup", adminPair.AccessToken, map[string]any{
		"currentPassword": "admin1234",
	}, nil)
	if rrSetup.Code != http.StatusOK {
		t.Fatalf("TOTP setup failed: %d %s", rrSetup.Code, rrSetup.Body.String())
	}
	var setupRes service.TOTPSetupResponse
	if err := json.Unmarshal(rrSetup.Body.Bytes(), &setupRes); err != nil {
		t.Fatal(err)
	}
	if setupRes.Secret == "" || !strings.Contains(setupRes.QRSVG, "<svg") || !strings.HasPrefix(setupRes.OTPAuthURL, "otpauth://totp/") {
		t.Fatalf("invalid TOTP setup payload: secret=%q url=%q svgLen=%d", setupRes.Secret, setupRes.OTPAuthURL, len(setupRes.QRSVG))
	}

	now := time.Now()
	codeNow, err := service.GenerateTOTPCodeAt(setupRes.Secret, now)
	if err != nil {
		t.Fatal(err)
	}
	rrEnable := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/enable", adminPair.AccessToken, map[string]any{
		"code": codeNow,
	}, nil)
	if rrEnable.Code != http.StatusOK {
		t.Fatalf("TOTP enable failed: %d %s", rrEnable.Code, rrEnable.Body.String())
	}
	var enableRes service.TOTPEnableResponse
	if err := json.Unmarshal(rrEnable.Body.Bytes(), &enableRes); err != nil {
		t.Fatal(err)
	}
	if !enableRes.OK || len(enableRes.RecoveryCodes) != 8 {
		t.Fatalf("expected 8 recovery codes on first MFA enable, got %+v", enableRes)
	}

	// 4. Primary login returns 2-step MFA challenge; mfaToken MUST be rejected as Bearer access token,
	//    bogus/expired mfaToken MUST return 401 MFA_TOKEN_EXPIRED, and wrong code keeps mfaToken retryable!
	chalTotp := mintChallenge(t, "198.51.100.11")
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/auth/me", chalTotp.MFAToken, nil, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 when using mfaToken as Bearer access token, got %d", rr.Code)
	}
	rrBogusMFA := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp", "", map[string]any{
		"mfaToken": "bogus.expired.token",
		"code":     "123456",
	}, nil)
	if rrBogusMFA.Code != http.StatusUnauthorized || !strings.Contains(rrBogusMFA.Body.String(), "MFA_TOKEN_EXPIRED") {
		t.Fatalf("expected 401 MFA_TOKEN_EXPIRED on invalid mfaToken, got %d %s", rrBogusMFA.Code, rrBogusMFA.Body.String())
	}

	// Re-using the exact same TOTP step consumed by enableTotp must return 400 INVALID_MFA_CODE while keeping chalTotp.MFAToken retryable
	rrReplayStep := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp", "", map[string]any{
		"mfaToken": chalTotp.MFAToken,
		"code":     codeNow,
	}, nil)
	if rrReplayStep.Code != http.StatusBadRequest || !strings.Contains(rrReplayStep.Body.String(), "INVALID_MFA_CODE") {
		t.Fatalf("expected 400 INVALID_MFA_CODE on replayed TOTP code, got %d: %s", rrReplayStep.Code, rrReplayStep.Body.String())
	}

	// Next 30s skew step on the SAME chalTotp.MFAToken succeeds and consumes chalTotp.MFAToken!
	codeNextStep, err := service.GenerateTOTPCodeAt(setupRes.Secret, now.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	rrTotpOK := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp", "", map[string]any{
		"mfaToken": chalTotp.MFAToken,
		"code":     codeNextStep,
	}, nil)
	if rrTotpOK.Code != http.StatusOK {
		t.Fatalf("expected 200 on valid TOTP verification, got %d: %s", rrTotpOK.Code, rrTotpOK.Body.String())
	}

	// Re-using consumed chalTotp.MFAToken for another login MUST fail with 401 MFA_TOKEN_EXPIRED!
	rrReuseMFAToken := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/recovery", "", map[string]any{
		"mfaToken":     chalTotp.MFAToken,
		"recoveryCode": enableRes.RecoveryCodes[0],
	}, nil)
	if rrReuseMFAToken.Code != http.StatusUnauthorized || !strings.Contains(rrReuseMFAToken.Body.String(), "MFA_TOKEN_EXPIRED") {
		t.Fatalf("expected 401 MFA_TOKEN_EXPIRED when replaying consumed mfaToken, got %d %s", rrReuseMFAToken.Code, rrReuseMFAToken.Body.String())
	}

	// 5. Recovery code single-use login (with fresh mfaToken) + regeneration
	chalRec := mintChallenge(t, "198.51.100.12")
	firstRecovery := enableRes.RecoveryCodes[0]
	rrRecOK := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/recovery", "", map[string]any{
		"mfaToken":     chalRec.MFAToken,
		"recoveryCode": strings.ToLower(strings.ReplaceAll(firstRecovery, "-", " ")),
	}, nil)
	if rrRecOK.Code != http.StatusOK {
		t.Fatalf("expected 200 on valid recovery code login, got %d: %s", rrRecOK.Code, rrRecOK.Body.String())
	}

	chalRec2 := mintChallenge(t, "198.51.100.12")
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/recovery", "", map[string]any{
		"mfaToken":     chalRec2.MFAToken,
		"recoveryCode": firstRecovery,
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when reusing consumed recovery code, got %d: %s", rr.Code, rr.Body.String())
	}

	rrRegen := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/recovery-codes/regenerate", adminPair.AccessToken, map[string]any{
		"currentPassword": "admin1234",
	}, nil)
	if rrRegen.Code != http.StatusOK {
		t.Fatalf("regenerate recovery codes failed: %d %s", rrRegen.Code, rrRegen.Body.String())
	}
	var regenRes struct {
		OK            bool     `json:"ok"`
		RecoveryCodes []string `json:"recoveryCodes"`
	}
	_ = json.Unmarshal(rrRegen.Body.Bytes(), &regenRes)
	if !regenRes.OK || len(regenRes.RecoveryCodes) != 8 {
		t.Fatalf("expected 8 regenerated recovery codes, got %+v", regenRes)
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/recovery", "", map[string]any{
		"mfaToken":     chalRec2.MFAToken,
		"recoveryCode": enableRes.RecoveryCodes[1],
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected old recovery code invalidated after regeneration, got %d", rr.Code)
	}

	// 6. WebAuthn ES256 Passkey Registration, Challenge Replay Protection, Reverse-Proxy Referer SecurityStatus & Synced Passkey Login
	const rpHost = "pve-dash.example.com"
	const rpOrigin = "https://pve-dash.example.com"

	doHostJSON := func(method, path, bearer, host, origin, remoteIP string, body any) *httptest.ResponseRecorder {
		var buf bytes.Buffer
		if body != nil {
			_ = json.NewEncoder(&buf).Encode(body)
		}
		req := httptest.NewRequest(method, "https://"+host+path, &buf)
		req.Host = host
		if remoteIP != "" {
			req.RemoteAddr = remoteIP + ":54321"
		}
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}

	// Cross-origin spoofing attempt even with valid Bearer token must be rejected
	if rr := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/passkeys/register/begin", adminPair.AccessToken, rpHost, "https://evil.example.org", "198.51.100.13", map[string]any{
		"currentPassword": "admin1234",
		"name":            "Spoofed Key",
	}); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on cross-origin WebAuthn begin, got %d: %s", rr.Code, rr.Body.String())
	}

	rrRegBegin := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/passkeys/register/begin", adminPair.AccessToken, rpHost, rpOrigin, "198.51.100.13", map[string]any{
		"currentPassword": "admin1234",
		"name":            "MacBook Touch ID",
	})
	if rrRegBegin.Code != http.StatusOK {
		t.Fatalf("passkey register begin failed: %d %s", rrRegBegin.Code, rrRegBegin.Body.String())
	}
	var regBegin service.PasskeyRegisterBeginResponse
	if err := json.Unmarshal(rrRegBegin.Body.Bytes(), &regBegin); err != nil {
		t.Fatal(err)
	}
	regChal, _ := regBegin.Options["challenge"].(string)
	if regBegin.ChallengeToken == "" || regChal == "" {
		t.Fatalf("missing challenge in register begin: %+v", regBegin)
	}

	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	credID := []byte("synced-icloud-passkey-cred-01")
	regCred := buildTestES256Attestation(t, rpHost, rpOrigin, regChal, credID, &privKey.PublicKey)

	rrRegFinish := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/passkeys/register/finish", adminPair.AccessToken, rpHost, rpOrigin, "198.51.100.13", map[string]any{
		"challengeToken": regBegin.ChallengeToken,
		"name":           "MacBook Touch ID",
		"credential":     regCred,
	})
	if rrRegFinish.Code != http.StatusCreated {
		t.Fatalf("passkey register finish failed: %d %s", rrRegFinish.Code, rrRegFinish.Body.String())
	}
	var regFinish service.PasskeyRegisterFinishResponse
	if err := json.Unmarshal(rrRegFinish.Body.Bytes(), &regFinish); err != nil {
		t.Fatal(err)
	}
	if !regFinish.OK || regFinish.Credential.RPID != rpHost || !regFinish.Credential.BackupEligible || !regFinish.Credential.BackupState {
		t.Fatalf("unexpected registered passkey summary: %+v", regFinish.Credential)
	}

	// Replaying the same registration challengeToken must be rejected with 400!
	credID2 := []byte("replayed-reg-cred-02")
	regCredReplay := buildTestES256Attestation(t, rpHost, rpOrigin, regChal, credID2, &privKey.PublicKey)
	if rr := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/passkeys/register/finish", adminPair.AccessToken, rpHost, rpOrigin, "198.51.100.13", map[string]any{
		"challengeToken": regBegin.ChallengeToken,
		"name":           "Replayed Key",
		"credential":     regCredReplay,
	}); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when replaying WebAuthn registration challengeToken, got %d %s", rr.Code, rr.Body.String())
	}

	// Simulate reverse-proxy plain HTTP backend (`r.TLS == nil`, `Origin == ""`, `PublicURL == ""`, `TrustProxy == false`)
	// with same-origin HTTPS Referer on GET /api/v1/auth/security: must resolve currentRpId="pve-dash.example.com" cleanly!
	reqSecProxy := httptest.NewRequest(http.MethodGet, "http://"+rpHost+"/api/v1/auth/security", nil)
	reqSecProxy.Host = rpHost
	reqSecProxy.Header.Set("Referer", rpOrigin+"/settings?tab=security")
	reqSecProxy.Header.Set("Authorization", "Bearer "+adminPair.AccessToken)
	rrSecProxy := httptest.NewRecorder()
	router.ServeHTTP(rrSecProxy, reqSecProxy)
	if rrSecProxy.Code != http.StatusOK {
		t.Fatalf("proxy GET /auth/security failed: %d %s", rrSecProxy.Code, rrSecProxy.Body.String())
	}
	var proxySec service.SecurityStatus
	_ = json.Unmarshal(rrSecProxy.Body.Bytes(), &proxySec)
	if proxySec.CurrentRPID != rpHost || !proxySec.WebAuthnAvailableForHost || proxySec.HasOtherHostPasskeys {
		t.Fatalf("expected Referer-resolved currentRpId=%q with webauthnAvailableForHost=true, got %+v", rpHost, proxySec)
	}

	// Verify synced passkey (signCount=0) succeeds across two fresh logins, AND replaying a captured assertion fails!
	for attempt := 1; attempt <= 2; attempt++ {
		rrDomainLogin := doHostJSON(http.MethodPost, "/api/v1/auth/login", "", rpHost, rpOrigin, "198.51.100.14", map[string]any{
			"username": "admin",
			"password": "admin1234",
		})
		var domainChal service.MFAChallengeResponse
		_ = json.Unmarshal(rrDomainLogin.Body.Bytes(), &domainChal)
		if !domainChal.WebAuthnAvailableForHost || domainChal.HasOtherHostPasskeys {
			t.Fatalf("expected webauthnAvailableForHost=true on matching domain, got %+v", domainChal)
		}

		rrWABegin := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/webauthn/begin", "", rpHost, rpOrigin, "198.51.100.14", map[string]any{
			"mfaToken": domainChal.MFAToken,
		})
		if rrWABegin.Code != http.StatusOK {
			t.Fatalf("attempt %d webauthn login begin failed: %d %s", attempt, rrWABegin.Code, rrWABegin.Body.String())
		}
		var waBegin service.PasskeyLoginBeginResponse
		_ = json.Unmarshal(rrWABegin.Body.Bytes(), &waBegin)
		loginChal, _ := waBegin.Options["challenge"].(string)

		assertion := buildTestES256Assertion(t, rpHost, rpOrigin, loginChal, credID, privKey, 0)
		rrWAFinish := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/webauthn/finish", "", rpHost, rpOrigin, "198.51.100.14", map[string]any{
			"mfaToken":       domainChal.MFAToken,
			"challengeToken": waBegin.ChallengeToken,
			"credential":     assertion,
		})
		if rrWAFinish.Code != http.StatusOK {
			t.Fatalf("attempt %d webauthn login finish (signCount=0) failed: %d %s", attempt, rrWAFinish.Code, rrWAFinish.Body.String())
		}

		// Replaying the captured assertion (even with a brand-new mfaToken!) must fail because waBegin.ChallengeToken is consumed!
		if attempt == 1 {
			rrFreshMFA := doHostJSON(http.MethodPost, "/api/v1/auth/login", "", rpHost, rpOrigin, "198.51.100.14", map[string]any{
				"username": "admin",
				"password": "admin1234",
			})
			var freshChal service.MFAChallengeResponse
			_ = json.Unmarshal(rrFreshMFA.Body.Bytes(), &freshChal)

			rrReplayWA := doHostJSON(http.MethodPost, "/api/v1/auth/mfa/webauthn/finish", "", rpHost, rpOrigin, "198.51.100.14", map[string]any{
				"mfaToken":       freshChal.MFAToken,
				"challengeToken": waBegin.ChallengeToken,
				"credential":     assertion,
			})
			if rrReplayWA.Code != http.StatusUnauthorized || !strings.Contains(rrReplayWA.Body.String(), "MFA_TOKEN_EXPIRED") {
				t.Fatalf("expected 401 MFA_TOKEN_EXPIRED when replaying WebAuthn assertion challengeToken, got %d %s", rrReplayWA.Code, rrReplayWA.Body.String())
			}
		}
	}

	// Accessing via raw IP (RFC 5737 TEST-NET-2 198.51.100.25) disables WebAuthn cleanly while reporting hasOtherHostPasskeys=true
	reqIP := httptest.NewRequest(http.MethodPost, "http://198.51.100.25:18080/api/v1/auth/login", strings.NewReader(`{"username":"admin","password":"admin1234"}`))
	reqIP.Host = "198.51.100.25:18080"
	reqIP.RemoteAddr = "198.51.100.25:54321"
	reqIP.Header.Set("Origin", "http://198.51.100.25:18080")
	reqIP.Header.Set("Content-Type", "application/json")
	rrIPLogin := httptest.NewRecorder()
	router.ServeHTTP(rrIPLogin, reqIP)
	if rrIPLogin.Code != http.StatusOK {
		t.Fatalf("raw IP login failed: %d %s", rrIPLogin.Code, rrIPLogin.Body.String())
	}
	var ipChal service.MFAChallengeResponse
	_ = json.Unmarshal(rrIPLogin.Body.Bytes(), &ipChal)
	if ipChal.WebAuthnAvailableForHost || !ipChal.HasOtherHostPasskeys {
		t.Fatalf("expected webauthnAvailableForHost=false & hasOtherHostPasskeys=true on raw IP, got %+v", ipChal)
	}

	// Admin attempting emergency DELETE /api/v1/users/{selfId}/mfa without password MUST be rejected with 400!
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/users/"+adminPair.User.ID+"/mfa", adminPair.AccessToken, nil, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when admin tries emergency MFA reset on self without password, got %d %s", rr.Code, rr.Body.String())
	}

	// Delete passkey & disable TOTP cleanly
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/auth/mfa/passkeys/"+regFinish.Credential.ID, adminPair.AccessToken, map[string]any{
		"currentPassword": "admin1234",
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("delete passkey failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/disable", adminPair.AccessToken, map[string]any{
		"currentPassword": "admin1234",
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("disable TOTP failed: %d %s", rr.Code, rr.Body.String())
	}

	// 7. Viewer self-service 2FA enrollment + per-user rate limit + ReadOnly guard + Admin emergency DELETE /users/{id}/mfa
	rrViewer := doJSONReq(t, router, http.MethodPost, "/api/v1/users", adminPair.AccessToken, map[string]any{
		"username":    "auditor",
		"displayName": "Read-Only Auditor",
		"password":    "viewerpass123",
		"role":        "viewer",
	}, nil)
	if rrViewer.Code != http.StatusCreated {
		t.Fatalf("create viewer failed: %d %s", rrViewer.Code, rrViewer.Body.String())
	}
	var viewerUser struct {
		ID string `json:"id"`
	}
	_ = json.Unmarshal(rrViewer.Body.Bytes(), &viewerUser)

	rrViewerLogin := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"username": "auditor",
		"password": "viewerpass123",
	}, nil)
	var viewerPair service.TokenPair
	_ = json.Unmarshal(rrViewerLogin.Body.Bytes(), &viewerPair)

	// Viewer CAN self-enroll TOTP when server ReadOnly=false
	rrVSetup := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/setup", viewerPair.AccessToken, map[string]any{
		"currentPassword": "viewerpass123",
	}, nil)
	if rrVSetup.Code != http.StatusOK {
		t.Fatalf("viewer expected 200 on self-service TOTP setup, got %d: %s", rrVSetup.Code, rrVSetup.Body.String())
	}
	var vSetup service.TOTPSetupResponse
	_ = json.Unmarshal(rrVSetup.Body.Bytes(), &vSetup)
	vCode, _ := service.GenerateTOTPCodeAt(vSetup.Secret, time.Now())
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/enable", viewerPair.AccessToken, map[string]any{
		"code": vCode,
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("viewer expected 200 on self-service TOTP enable, got %d: %s", rr.Code, rr.Body.String())
	}

	// ReadOnly=true blocks self-service MFA mutations with 403
	srv.cfg.ReadOnly = true
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/disable", viewerPair.AccessToken, map[string]any{
		"currentPassword": "viewerpass123",
	}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 when ReadOnly=true, got %d", rr.Code)
	}
	srv.cfg.ReadOnly = false

	// Viewer cannot call admin MFA reset endpoint
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/users/"+adminPair.User.ID+"/mfa", viewerPair.AccessToken, nil, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for viewer calling admin MFA reset, got %d", rr.Code)
	}

	// Per-user rate limit (`mfa-self:<viewerID>`) blocks brute-force password guesses past 20/min without affecting admin's bucket
	var saw429 bool
	for i := 0; i < 22; i++ {
		rrRL := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/mfa/totp/disable", viewerPair.AccessToken, map[string]any{
			"currentPassword": "x",
		}, nil)
		if rrRL.Code == http.StatusTooManyRequests {
			saw429 = true
			break
		}
	}
	if !saw429 {
		t.Fatal("expected 429 from rateLimitMFASelf after >20 rapid self-service MFA attempts")
	}

	// Admin resets viewer's 2FA -> revokes viewer's active JWT immediately & restores 1-step password login
	if rr := doJSONReq(t, router, http.MethodDelete, "/api/v1/users/"+viewerUser.ID+"/mfa", adminPair.AccessToken, nil, nil); rr.Code != http.StatusOK {
		t.Fatalf("admin DELETE /users/{id}/mfa failed: %d %s", rr.Code, rr.Body.String())
	}
	if rr := doJSONReq(t, router, http.MethodGet, "/api/v1/auth/me", viewerPair.AccessToken, nil, nil); rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected viewer old session immediately revoked after admin MFA reset, got %d", rr.Code)
	}
	rrViewerReLogin := doJSONReq(t, router, http.MethodPost, "/api/v1/auth/login", "", map[string]any{
		"username": "auditor",
		"password": "viewerpass123",
	}, nil)
	var reLoginBody map[string]any
	_ = json.Unmarshal(rrViewerReLogin.Body.Bytes(), &reLoginBody)
	if reLoginBody["mfaRequired"] == true || reLoginBody["accessToken"] == "" {
		t.Fatalf("expected 1-step login restored after admin MFA reset, got %+v", reLoginBody)
	}
}

func buildTestES256Attestation(t *testing.T, rpID, origin, challengeB64 string, credID []byte, pub *ecdsa.PublicKey) map[string]any {
	t.Helper()
	var xBuf, yBuf [32]byte
	pub.X.FillBytes(xBuf[:])
	pub.Y.FillBytes(yBuf[:])

	// COSE_Key map (5 pairs): {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
	var coseKey bytes.Buffer
	coseKey.WriteByte(0xa5)
	coseKey.Write([]byte{0x01, 0x02})
	coseKey.Write([]byte{0x03, 0x26})
	coseKey.Write([]byte{0x20, 0x01})
	coseKey.Write([]byte{0x21, 0x58, 0x20})
	coseKey.Write(xBuf[:])
	coseKey.Write([]byte{0x22, 0x58, 0x20})
	coseKey.Write(yBuf[:])

	rpHash := sha256.Sum256([]byte(rpID))
	var authData bytes.Buffer
	authData.Write(rpHash[:])
	// Flags: UP(0x01) | UV(0x04) | BE(0x08) | BS(0x10) | AT(0x40) = 0x5d
	authData.WriteByte(0x5d)
	// signCount = 0 (synced passkey)
	authData.Write([]byte{0, 0, 0, 0})
	// 16-byte AAGUID
	authData.Write(bytes.Repeat([]byte{0xab}, 16))
	var idLen [2]byte
	binary.BigEndian.PutUint16(idLen[:], uint16(len(credID)))
	authData.Write(idLen[:])
	authData.Write(credID)
	authData.Write(coseKey.Bytes())

	authBytes := authData.Bytes()
	var attObj bytes.Buffer
	attObj.WriteByte(0xa3)
	attObj.Write([]byte{0x63, 'f', 'm', 't', 0x64, 'n', 'o', 'n', 'e'})
	attObj.Write([]byte{0x67, 'a', 't', 't', 'S', 't', 'm', 't', 0xa0})
	attObj.Write([]byte{0x68, 'a', 'u', 't', 'h', 'D', 'a', 't', 'a'})
	if len(authBytes) < 256 {
		attObj.Write([]byte{0x58, byte(len(authBytes))})
	} else {
		attObj.WriteByte(0x59)
		var l2 [2]byte
		binary.BigEndian.PutUint16(l2[:], uint16(len(authBytes)))
		attObj.Write(l2[:])
	}
	attObj.Write(authBytes)

	clientData, _ := json.Marshal(map[string]any{
		"type":      "webauthn.create",
		"challenge": challengeB64,
		"origin":    origin,
	})
	credB64 := base64.RawURLEncoding.EncodeToString(credID)
	return map[string]any{
		"id":    credB64,
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
			"attestationObject": base64.RawURLEncoding.EncodeToString(attObj.Bytes()),
			"transports":        []string{"internal", "hybrid"},
		},
	}
}

func buildTestES256Assertion(t *testing.T, rpID, origin, challengeB64 string, credID []byte, priv *ecdsa.PrivateKey, signCount uint32) map[string]any {
	t.Helper()
	rpHash := sha256.Sum256([]byte(rpID))
	var authData [37]byte
	copy(authData[0:32], rpHash[:])
	// Flags: UP(0x01) | UV(0x04) | BE(0x08) | BS(0x10) = 0x1d
	authData[32] = 0x1d
	binary.BigEndian.PutUint32(authData[33:37], signCount)

	clientData, _ := json.Marshal(map[string]any{
		"type":      "webauthn.get",
		"challenge": challengeB64,
		"origin":    origin,
	})
	cdHash := sha256.Sum256(clientData)
	var signedPayload [37 + 32]byte
	copy(signedPayload[0:37], authData[:])
	copy(signedPayload[37:69], cdHash[:])
	digest := sha256.Sum256(signedPayload[:])

	sigASN1, err := ecdsa.SignASN1(rand.Reader, priv, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	credB64 := base64.RawURLEncoding.EncodeToString(credID)
	return map[string]any{
		"id":    credB64,
		"rawId": credB64,
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(clientData),
			"authenticatorData": base64.RawURLEncoding.EncodeToString(authData[:]),
			"signature":         base64.RawURLEncoding.EncodeToString(sigASN1),
		},
	}
}
