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

func newTestAPIServer(t *testing.T) (*Server, *service.TokenPair, http.Handler) {
	t.Helper()
	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "test_api.db"))
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
	auth.SetCryptoBox(box)
	pool := pve.NewPool(st, box)
	agg := service.NewAggregatorService(st, pool)
	console := pve.NewConsoleManager(pool)
	cfg := &config.Config{}

	srv := NewServer(cfg, st, box, auth, pool, agg, nil, console, nil, context.Background())
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

func TestCookieCSRFProtection(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)
	srv.cfg.PublicURL = "https://dash.example.com"

	doCookiePut := func(host, origin, secFetchSite string) *httptest.ResponseRecorder {
		body, _ := json.Marshal(map[string]any{
			"theme":       "obsidian",
			"density":     "compact",
			"refreshSec":  5,
			"sidebarMode": "functional",
		})
		req := httptest.NewRequest(http.MethodPut, "http://"+host+"/api/v1/preferences", bytes.NewReader(body))
		req.Host = host
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "pve_dash_access", Value: adminPair.AccessToken})
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		if secFetchSite != "" {
			req.Header.Set("Sec-Fetch-Site", secFetchSite)
		}
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		return rr
	}

	// 1. Same-IP cross-port attack (SameSite=Lax sends cookies, CSRF middleware must reject with 403)
	if rr := doCookiePut("198.51.100.10:18080", "http://198.51.100.10:3000", "same-site"); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for same-IP cross-port cookie write, got %d %s", rr.Code, rr.Body.String())
	}
	// Even without Sec-Fetch-Site, mismatched Origin port must be rejected
	if rr := doCookiePut("198.51.100.10:18080", "http://198.51.100.10:3000", ""); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-port Origin without Sec-Fetch-Site, got %d", rr.Code)
	}

	// 2. Sibling subdomain attack & cross-site Sec-Fetch-Site & null Origin
	if rr := doCookiePut("pve.example.com", "https://evil.example.com", "same-site"); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for sibling subdomain CSRF, got %d", rr.Code)
	}
	if rr := doCookiePut("pve.example.com", "", "cross-site"); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for Sec-Fetch-Site=cross-site, got %d", rr.Code)
	}
	if rr := doCookiePut("pve.example.com", "null", "same-origin"); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for Origin=null, got %d", rr.Code)
	}

	// 3. Legitimate same-origin & configured PublicURL requests succeed
	if rr := doCookiePut("198.51.100.10:18080", "http://198.51.100.10:18080", "same-origin"); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for exact same-origin cookie write, got %d %s", rr.Code, rr.Body.String())
	}
	if rr := doCookiePut("internal-backend:8080", "https://dash.example.com", "same-origin"); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 for matching PublicURL cookie write, got %d %s", rr.Code, rr.Body.String())
	}

	// 4. Cross-origin POST /auth/refresh and /auth/logout are blocked even with cookies
	refreshReq := httptest.NewRequest(http.MethodPost, "http://198.51.100.10:18080/api/v1/auth/refresh", nil)
	refreshReq.Host = "198.51.100.10:18080"
	refreshReq.Header.Set("Origin", "http://198.51.100.10:3000")
	refreshReq.AddCookie(&http.Cookie{Name: "pve_dash_refresh", Value: adminPair.RefreshToken})
	rrRefresh := httptest.NewRecorder()
	router.ServeHTTP(rrRefresh, refreshReq)
	if rrRefresh.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-port /auth/refresh, got %d", rrRefresh.Code)
	}

	// 5. Referer fallback when both Sec-Fetch-Site and Origin are absent
	refBadReq := httptest.NewRequest(http.MethodPut, "http://198.51.100.10:18080/api/v1/preferences", bytes.NewReader([]byte(`{"refreshSec":5}`)))
	refBadReq.Host = "198.51.100.10:18080"
	refBadReq.Header.Set("Content-Type", "application/json")
	refBadReq.Header.Set("Referer", "http://198.51.100.10:3000/csrf.html")
	refBadReq.AddCookie(&http.Cookie{Name: "pve_dash_access", Value: adminPair.AccessToken})
	rrRefBad := httptest.NewRecorder()
	router.ServeHTTP(rrRefBad, refBadReq)
	if rrRefBad.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-port Referer when Origin/Sec-Fetch-Site absent, got %d", rrRefBad.Code)
	}

	refGoodReq := httptest.NewRequest(http.MethodPut, "http://198.51.100.10:18080/api/v1/preferences", bytes.NewReader([]byte(`{"refreshSec":5}`)))
	refGoodReq.Host = "198.51.100.10:18080"
	refGoodReq.Header.Set("Content-Type", "application/json")
	refGoodReq.Header.Set("Referer", "http://198.51.100.10:18080/settings?tab=appearance")
	refGoodReq.AddCookie(&http.Cookie{Name: "pve_dash_access", Value: adminPair.AccessToken})
	rrRefGood := httptest.NewRecorder()
	router.ServeHTTP(rrRefGood, refGoodReq)
	if rrRefGood.Code != http.StatusOK {
		t.Fatalf("expected 200 for same-origin Referer fallback, got %d %s", rrRefGood.Code, rrRefGood.Body.String())
	}

	// 6. Explicit Authorization: Bearer requests (e.g. Capacitor mobile app) bypass cookie CSRF check
	rrBearer := doJSONReq(t, router, http.MethodPut, "/api/v1/preferences", adminPair.AccessToken, map[string]any{
		"theme":       "obsidian",
		"density":     "comfortable",
		"refreshSec":  10,
		"sidebarMode": "tree",
	}, map[string]string{
		"Origin":         "capacitor://localhost",
		"Sec-Fetch-Site": "cross-site",
	})
	if rrBearer.Code != http.StatusOK {
		t.Fatalf("expected Bearer request allowed, got %d %s", rrBearer.Code, rrBearer.Body.String())
	}

	// 7. DevCORS preflight allows X-Requested-With and IPv6 loopback [::1]
	srv.cfg.DevCORS = true
	devRouter := srv.Router()
	for _, devOrigin := range []string{"http://localhost:5173", "http://[::1]:5173"} {
		optReq := httptest.NewRequest(http.MethodOptions, "http://127.0.0.1:8080/api/v1/overview", nil)
		optReq.Header.Set("Origin", devOrigin)
		optReq.Header.Set("Access-Control-Request-Method", "POST")
		optReq.Header.Set("Access-Control-Request-Headers", "Content-Type, X-Requested-With")
		rrOpt := httptest.NewRecorder()
		devRouter.ServeHTTP(rrOpt, optReq)
		if rrOpt.Code != http.StatusNoContent {
			t.Fatalf("expected 204 on DevCORS preflight for %s, got %d", devOrigin, rrOpt.Code)
		}
		allowHdrs := rrOpt.Header().Get("Access-Control-Allow-Headers")
		if allowHdrs == "" || !bytes.Contains([]byte(allowHdrs), []byte("X-Requested-With")) {
			t.Fatalf("expected X-Requested-With in Access-Control-Allow-Headers, got %q", allowHdrs)
		}
	}

	// 8. GET /overview serves pre-marshaled JSON cleanly
	rrOv := doJSONReq(t, router, http.MethodGet, "/api/v1/overview", adminPair.AccessToken, nil, nil)
	if rrOv.Code != http.StatusOK {
		t.Fatalf("expected 200 on GET /overview, got %d %s", rrOv.Code, rrOv.Body.String())
	}
	var ovMap map[string]any
	if err := json.Unmarshal(rrOv.Body.Bytes(), &ovMap); err != nil {
		t.Fatalf("expected valid JSON from GET /overview, got err=%v body=%q", err, rrOv.Body.String())
	}
}

