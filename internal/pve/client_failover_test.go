package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
)

func closedLocalURL(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return "https://" + addr
}

func TestEncodeCloudInitSSHKeysAndDetailedAPIError(t *testing.T) {
	rawKey := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI+AbCdEfGhIjKlMnOpQrStUv== ops@lab\r\nssh-rsa AAAAB3NzaC1yc2EA+xy== dev@lab\r\n"
	enc := EncodeCloudInitSSHKeys(rawKey)
	if strings.Contains(enc, "+") || strings.Contains(enc, " ") || strings.Contains(enc, "\n") || strings.Contains(enc, "\r") || strings.Contains(strings.ToUpper(enc), "%0D") {
		t.Fatalf("EncodeCloudInitSSHKeys left unescaped chars or %%0D: %q", enc)
	}
	if !strings.Contains(enc, "%2B") || !strings.Contains(enc, "%20") || !strings.Contains(strings.ToUpper(enc), "%0A") {
		t.Fatalf("expected %%2B, %%20, and %%0A in encoded key, got: %q", enc)
	}

	var gotSSHKeys string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		gotSSHKeys = r.FormValue("sshkeys")
		_, _ = w.Write([]byte(`{"data":null}`))
	}))
	defer srv.Close()

	cl, err := NewClient(ClientConfig{
		AuthMode:    "token",
		TokenID:     "root@pam!t1",
		TokenSecret: "sec",
		TLSMode:     "insecure",
		Endpoints:   []EndpointConfig{{ID: "ep1", URL: srv.URL, Priority: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()

	if err := cl.UpdateGuestConfig(context.Background(), "pve1", "qemu", 100, map[string]string{"sshkeys": rawKey}, nil, nil); err != nil {
		t.Fatalf("UpdateGuestConfig: %v", err)
	}
	// Note: UpdateGuestConfig passes the PVE-urlencoded string as the form parameter value, so PVE decodes form once and still sees %2B/%20
	if gotSSHKeys != enc {
		t.Fatalf("expected UpdateGuestConfig to send PVE-encoded sshkeys %q, got %q", enc, gotSSHKeys)
	}

	apiErr := &APIError{
		StatusCode: 400,
		Status:     "400 Bad Request",
		Body:       `{"data":null,"message":"Parameter verification failed.","errors":{"sshkeys":"invalid urlencoded string","net0":"invalid bridge"}}`,
	}
	detail := apiErr.DetailedMessage()
	if !strings.Contains(detail, "net0: invalid bridge") || !strings.Contains(detail, "sshkeys: invalid urlencoded string") {
		t.Fatalf("unexpected DetailedMessage: %q", detail)
	}
}

func TestTicketAuthFailoverDialFailoverAndConsolePinning(t *testing.T) {
	deadURL := closedLocalURL(t)

	var ticketCalls, powerCalls, termProxyCalls atomic.Int32
	healthySrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/access/ticket":
			ticketCalls.Add(1)
			_, _ = w.Write([]byte(`{"data":{"ticket":"PVE:root@pam:TICKET1","CSRFPreventionToken":"CSRF1"}}`))
		case "/api2/json/version":
			_, _ = w.Write([]byte(`{"data":{"version":"8.3.1","release":"8.3","repoid":"abc"}}`))
		case "/api2/json/nodes/pve2/qemu/101/status/start":
			powerCalls.Add(1)
			_, _ = w.Write([]byte(`{"data":"UPID:pve2:0001"}`))
		case "/api2/json/nodes/pve2/termproxy":
			termProxyCalls.Add(1)
			_, _ = w.Write([]byte(`{"data":{"port":5901,"ticket":"PVEVNC:TERM1","user":"root@pam"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer healthySrv.Close()

	st, err := store.OpenSQLite(filepath.Join(t.TempDir(), "pool.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	box, err := crypto.NewBox(bytes.Repeat([]byte{0x11}, 32))
	if err != nil {
		t.Fatal(err)
	}
	encPass, _ := box.EncryptString("pve-secret")
	inst := &store.PVEInstance{
		ID:                "inst-ha",
		Name:              "ha-cluster",
		GroupName:         "prod",
		Color:             "#22C55E",
		AuthMode:          "ticket",
		TicketUsername:    "root@pam",
		TicketPasswordEnc: encPass,
		TLSMode:           "insecure",
		Enabled:           true,
		Endpoints: []store.PVEEndpoint{
			{ID: "ep-dead", InstanceID: "inst-ha", URL: deadURL, Priority: 1, IsHealthy: true},
			{ID: "ep-live", InstanceID: "inst-ha", URL: healthySrv.URL, Priority: 2, IsHealthy: true},
		},
	}
	if err := st.SaveInstance(context.Background(), inst, true); err != nil {
		t.Fatal(err)
	}

	pool := NewPool(st, box)
	defer pool.Close()

	cl, _, err := pool.Get(context.Background(), "inst-ha")
	if err != nil {
		t.Fatal(err)
	}
	// Ticket-mode GET must fail over when primary endpoint fails during EnsureTicket
	ver, err := cl.GetVersion(context.Background())
	if err != nil || ver.Version != "8.3.1" {
		t.Fatalf("expected ticket-mode failover to succeed, got (%+v, %v)", ver, err)
	}

	// Reset cooldown to force POST dial against dead primary first -> must fail over on pre-HTTP dial error
	for _, ep := range cl.endpoints {
		ep.cooldownUntil = cl.endpoints[1].cooldownUntil
	}
	upid, err := cl.GuestPowerAction(context.Background(), "pve2", "qemu", 101, "start")
	if err != nil || upid != "UPID:pve2:0001" {
		t.Fatalf("expected POST dial failover to succeed, got (%q, %v)", upid, err)
	}

	// Console session must pin the healthy endpoint URL that minted the termproxy ticket
	cm := NewConsoleManager(pool)
	defer cm.Stop()
	sessOut, err := cm.CreateSession(context.Background(), CreateSessionInput{
		OwnerUserID: "u1",
		InstanceID:  "inst-ha",
		Node:        "pve2",
		TargetType:  "node",
		Protocol:    "xterm",
	})
	if err != nil {
		t.Fatalf("CreateSession: %v", err)
	}
	consumed, ok := cm.consumeSession(sessOut.SessionID, "u1")
	if !ok || consumed.BaseURL != healthySrv.URL {
		t.Fatalf("expected ConsoleSession pinned to %q, got %+v", healthySrv.URL, consumed)
	}

	// Zero-SQL Pool.Get hit check: close store DB and verify cached Pool.Get still succeeds without touching SQLite
	_ = st.Close()
	if _, cachedInst, err := pool.Get(context.Background(), "inst-ha"); err != nil || cachedInst == nil || cachedInst.Name != "ha-cluster" {
		t.Fatalf("expected Pool.Get cache hit to require zero SQLite queries, got (%+v, %v)", cachedInst, err)
	}
}

func TestSyslogJournalPreferredAndHostTimezoneWindow(t *testing.T) {
	var journalHits, timeHits atomic.Int32
	var floodSyslog atomic.Bool
	var gotSince string

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/nodes/pve1/journal":
			journalHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []string{
					"s=abc;i=1;b=boot1;m=1;t=1;x=1",
					"Nov 27 15:00:01 pve1 pvedaemon[100]: starting worker",
					"Nov 27 15:00:02 pve1 systemd[1]: latest tail line",
					"s=abc;i=2;b=boot1;m=2;t=2;x=2",
				},
			})
		case "/api2/json/nodes/pve1/time":
			timeHits.Add(1)
			// Fixed UTC epoch: 2026-11-27T04:00:00Z -> Asia/Shanghai is 2026-11-27 12:00:00
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"time":      1795752000,
					"localtime": 1795780800,
					"timezone":  "Asia/Shanghai",
				},
			})
		case "/api2/json/nodes/pve1/syslog":
			gotSince = r.URL.Query().Get("since")
			if floodSyslog.Load() {
				many := make([]SyslogLine, 1000)
				for i := range many {
					many[i] = SyslogLine{N: i + 1, T: "oldest truncated line"}
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"data": many})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []SyslogLine{{N: 1, T: "service filtered line"}},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cl, err := NewClient(ClientConfig{
		AuthMode:    "token",
		TokenID:     "root@pam!t1",
		TokenSecret: "sec",
		TLSMode:     "insecure",
		Endpoints:   []EndpointConfig{{ID: "ep1", URL: srv.URL, Priority: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()

	// 1. Unfiltered tail uses /journal?lastentries=50 and strips cursor lines
	lines, err := cl.GetNodeSyslog(context.Background(), "pve1", 50, "", "", "")
	if err != nil {
		t.Fatalf("GetNodeSyslog: %v", err)
	}
	if journalHits.Load() != 1 || len(lines) != 2 || !strings.Contains(lines[0].T, "pvedaemon") {
		t.Fatalf("expected 2 filtered journal lines, got %+v", lines)
	}

	// 2. Relative Hours + Service filter uses /nodes/{node}/time in PVE host's timezone
	sLines, err := cl.GetNodeSyslogWithOptions(context.Background(), "pve1", NodeSyslogOptions{
		Limit:   50,
		Service: "pvedaemon",
		Hours:   2,
	})
	if err != nil || len(sLines) != 1 {
		t.Fatalf("GetNodeSyslogWithOptions: (%+v, %v)", sLines, err)
	}
	if timeHits.Load() != 1 || gotSince != "2026-11-27 10:00:00" {
		t.Fatalf("expected Asia/Shanghai relative since='2026-11-27 10:00:00', got %q (timeHits=%d)", gotSince, timeHits.Load())
	}

	// 3. Relative Hours without Service when /syslog hits 1,000-line forward cap falls back to /journal tail!
	floodSyslog.Store(true)
	tailLines, err := cl.GetNodeSyslogWithOptions(context.Background(), "pve1", NodeSyslogOptions{
		Limit: 2,
		Hours: 2,
	})
	if err != nil || len(tailLines) != 2 || !strings.Contains(tailLines[1].T, "latest tail line") {
		t.Fatalf("expected Hours>0 >1000-line flood to fall back to /journal tail, got (%+v, %v)", tailLines, err)
	}
}

func TestUploadStorageStreamPreStreamFailover(t *testing.T) {
	deadURL := closedLocalURL(t)
	payload := "ISO-BINARY-CONTENT-1234567890"
	var uploadedContent, uploadedFilename, uploadedBody string

	liveSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/access/ticket":
			_, _ = w.Write([]byte(`{"data":{"ticket":"PVE:root@pam:T1","CSRFPreventionToken":"C1"}}`))
		case "/api2/json/nodes/pve1/storage/local/upload":
			mr, err := r.MultipartReader()
			if err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			for {
				p, err := mr.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				b, _ := io.ReadAll(p)
				if p.FormName() == "content" {
					uploadedContent = string(b)
				} else if p.FormName() == "filename" {
					uploadedFilename = p.FileName()
					uploadedBody = string(b)
				}
			}
			_, _ = w.Write([]byte(`{"data":"UPID:pve1:UPLOAD1"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer liveSrv.Close()

	// Both ticket-auth failover AND token-auth dial failover before reading file stream
	for _, mode := range []string{"ticket", "token"} {
		cl, err := NewClient(ClientConfig{
			AuthMode:       mode,
			TokenID:        "root@pam!t",
			TokenSecret:    "sec",
			TicketUsername: "root@pam",
			TicketPassword: "pw",
			TLSMode:        "insecure",
			Endpoints: []EndpointConfig{
				{ID: "dead", URL: deadURL, Priority: 1},
				{ID: "live", URL: liveSrv.URL, Priority: 2},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		upid, err := cl.UploadStorageStream(context.Background(), "pve1", "local", "iso", "alpine.iso", strings.NewReader(payload))
		cl.Close()
		if err != nil || upid != "UPID:pve1:UPLOAD1" {
			t.Fatalf("mode=%s UploadStorageStream failover failed: upid=%q err=%v", mode, upid, err)
		}
		if uploadedContent != "iso" || uploadedFilename != "alpine.iso" || uploadedBody != payload {
			t.Fatalf("mode=%s unexpected uploaded data: content=%q file=%q body=%q", mode, uploadedContent, uploadedFilename, uploadedBody)
		}
	}
}

func TestHardwareSingleStatusAntiStampedeAndAlertSweepSkipsConfigs(t *testing.T) {
	InvalidateHardwareCache()
	var statusHits, configHits, pciHits atomic.Int32

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api2/json/nodes/pve1/status":
			statusHits.Add(1)
			_, _ = w.Write([]byte(`{"data":{"cpu":0.15,"uptime":3600,"pveversion":"pve-manager/8.3","kversion":"Linux 6.8","cpuinfo":{"cores":8,"cpus":16,"sockets":1,"model":"Xeon"},"memory":{"total":1000,"used":400,"available":600}}}`))
		case r.URL.Path == "/api2/json/nodes/pve1/disks/list":
			_, _ = w.Write([]byte(`{"data":[{"devpath":"/dev/sda","model":"NAS-HDD","serial":"S1","type":"hdd","size":4000000000,"health":"STANDBY"}]}`))
		case r.URL.Path == "/api2/json/nodes/pve1/hardware/pci":
			pciHits.Add(1)
			_, _ = w.Write([]byte(`{"data":[]}`))
		case r.URL.Path == "/api2/json/cluster/resources":
			_, _ = w.Write([]byte(`{"data":[{"type":"qemu","node":"pve1","vmid":100,"name":"vm100","status":"running"}]}`))
		case r.URL.Path == "/api2/json/cluster/mapping/pci":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case strings.HasSuffix(r.URL.Path, "/config"):
			configHits.Add(1)
			_, _ = w.Write([]byte(`{"data":{}}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	cl, err := NewClient(ClientConfig{
		AuthMode:    "token",
		TokenID:     "root@pam!t1",
		TokenSecret: "sec",
		TLSMode:     "insecure",
		Endpoints:   []EndpointConfig{{ID: "ep1", URL: srv.URL, Priority: 1}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()

	// CollectNodeAlertHardware must NOT crawl VM /config or /hardware/pci and must skip waking STANDBY HDD
	alertRep, err := CollectNodeAlertHardware(context.Background(), cl, "inst1", "", "pve1", true)
	if err != nil {
		t.Fatalf("CollectNodeAlertHardware: %v", err)
	}
	if configHits.Load() != 0 || pciHits.Load() != 0 {
		t.Fatalf("expected 0 config/pci calls in alert hardware sweep, got config=%d pci=%d", configHits.Load(), pciHits.Load())
	}
	if statusHits.Load() != 1 {
		t.Fatalf("expected single /status request, got %d", statusHits.Load())
	}
	if len(alertRep.Disks) != 1 || alertRep.Disks[0].HealthPct != nil {
		t.Fatalf("expected standby HDD to keep nil HealthPct, got %+v", alertRep.Disks)
	}

	// CollectNodeHardware must deduplicate /status to 1 HTTP request and enforce 5s anti-stampede floor on force=true
	statusHits.Store(0)
	if _, err := CollectNodeHardware(context.Background(), cl, "inst1", "pve1", "", true); err != nil {
		t.Fatalf("CollectNodeHardware 1: %v", err)
	}
	if statusHits.Load() != 1 {
		t.Fatalf("expected deduplicated single /status call in CollectNodeHardware, got %d", statusHits.Load())
	}
	if _, err := CollectNodeHardware(context.Background(), cl, "inst1", "pve1", "", true); err != nil {
		t.Fatalf("CollectNodeHardware 2 (within 5s floor): %v", err)
	}
	if statusHits.Load() != 1 {
		t.Fatalf("expected 5s anti-stampede floor to serve cached report on immediate force=true, got statusHits=%d", statusHits.Load())
	}
}
