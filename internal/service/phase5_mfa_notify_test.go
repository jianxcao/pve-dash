package service

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
)

func TestNotifyChannelProtocolAndMasking(t *testing.T) {
	// 1. Endpoint resolution & SSRF validation
	ep1, err := ResolveNotifyEndpoint(ChannelConfig{
		URL:      "https://notify.example.com:2053",
		AppID:    "pve",
		PanelURL: "https://dash.example.com",
	})
	if err != nil || ep1 != "https://notify.example.com:2053/api/v1/notify/pve" {
		t.Fatalf("ResolveNotifyEndpoint base+appId: got (%q, %v)", ep1, err)
	}
	ep2, err := ResolveNotifyEndpoint(ChannelConfig{
		URL: "https://notify.example.com:2053/api/v1/notify/homelab",
	})
	if err != nil || ep2 != "https://notify.example.com:2053/api/v1/notify/homelab" {
		t.Fatalf("ResolveNotifyEndpoint full URL: got (%q, %v)", ep2, err)
	}
	// Trailing /api/v1/notify/ with empty segment must use AppID or reject if AppID is empty
	if _, err := ResolveNotifyEndpoint(ChannelConfig{URL: "https://notify.example.com:2053/api/v1/notify/"}); err == nil {
		t.Fatal("expected trailing /api/v1/notify/ without AppID rejected")
	}
	epTrailing, err := ResolveNotifyEndpoint(ChannelConfig{
		URL:   "https://notify.example.com:2053/api/v1/notify/?env=prod",
		AppID: "pve",
	})
	if err != nil || epTrailing != "https://notify.example.com:2053/api/v1/notify/pve?env=prod" {
		t.Fatalf("ResolveNotifyEndpoint trailing slash + query: got (%q, %v)", epTrailing, err)
	}
	epQuery, err := ResolveNotifyEndpoint(ChannelConfig{
		URL:   "https://notify.example.com:2053/sub?token=abc",
		AppID: "pve",
	})
	if err != nil || epQuery != "https://notify.example.com:2053/sub/api/v1/notify/pve?token=abc" {
		t.Fatalf("ResolveNotifyEndpoint base + query: got (%q, %v)", epQuery, err)
	}
	if _, err := ResolveNotifyEndpoint(ChannelConfig{URL: "http://127.0.0.1:8080", AppID: "pve"}); err == nil {
		t.Fatal("expected loopback Notify URL rejected")
	}
	if _, err := ResolveNotifyEndpoint(ChannelConfig{URL: "https://notify.example.com"}); err == nil {
		t.Fatal("expected missing AppID without /api/v1/notify/ path rejected")
	}

	preview := MaskChannelConfig("notify", ChannelConfig{
		URL:      "https://notify.example.com:2053",
		Secret:   "super-secret-bearer-token",
		AppID:    "pve",
		Targets:  "ops,admin",
		PanelURL: "https://dash.example.com",
	})
	if preview["hasSecret"] != true || preview["appId"] != "pve" || preview["targets"] != "ops,admin" {
		t.Fatalf("unexpected notify MaskChannelConfig: %+v", preview)
	}

	// 2. HTTP 200 with code==0 vs HTTP 200 with code!=0 (jianxcao/notify error contract)
	var mu sync.Mutex
	respCode := 0
	respMsg := "success"
	var gotAuth, gotPath string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		gotAuth = r.Header.Get("Authorization")
		gotPath = r.URL.Path
		_ = json.Unmarshal(raw, &gotBody)
		c, m := respCode, respMsg
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": c, "msg": m})
	}))
	defer srv.Close()

	origClient := notifyHTTPClient
	defer func() { notifyHTTPClient = origClient }()
	notifyHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			clone := req.Clone(req.Context())
			clone.URL.Scheme = "http"
			clone.URL.Host = strings.TrimPrefix(srv.URL, "http://")
			return http.DefaultTransport.RoundTrip(clone)
		}),
	}

	cfg := ChannelConfig{
		URL:      "https://notify.example.com:2053",
		Secret:   "my-notify-token-123",
		AppID:    "pve",
		Targets:  "feishu-ops",
		PanelURL: "https://dash.example.com",
	}
	err = DispatchNotification(context.Background(), "notify", cfg, AlertNotice{
		EventType:    "ops",
		Severity:     "warning",
		Title:        "手动执行备份 (VZDump)",
		Message:      "VM #101 备份已完成",
		RuleName:     "备份与恢复任务",
		InstanceName: "prod-cluster",
		ResourceName: "qemu/101",
		Metric:       "backup.ops",
	})
	if err != nil {
		t.Fatalf("DispatchNotification notify code=0 failed: %v", err)
	}

	mu.Lock()
	if gotPath != "/api/v1/notify/pve" {
		t.Fatalf("expected path /api/v1/notify/pve, got %q", gotPath)
	}
	if gotAuth != "Bearer my-notify-token-123" {
		t.Fatalf("expected Bearer auth header, got %q", gotAuth)
	}
	if !strings.HasPrefix(gotBody["title"].(string), "[运维事件]") {
		t.Fatalf("expected [运维事件] prefix in title, got %v", gotBody["title"])
	}
	fields, _ := gotBody["fields"].(map[string]any)
	if _, hasType := fields["type"]; hasType {
		t.Fatalf("fields must NOT set 'type' so doc/pve.md template renders content cleanly: %+v", fields)
	}
	respCode = 5001
	respMsg = "upstream bot token invalid"
	mu.Unlock()

	err = DispatchNotification(context.Background(), "notify", cfg, AlertNotice{
		EventType: "security",
		Severity:  "critical",
		Title:     "异常登录拦截",
		Message:   "密码错误",
	})
	if err == nil || !strings.Contains(err.Error(), "code=5001") {
		t.Fatalf("expected HTTP 200 code=5001 to return Notify error, got %v", err)
	}
}