func TestPreferencesValidationAndReadOnlyProtection(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	// Invalid density, sidebarMode, refreshSec, and oversized theme rejected with 400
	badPayloads := []map[string]any{
		{"density": "ultra-wide", "refreshSec": 5},
		{"sidebarMode": "floating", "refreshSec": 5},
		{"refreshSec": 1},
		{"refreshSec": 120},
		{"theme": "this-theme-name-exceeds-thirty-two-characters-limit", "refreshSec": 5},
	}
	for i, p := range badPayloads {
		if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/preferences", adminPair.AccessToken, p, nil); rr.Code != http.StatusBadRequest {
			t.Fatalf("case %d: expected 400 for invalid preferences %+v, got %d %s", i, p, rr.Code, rr.Body.String())
		}
	}

	// ReadOnly mode blocks preference writes and skips DB mutation during handleProbeInstance
	mockPVE := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/version":
			_, _ = w.Write([]byte(`{"data":{"version":"9.1.2","release":"9.1"}}`))
		case "/api2/json/cluster/status":
			_, _ = w.Write([]byte(`{"data":[{"type":"node","name":"pve"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer mockPVE.Close()

	encSec, _ := srv.box.EncryptString("secret")
	if err := srv.store.SaveInstance(context.Background(), &store.PVEInstance{
		ID:             "inst-ro",
		Name:           "ro-test",
		GroupName:      "lab",
		Color:          "#22C55E",
		AuthMode:       "token",
		TokenID:        "root@pam!tok",
		TokenSecretEnc: encSec,
		TLSMode:        "tofu",
		Enabled:        true,
		Endpoints: []store.PVEEndpoint{
			{ID: "ep-ro", InstanceID: "inst-ro", URL: mockPVE.URL, Priority: 10},
		},
	}, true); err != nil {
		t.Fatal(err)
	}

	srv.cfg.ReadOnly = true
	if rr := doJSONReq(t, router, http.MethodPut, "/api/v1/preferences", adminPair.AccessToken, map[string]any{"refreshSec": 10}, nil); rr.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for PUT /preferences in ReadOnly mode, got %d", rr.Code)
	}

	rrProbe := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-ro/probe", adminPair.AccessToken, nil, nil)
	if rrProbe.Code != http.StatusOK {
		t.Fatalf("expected 200 on probe in ReadOnly mode, got %d %s", rrProbe.Code, rrProbe.Body.String())
	}
	reloaded, err := srv.store.GetInstance(context.Background(), "inst-ro")
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.DetectedVersion != "" || reloaded.Endpoints[0].CertFingerprint != "" {
		t.Fatalf("ReadOnly probe must not persist TOFU/detection to DB, got version=%q fp=%q", reloaded.DetectedVersion, reloaded.Endpoints[0].CertFingerprint)
	}
}
