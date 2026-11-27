package pve

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMergeGuestTags(t *testing.T) {
	if got := MergeGuestTags("Prod;web", "add", []string{"Docker", "web"}); got != "docker;prod;web" {
		t.Fatalf("add tags got %q", got)
	}
	if got := MergeGuestTags("docker;prod;web", "remove", []string{"WEB"}); got != "docker;prod" {
		t.Fatalf("remove tags got %q", got)
	}
	if got := MergeGuestTags("old", "replace", []string{"B", "a"}); got != "a;b" {
		t.Fatalf("replace tags got %q", got)
	}
	if got := MergeGuestTags("only", "remove", []string{"only"}); got != "" {
		t.Fatalf("expected empty tags, got %q", got)
	}
}

func TestBuildFirewallScopePathAndValidators(t *testing.T) {
	p, err := BuildFirewallScopePath("cluster", "", "", 0)
	if err != nil || p != "/cluster/firewall" {
		t.Fatalf("cluster path got (%q, %v)", p, err)
	}
	p, err = BuildFirewallScopePath("node", "pve-01", "", 0)
	if err != nil || p != "/nodes/pve-01/firewall" {
		t.Fatalf("node path got (%q, %v)", p, err)
	}
	if _, err := BuildFirewallScopePath("node", "..", "", 0); err == nil {
		t.Fatal("expected traversal node name to fail")
	}
	p, err = BuildFirewallScopePath("guest", "pve", "lxc", 100)
	if err != nil || p != "/nodes/pve/lxc/100/firewall" {
		t.Fatalf("guest path got (%q, %v)", p, err)
	}
	if _, err := BuildFirewallScopePath("guest", "pve", "invalid", 100); err == nil {
		t.Fatal("expected invalid guest type error")
	}

	// Node validator
	if err := ValidateNodeName("pve1"); err != nil {
		t.Fatalf("expected pve1 valid: %v", err)
	}
	for _, bad := range []string{"", "..", ".", "pve/1", " pve1", "pve1\n", "-bad"} {
		if err := ValidateNodeName(bad); err == nil {
			t.Fatalf("expected node %q invalid", bad)
		}
	}

	// Iface validator (must reject whitespace & traversal)
	if err := ValidateIfaceName("vmbr0.100"); err != nil {
		t.Fatalf("expected vmbr0.100 valid: %v", err)
	}
	for _, bad := range []string{"../bad", " vmbr0", "vmbr0\n", "..", "a..b"} {
		if err := ValidateIfaceName(bad); err == nil {
			t.Fatalf("expected iface %q invalid", bad)
		}
	}

	// PoolID validator (supports nested PVE 8.1+ pools, rejects traversal & whitespace)
	for _, good := range []string{"homelab-prod", "parent/child", "org/team/env_1"} {
		if err := ValidatePoolID(good); err != nil {
			t.Fatalf("expected pool %q valid: %v", good, err)
		}
	}
	for _, bad := range []string{"", " prod", "prod\n", "/leading", "trailing/", "a//b", "a/../b", ".."} {
		if err := ValidatePoolID(bad); err == nil {
			t.Fatalf("expected pool %q invalid", bad)
		}
	}

	// Tag validator
	for _, good := range []string{"prod", "web-01", "_internal", "k8s.node+gpu"} {
		if err := ValidateGuestTag(good); err != nil {
			t.Fatalf("expected tag %q valid: %v", good, err)
		}
	}
	for _, bad := range []string{"", "a;b", "a b", "-dash", "bad/tag"} {
		if err := ValidateGuestTag(bad); err == nil {
			t.Fatalf("expected tag %q invalid", bad)
		}
	}
}

func TestOptionalFlexBoolSerialization(t *testing.T) {
	// Ensure explicit false is preserved (not omitted) when *FlexBool is non-nil, while nil is omitted.
	var opts FirewallOptions
	if err := json.Unmarshal([]byte(`{"enable":1,"dhcp":0,"macfilter":1}`), &opts); err != nil {
		t.Fatalf("unmarshal opts: %v", err)
	}
	if opts.DHCP == nil || bool(*opts.DHCP) != false {
		t.Fatalf("expected explicit dhcp=false, got %v", opts.DHCP)
	}
	if opts.MACFilter == nil || bool(*opts.MACFilter) != true {
		t.Fatalf("expected explicit macfilter=true, got %v", opts.MACFilter)
	}
	if opts.IPFilter != nil {
		t.Fatalf("expected omitted ipfilter=nil, got %v", opts.IPFilter)
	}
	out, err := json.Marshal(opts)
	if err != nil {
		t.Fatalf("marshal opts: %v", err)
	}
	s := string(out)
	if !strings.Contains(s, `"dhcp":false`) || !strings.Contains(s, `"macfilter":true`) || strings.Contains(s, `"ipfilter"`) {
		t.Fatalf("unexpected FirewallOptions JSON: %s", s)
	}

	var iface NodeNetworkIface
	if err := json.Unmarshal([]byte(`{"iface":"vmbr1","type":"bridge","exists":0}`), &iface); err != nil {
		t.Fatalf("unmarshal iface: %v", err)
	}
	if iface.Exists == nil || bool(*iface.Exists) != false {
		t.Fatalf("expected explicit exists=false, got %v", iface.Exists)
	}
	ifaceJSON, _ := json.Marshal(iface)
	if !strings.Contains(string(ifaceJSON), `"exists":false`) {
		t.Fatalf("expected exists:false in JSON, got %s", string(ifaceJSON))
	}
}
