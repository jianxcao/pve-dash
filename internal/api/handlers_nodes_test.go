package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jianxcao/pve-dash/internal/pve"
)

func TestBuildNetworkParamsValidation(t *testing.T) {
	// Valid bridge
	autostart := true
	vlanAware := true
	mtu := 9000
	p, err := buildNetworkParams(nodeNetworkReq{
		Iface:           "vmbr1",
		Type:            "bridge",
		BridgePorts:     "enp3s0",
		BridgeVlanAware: &vlanAware,
		Autostart:       &autostart,
		MTU:             &mtu,
	}, true)
	if err != nil {
		t.Fatalf("expected valid bridge, got error: %v", err)
	}
	if p.Get("bridge_ports") != "enp3s0" || p.Get("bridge_vlan_aware") != "1" || p.Get("mtu") != "9000" {
		t.Fatalf("unexpected params: %v", p)
	}

	// Valid OVSBridge must map to ovs_ports, NOT bridge_ports
	p, err = buildNetworkParams(nodeNetworkReq{
		Iface:    "vmbr2",
		Type:     "OVSBridge",
		OVSPorts: "enp4s0",
	}, true)
	if err != nil {
		t.Fatalf("expected valid OVSBridge, got error: %v", err)
	}
	if p.Get("ovs_ports") != "enp4s0" || p.Has("bridge_ports") {
		t.Fatalf("unexpected OVSBridge params: %v", p)
	}

	// Reject invalid MTU (< 1280)
	badMTU := 576
	if _, err := buildNetworkParams(nodeNetworkReq{Iface: "vmbr1", Type: "bridge", MTU: &badMTU}, true); err == nil {
		t.Fatal("expected MTU < 1280 to fail")
	}

	// Reject invalid VLAN ID (> 4094)
	badVlan := 5000
	if _, err := buildNetworkParams(nodeNetworkReq{Iface: "vmbr0.5000", Type: "vlan", VlanID: &badVlan}, true); err == nil {
		t.Fatal("expected VLAN ID > 4094 to fail")
	}

	// Reject disallowed delete key and overlap between set + delete
	if _, err := buildNetworkParams(nodeNetworkReq{Type: "bridge", Delete: []string{"iface"}}, false); err == nil {
		t.Fatal("expected disallowed delete key to fail")
	}
	if _, err := buildNetworkParams(nodeNetworkReq{Type: "bridge", Gateway: "198.51.100.1", Delete: []string{"gateway"}}, false); err == nil {
		t.Fatal("expected set+delete overlap to fail")
	}
}

func TestHandleTaskLogSSECursorAndMultiPageDrain(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	// Simulate a verbose PVE task whose log grows across poll boundaries and exceeds 500 lines on completion.
	// PVE `start` is 0-based while `n` is 1-based!
	const totalLines = 620
	allLines := make([]pve.TaskLogLine, totalLines)
	for i := 0; i < totalLines; i++ {
		allLines[i] = pve.TaskLogLine{N: i + 1, T: fmt.Sprintf("line-%04d", i+1)}
	}

	var statusPollCount atomic.Int32
	var visibleLines atomic.Int32
	visibleLines.Store(3) // First flush sees lines 1..3; final drain sees 4..620 across 2 pages!

	seedMockPVEInstance(t, srv, "inst-sse", "9.0.0", func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/log"):
			start, _ := strconv.Atoi(r.URL.Query().Get("start"))
			limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
			if limit <= 0 {
				limit = 500
			}
			vis := int(visibleLines.Load())
			if start >= vis {
				_, _ = w.Write([]byte(`{"data":[]}`))
				return
			}
			end := start + limit
			if end > vis {
				end = vis
			}
			b, _ := json.Marshal(map[string]any{"data": allLines[start:end]})
			_, _ = w.Write(b)
		case strings.HasSuffix(r.URL.Path, "/status"):
			n := statusPollCount.Add(1)
			if n == 1 {
				// Before returning stopped, expose remaining lines 4..620 so final multi-page drain runs!
				visibleLines.Store(totalLines)
			}
			_, _ = w.Write([]byte(`{"data":{"status":"stopped","exitstatus":"OK"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	rr := doJSONReq(t, router, http.MethodGet, "/api/v1/instances/inst-sse/nodes/pve/tasks/UPID:pve:1/log/stream", adminPair.AccessToken, nil, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 on task log SSE, got %d %s", rr.Code, rr.Body.String())
	}

	var received []pve.TaskLogLine
	for _, rawLine := range strings.Split(rr.Body.String(), "\n") {
		if strings.HasPrefix(rawLine, "data: [") {
			var chunk []pve.TaskLogLine
			if err := json.Unmarshal([]byte(strings.TrimPrefix(rawLine, "data: ")), &chunk); err != nil {
				t.Fatalf("unmarshal log chunk: %v", err)
			}
			received = append(received, chunk...)
		}
	}
	if len(received) != totalLines {
		t.Fatalf("expected all %d lines without off-by-one drop or 500-line truncation, got %d", totalLines, len(received))
	}
	for i, l := range received {
		if l.N != i+1 {
			t.Fatalf("line %d sequence mismatch: got N=%d (%q), want %d", i, l.N, l.T, i+1)
		}
	}
}

func TestNodeAndStorageParamValidation(t *testing.T) {
	_, adminPair, router := newTestAPIServer(t)

	paths := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/v1/instances/any/nodes/..%2Fcluster/status"},
		{http.MethodGet, "/api/v1/instances/any/nodes/..%2Fcluster/rrd"},
		{http.MethodGet, "/api/v1/instances/any/nodes/..%2Fcluster/services"},
		{http.MethodGet, "/api/v1/instances/any/nodes/..%2Fcluster/syslog"},
		{http.MethodGet, "/api/v1/instances/any/nodes/pve/storage/..%2Fetc/content"},
	}
	for _, tc := range paths {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.Header.Set("Authorization", "Bearer "+adminPair.AccessToken)
		rr := httptest.NewRecorder()
		router.ServeHTTP(rr, req)
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 on %s %s, got %d %s", tc.method, tc.path, rr.Code, rr.Body.String())
		}
	}
}

func TestHandleNodeSyslogDelegatesHoursToGetNodeSyslogWithOptions(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	var timeCalled atomic.Int32
	var receivedSince string
	seedMockPVEInstance(t, srv, "inst-sys", "9.1.0", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/nodes/pve/time":
			timeCalled.Add(1)
			// Fixed UTC epoch: 2026-06-01T12:00:00Z
			_, _ = w.Write([]byte(`{"data":{"time":1780315200,"localtime":1780315200,"timezone":"UTC"}}`))
		case "/api2/json/nodes/pve/syslog":
			receivedSince = r.URL.Query().Get("since")
			_, _ = w.Write([]byte(`{"data":[{"n":1,"t":"Jun 01 11:59:00 pve systemd[1]: Started service."}]}`))
		case "/api2/json/nodes/pve/journal":
			_, _ = w.Write([]byte(`{"data":["Jun 01 11:59:59 pve kernel: tail line"]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	rr := doJSONReq(t, router, http.MethodGet, "/api/v1/instances/inst-sys/nodes/pve/syslog?hours=2&service=pvedaemon", adminPair.AccessToken, nil, nil)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 on node syslog, got %d %s", rr.Code, rr.Body.String())
	}
	if timeCalled.Load() == 0 {
		t.Fatal("expected GetNodeSyslogWithOptions to query /nodes/pve/time for host timezone")
	}
	if receivedSince != "2026-06-01 10:00:00" {
		t.Fatalf("expected host-timezone since='2026-06-01 10:00:00', got %q", receivedSince)
	}
}
