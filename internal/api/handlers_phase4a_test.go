package api

import "testing"

func TestBuildStorageConfigParams(t *testing.T) {
	// Valid NFS create (normalizes trimmed/deduped nodes)
	p, err := buildCreateStorageParams(storageConfigCreateReq{
		Storage: "nas-nfs",
		Type:    "nfs",
		Server:  "192.168.1.20",
		Export:  "/export/proxmox",
		Content: []string{"iso", "backup", "iso"},
		Nodes:   " pve1 , pve2 , pve1 ",
	})
	if err != nil {
		t.Fatalf("expected valid nfs storage, got %v", err)
	}
	if p.Get("server") != "192.168.1.20" || p.Get("export") != "/export/proxmox" || p.Get("content") != "backup,iso" || p.Get("nodes") != "pve1,pve2" {
		t.Fatalf("unexpected nfs params: %v", p)
	}

	// Reject embedded newline in nodes/password/path
	if _, err := buildCreateStorageParams(storageConfigCreateReq{
		Storage: "nas-bad",
		Type:    "nfs",
		Server:  "192.168.1.20",
		Export:  "/export/proxmox",
		Nodes:   "pve1,\npve2",
	}); err == nil {
		t.Fatal("expected newline in nodes rejected")
	}

	// Reject directory traversal
	if _, err := buildCreateStorageParams(storageConfigCreateReq{
		Storage: "bad-dir",
		Type:    "dir",
		Path:    "/mnt/../etc",
	}); err == nil {
		t.Fatal("expected dir path traversal rejected")
	}

	// Reject unsupported content type on PBS (only backup/none allowed)
	if _, err := buildCreateStorageParams(storageConfigCreateReq{
		Storage:   "pbs-main",
		Type:      "pbs",
		Server:    "192.168.1.30",
		Datastore: "backups",
		Username:  "backup@pbs",
		Content:   []string{"iso"},
	}); err == nil {
		t.Fatal("expected iso content rejected on pbs")
	}

	// Reject combining none with other content types
	if _, err := buildUpdateStorageParams("iscsi", storageConfigUpdateReq{
		Content: []string{"none", "images"},
	}); err == nil {
		t.Fatal("expected none + images rejected")
	}

	// Allow content=none on iscsi
	if up, err := buildUpdateStorageParams("iscsi", storageConfigUpdateReq{Content: []string{"none"}}); err != nil || up.Get("content") != "none" {
		t.Fatalf("expected content=none valid on iscsi, got (%v, %v)", up, err)
	}

	// Reject prune-backups on lvmthin and shared on nfs
	if _, err := buildUpdateStorageParams("lvmthin", storageConfigUpdateReq{PruneBackups: "keep-last=3"}); err == nil {
		t.Fatal("expected prune-backups rejected on lvmthin")
	}
	sh := true
	if _, err := buildUpdateStorageParams("nfs", storageConfigUpdateReq{Shared: &sh}); err == nil {
		t.Fatal("expected shared rejected on nfs")
	}
	// Allow shared on lvm
	if up, err := buildUpdateStorageParams("lvm", storageConfigUpdateReq{Shared: &sh}); err != nil || up.Get("shared") != "1" {
		t.Fatalf("expected shared allowed on lvm, got (%v, %v)", up, err)
	}

	// Update validation: empty, disallowed delete, overlap
	if _, err := buildUpdateStorageParams("dir", storageConfigUpdateReq{}); err == nil {
		t.Fatal("expected empty update rejected")
	}
	if _, err := buildUpdateStorageParams("dir", storageConfigUpdateReq{Delete: []string{"storage"}}); err == nil {
		t.Fatal("expected disallowed delete key rejected")
	}
	dis := true
	if _, err := buildUpdateStorageParams("dir", storageConfigUpdateReq{Disable: &dis, Delete: []string{"disable"}}); err == nil {
		t.Fatal("expected set+delete overlap rejected")
	}
	up, err := buildUpdateStorageParams("dir", storageConfigUpdateReq{
		Content: []string{"backup", "iso"},
		Disable: &dis,
		Digest:  "deadbeef",
	})
	if err != nil || up.Get("disable") != "1" || up.Get("digest") != "deadbeef" {
		t.Fatalf("expected valid storage update, got (%v, %v)", up, err)
	}
}
