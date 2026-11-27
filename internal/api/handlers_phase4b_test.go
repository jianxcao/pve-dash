package api

import "testing"

func TestBuildHAResourceAndMappingParams(t *testing.T) {
	mr, mrel := 2, 1
	p, err := buildHAResourceParams(haResourceReq{
		SID:         "vm:104",
		State:       "started",
		Group:       "ha-core",
		MaxRestart:  &mr,
		MaxRelocate: &mrel,
		Comment:     "critical",
	}, true, true)
	if err != nil {
		t.Fatalf("expected valid HA create on PVE 8, got %v", err)
	}
	if p.Get("sid") != "vm:104" || p.Get("group") != "ha-core" || p.Get("max_restart") != "2" {
		t.Fatalf("unexpected HA params: %v", p)
	}

	// PVE 9.x rejects group on HA resource
	if _, err := buildHAResourceParams(haResourceReq{
		SID:   "vm:104",
		Group: "ha-core",
	}, true, false); err == nil {
		t.Fatal("expected group rejected on PVE 9 HA rules mode")
	}

	// Reject out-of-range maxRestart
	badMR := 20
	if _, err := buildHAResourceParams(haResourceReq{SID: "ct:100", MaxRestart: &badMR}, true, false); err == nil {
		t.Fatal("expected maxRestart=20 rejected")
	}

	// Reject empty PUT
	if _, err := buildHAResourceParams(haResourceReq{}, false, false); err == nil {
		t.Fatal("expected empty HA PUT rejected")
	}

	// Valid PCI mapping
	mdev := true
	mp, err := buildCreateMappingParams("pci", createMappingReq{
		ID:          "igpu-uhd",
		Description: "Intel iGPU",
		Map:         []string{"node=pve,path=0000:00:02.0,id=8086:a7a0"},
		Mdev:        &mdev,
	})
	if err != nil {
		t.Fatalf("expected valid pci mapping, got %v", err)
	}
	if mp.Get("id") != "igpu-uhd" || mp.Get("mdev") != "1" || len(mp["map"]) != 1 {
		t.Fatalf("unexpected mapping params: %v", mp)
	}

	// Reject mapping entry without valid node= segment
	for _, badMap := range []string{
		"path=/mnt/media",
		"node=,path=/mnt/media",
		"description=node=pve,path=/mnt/media",
		"node=pve\x07,path=/mnt/media",
	} {
		if _, err := buildCreateMappingParams("dir", createMappingReq{
			ID:  "shared-media",
			Map: []string{badMap},
		}); err == nil {
			t.Fatalf("expected invalid mapping %q rejected", badMap)
		}
	}

	// Reject PCI-only flags on non-PCI mapping kinds
	if _, err := buildCreateMappingParams("usb", createMappingReq{
		ID:   "usb-zigbee",
		Map:  []string{"node=pve,id=1234:5678"},
		Mdev: &mdev,
	}); err == nil {
		t.Fatal("expected mdev rejected on usb mapping")
	}
}
