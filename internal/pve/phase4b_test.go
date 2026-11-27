package pve

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestPhase4BValidatorsAndACMEParser(t *testing.T) {
	for _, good := range []string{"vm:100", "ct:101"} {
		if err := ValidateHASID(good); err != nil {
			t.Fatalf("expected sid %q valid: %v", good, err)
		}
	}
	for _, bad := range []string{"", "100", "vm:0", "vm:-1", "lxc:100", "vm:100 ", "vm:100/.."} {
		if err := ValidateHASID(bad); err == nil {
			t.Fatalf("expected sid %q invalid", bad)
		}
	}

	if err := ValidateMappingKind("pci"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMappingKind("usb"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMappingKind("dir"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMappingKind("other"); err == nil {
		t.Fatal("expected other mapping kind invalid")
	}

	for _, good := range []string{"ab", "igpu-uhd", "usb_zigbee01"} {
		if err := ValidateMappingID(good); err != nil {
			t.Fatalf("expected mapping id %q valid: %v", good, err)
		}
	}
	for _, bad := range []string{"", "a", "gpu.0", " bad", "a..b", "../x", "1gpu"} {
		if err := ValidateMappingID(bad); err == nil {
			t.Fatalf("expected mapping id %q invalid", bad)
		}
	}

	acct, domains := ParseNodeACMEConfig(map[string]any{
		"acme":        "account=default,domains=pve1.example.com;pve1-alt.example.com",
		"acmedomain0": "domain=lab.example.com,plugin=cloudflare",
		"acmedomain1": "pve1.example.com", // duplicate should be deduplicated
	})
	if acct != "default" {
		t.Fatalf("expected account=default, got %q", acct)
	}
	want := []string{"pve1.example.com", "pve1-alt.example.com", "lab.example.com"}
	if !reflect.DeepEqual(domains, want) {
		t.Fatalf("expected domains %v, got %v", want, domains)
	}
}

func TestHAResourceZeroMaxRestartPreserved(t *testing.T) {
	raw := `{"sid":"vm:100","state":"started","max_restart":0,"max_relocate":0}`
	var res HAResource
	if err := json.Unmarshal([]byte(raw), &res); err != nil {
		t.Fatalf("unmarshal HAResource failed: %v", err)
	}
	if res.MaxRestart == nil || *res.MaxRestart != 0 || res.MaxRelocate == nil || *res.MaxRelocate != 0 {
		t.Fatalf("expected explicit 0 preserved, got restart=%v relocate=%v", res.MaxRestart, res.MaxRelocate)
	}
	out, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal failed: %v", err)
	}
	if !strings.Contains(string(out), `"max_restart":0`) || !strings.Contains(string(out), `"max_relocate":0`) {
		t.Fatalf("expected JSON to preserve explicit zeros, got %s", out)
	}

	var defRes HAResource
	if err := json.Unmarshal([]byte(`{"sid":"vm:101"}`), &defRes); err != nil {
		t.Fatal(err)
	}
	if defRes.MaxRestart != nil || defRes.MaxRelocate != nil {
		t.Fatalf("expected omitted fields nil, got restart=%v relocate=%v", defRes.MaxRestart, defRes.MaxRelocate)
	}
}

func TestACMEOrderAndRenewMethods(t *testing.T) {
	var seenMethods []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api2/json/nodes/pve/certificates/acme/certificate" {
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		seenMethods = append(seenMethods, r.Method)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":"UPID:pve:00001234:00000001:66000000:acmenewcert::root@pam:"}`))
	}))
	defer ts.Close()

	cl, err := NewClient(ClientConfig{
		AuthMode:    "token",
		TokenID:     "root@pam!test",
		TokenSecret: "secret",
		TLSMode:     "insecure",
		Endpoints:   []EndpointConfig{{URL: ts.URL, Priority: 10}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()

	if upid, err := cl.OrderNodeACMECert(context.Background(), "pve", true); err != nil || upid == "" {
		t.Fatalf("OrderNodeACMECert failed: upid=%q err=%v", upid, err)
	}
	if upid, err := cl.RenewNodeACMECert(context.Background(), "pve", false); err != nil || upid == "" {
		t.Fatalf("RenewNodeACMECert failed: upid=%q err=%v", upid, err)
	}
	if !reflect.DeepEqual(seenMethods, []string{http.MethodPost, http.MethodPut}) {
		t.Fatalf("expected [POST PUT], got %v", seenMethods)
	}
}