func TestAlertEngineNotifyOnResolveToggleAndEventNotifier(t *testing.T) {
	var mu sync.Mutex
	cpuHigh := true
	var receivedTitles []string

	pveSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		high := cpuHigh
		mu.Unlock()
		cpuVal := 0.20
		if high {
			cpuVal = 0.95
		}
		switch r.URL.Path {
		case "/api2/json/cluster/resources":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{
					{"type": "node", "node": "pve1", "status": "online", "cpu": cpuVal, "maxcpu": 8, "mem": 1000, "maxmem": 8000},
				},
			})
		case "/api2/json/cluster/status", "/api2/json/cluster/tasks":
			_, _ = w.Write([]byte(`{"data":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer pveSrv.Close()

	notifySrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		if title, ok := body["title"].(string); ok {
			receivedTitles = append(receivedTitles, title)
		}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"code":0,"msg":"success"}`))
	}))
	defer notifySrv.Close()

	origClient := notifyHTTPClient
	defer func() { notifyHTTPClient = origClient }()
	notifyHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			clone := req.Clone(req.Context())
			clone.URL.Scheme = "http"
			clone.URL.Host = strings.TrimPrefix(notifySrv.URL, "http://")
			return http.DefaultTransport.RoundTrip(clone)
		}),
	}

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "notify_resolve.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	seeded, _ := st.ListAlertRules(ctx)
	for _, sr := range seeded {
		sr.Enabled = false
		_ = st.UpdateAlertRule(ctx, &sr)
	}

	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x66}, 32))
	encSec, _ := box.EncryptString("sec")
	_ = st.SaveInstance(ctx, &store.PVEInstance{
		ID:               "inst-nr",
		Name:             "nr-cluster",
		GroupName:        "prod",
		Color:            "#22C55E",
		AuthMode:         "token",
		TokenID:          "root@pam!t",
		TokenSecretEnc:   encSec,
		TLSMode:          "insecure",
		Enabled:          true,
		DetectedVersion:  "8.3.0",
		CapabilitiesJSON: `{"pveVersion":"8.3.0"}`,
		Endpoints:        []store.PVEEndpoint{{ID: "ep1", InstanceID: "inst-nr", URL: pveSrv.URL, Priority: 1, IsHealthy: true}},
	}, true)

	cfgRaw, _ := json.Marshal(ChannelConfig{URL: "https://notify.example.com:2053/api/v1/notify/pve", Secret: "tok"})
	cfgEnc, _ := box.EncryptString(string(cfgRaw))
	_ = st.CreateAlertChannel(ctx, &store.AlertChannel{
		ID:        "ch-n",
		Name:      "Notify",
		Type:      "notify",
		ConfigEnc: cfgEnc,
		Enabled:   true,
	})

	// Rule A: NotifyOnResolve = true; Rule B: NotifyOnResolve = false
	_ = st.CreateAlertRule(ctx, &store.AlertRule{
		ID: "r-yes", Name: "CPU With Resolve", Enabled: true, Severity: "warning",
		Metric: "node_cpu", Operator: "gte", Threshold: 80, CooldownMin: 30, NotifyOnResolve: true,
	})
	_ = st.CreateAlertRule(ctx, &store.AlertRule{
		ID: "r-no", Name: "CPU Silent Resolve", Enabled: true, Severity: "warning",
		Metric: "node_cpu", Operator: "gte", Threshold: 85, CooldownMin: 30, NotifyOnResolve: false,
	})

	pool := pve.NewPool(st, box)
	defer pool.Close()
	agg := NewAggregatorService(st, pool)
	eng := NewAlertEngine(st, box, pool, agg)

	// Fire both rules
	if _, err := eng.EvaluateNow(ctx, false); err != nil {
		t.Fatal(err)
	}
	eng.Wait()

	// Recover CPU -> both auto-resolve, but ONLY r-yes sends [已恢复] notification!
	mu.Lock()
	cpuHigh = false
	mu.Unlock()
	agg.InvalidateCache()
	res, err := eng.EvaluateNow(ctx, false)
	if err != nil || res.AutoResolved != 2 {
		t.Fatalf("expected AutoResolved=2, got (%+v, %v)", res, err)
	}
	eng.Wait()

	mu.Lock()
	resolvedCount := 0
	for _, title := range receivedTitles {
		if strings.HasPrefix(title, "[已恢复]") {
			resolvedCount++
			if !strings.Contains(title, "CPU With Resolve") {
				t.Fatalf("unexpected resolved notification title: %q", title)
			}
		}
	}
	receivedTitles = nil
	mu.Unlock()
	if resolvedCount != 1 {
		t.Fatalf("expected exactly 1 [已恢复] notification (NotifyOnResolve=true only), got %d", resolvedCount)
	}

	// Test EventNotifier: failed_only filtering, login new-IP detection, and 60s anomaly dedup
	_ = st.UpsertEventSubscriptions(ctx, []store.EventSubscription{
		{Category: store.EventCatBackupOps, Enabled: true, TriggerMode: "failed_only"},
		{Category: store.EventCatSecurityLoginSuccess, Enabled: true, TriggerMode: "all"},
		{Category: store.EventCatSecurityLoginAnomaly, Enabled: true, TriggerMode: "all"},
	})
	evNotifier := NewEventNotifier(st, box)
	defer evNotifier.Stop()

	// ClassifyAuditAction coverage check
	if cat, _, ok := ClassifyAuditAction("qemu.start"); !ok || cat != store.EventCatVMPower {
		t.Fatalf("ClassifyAuditAction(qemu.start) = (%q, %v)", cat, ok)
	}
	if cat, _, ok := ClassifyAuditAction("backup.vzdump"); !ok || cat != store.EventCatBackupOps {
		t.Fatalf("ClassifyAuditAction(backup.vzdump) = (%q, %v)", cat, ok)
	}
	if cat, _, ok := ClassifyAuditAction("user.mfa.reset"); !ok || cat != store.EventCatSecurityAccountChange {
		t.Fatalf("ClassifyAuditAction(user.mfa.reset) = (%q, %v)", cat, ok)
	}

	// Successful backup should be ignored under failed_only; failed backup should send
	evNotifier.Publish(EventDispatch{Category: store.EventCatBackupOps, Title: "Backup OK", Message: "ok", Failed: false})
	evNotifier.Publish(EventDispatch{Category: store.EventCatBackupOps, Title: "Backup Failed", Message: "disk full", Failed: true})
	// Login from initial IP + second login from new IP
	evNotifier.RecordLoginSuccess("admin", "u1", "admin", "203.0.113.10", "Mozilla/5.0")
	evNotifier.RecordLoginSuccess("admin", "u1", "admin", "198.51.100.22", "Mozilla/5.0")
	// Two rapid anomalies from same IP -> deduplicated to 1!
	evNotifier.RecordLoginAnomaly("admin", "203.0.113.55", "密码或动态口令错误")
	evNotifier.RecordLoginAnomaly("admin", "203.0.113.55", "密码或动态口令错误")
	evNotifier.WaitIdle()

	mu.Lock()
	gotEvents := append([]string(nil), receivedTitles...)
	mu.Unlock()
	// Expected 4 dispatches: Backup Failed, Login 1, Login 2 (新 IP), Anomaly (1x deduped)
	if len(gotEvents) != 4 {
		t.Fatalf("expected 4 event notifications, got %d: %v", len(gotEvents), gotEvents)
	}
	hasNewIP := false
	for _, tStr := range gotEvents {
		if strings.Contains(tStr, "新 IP") {
			hasNewIP = true
		}
	}
	if !hasNewIP {
		t.Fatalf("expected new-IP login warning in %v", gotEvents)
	}
}

