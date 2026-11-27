package service

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
)

func TestAuthPasswordBoundsTimingPadAndInstantCacheInvalidation(t *testing.T) {
	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	auth := NewAuthService(st, bytes.Repeat([]byte{0x22}, 32))

	// Reject <8 and >128 passwords during initial setup
	if _, err := auth.SetupAdminAndLogin(ctx, "admin", "Admin", "short77", "ua", "127.0.0.1"); err == nil {
		t.Fatal("expected 7-char setup password rejected")
	}
	if _, err := auth.SetupAdminAndLogin(ctx, "admin", "Admin", strings.Repeat("a", 129), "ua", "127.0.0.1"); err == nil {
		t.Fatal("expected 129-char setup password rejected")
	}

	pair, err := auth.SetupAdminAndLogin(ctx, "admin", "Admin", "admin-pass-123", "ua", "127.0.0.1")
	if err != nil {
		t.Fatalf("SetupAdminAndLogin: %v", err)
	}

	// Unknown user and overlong password must both return ErrInvalidCredentials cleanly
	if _, err := auth.Login(ctx, "nonexistent", "wrong-pass-123", "ua", "127.0.0.1"); err != ErrInvalidCredentials {
		t.Fatalf("expected ErrInvalidCredentials for unknown user, got %v", err)
	}
	if _, err := auth.Login(ctx, "admin", strings.Repeat("x", 200), "ua", "127.0.0.1"); err != ErrInvalidCredentials {
		t.Fatalf("expected ErrInvalidCredentials for >128 password, got %v", err)
	}

	// Prime 2s user cache via GetActiveUser, then mutate user directly through Store (RevokeUserSessions)
	u1, err := auth.GetActiveUser(ctx, pair.User.ID)
	if err != nil || u1.TokenVersion != 1 {
		t.Fatalf("GetActiveUser initial: (%+v, %v)", u1, err)
	}
	if _, err := st.RevokeUserSessions(ctx, pair.User.ID); err != nil {
		t.Fatalf("RevokeUserSessions: %v", err)
	}
	// Immediate next GetActiveUser MUST reflect bumped TokenVersion=2 with zero stale cache window
	u2, err := auth.GetActiveUser(ctx, pair.User.ID)
	if err != nil || u2.TokenVersion != 2 {
		t.Fatalf("expected immediate TokenVersion=2 after store mutation, got (%+v, %v)", u2, err)
	}
}

