package pve

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateSSHHostAndPortParsing(t *testing.T) {
	valid := []struct {
		input      string
		wantTarget string
		wantPort   string
	}{
		{"", "", ""},
		{"pve1", "pve1", ""},
		{"root@198.51.100.10", "root@198.51.100.10", ""},
		{"admin_ops@pve-node01.lan:2222", "admin_ops@pve-node01.lan", "2222"},
		{"pve.lan:2200", "pve.lan", "2200"},
		{"2001:db8::1", "2001:db8::1", ""},
		{"root@2001:db8::1", "root@2001:db8::1", ""},
		{"[fe80::1]", "fe80::1", ""},
		{"root@[fe80::1]", "root@fe80::1", ""},
		{"[2001:db8::1]:2222", "2001:db8::1", "2222"},
		{"root@[2001:db8::1]:2222", "root@2001:db8::1", "2222"},
	}
	for _, tc := range valid {
		if err := ValidateSSHHost(tc.input); err != nil {
			t.Errorf("expected valid sshHost %q, got error: %v", tc.input, err)
		}
		gotTarget, gotPort, err := parseSSHHostTarget(tc.input)
		if err != nil || gotTarget != tc.wantTarget || gotPort != tc.wantPort {
			t.Errorf("parseSSHHostTarget(%q) = (%q, %q, %v), want (%q, %q, nil)",
				tc.input, gotTarget, gotPort, err, tc.wantTarget, tc.wantPort)
		}
		if strings.ContainsAny(gotTarget, "[]") {
			t.Errorf("expected brackets stripped from OpenSSH target for %q, got %q", tc.input, gotTarget)
		}
	}

	invalid := []string{
		"-oProxyCommand=id",
		"-F/tmp/evil",
		"--help",
		"root@host;id",
		"root@host $(whoami)",
		"root@host\nProxyCommand=id",
		"ssh://root@host",
		"-oLocalCommand=touch",
		"root@pve.lan:0",
		"root@pve.lan:65536",
		"root@pve.lan:abc",
		"root@pve.lan:-22",
		"2001:db8:::1",
		"[not-ipv6]:22",
		"[198.51.100.10]:22",
		"[fe80::1]:",
		"root@[fe80::1]extra",
	}
	for _, h := range invalid {
		if err := ValidateSSHHost(h); err == nil {
			t.Errorf("expected invalid sshHost %q to be rejected", h)
		}
	}

	// Verify -p <port>, stripped IPv6 brackets, and missing $HOME/.ssh fallback in buildSSHCommandArgs
	t.Setenv("HOME", filepath.Join(t.TempDir(), "nested-home"))
	target6, port6, err := parseSSHHostTarget("root@[2001:db8::1]:2222")
	if err != nil {
		t.Fatal(err)
	}
	args := buildSSHCommandArgs(target6, port6, "echo ok")
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "-p 2222 -- root@2001:db8::1") {
		t.Fatalf("expected -p 2222 before unbracketed IPv6 target, got: %v", args)
	}
}

func TestStandbySafeSSHProbeDoesNotFalseFailSleepingDisks(t *testing.T) {
	if !strings.Contains(alertStandbySSHProbeScript, "-n standby,0") {
		t.Fatalf("alert SSH script must pass -n standby,0 to smartctl")
	}
	if strings.Contains(alertStandbySSHProbeScript, "intel_gpu_top") {
		t.Fatalf("alert SSH script must skip intel_gpu_top")
	}

	rawOut := `===TOOLS===
smartctl=1
sensors=1
nvme=1
===SENSORS===
coretemp-isa-0000
Package id 0:  +48.0°C  (high = +80.0°C, crit = +100.0°C)
===SMART_STANDBY===
@@DISK|/dev/sda
{
  "json_format_version": [1, 0],
  "power_mode": {"name": "STANDBY"},
  "smartctl": {"messages": [{"string": "Device is in STANDBY mode, exit(0)"}]}
}
@@DISK|/dev/nvme0n1
{
  "serial_number": "SN-NVME-1",
  "smart_status": {"passed": true},
  "temperature": {"current": 39},
  "nvme_smart_health_information_log": {"percentage_used": 4, "available_spare": 100, "available_spare_threshold": 10}
}
`
	parsed := parseSSHProbeOutput(rawOut)
	if !parsed.StandbyDisks["/dev/sda"] {
		t.Fatalf("expected /dev/sda detected as standby disk")
	}
	if parsed.DiskSMART["/dev/nvme0n1"] == nil {
		t.Fatalf("expected /dev/nvme0n1 parsed in DiskSMART")
	}

	// Even if a partial smartctl JSON omits smart_status without standby text, it must NOT default to FAILED
	partialItem := &DiskHardwareItem{DevPath: "/dev/sdb", Type: "hdd"}
	var partialDoc smartctlJSON
	applySmartJSON(partialItem, &partialDoc)
	if partialItem.Health == "FAILED" {
		t.Fatalf("missing smart_status must never default Health to FAILED")
	}
}

func TestNVMeOver100PercentUsedAndSMARTScore(t *testing.T) {
	item := &DiskHardwareItem{
		DevPath: "/dev/nvme0n1",
		Health:  "PASSED",
	}
	parseSmartText(item, "Temperature: 42 Celsius\nPercentage Used: 112%\nAvailable Spare: 95%\nAvailable Spare Threshold: 10%\n")
	if item.UsedLifePct == nil || *item.UsedLifePct != 112 {
		t.Fatalf("expected UsedLifePct=112, got %v", item.UsedLifePct)
	}
	if item.WearoutPct == nil || *item.WearoutPct != 0 {
		t.Fatalf("expected WearoutPct clamped to 0, got %v", item.WearoutPct)
	}
	computeDiskHealth(item, false)
	if item.HealthPct == nil || *item.HealthPct != 0 {
		t.Fatalf("expected worn-out NVMe HealthPct=0, got %v", item.HealthPct)
	}
	if item.HealthGrade != "critical" {
		t.Fatalf("expected critical grade, got %q", item.HealthGrade)
	}
}