func TestEventNotifierConcurrentPublishStopWaitIdleRace(t *testing.T) {
	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "ev_race.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x99}, 32))
	_ = st.UpsertEventSubscriptions(context.Background(), []store.EventSubscription{
		{Category: store.EventCatVMPower, Enabled: true, TriggerMode: "all"},
	})

	for round := 0; round < 20; round++ {
		n := NewEventNotifier(st, box)
		var wg sync.WaitGroup
		for p := 0; p < 16; p++ {
			wg.Add(1)
			go func(id int) {
				defer wg.Done()
				for k := 0; k < 15; k++ {
					n.Publish(EventDispatch{
						Category: store.EventCatVMPower,
						Title:    "Concurrent Power Op",
						Message:  "ok",
					})
					if k%4 == 0 {
						n.WaitIdle()
					}
				}
			}(p)
		}
		for w := 0; w < 4; w++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				n.WaitIdle()
			}()
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			time.Sleep(time.Millisecond)
			n.Stop()
		}()
		wg.Wait()
		n.Stop()
		n.WaitIdle()
	}
}

func TestPhase5FullMFAFlowsTOTPPasskeysAndRecoveryCodes(t *testing.T) {
	// Verify QR generator across v1, v4, and v10 payloads
	for _, sample := range []string{"HELLO", strings.Repeat("otpauth://totp/PVE?secret=ABCDEF", 3), strings.Repeat("X", 230)} {
		svg, err := GenerateQRSVG(sample)
		if err != nil || !strings.HasPrefix(svg, "<svg") || !strings.Contains(svg, "<path") {
			t.Fatalf("GenerateQRSVG len=%d failed: err=%v", len(sample), err)
		}
	}
	if _, err := GenerateQRSVG(strings.Repeat("Z", 300)); err == nil {
		t.Fatal("expected overlong QR payload >271 bytes to return error")
	}

	// Verify RP ID validation (domain/localhost allowed, bare IP rejected)
	if !IsValidWebAuthnRPID("localhost") || !IsValidWebAuthnRPID("dash.example.com:8443") {
		t.Fatal("expected localhost and domain RP IDs to be valid")
	}
	if IsValidWebAuthnRPID("203.0.113.10") || IsValidWebAuthnRPID("[2001:db8::1]") {
		t.Fatal("expected bare IPv4/IPv6 literals rejected for WebAuthn RP ID")
	}
	if _, _, err := ResolveWebAuthnRP("203.0.113.10:8080", "http://203.0.113.10:8080", "", false); err == nil {
		t.Fatal("expected ResolveWebAuthnRP to reject bare IP origin")
	}

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "mfa_flows.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x77}, 32))
	auth := NewAuthService(st, bytes.Repeat([]byte{0x88}, 32))
	auth.SetCryptoBox(box)

	adminPair, err := auth.SetupAdminAndLogin(ctx, "admin", "System Admin", "StrongPass#2026", "test-ua", "203.0.113.1")
	if err != nil {
		t.Fatalf("SetupAdminAndLogin: %v", err)
	}
	uid := adminPair.User.ID

	// 1. TOTP Setup + Confirm + Login Challenge + Token Isolation + Anti-Replay
	totpSetup, err := auth.BeginTOTPSetup(ctx, uid, "StrongPass#2026")
	if err != nil || totpSetup.Secret == "" || !strings.HasPrefix(totpSetup.QRSVG, "<svg") {
		t.Fatalf("BeginTOTPSetup: (%+v, %v)", totpSetup, err)
	}
	// Setup uses step T-30s (-1 step skew) so current step T is still fresh for immediate login test!
	setupCode, err := GenerateTOTPCodeAt(totpSetup.Secret, time.Now().Add(-30*time.Second))
	if err != nil {
		t.Fatalf("GenerateTOTPCodeAt(-30s): %v", err)
	}
	enableRes, err := auth.ConfirmTOTPSetup(ctx, uid, setupCode)
	if err != nil || !enableRes.OK || !enableRes.TOTPEnabled || len(enableRes.RecoveryCodes) != 8 {
		t.Fatalf("ConfirmTOTPSetup expected 8 initial recovery codes, got (%+v, %v)", enableRes, err)
	}
	initialCodes := enableRes.RecoveryCodes

	// Direct Login() must now return ErrMFARequired
	if _, err := auth.Login(ctx, "admin", "StrongPass#2026", "ua", "203.0.113.1"); err != ErrMFARequired {
		t.Fatalf("expected ErrMFARequired when TOTP active, got %v", err)
	}

	primaryUser, err := auth.AuthenticatePrimary(ctx, "admin", "StrongPass#2026")
	if err != nil {
		t.Fatalf("AuthenticatePrimary: %v", err)
	}
	chal, err := auth.BuildLoginChallenge(ctx, primaryUser, "dash.example.com")
	if err != nil || chal == nil || !chal.MFARequired {
		t.Fatalf("BuildLoginChallenge: (%+v, %v)", chal, err)
	}
	// CRITICAL SECURITY INVARIANT: mfaToken MUST be rejected by ParseAccessToken!
	if _, err := auth.ParseAccessToken(chal.MFAToken); err == nil {
		t.Fatal("SECURITY BUG: ParseAccessToken accepted an mfa_challenge token!")
	}

	// Failed TOTP attempt returns ErrInvalidMFACode while keeping mfaToken retryable!
	if _, err := auth.VerifyTOTPLogin(ctx, chal.MFAToken, "000000", "ua", "203.0.113.1"); !errors.Is(err, ErrInvalidMFACode) {
		t.Fatalf("expected ErrInvalidMFACode on wrong TOTP code, got %v", err)
	}

	loginCode, _ := GenerateTOTPCodeAt(totpSetup.Secret, time.Now())
	totpPair, err := auth.VerifyTOTPLogin(ctx, chal.MFAToken, loginCode, "ua", "203.0.113.1")
	if err != nil || totpPair.AccessToken == "" {
		t.Fatalf("VerifyTOTPLogin: (%+v, %v)", totpPair, err)
	}
	// Once VerifyTOTPLogin succeeds, mfaToken is consumed -> replay returns ErrUnauthorized (NOT ErrInvalidMFACode)!
	if _, err := auth.VerifyTOTPLogin(ctx, chal.MFAToken, loginCode, "ua", "203.0.113.1"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected consumed mfaToken to return ErrUnauthorized, got %v", err)
	}
	// Replaying the exact same 6-digit TOTP code in the same 30s window EVEN with fresh mfaTokens MUST fail!
	var replayAllowed atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			cFresh, _ := auth.BuildLoginChallenge(ctx, primaryUser, "dash.example.com")
			if _, rErr := auth.VerifyTOTPLogin(ctx, cFresh.MFAToken, loginCode, "ua", "203.0.113.1"); rErr == nil {
				replayAllowed.Add(1)
			}
		}()
	}
	wg.Wait()
	if replayAllowed.Load() != 0 {
		t.Fatalf("expected 0 TOTP replays allowed across fresh mfaTokens, got %d", replayAllowed.Load())
	}

	// 2. WebAuthn Passkeys: ES256 hardware key + Ed25519 synced passkey (BE=1, BS=1, signCount=0)
	const rpID = "dash.example.com"
	const origin = "https://dash.example.com"

	// 2a. Malformed rawId base64url must be rejected; registration challengeToken is single-use
	regBadBegin, err := auth.BeginPasskeyRegistration(ctx, uid, "StrongPass#2026", "Bad RawID", rpID, origin)
	if err != nil {
		t.Fatalf("BeginPasskeyRegistration bad rawId: %v", err)
	}
	esPriv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	esCredID := []byte("cred-es256-hardware-01")
	badRawIDAtt := buildTestAttestationCBOR(rpID, 0x45, 1, esCredID, buildES256COSEKey(&esPriv.PublicKey))
	badRawIDCD, _ := json.Marshal(map[string]any{
		"type":      "webauthn.create",
		"challenge": regBadBegin.Options["challenge"].(string),
		"origin":    origin,
	})
	badRawIDBody, _ := json.Marshal(map[string]any{
		"id":    encodeBase64URL(esCredID),
		"rawId": "%%%invalid-base64url%%%",
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    encodeBase64URL(badRawIDCD),
			"attestationObject": encodeBase64URL(badRawIDAtt),
		},
	})
	if _, err := auth.FinishPasskeyRegistration(ctx, uid, regBadBegin.ChallengeToken, "Bad RawID", rpID, origin, badRawIDBody); err == nil {
		t.Fatal("expected malformed rawId base64url in FinishPasskeyRegistration to be rejected")
	}

	// Register ES256 key (wrapped in {"credential": ...} envelope) and verify registration challengeToken cannot be replayed
	regBeginES, err := auth.BeginPasskeyRegistration(ctx, uid, "StrongPass#2026", "YubiKey 5", rpID, origin)
	if err != nil || regBeginES.ChallengeToken == "" {
		t.Fatalf("BeginPasskeyRegistration ES256: %v", err)
	}
	esChal := regBeginES.Options["challenge"].(string)
	esAtt := buildTestAttestationCBOR(rpID, 0x45, 1, esCredID, buildES256COSEKey(&esPriv.PublicKey))
	esRegBody := buildTestRegCredentialJSON(esCredID, esChal, origin, esAtt, true)

	regFinES, err := auth.FinishPasskeyRegistration(ctx, uid, regBeginES.ChallengeToken, "YubiKey 5", rpID, origin, esRegBody)
	if err != nil || !regFinES.OK || regFinES.Credential.Name != "YubiKey 5" {
		t.Fatalf("FinishPasskeyRegistration ES256: (%+v, %v)", regFinES, err)
	}
	if _, err := auth.FinishPasskeyRegistration(ctx, uid, regBeginES.ChallengeToken, "Replay Reg", rpID, origin, esRegBody); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected replayed registration challengeToken rejected with ErrUnauthorized, got %v", err)
	}
	// Since recovery codes already existed from TOTP, registering a second factor should NOT overwrite them
	if len(regFinES.RecoveryCodes) != 0 {
		t.Fatalf("expected existing recovery codes preserved, got %v", regFinES.RecoveryCodes)
	}

	// 2b. Register Synced Passkey (Touch ID / Bitwarden: Ed25519, flags=0x5D UP|UV|BE|BS|AT, signCount=0)
	regBeginSync, err := auth.BeginPasskeyRegistration(ctx, uid, "StrongPass#2026", "Mac Touch ID / Bitwarden", rpID, origin)
	if err != nil {
		t.Fatalf("BeginPasskeyRegistration Synced: %v", err)
	}
	syncChal := regBeginSync.Options["challenge"].(string)
	edPub, edPriv, _ := ed25519.GenerateKey(rand.Reader)
	syncCredID := []byte("cred-synced-passkey-touchid")
	syncAtt := buildTestAttestationCBOR(rpID, 0x5D, 0, syncCredID, buildEd25519COSEKey(edPub))
	syncRegBody := buildTestRegCredentialJSON(syncCredID, syncChal, origin, syncAtt, false)

	regFinSync, err := auth.FinishPasskeyRegistration(ctx, uid, regBeginSync.ChallengeToken, "Mac Touch ID / Bitwarden", rpID, origin, syncRegBody)
	if err != nil || !regFinSync.Credential.BackupEligible || !regFinSync.Credential.BackupState {
		t.Fatalf("FinishPasskeyRegistration Synced: (%+v, %v)", regFinSync, err)
	}

	// Check domain-aware challenge & GetSecurityStatus WebAuthnAvailableForHost:
	// accessing from another domain reports WebAuthnAvailableForHost=false, WebAuthnSupportedForHost=true, HasOtherHostPasskeys=true!
	otherChal, err := auth.BuildLoginChallenge(ctx, primaryUser, "other.example.com")
	if err != nil || otherChal.WebAuthnAvailableForHost || !otherChal.HasOtherHostPasskeys {
		t.Fatalf("expected HasOtherHostPasskeys=true on other domain, got %+v (err=%v)", otherChal, err)
	}
	secOtherHost, err := auth.GetSecurityStatus(ctx, uid, "other.example.com")
	if err != nil || secOtherHost.WebAuthnAvailableForHost || !secOtherHost.WebAuthnSupportedForHost || !secOtherHost.HasOtherHostPasskeys {
		t.Fatalf("expected GetSecurityStatus WebAuthnAvailableForHost=false on other.example.com, got %+v (err=%v)", secOtherHost, err)
	}

	// 2c. Login twice with Synced Passkey reporting signCount=0 (each with fresh mfaToken + userHandle verification + anti-replay check!)
	for attempt := 1; attempt <= 2; attempt++ {
		stepChal, err := auth.BuildLoginChallenge(ctx, primaryUser, rpID)
		if err != nil || !stepChal.WebAuthnAvailableForHost || stepChal.HasOtherHostPasskeys {
			t.Fatalf("BuildLoginChallenge #%d: (%+v, %v)", attempt, stepChal, err)
		}
		loginBegin, err := auth.BeginPasskeyLogin(ctx, stepChal.MFAToken, rpID, origin)
		if err != nil {
			t.Fatalf("BeginPasskeyLogin #%d: %v", attempt, err)
		}
		lChal := loginBegin.Options["challenge"].(string)
		assertion := buildEd25519AssertionJSONWithUserHandle(syncCredID, rpID, origin, lChal, 0x1D, 0, edPriv, encodeBase64URL([]byte(uid)), attempt == 1)
		pkPair, err := auth.FinishPasskeyLogin(ctx, stepChal.MFAToken, loginBegin.ChallengeToken, rpID, origin, assertion, "ua", "203.0.113.1")
		if err != nil || pkPair.AccessToken == "" {
			t.Fatalf("FinishPasskeyLogin synced #%d (signCount=0): (%+v, %v)", attempt, pkPair, err)
		}
		// Replaying captured synced-passkey assertion (even with a brand new mfaToken!) MUST fail with ErrUnauthorized!
		freshChal, _ := auth.BuildLoginChallenge(ctx, primaryUser, rpID)
		if _, err := auth.FinishPasskeyLogin(ctx, freshChal.MFAToken, loginBegin.ChallengeToken, rpID, origin, assertion, "ua", "203.0.113.1"); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("expected replayed synced-passkey challengeToken rejected with ErrUnauthorized, got %v", err)
		}
		// Replaying consumed stepChal.MFAToken on BeginPasskeyLogin MUST also fail with ErrUnauthorized!
		if _, err := auth.BeginPasskeyLogin(ctx, stepChal.MFAToken, rpID, origin); !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("expected consumed mfaToken rejected on BeginPasskeyLogin, got %v", err)
		}
	}

	// 2d. Verify userHandle mismatch, wrong origin, and ES256 signCount clone check all return ErrInvalidMFACode while keeping mfaToken retryable!
	retryChal, _ := auth.BuildLoginChallenge(ctx, primaryUser, rpID)

	// Wrong userHandle -> ErrInvalidMFACode, mfaToken still valid!
	uhBegin, _ := auth.BeginPasskeyLogin(ctx, retryChal.MFAToken, rpID, origin)
	badUHAssertion := buildEd25519AssertionJSONWithUserHandle(syncCredID, rpID, origin, uhBegin.Options["challenge"].(string), 0x1D, 0, edPriv, encodeBase64URL([]byte("wrong-user-id")), false)
	if _, err := auth.FinishPasskeyLogin(ctx, retryChal.MFAToken, uhBegin.ChallengeToken, rpID, origin, badUHAssertion, "ua", "203.0.113.1"); !errors.Is(err, ErrInvalidMFACode) {
		t.Fatalf("expected wrong userHandle rejected with ErrInvalidMFACode, got %v", err)
	}

	// Wrong origin -> ErrInvalidMFACode, mfaToken STILL valid for next ceremony!
	hwBeginBad, _ := auth.BeginPasskeyLogin(ctx, retryChal.MFAToken, rpID, origin)
	badOriginAssertion := buildES256AssertionJSON(esCredID, rpID, "https://evil.example.com", hwBeginBad.Options["challenge"].(string), 0x05, 2, esPriv)
	if _, err := auth.FinishPasskeyLogin(ctx, retryChal.MFAToken, hwBeginBad.ChallengeToken, rpID, origin, badOriginAssertion, "ua", "203.0.113.1"); !errors.Is(err, ErrInvalidMFACode) {
		t.Fatalf("expected wrong-origin assertion rejected with ErrInvalidMFACode, got %v", err)
	}

	// Valid ES256 hardware key assertion on the SAME retryChal.MFAToken succeeds and consumes retryChal.MFAToken!
	hwBeginGood, err := auth.BeginPasskeyLogin(ctx, retryChal.MFAToken, rpID, origin)
	if err != nil {
		t.Fatalf("expected retryChal.MFAToken to remain retryable after failed assertions, got %v", err)
	}
	goodHWAssertion := buildES256AssertionJSON(esCredID, rpID, origin, hwBeginGood.Options["challenge"].(string), 0x05, 2, esPriv)
	if _, err := auth.FinishPasskeyLogin(ctx, retryChal.MFAToken, hwBeginGood.ChallengeToken, rpID, origin, goodHWAssertion, "ua", "203.0.113.1"); err != nil {
		t.Fatalf("FinishPasskeyLogin ES256 signCount=2 failed: %v", err)
	}

	// Non-incrementing hardware signCount=2 on next login fails with ErrInvalidMFACode
	cloneChal, _ := auth.BuildLoginChallenge(ctx, primaryUser, rpID)
	hwBeginClone, _ := auth.BeginPasskeyLogin(ctx, cloneChal.MFAToken, rpID, origin)
	staleCountAssertion := buildES256AssertionJSON(esCredID, rpID, origin, hwBeginClone.Options["challenge"].(string), 0x05, 2, esPriv)
	if _, err := auth.FinishPasskeyLogin(ctx, cloneChal.MFAToken, hwBeginClone.ChallengeToken, rpID, origin, staleCountAssertion, "ua", "203.0.113.1"); !errors.Is(err, ErrInvalidMFACode) {
		t.Fatalf("expected non-incrementing hardware signCount=2 rejected with ErrInvalidMFACode, got %v", err)
	}

	// 3. Recovery code single-use login (reusing cloneChal.MFAToken after failed passkey assertion!) + Regenerate + Admin MFA Reset
	recPair, err := auth.VerifyRecoveryCodeLogin(ctx, cloneChal.MFAToken, strings.ToLower(initialCodes[0]), "ua", "203.0.113.1")
	if err != nil || recPair.AccessToken == "" {
		t.Fatalf("VerifyRecoveryCodeLogin first use: %v", err)
	}
	// Replaying consumed cloneChal.MFAToken returns ErrUnauthorized; replaying consumed recovery code with fresh mfaToken returns ErrInvalidMFACode!
	if _, err := auth.VerifyRecoveryCodeLogin(ctx, cloneChal.MFAToken, initialCodes[1], "ua", "203.0.113.1"); !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("expected consumed mfaToken on VerifyRecoveryCodeLogin to return ErrUnauthorized, got %v", err)
	}
	recChal2, _ := auth.BuildLoginChallenge(ctx, primaryUser, rpID)
	if _, err := auth.VerifyRecoveryCodeLogin(ctx, recChal2.MFAToken, initialCodes[0], "ua", "203.0.113.1"); !errors.Is(err, ErrInvalidMFACode) {
		t.Fatalf("expected consumed recovery code rejected with ErrInvalidMFACode, got %v", err)
	}

	secStatus, err := auth.GetSecurityStatus(ctx, uid, rpID)
	if err != nil || !secStatus.MFAEnabled || !secStatus.WebAuthnAvailableForHost || len(secStatus.Passkeys) != 2 || secStatus.RecoveryCodesRemaining != 7 {
		t.Fatalf("GetSecurityStatus unexpected: (%+v, %v)", secStatus, err)
	}

	regenCodes, err := auth.RegenerateRecoveryCodes(ctx, uid, "StrongPass#2026")
	if err != nil || len(regenCodes) != 8 {
		t.Fatalf("RegenerateRecoveryCodes: (%v, %v)", regenCodes, err)
	}

	if err := auth.ResetUserMFA(ctx, uid); err != nil {
		t.Fatalf("ResetUserMFA: %v", err)
	}
	secAfterReset, _ := auth.GetSecurityStatus(ctx, uid, rpID)
	if secAfterReset.MFAEnabled || secAfterReset.TOTPEnabled || len(secAfterReset.Passkeys) != 0 || secAfterReset.RecoveryCodesRemaining != 0 {
		t.Fatalf("expected all 2FA factors cleared after ResetUserMFA, got %+v", secAfterReset)
	}
	// Unconsumed recChal2.MFAToken must now be invalid because ResetUserMFA bumped TokenVersion!
	if _, err := auth.ParseMFAToken(ctx, recChal2.MFAToken); err == nil {
		t.Fatal("expected old mfaToken invalidated after ResetUserMFA TokenVersion bump")
	}
}

