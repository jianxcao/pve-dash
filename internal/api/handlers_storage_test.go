package api

import (
	"bytes"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestBuildStorageConfigParams(t *testing.T) {
	// Valid NFS create (normalizes trimmed/deduped nodes)
	p, err := buildCreateStorageParams(storageConfigCreateReq{
		Storage: "nas-nfs",
		Type:    "nfs",
		Server:  "198.51.100.20",
		Export:  "/export/proxmox",
		Content: []string{"iso", "backup", "iso"},
		Nodes:   " pve1 , pve2 , pve1 ",
	})
	if err != nil {
		t.Fatalf("expected valid nfs storage, got %v", err)
	}
	if p.Get("server") != "198.51.100.20" || p.Get("export") != "/export/proxmox" || p.Get("content") != "backup,iso" || p.Get("nodes") != "pve1,pve2" {
		t.Fatalf("unexpected nfs params: %v", p)
	}

	// Reject embedded newline in nodes/password/path
	if _, err := buildCreateStorageParams(storageConfigCreateReq{
		Storage: "nas-bad",
		Type:    "nfs",
		Server:  "198.51.100.20",
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
		Server:    "198.51.100.30",
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

func TestStorageOCIPullVersionGateAndMultipartUpload(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	var uploadedContent string
	mockHandler := func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/oci-registry-pull"):
			_, _ = w.Write([]byte(`{"data":"UPID:pve:1:oci"}`))
		case strings.HasSuffix(r.URL.Path, "/upload"):
			mr, err := r.MultipartReader()
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			for {
				p, err := mr.NextPart()
				if err != nil {
					break
				}
				if p.FormName() == "content" {
					buf := new(bytes.Buffer)
					_, _ = buf.ReadFrom(p)
					uploadedContent = strings.TrimSpace(buf.String())
				}
				p.Close()
			}
			_, _ = w.Write([]byte(`{"data":"UPID:pve:1:upload"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}

	seedMockPVEInstance(t, srv, "inst-pve8", "8.4.1", mockHandler)
	seedMockPVEInstance(t, srv, "inst-pve91", "9.1.0", mockHandler)

	// OCI Pull blocked on PVE 8.4 (< 9.1)
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-pve8/nodes/pve/storage/local/oci-pull", adminPair.AccessToken, map[string]any{
		"reference": "docker.io/library/alpine:latest",
	}, nil); rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 on PVE 8.4 OCI pull, got %d %s", rr.Code, rr.Body.String())
	}

	// OCI Pull allowed on PVE 9.1+
	if rr := doJSONReq(t, router, http.MethodPost, "/api/v1/instances/inst-pve91/nodes/pve/storage/local/oci-pull", adminPair.AccessToken, map[string]any{
		"reference": "docker.io/library/alpine:latest",
	}, nil); rr.Code != http.StatusOK {
		t.Fatalf("expected 200 on PVE 9.1 OCI pull, got %d %s", rr.Code, rr.Body.String())
	}

	// Multipart upload where `file` precedes `content` still uses `?content=vztmpl` query override
	var mpBuf bytes.Buffer
	mw := multipart.NewWriter(&mpBuf)
	fw, _ := mw.CreateFormFile("file", "alpine-rootfs.tar.zst")
	_, _ = fw.Write([]byte("archive-bytes"))
	_ = mw.WriteField("content", "vztmpl")
	_ = mw.Close()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/inst-pve91/nodes/pve/storage/local/upload?content=vztmpl", &mpBuf)
	req.Header.Set("Authorization", "Bearer "+adminPair.AccessToken)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rrUp := httptest.NewRecorder()
	router.ServeHTTP(rrUp, req)
	if rrUp.Code != http.StatusOK || uploadedContent != "vztmpl" {
		t.Fatalf("expected upload ok with content=vztmpl, got code=%d content=%q body=%s", rrUp.Code, uploadedContent, rrUp.Body.String())
	}

	// Reject invalid upload content query param
	reqBad := httptest.NewRequest(http.MethodPost, "/api/v1/instances/inst-pve91/nodes/pve/storage/local/upload?content=rootdir", nil)
	reqBad.Header.Set("Authorization", "Bearer "+adminPair.AccessToken)
	rrBad := httptest.NewRecorder()
	router.ServeHTTP(rrBad, reqBad)
	if rrBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid upload content type, got %d", rrBad.Code)
	}
}
