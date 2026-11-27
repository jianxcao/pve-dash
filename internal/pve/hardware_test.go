package pve

import "testing"

func TestValidateSSHHost(t *testing.T) {
	valid := []string{
		"",
		"pve1",
		"root@192.168.1.10",
		"admin_ops@pve-node01.lan",
		"root@[fe80::1]",
	}
	for _, h := range valid {
		if err := ValidateSSHHost(h); err != nil {
			t.Errorf("expected valid sshHost %q, got error: %v", h, err)
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
	}
	for _, h := range invalid {
		if err := ValidateSSHHost(h); err == nil {
			t.Errorf("expected invalid sshHost %q to be rejected", h)
		}
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