// --- Test CBOR & WebAuthn Fixture Builders ---

func cborBytesHeader(major byte, n int) []byte {
	switch {
	case n < 24:
		return []byte{(major << 5) | byte(n)}
	case n <= 0xff:
		return []byte{(major << 5) | 24, byte(n)}
	default:
		return []byte{(major << 5) | 25, byte(n >> 8), byte(n)}
	}
}

func cborBstr(b []byte) []byte {
	return append(cborBytesHeader(2, len(b)), b...)
}

func cborTstr(s string) []byte {
	return append(cborBytesHeader(3, len(s)), []byte(s)...)
}

func buildES256COSEKey(pub *ecdsa.PublicKey) []byte {
	x := pub.X.FillBytes(make([]byte, 32))
	y := pub.Y.FillBytes(make([]byte, 32))
	var out bytes.Buffer
	out.WriteByte(0xa5) // map(5)
	out.Write([]byte{0x01, 0x02}) // 1: 2 (EC2)
	out.Write([]byte{0x03, 0x26}) // 3: -7 (ES256)
	out.Write([]byte{0x20, 0x01}) // -1: 1 (P-256)
	out.WriteByte(0x21)           // -2: x
	out.Write(cborBstr(x))
	out.WriteByte(0x22) // -3: y
	out.Write(cborBstr(y))
	return out.Bytes()
}

