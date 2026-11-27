package pve

import "testing"

func TestMergeGuestTags(t *testing.T) {
	if got := MergeGuestTags("prod;web", "add", []string{"docker", "web"}); got != "docker;prod;web" {
		t.Fatalf("add tags got %q", got)
	}
	if got := MergeGuestTags("docker;prod;web", "remove", []string{"web"}); got != "docker;prod" {
		t.Fatalf("remove tags got %q", got)
	}
	if got := MergeGuestTags("old", "replace", []string{"b", "a"}); got != "a;b" {
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
	p, err = BuildFirewallScopePath("node", "pve", "", 0)
	if err != nil || p != "/nodes/pve/firewall" {
		t.Fatalf("node path got (%q, %v)", p, err)
	}
	p, err = BuildFirewallScopePath("guest", "pve", "lxc", 100)
	if err != nil || p != "/nodes/pve/lxc/100/firewall" {
		t.Fatalf("guest path got (%q, %v)", p, err)
	}
	if _, err := BuildFirewallScopePath("guest", "pve", "invalid", 100); err == nil {
		t.Fatal("expected invalid guest type error")
	}
	if err := ValidateIfaceName("vmbr0"); err != nil {
		t.Fatalf("expected vmbr0 valid: %v", err)
	}
	if err := ValidateIfaceName("../bad"); err == nil {
		t.Fatal("expected traversal iface invalid")
	}
	if err := ValidatePoolID("homelab-prod"); err != nil {
		t.Fatalf("expected pool valid: %v", err)
	}
	if err := ValidatePoolID("bad/pool"); err == nil {
		t.Fatal("expected slash pool invalid")
	}
}
