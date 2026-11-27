package pve

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPhase4AValidatorsAndCephErrorClassification(t *testing.T) {
	for _, good := range []string{"local", "nas-nfs_01", "pbs.main", "s1"} {
		if err := ValidateStorageID(good); err != nil {
			t.Fatalf("expected storage id %q valid: %v", good, err)
		}
	}
	for _, bad := range []string{"", "a", " local", "local\n", "../etc", "a..b", "1bad", "a/b", "nas-", "nas."} {
		if err := ValidateStorageID(bad); err == nil {
			t.Fatalf("expected storage id %q invalid", bad)
		}
	}

	for _, good := range []string{"rpool", "tank_01", "nvme-pool:fast"} {
		if err := ValidateZFSName(good); err != nil {
			t.Fatalf("expected zfs name %q valid: %v", good, err)
		}
	}
	for _, bad := range []string{"", " rpool", "a..b", "a/b"} {
		if err := ValidateZFSName(bad); err == nil {
			t.Fatalf("expected zfs name %q invalid", bad)
		}
	}

	if !IsCephNotInstalledError(&APIError{StatusCode: http.StatusInternalServerError, Body: "pveceph configuration not initialized"}) {
		t.Fatal("expected not-initialized ceph error classified as not installed")
	}
	if !IsCephNotInstalledError(&APIError{StatusCode: http.StatusNotImplemented, Body: "not implemented"}) {
		t.Fatal("expected 501 classified as not installed")
	}
	// Live Ceph outage errors MUST NOT be misclassified as "not installed"!
	if IsCephNotInstalledError(&APIError{StatusCode: http.StatusInternalServerError, Body: "rados_connect failed - Connection timed out"}) {
		t.Fatal("expected rados timeout outage NOT classified as not installed")
	}
	if IsCephNotInstalledError(&APIError{StatusCode: http.StatusInternalServerError, Body: "unable to connect to monitor"}) {
		t.Fatal("expected monitor outage NOT classified as not installed")
	}
	if IsCephNotInstalledError(errors.New("connection refused")) {
		t.Fatal("expected generic network error NOT classified as ceph not installed")
	}
}

func TestCephOverviewEndpointsAndIntegerQuorumParsing(t *testing.T) {
	var hitPoolSingular, hitPoolPlural bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api2/json/nodes/pve1/ceph/status":
			_, _ = w.Write([]byte(`{"data":{"health":{"status":"HEALTH_WARN","checks":{"Z_CHECK":{"severity":"HEALTH_WARN","summary":{"message":"z"}},"A_CHECK":{"severity":"HEALTH_WARN","summary":{"message":"a"}}}},"monmap":{"num_mons":3},"quorum":[0,1,2],"mgrmap":{"active_name":"pve1"},"osdmap":{"osdmap":{"num_osds":6,"num_up_osds":6,"num_in_osds":6}},"pgmap":{"num_pgs":128,"bytes_total":1000,"bytes_used":250,"bytes_avail":750,"read_bytes_sec":100,"write_bytes_sec":200,"read_op_per_sec":10,"write_op_per_sec":20}}}`))
		case "/api2/json/nodes/pve1/ceph/pool":
			hitPoolSingular = true
			_, _ = w.Write([]byte(`{"data":[{"pool_name":"rbd","pool":1,"size":3,"min_size":2,"pg_num":64,"bytes_used":120,"percent_used":0.12}]}`))
		case "/api2/json/nodes/pve1/ceph/pools":
			hitPoolPlural = true
			w.WriteHeader(http.StatusNotImplemented)
		case "/api2/json/nodes/pve1/ceph/mon":
			// PVE returns integer 1 for quorum!
			_, _ = w.Write([]byte(`{"data":[{"name":"pve1","host":"pve1","addr":"10.0.0.1:3300","rank":0,"quorum":1,"state":"leader"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	cl, err := NewClient(ClientConfig{
		InstanceID:  "inst1",
		AuthMode:    "token",
		TokenID:     "root@pam!test",
		TokenSecret: "secret",
		TLSMode:     "insecure",
		Endpoints:   []EndpointConfig{{ID: "ep1", URL: srv.URL, Priority: 1}},
	})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	defer cl.Close()

	ov, err := cl.GetNodeCephOverview(context.Background(), "pve1")
	if err != nil {
		t.Fatalf("GetNodeCephOverview: %v", err)
	}
	if !hitPoolSingular || hitPoolPlural {
		t.Fatalf("expected singular /ceph/pool hit=%v, plural hit=%v", hitPoolSingular, hitPoolPlural)
	}
	if !ov.Installed || ov.Health != "HEALTH_WARN" || ov.OSDTotal != 6 || ov.QuorumCount != 3 {
		t.Fatalf("unexpected CephOverview: %+v", ov)
	}
	if len(ov.HealthMessages) != 2 || ov.HealthMessages[0] > ov.HealthMessages[1] {
		t.Fatalf("expected sorted health messages, got %v", ov.HealthMessages)
	}
	if len(ov.Pools) != 1 || ov.Pools[0].PoolName != "rbd" {
		t.Fatalf("expected 1 pool, got %+v", ov.Pools)
	}
	if len(ov.Monitors) != 1 || !bool(ov.Monitors[0].Quorum) || ov.Monitors[0].Name != "pve1" {
		t.Fatalf("expected integer quorum=1 parsed into Monitor, got %+v", ov.Monitors)
	}
}