func buildEd25519COSEKey(pub ed25519.PublicKey) []byte {
	var out bytes.Buffer
	out.WriteByte(0xa4)           // map(4)
	out.Write([]byte{0x01, 0x01}) // 1: 1 (OKP)
	out.Write([]byte{0x03, 0x27}) // 3: -8 (EdDSA)
	out.Write([]byte{0x20, 0x06}) // -1: 6 (Ed25519)
	out.WriteByte(0x21)           // -2: x
	out.Write(cborBstr(pub))
	return out.Bytes()
}

func buildTestAttestationCBOR(rpID string, flags byte, signCount uint32, credID, coseKey []byte) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	var authData bytes.Buffer
	authData.Write(rpHash[:])
	authData.WriteByte(flags)
	var sc [4]byte
	binary.BigEndian.PutUint32(sc[:], signCount)
	authData.Write(sc[:])
	authData.Write(bytes.Repeat([]byte{0xaa}, 16)) // AAGUID
	var cidLen [2]byte
	binary.BigEndian.PutUint16(cidLen[:], uint16(len(credID)))
	authData.Write(cidLen[:])
	authData.Write(credID)
	authData.Write(coseKey)

	var att bytes.Buffer
	att.WriteByte(0xa2) // map(2)
	att.Write(cborTstr("fmt"))
	att.Write(cborTstr("none"))
	att.Write(cborTstr("authData"))
	att.Write(cborBstr(authData.Bytes()))
	return att.Bytes()
}

