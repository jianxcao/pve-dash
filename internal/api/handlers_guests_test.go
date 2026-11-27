package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/jianxcao/pve-dash/internal/store"
)

func seedMockPVEInstance(t *testing.T, srv *Server, id, version string, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	ts := httptest.NewTLSServer(handler)
	t.Cleanup(ts.Close)

	encSec, err := srv.box.EncryptString("mock-token-secret")
	if err != nil {
		t.Fatal(err)
	}
	if err := srv.store.SaveInstance(context.Background(), &store.PVEInstance{
		ID:              id,
		Name:            "cluster-" + id,
		GroupName:       "lab",
		Color:           "#22C55E",
		AuthMode:        "token",
		TokenID:         "root@pam!dash",
		TokenSecretEnc:  encSec,
		TLSMode:         "insecure",
		Enabled:         true,
		DetectedVersion: version,
		Endpoints: []store.PVEEndpoint{
			{ID: "ep-" + id, InstanceID: id, URL: ts.URL, Priority: 10},
		},
	}, true); err != nil {
		t.Fatal(err)
	}
	return ts
}

func TestQemuCloudInitSSHKeysAndOVMFSecureBootTPM(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	var lastForm url.Values
	seedMockPVEInstance(t, srv, "inst-vm", "9.1.0", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		lastForm = r.PostForm
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/api2/json/nodes/pve/qemu":
			_, _ = w.Write([]byte(`{"data":"UPID:pve:0001:create"}`))
		case r.Method == http.MethodPut && r.URL.Path == "/api2/json/nodes/pve/qemu/105/config":
			_, _ = w.Write([]byte(`{"data":null}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	rawSSHKey := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI+base64PlusKey/xyz== ops@lab"

	// 1. Linux OVMF VM: Cloud-Init sshkeys escapes '+' as %2B and spaces as %20; SecureBoot defaults to pre-enrolled-keys=0
	rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-vm/nodes/pve/qemu", adminPair.AccessToken, map[string]any{
		"vmid":            105,
		"name":            "ubuntu-ci",
		"ostype":          "l26",
		"storage":         "local-lvm",
		"diskSizeGb":      32,
		"bios":            "ovmf",
		"tpm":             true,
		"enableCloudInit": true,
		"ciuser":          "ubuntu",
		"sshkeys":         rawSSHKey,
	}, nil)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create qemu failed: %d %s", rr.Code, rr.Body.String())
	}
	encodedSSH := lastForm.Get("sshkeys")
	if strings.Contains(encodedSSH, "+") || !strings.Contains(encodedSSH, "%2B") || !strings.Contains(encodedSSH, "%20") {
		t.Fatalf("expected sshkeys with %%2B and %%20 (no raw '+'), got %q", encodedSSH)
	}
	unescaped, err := url.PathUnescape(encodedSSH)
	if err != nil || unescaped != rawSSHKey {
		t.Fatalf("PVE uri_unescape mismatch: got %q want %q (err=%v)", unescaped, rawSSHKey, err)
	}
	if got := lastForm.Get("efidisk0"); got != "local-lvm:1,efitype=4m,pre-enrolled-keys=0" {
		t.Fatalf("expected pre-enrolled-keys=0 for l26 default, got %q", got)
	}
	if got := lastForm.Get("tpmstate0"); got != "local-lvm:1,version=v2.0" {
		t.Fatalf("expected tpmstate0 configured, got %q", got)
	}

	// 2. Windows 11 OVMF VM (even diskless) defaults SecureBoot pre-enrolled-keys=1
	rrWin := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-vm/nodes/pve/qemu", adminPair.AccessToken, map[string]any{
		"vmid":       106,
		"name":       "win11-ws",
		"ostype":     "win11",
		"storage":    "local-lvm",
		"diskSizeGb": 0,
		"bios":       "ovmf",
	}, nil)
	if rrWin.Code != http.StatusCreated {
		t.Fatalf("create win11 qemu failed: %d %s", rrWin.Code, rrWin.Body.String())
	}
	if got := lastForm.Get("efidisk0"); got != "local-lvm:1,efitype=4m,pre-enrolled-keys=1" {
		t.Fatalf("expected efidisk0 with pre-enrolled-keys=1 for win11, got %q", got)
	}

	// 3. handleGuestConfigUpdate normalizes raw sshkeys with '+'/spaces while keeping already-encoded strings intact
	rrCfg := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-vm/nodes/pve/qemu/105/config", adminPair.AccessToken, map[string]any{
		"values": map[string]string{
			"sshkeys": rawSSHKey,
		},
	}, nil)
	if rrCfg.Code != http.StatusOK {
		t.Fatalf("update config failed: %d %s", rrCfg.Code, rrCfg.Body.String())
	}
	if got := lastForm.Get("sshkeys"); got != encodedSSH {
		t.Fatalf("expected normalized sshkeys %q, got %q", encodedSSH, got)
	}

	// Already percent-encoded sshkeys must not be double-encoded
	rrCfg2 := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-vm/nodes/pve/qemu/105/config", adminPair.AccessToken, map[string]any{
		"values": map[string]string{
			"sshkeys": encodedSSH,
		},
	}, nil)
	if rrCfg2.Code != http.StatusOK || lastForm.Get("sshkeys") != encodedSSH {
		t.Fatalf("expected already-encoded sshkeys preserved as %q, got %q", encodedSSH, lastForm.Get("sshkeys"))
	}
}

func TestHandleGuestDetailConcurrentAndSafeQGAProbe(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	var qgaCalls atomic.Int32
	var vmStatus atomic.Value
	var vmAgent atomic.Value
	vmStatus.Store("stopped")
	vmAgent.Store("0")

	seedMockPVEInstance(t, srv, "inst-det", "8.4.1", func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api2/json/nodes/pve/qemu/200/status/current":
			st := vmStatus.Load().(string)
			_, _ = w.Write([]byte(`{"data":{"status":"` + st + `","vmid":200}}`))
		case "/api2/json/nodes/pve/qemu/200/config":
			ag := vmAgent.Load().(string)
			_, _ = w.Write([]byte(`{"data":{"name":"app-vm","agent":"` + ag + `"}}`))
		case "/api2/json/nodes/pve/qemu/200/pending":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/api2/json/nodes/pve/qemu/200/snapshot":
			_, _ = w.Write([]byte(`{"data":[]}`))
		case "/api2/json/nodes/pve/qemu/200/agent/network-get-interfaces":
			qgaCalls.Add(1)
			_, _ = w.Write([]byte(`{"data":{"result":[{"name":"eth0","hardware-address":"AA:BB:CC:DD:EE:FF","ip-addresses":[{"ip-address":"198.51.100.50","ip-address-type":"ipv4","prefix":24}]}]}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})

	// Stopped VM -> must NOT probe QGA
	rr := doJSONReq(t, router, http.MethodGet, "/api/v1/instances/inst-det/nodes/pve/qemu/200/detail", adminPair.AccessToken, nil, nil)
	if rr.Code != http.StatusOK || qgaCalls.Load() != 0 {
		t.Fatalf("stopped VM should skip QGA: code=%d qgaCalls=%d", rr.Code, qgaCalls.Load())
	}

	// Running VM with agent="enabled=0" -> must NOT probe QGA
	vmStatus.Store("running")
	vmAgent.Store("enabled=0,fstrim_cloned_disks=1")
	rr = doJSONReq(t, router, http.MethodGet, "/api/v1/instances/inst-det/nodes/pve/qemu/200/detail", adminPair.AccessToken, nil, nil)
	if rr.Code != http.StatusOK || qgaCalls.Load() != 0 {
		t.Fatalf("running VM with agent=enabled=0 should skip QGA: code=%d qgaCalls=%d", rr.Code, qgaCalls.Load())
	}

	// Running VM with agent="enabled=1" -> probes QGA and returns IP
	vmAgent.Store("enabled=1")
	rr = doJSONReq(t, router, http.MethodGet, "/api/v1/instances/inst-det/nodes/pve/qemu/200/detail", adminPair.AccessToken, nil, nil)
	if rr.Code != http.StatusOK || qgaCalls.Load() != 1 {
		t.Fatalf("running VM with agent=enabled=1 should call QGA once: code=%d qgaCalls=%d", rr.Code, qgaCalls.Load())
	}
	var detail struct {
		IPs []struct {
			IPv4 []string `json:"ipv4"`
		} `json:"ips"`
	}
	_ = json.Unmarshal(rr.Body.Bytes(), &detail)
	if len(detail.IPs) != 1 || len(detail.IPs[0].IPv4) != 1 || detail.IPs[0].IPv4[0] != "198.51.100.50/24" {
		t.Fatalf("unexpected guest IPs: %+v", detail.IPs)
	}
}

func TestBackupJobValidationAndUpdate(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	var lastPut url.Values
	seedMockPVEInstance(t, srv, "inst-bk", "8.4.1", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		lastPut = r.PostForm
		_, _ = w.Write([]byte(`{"data":null}`))
	})

	// Reject !all && empty vmid instead of silently backing up the entire cluster
	rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-bk/backups/jobs", adminPair.AccessToken, map[string]any{
		"schedule": "02:00",
		"storage":  "local",
		"all":      false,
		"vmid":     "",
	}, nil)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when all=false and vmid empty, got %d %s", rr.Code, rr.Body.String())
	}

	// Update job supports vmid, node, exclude, and allowlisted delete keys
	allFlag := false
	rrUp := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-bk/backups/jobs/backup-1", adminPair.AccessToken, map[string]any{
		"all":     &allFlag,
		"vmid":    "101, 102",
		"node":    "pve1",
		"exclude": "109",
		"delete":  []string{"comment"},
	}, nil)
	if rrUp.Code != http.StatusOK {
		t.Fatalf("expected 200 on backup job update, got %d %s", rrUp.Code, rrUp.Body.String())
	}
	if lastPut.Get("all") != "0" || lastPut.Get("vmid") != "101,102" || lastPut.Get("node") != "pve1" || lastPut.Get("exclude") != "109" || lastPut.Get("delete") != "comment" {
		t.Fatalf("unexpected backup job PUT params: %v", lastPut)
	}

	// Disallowed delete key rejected
	if rrBad := doJSONReq(t, router, http.MethodPut, "/api/v1/instances/inst-bk/backups/jobs/backup-1", adminPair.AccessToken, map[string]any{
		"delete": []string{"storage"},
	}, nil); rrBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for disallowed backup delete key, got %d", rrBad.Code)
	}
}
