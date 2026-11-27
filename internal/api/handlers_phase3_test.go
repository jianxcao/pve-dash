package api

import (
	"testing"
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
	if _, err := buildNetworkParams(nodeNetworkReq{Type: "bridge", Gateway: "192.168.1.1", Delete: []string{"gateway"}}, false); err == nil {
		t.Fatal("expected set+delete overlap to fail")
	}
}

func TestBuildFirewallRuleParamsValidation(t *testing.T) {
	// Valid security group rule
	en := true
	p, err := buildFirewallRuleParams("cluster", firewallRuleReq{
		Type:   "group",
		Action: "web_tier",
		Enable: &en,
		Iface:  "vmbr0",
	}, true)
	if err != nil {
		t.Fatalf("expected valid group rule, got error: %v", err)
	}
	if p.Get("type") != "group" || p.Get("action") != "web_tier" {
		t.Fatalf("unexpected group params: %v", p)
	}

	// Group rule must reject proto/log/dport
	if _, err := buildFirewallRuleParams("cluster", firewallRuleReq{
		Type:   "group",
		Action: "web_tier",
		Proto:  "tcp",
	}, true); err == nil {
		t.Fatal("expected group rule with proto to fail")
	}

	// Guest scope must reject forward rules
	if _, err := buildFirewallRuleParams("guest", firewallRuleReq{
		Type:   "forward",
		Action: "ACCEPT",
	}, true); err == nil {
		t.Fatal("expected guest forward rule to fail")
	}

	// Macro + proto mutual exclusion
	if _, err := buildFirewallRuleParams("node", firewallRuleReq{
		Type:   "in",
		Action: "ACCEPT",
		Macro:  "SSH",
		Proto:  "tcp",
	}, true); err == nil {
		t.Fatal("expected macro + proto to fail")
	}

	// Empty update must fail
	if _, err := buildFirewallRuleParams("node", firewallRuleReq{}, false); err == nil {
		t.Fatal("expected empty PUT to fail")
	}

	// Toggle enable only with digest must succeed
	disable := false
	p, err = buildFirewallRuleParams("guest", firewallRuleReq{
		Enable: &disable,
		Digest: "abc123",
	}, false)
	if err != nil {
		t.Fatalf("expected toggle enable with digest to succeed, got %v", err)
	}
	if p.Get("enable") != "0" || p.Get("digest") != "abc123" {
		t.Fatalf("unexpected toggle params: %v", p)
	}
}