func TestAggregatorOverviewJSONCacheAndForceFloor(t *testing.T) {
	var clusterHits atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/cluster/resources":
			clusterHits.Add(1)
			_, _ = w.Write([]byte(`{"data":[{"type":"node","node":"pve1","status":"online","cpu":0.2,"maxcpu":8,"mem":1024,"maxmem":4096}]}`))
		case "/api2/json/cluster/status":
			_, _ = w.Write([]byte(`{"data":[{"type":"node","name":"pve1","ip":"198.51.100.10","online":1}]}`))
		case "/api2/json/cluster/tasks":
			_, _ = w.Write([]byte(`{"data":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "agg.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x33}, 32))
	encSec, _ := box.EncryptString("sec")
	_ = st.SaveInstance(context.Background(), &store.PVEInstance{
		ID:               "i1",
		Name:             "lab",
		GroupName:        "g",
		Color:            "#22C55E",
		AuthMode:         "token",
		TokenID:          "root@pam!t",
		TokenSecretEnc:   encSec,
		TLSMode:          "insecure",
		Enabled:          true,
		DetectedVersion:  "8.3.0",
		CapabilitiesJSON: `{"pveVersion":"8.3.0"}`,
		Endpoints:        []store.PVEEndpoint{{ID: "ep1", InstanceID: "i1", URL: srv.URL, Priority: 1, IsHealthy: true}},
	}, true)

	pool := pve.NewPool(st, box)
	defer pool.Close()
	agg := NewAggregatorService(st, pool)

	ov, raw, err := agg.GetOverviewWithJSON(context.Background(), true)
	if err != nil || ov == nil || len(raw) == 0 {
		t.Fatalf("GetOverviewWithJSON: (%v, len=%d, err=%v)", ov, len(raw), err)
	}
	if clusterHits.Load() != 1 {
		t.Fatalf("expected 1 upstream hit, got %d", clusterHits.Load())
	}

	// Immediate second forceRefresh=true must hit 1s anti-stampede floor
	_, raw2, err := agg.GetOverviewWithJSON(context.Background(), true)
	if err != nil || !bytes.Equal(raw, raw2) || clusterHits.Load() != 1 {
		t.Fatalf("expected 1s anti-stampede floor on forceRefresh=true, clusterHits=%d", clusterHits.Load())
	}

	// Explicit InvalidateCache resets cachedAt so next call refreshes immediately
	agg.InvalidateCache()
	if _, _, err := agg.GetOverviewWithJSON(context.Background(), true); err != nil {
		t.Fatal(err)
	}
	if clusterHits.Load() != 2 {
		t.Fatalf("expected immediate refresh after InvalidateCache, clusterHits=%d", clusterHits.Load())
	}
}

func TestAlertEngineMigrationFingerprintZombieCleanupAndAsyncBackoff(t *testing.T) {
	var mu sync.Mutex
	guestNode := "pve1"
	guestPresent := true
	storagePresent := true

	pveSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gn, gp, sp := guestNode, guestPresent, storagePresent
		mu.Unlock()

		switch r.URL.Path {
		case "/api2/json/cluster/resources":
			items := []map[string]any{
				{"type": "node", "node": "pve1", "status": "online", "cpu": 0.1, "maxcpu": 8, "mem": 1000, "maxmem": 8000},
				{"type": "node", "node": "pve2", "status": "online", "cpu": 0.1, "maxcpu": 8, "mem": 1000, "maxmem": 8000},
			}
			if gp {
				items = append(items, map[string]any{
					"type": "qemu", "node": gn, "vmid": 105, "name": "web-vm", "status": "running",
					"cpu": 0.95, "maxcpu": 4, "mem": 2000, "maxmem": 4000,
				})
			}
			if sp {
				items = append(items, map[string]any{
					"type": "storage", "node": "pve1", "storage": "fast-zfs", "status": "available",
					"disk": 950, "maxdisk": 1000,
				})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": items})
		case "/api2/json/cluster/status":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/api2/json/cluster/tasks":
			_, _ = w.Write([]byte(`{"data":[]}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer pveSrv.Close()

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "alerts.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	ctx := context.Background()

	// Disable seeded default rules so we test our exact guest & storage rules deterministically
	seeded, _ := st.ListAlertRules(ctx)
	for _, sr := range seeded {
		sr.Enabled = false
		_ = st.UpdateAlertRule(ctx, &sr)
	}

	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x44}, 32))
	encSec, _ := box.EncryptString("sec")
	inst := &store.PVEInstance{
		ID:               "inst-a",
		Name:             "prod-pve",
		GroupName:        "prod",
		Color:            "#22C55E",
		AuthMode:         "token",
		TokenID:          "root@pam!t",
		TokenSecretEnc:   encSec,
		TLSMode:          "insecure",
		Enabled:          true,
		DetectedVersion:  "8.3.0",
		CapabilitiesJSON: `{"pveVersion":"8.3.0"}`,
		Endpoints:        []store.PVEEndpoint{{ID: "ep1", InstanceID: "inst-a", URL: pveSrv.URL, Priority: 1, IsHealthy: true}},
	}
	if err := st.SaveInstance(ctx, inst, true); err != nil {
		t.Fatal(err)
	}

	guestRule := &store.AlertRule{
		ID:          "r-guest",
		Name:        "VM High CPU",
		Enabled:     true,
		Severity:    "warning",
		Metric:      "guest_cpu",
		Operator:    "gte",
		Threshold:   80,
		CooldownMin: 30,
	}
	storageRule := &store.AlertRule{
		ID:          "r-stor",
		Name:        "Storage Full",
		Enabled:     true,
		Severity:    "critical",
		Metric:      "storage_usage",
		Operator:    "gte",
		Threshold:   90,
		CooldownMin: 30,
	}
	_ = st.CreateAlertRule(ctx, guestRule)
	_ = st.CreateAlertRule(ctx, storageRule)

	// Configure a failing webhook channel (points to a closed local port; override notifyHTTPClient dialer for test)
	var webhookHits atomic.Int32
	hookSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		webhookHits.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("upstream down"))
	}))
	defer hookSrv.Close()

	origClient := notifyHTTPClient
	notifyHTTPClient = hookSrv.Client()
	defer func() { notifyHTTPClient = origClient }()

	// Use non-loopback hostname rewritten via custom transport to hookSrv so ValidateWebhookURL passes cleanly
	hookSrvURL := strings.Replace(hookSrv.URL, "127.0.0.1", "203.0.113.99", 1)
	notifyHTTPClient = &http.Client{
		Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			req2 := req.Clone(req.Context())
			req2.URL.Host = strings.TrimPrefix(hookSrv.URL, "http://")
			return http.DefaultTransport.RoundTrip(req2)
		}),
	}

	cfgBytes, _ := json.Marshal(ChannelConfig{URL: hookSrvURL})
	cfgEnc, _ := box.EncryptString(string(cfgBytes))
	_ = st.CreateAlertChannel(ctx, &store.AlertChannel{
		ID:        "ch-fail",
		Name:      "Failing Hook",
		Type:      "webhook",
		ConfigEnc: cfgEnc,
		Enabled:   true,
	})

	pool := pve.NewPool(st, box)
	defer pool.Close()
	agg := NewAggregatorService(st, pool)
	eng := NewAlertEngine(st, box, pool, agg)

	// Cycle 1: fires both guest_cpu (without node in fingerprint!) and storage_usage
	res1, err := eng.EvaluateNow(ctx, false)
	if err != nil || res1.NewlyFired != 2 {
		t.Fatalf("Cycle 1 expected NewlyFired=2, got (%+v, %v)", res1, err)
	}
	eng.Wait()
	if webhookHits.Load() != 2 {
		t.Fatalf("expected 2 async webhook attempts on Cycle 1, got %d", webhookHits.Load())
	}

	active, _ := st.ListActiveAlertEvents(ctx)
	var guestFP string
	for _, ev := range active {
		if ev.ResourceType == "guest" {
			guestFP = ev.Fingerprint
		}
	}
	if guestFP != "r-guest:guest_cpu:guest:inst-a:qemu:105" {
		t.Fatalf("expected node-agnostic guest fingerprint, got %q", guestFP)
	}

	// Cycle 2: VM live-migrates pve1 -> pve2; failing webhook must NOT retry within 2m backoff,
	// VM alert must NOT duplicate/orphan, AND ResourceID must refresh to "pve2/qemu/105"!
	mu.Lock()
	guestNode = "pve2"
	mu.Unlock()
	agg.InvalidateCache()

	res2, err := eng.EvaluateNow(ctx, false)
	if err != nil || res2.NewlyFired != 0 || res2.ActiveAlerts != 2 {
		t.Fatalf("Cycle 2 after migration expected NewlyFired=0 ActiveAlerts=2, got (%+v, %v)", res2, err)
	}
	eng.Wait()
	if webhookHits.Load() != 2 {
		t.Fatalf("expected 2m failure retry backoff to suppress immediate webhook retry, got %d hits", webhookHits.Load())
	}
	migratedEv, err := st.GetActiveAlertByFingerprint(ctx, guestFP)
	if err != nil || migratedEv.ResourceID != "pve2/qemu/105" {
		t.Fatalf("expected migrated VM ResourceID refreshed to pve2/qemu/105, got (%+v, %v)", migratedEv, err)
	}

	// Cycle 3: VM and Storage are deleted while instance remains online -> both active alerts must auto-resolve!
	mu.Lock()
	guestPresent = false
	storagePresent = false
	mu.Unlock()
	agg.InvalidateCache()

	res3, err := eng.EvaluateNow(ctx, false)
	if err != nil || res3.AutoResolved != 2 || res3.ActiveAlerts != 0 {
		t.Fatalf("Cycle 3 after guest/storage deletion expected AutoResolved=2 ActiveAlerts=0, got (%+v, %v)", res3, err)
	}

	// Cycle 4: test PurgeInstance cleans active alerts & caches
	mu.Lock()
	guestPresent = true
	mu.Unlock()
	agg.InvalidateCache()
	_, _ = eng.EvaluateNow(ctx, false)
	eng.Wait()
	eng.PurgeInstance("inst-a")
	remActive, _ := st.ListActiveAlertEvents(ctx)
	if len(remActive) != 0 {
		t.Fatalf("expected PurgeInstance to resolve remaining active events, got %d", len(remActive))
	}
}