func buildTestRegCredentialJSON(credID []byte, challenge, origin string, attObj []byte, wrapped bool) []byte {
	cd, _ := json.Marshal(map[string]any{
		"type":      "webauthn.create",
		"challenge": challenge,
		"origin":    origin,
	})
	cred := map[string]any{
		"id":    encodeBase64URL(credID),
		"rawId": encodeBase64URL(credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    encodeBase64URL(cd),
			"attestationObject": encodeBase64URL(attObj),
			"transports":        []string{"internal", "hybrid"},
		},
	}
	if wrapped {
		b, _ := json.Marshal(map[string]any{"credential": cred})
		return b
	}
	b, _ := json.Marshal(cred)
	return b
}

func buildAssertionAuthData(rpID string, flags byte, signCount uint32) []byte {
	rpHash := sha256.Sum256([]byte(rpID))
	out := make([]byte, 37)
	copy(out[0:32], rpHash[:])
	out[32] = flags
	binary.BigEndian.PutUint32(out[33:37], signCount)
	return out
}

func buildEd25519AssertionJSONWithUserHandle(credID []byte, rpID, origin, challenge string, flags byte, signCount uint32, priv ed25519.PrivateKey, userHandle string, wrapped bool) []byte {
	cd, _ := json.Marshal(map[string]any{
		"type":      "webauthn.get",
		"challenge": challenge,
		"origin":    origin,
	})
	authData := buildAssertionAuthData(rpID, flags, signCount)
	cdHash := sha256.Sum256(cd)
	signed := append(append([]byte{}, authData...), cdHash[:]...)
	sig := ed25519.Sign(priv, signed)

	respObj := map[string]any{
		"clientDataJSON":    encodeBase64URL(cd),
		"authenticatorData": encodeBase64URL(authData),
		"signature":         encodeBase64URL(sig),
	}
	if userHandle != "" {
		respObj["userHandle"] = userHandle
	}
	cred := map[string]any{
		"id":       encodeBase64URL(credID),
		"rawId":    encodeBase64URL(credID),
		"type":     "public-key",
		"response": respObj,
	}
	if wrapped {
		b, _ := json.Marshal(map[string]any{"credential": cred})
		return b
	}
	b, _ := json.Marshal(cred)
	return b
}

func buildES256AssertionJSON(credID []byte, rpID, origin, challenge string, flags byte, signCount uint32, priv *ecdsa.PrivateKey) []byte {
	cd, _ := json.Marshal(map[string]any{
		"type":      "webauthn.get",
		"challenge": challenge,
		"origin":    origin,
	})
	authData := buildAssertionAuthData(rpID, flags, signCount)
	cdHash := sha256.Sum256(cd)
	signed := append(append([]byte{}, authData...), cdHash[:]...)
	digest := sha256.Sum256(signed)
	sig, _ := ecdsa.SignASN1(rand.Reader, priv, digest[:])

	b, _ := json.Marshal(map[string]any{
		"id":    encodeBase64URL(credID),
		"rawId": encodeBase64URL(credID),
		"type":  "public-key",
		"response": map[string]any{
			"clientDataJSON":    encodeBase64URL(cd),
			"authenticatorData": encodeBase64URL(authData),
			"signature":         encodeBase64URL(sig),
		},
	})
	return b
}