func TestAlertEngineStoppedGuestScopeNodeEditAndStandbySafeDiskRemoval(t *testing.T) {
	pve.InvalidateHardwareCache()

	var mu sync.Mutex
	guestStatus := "running"
	diskState := "worn" // "worn" -> "standby" -> "removed"

	pveSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gs, ds := guestStatus, diskState
		mu.Unlock()

		switch r.URL.Path {
		case "/api2/json/cluster/resources":
			items := []map[string]any{
				{"type": "node", "node": "pve1", "status": "online", "cpu": 0.1, "maxcpu": 8, "mem": 1000, "maxmem": 8000},
				{"type": "node", "node": "pve2", "status": "online", "cpu": 0.95, "maxcpu": 8, "mem": 1000, "maxmem": 8000},
				{"type": "qemu", "node": "pve1", "vmid": 200, "name": "app-vm", "status": gs, "cpu": 0.95, "maxcpu": 4, "mem": 2000, "maxmem": 4000},
				{"type": "storage", "node": "pve2", "storage": "local-zfs", "status": "available", "disk": 950, "maxdisk": 1000},
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": items})
		case "/api2/json/cluster/status":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/api2/json/cluster/tasks":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/api2/json/nodes/pve1/status", "/api2/json/nodes/pve2/status":
			_, _ = w.Write([]byte(`{"data":{"cpu":0.1,"uptime":100,"pveversion":"8.3","kversion":"6.8","cpuinfo":{"cores":4,"cpus":8,"sockets":1},"memory":{"total":8000,"used":1000,"available":7000}}}`))
		case "/api2/json/nodes/pve2/disks/list":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/api2/json/nodes/pve1/disks/list":
			switch ds {
			case "worn":
				_, _ = w.Write([]byte(`{"data":[{"devpath":"/dev/sda","model":"NAS-HDD","serial":"S1","type":"hdd","size":1000,"health":"PASSED","wearout":50}]}`))
			case "standby":
				_, _ = w.Write([]byte(`{"data":[{"devpath":"/dev/sda","model":"NAS-HDD","serial":"S1","type":"hdd","size":1000,"health":"STANDBY"}]}`))
			case "removed":
				_, _ = w.Write([]byte(`{"data":[]}`))
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer pveSrv.Close()

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "alerts_lifecycle.db"))
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

	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x55}, 32))
	encSec, _ := box.EncryptString("sec")
	_ = st.SaveInstance(ctx, &store.PVEInstance{
		ID:               "inst-lc",
		Name:             "lc-cluster",
		GroupName:        "prod",
		Color:            "#22C55E",
		AuthMode:         "token",
		TokenID:          "root@pam!t",
		TokenSecretEnc:   encSec,
		TLSMode:          "insecure",
		Enabled:          true,
		DetectedVersion:  "8.3.0",
		CapabilitiesJSON: `{"pveVersion":"8.3.0"}`,
		Endpoints:        []store.PVEEndpoint{{ID: "ep1", InstanceID: "inst-lc", URL: pveSrv.URL, Priority: 1, IsHealthy: true}},
	}, true)

	rGuest := &store.AlertRule{ID: "rg", Name: "Guest CPU", Enabled: true, Severity: "warning", Metric: "guest_cpu", Operator: "gte", Threshold: 80, CooldownMin: 30}
	rNode := &store.AlertRule{ID: "rn", Name: "Node CPU", Enabled: true, Severity: "warning", Metric: "node_cpu", Operator: "gte", Threshold: 85, CooldownMin: 30}
	rStor := &store.AlertRule{ID: "rs", Name: "Stor Full", Enabled: true, Severity: "critical", Metric: "storage_usage", Operator: "gte", Threshold: 90, CooldownMin: 30}
	rDisk := &store.AlertRule{ID: "rd", Name: "Disk Health", Enabled: true, Severity: "warning", Metric: "disk_health", Operator: "lte", Threshold: 80, CooldownMin: 30}
	for _, r := range []*store.AlertRule{rGuest, rNode, rStor, rDisk} {
		if err := st.CreateAlertRule(ctx, r); err != nil {
			t.Fatal(err)
		}
	}

	pool := pve.NewPool(st, box)
	defer pool.Close()
	agg := NewAggregatorService(st, pool)
	eng := NewAlertEngine(st, box, pool, agg)

	// 1. Initial evaluation fires all 4 alerts: guest_cpu(200), node_cpu(pve2), storage_usage(pve2/local-zfs), disk_health(pve1//dev/sda)
	res1, err := eng.EvaluateNow(ctx, true)
	if err != nil || res1.NewlyFired != 4 || res1.ActiveAlerts != 4 {
		t.Fatalf("Step 1 expected 4 active alerts, got (%+v, %v)", res1, err)
	}

	// 2. Power off guest #200 -> guest_cpu must auto-resolve!
	mu.Lock()
	guestStatus = "stopped"
	mu.Unlock()
	agg.InvalidateCache()
	res2, err := eng.EvaluateNow(ctx, false)
	if err != nil || res2.AutoResolved != 1 || res2.ActiveAlerts != 3 {
		t.Fatalf("Step 2 stopped guest expected AutoResolved=1 ActiveAlerts=3, got (%+v, %v)", res2, err)
	}

	// 3. Edit ScopeNode="pve1" on node_cpu & storage_usage rules -> active alerts on pve2 must auto-resolve!
	rNode.ScopeNode = "pve1"
	rStor.ScopeNode = "pve1"
	_ = st.UpdateAlertRule(ctx, rNode)
	_ = st.UpdateAlertRule(ctx, rStor)
	res3, err := eng.EvaluateNow(ctx, false)
	if err != nil || res3.AutoResolved != 2 || res3.ActiveAlerts != 1 {
		t.Fatalf("Step 3 ScopeNode edit expected AutoResolved=2 ActiveAlerts=1 (disk_health remaining), got (%+v, %v)", res3, err)
	}

	// 4. Disk /dev/sda enters STANDBY -> must NOT falsely resolve disk_health!
	mu.Lock()
	diskState = "standby"
	mu.Unlock()
	pve.InvalidateHardwareCache()
	res4, err := eng.EvaluateNow(ctx, true)
	if err != nil || res4.AutoResolved != 0 || res4.ActiveAlerts != 1 {
		t.Fatalf("Step 4 standby disk must NOT falsely resolve active disk_health alert, got (%+v, %v)", res4, err)
	}

	// 5. Disk /dev/sda is physically removed from pve1 -> disk_health MUST auto-resolve!
	mu.Lock()
	diskState = "removed"
	mu.Unlock()
	pve.InvalidateHardwareCache()
	res5, err := eng.EvaluateNow(ctx, true)
	if err != nil || res5.AutoResolved != 1 || res5.ActiveAlerts != 0 {
		t.Fatalf("Step 5 physically removed disk expected AutoResolved=1 ActiveAlerts=0, got (%+v, %v)", res5, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
