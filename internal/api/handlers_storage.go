package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
)

// --- Storage Content, Streaming Upload, URL/APL/OCI Downloads & Volume Management ---

var allowedUploadContentTypes = map[string]bool{
	"iso":    true,
	"vztmpl": true,
	"import": true,
}

func (s *Server) handleStorageContent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, err := cl.GetStorageContent(r.Context(), node, storage, r.URL.Query().Get("content"))
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if items == nil {
		items = []pve.StorageContentItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleStorageUpload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	qContent := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("content")))
	if qContent != "" && !allowedUploadContentTypes[qContent] {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("不支持的上传内容类型 %q（仅支持 iso、vztmpl、import）", qContent))
		return
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}

	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "expected multipart/form-data upload: "+err.Error())
		return
	}

	contentTypeField := "iso"
	if qContent != "" {
		contentTypeField = qContent
	}
	var uploadedName string
	var upid string
	fileHandled := false

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, "read multipart stream: "+err.Error())
			return
		}
		formName := part.FormName()
		if formName == "content" {
			b, _ := io.ReadAll(io.LimitReader(part, 128))
			part.Close()
			if v := strings.ToLower(strings.TrimSpace(string(b))); v != "" {
				if !allowedUploadContentTypes[v] {
					writeErr(w, http.StatusBadRequest, fmt.Sprintf("不支持的上传内容类型 %q（仅支持 iso、vztmpl、import）", v))
					return
				}
				if qContent == "" {
					contentTypeField = v
				}
			}
			continue
		}
		if formName == "filename" || formName == "file" {
			rawName := strings.ReplaceAll(strings.TrimSpace(part.FileName()), "\\", "/")
			fname := filepath.Base(rawName)
			if fname == "" || fname == "." || fname == "/" {
				part.Close()
				writeErr(w, http.StatusBadRequest, "missing upload filename")
				return
			}
			uploadedName = fname
			upid, err = cl.UploadStorageStream(r.Context(), node, storage, contentTypeField, fname, part)
			part.Close()
			fileHandled = true
			s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.upload", fmt.Sprintf("%s (%s)", fname, contentTypeField), upid, err)
			if err != nil {
				s.writePVEError(w, err)
				return
			}
			break
		}
		part.Close()
	}

	if !fileHandled {
		writeErr(w, http.StatusBadRequest, "no file field found in multipart upload")
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "filename": uploadedName, "upid": upid})
}

func (s *Server) handleQueryURLMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		URL         string `json:"url"`
		VerifyCerts *bool  `json:"verifyCerts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.URL) == "" {
		writeErr(w, http.StatusBadRequest, "url is required")
		return
	}
	parsedURL, err := url.Parse(strings.TrimSpace(body.URL))
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		writeErr(w, http.StatusBadRequest, "仅支持有效的 http:// 或 https:// 下载地址")
		return
	}
	verify := true
	if body.VerifyCerts != nil {
		verify = *body.VerifyCerts
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	meta, err := cl.QueryURLMetadata(r.Context(), node, strings.TrimSpace(body.URL), verify)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) handleStorageDownloadURL(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		URL               string `json:"url"`
		Filename          string `json:"filename"`
		Content           string `json:"content"` // iso | vztmpl | import
		Checksum          string `json:"checksum"`
		ChecksumAlgorithm string `json:"checksumAlgorithm"`
		VerifyCerts       *bool  `json:"verifyCerts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.URL) == "" || strings.TrimSpace(body.Filename) == "" {
		writeErr(w, http.StatusBadRequest, "url and filename are required")
		return
	}
	parsedURL, err := url.Parse(strings.TrimSpace(body.URL))
	if err != nil || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.Host == "" {
		writeErr(w, http.StatusBadRequest, "仅支持有效的 http:// 或 https:// 下载地址")
		return
	}
	content := strings.ToLower(strings.TrimSpace(body.Content))
	if content == "" {
		content = "iso"
	}
	if !allowedUploadContentTypes[content] {
		writeErr(w, http.StatusBadRequest, fmt.Sprintf("不支持的内容类型 %q", body.Content))
		return
	}
	verify := true
	if body.VerifyCerts != nil {
		verify = *body.VerifyCerts
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.DownloadURLToStorage(r.Context(), node, storage, content, body.URL, body.Filename, body.Checksum, body.ChecksumAlgorithm, verify)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.download_url", fmt.Sprintf("%s -> %s", body.URL, body.Filename), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleListAPLTemplates(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, err := cl.GetNodeAPLTemplates(r.Context(), node)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if items == nil {
		items = []pve.APLTemplate{}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Section != items[j].Section {
			return items[i].Section < items[j].Section
		}
		return items[i].Template < items[j].Template
	})
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleDownloadAPLTemplate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Storage  string `json:"storage"`
		Template string `json:"template"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Storage) == "" || strings.TrimSpace(body.Template) == "" {
		writeErr(w, http.StatusBadRequest, "storage and template are required")
		return
	}
	storage := strings.TrimSpace(body.Storage)
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.DownloadAPLTemplate(r.Context(), node, storage, body.Template)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.apl_download", body.Template, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleStorageOCIPull(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Reference string `json:"reference"`
		Filename  string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Reference) == "" {
		writeErr(w, http.StatusBadRequest, "reference is required (e.g. docker.io/library/alpine:latest)")
		return
	}
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if inst != nil && inst.DetectedVersion != "" {
		caps := pve.BuildCapabilities(&pve.VersionInfo{Version: inst.DetectedVersion}, inst.IsCluster)
		if !caps.Features.LXCOciImages {
			writeErr(w, http.StatusBadRequest, "OCI 容器镜像拉取仅支持 Proxmox VE 9.1 及以上版本")
			return
		}
	}
	upid, err := cl.PullOCIToStorage(r.Context(), node, storage, body.Reference, body.Filename)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.oci_pull", body.Reference, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleDeleteStorageVolume(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	volid := strings.TrimSpace(r.URL.Query().Get("volid"))
	if volid == "" {
		volid = urlParamDecoded(r, "volume")
	}
	if volid == "" || strings.Contains(volid, "..") || hasControlChars(volid) {
		writeErr(w, http.StatusBadRequest, "volume is required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.DeleteStorageVolume(r.Context(), node, storage, volid)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.volume.delete", volid, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleUpdateVolumeConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	volid := strings.TrimSpace(r.URL.Query().Get("volid"))
	if volid == "" {
		volid = urlParamDecoded(r, "volume")
	}
	if volid == "" || strings.Contains(volid, "..") || hasControlChars(volid) {
		writeErr(w, http.StatusBadRequest, "volid is required")
		return
	}
	var body struct {
		Notes     *string `json:"notes"`
		Protected *bool   `json:"protected"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.UpdateVolumeConfig(r.Context(), node, storage, volid, body.Notes, body.Protected)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.volume.update", volid, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Cluster Storage Definitions CRUD (/storage) ---

type storagePluginCaps struct {
	Content              map[string]bool
	SupportsNone         bool
	SupportsPruneBackups bool
	SupportsShared       bool
}

var (
	allowedCreateStorageTypes = map[string]bool{
		"dir":  true,
		"nfs":  true,
		"cifs": true,
		"pbs":  true,
	}
	allowedStorageContentTypes = map[string]bool{
		"images":   true,
		"rootdir":  true,
		"iso":      true,
		"vztmpl":   true,
		"backup":   true,
		"snippets": true,
		"import":   true,
		"none":     true,
		// PVE 9.2+ granular content types
		"vm-vol":   true,
		"vm-state": true,
		"ct-vol":   true,
	}
	allowedStorageDeleteKeys = map[string]bool{
		"nodes":                 true,
		"disable":               true,
		"shared":                true,
		"prune-backups":         true,
		"max-protected-backups": true,
	}
	storageCapsByType = map[string]storagePluginCaps{
		"dir": {
			Content:              map[string]bool{"images": true, "rootdir": true, "iso": true, "vztmpl": true, "backup": true, "snippets": true, "import": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         true,
			SupportsPruneBackups: true,
			SupportsShared:       true,
		},
		"btrfs": {
			Content:              map[string]bool{"images": true, "rootdir": true, "iso": true, "vztmpl": true, "backup": true, "snippets": true, "import": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         true,
			SupportsPruneBackups: true,
			SupportsShared:       true,
		},
		"nfs": {
			Content:              map[string]bool{"images": true, "rootdir": true, "iso": true, "vztmpl": true, "backup": true, "snippets": true, "import": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         false,
			SupportsPruneBackups: true,
			SupportsShared:       false,
		},
		"cifs": {
			Content:              map[string]bool{"images": true, "rootdir": true, "iso": true, "vztmpl": true, "backup": true, "snippets": true, "import": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         false,
			SupportsPruneBackups: true,
			SupportsShared:       false,
		},
		"cephfs": {
			Content:              map[string]bool{"iso": true, "vztmpl": true, "backup": true, "snippets": true, "import": true},
			SupportsNone:         false,
			SupportsPruneBackups: true,
			SupportsShared:       false,
		},
		"pbs": {
			Content:              map[string]bool{"backup": true},
			SupportsNone:         true,
			SupportsPruneBackups: true,
			SupportsShared:       false,
		},
		"lvm": {
			Content:              map[string]bool{"images": true, "rootdir": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         false,
			SupportsPruneBackups: false,
			SupportsShared:       true,
		},
		"lvmthin": {
			Content:              map[string]bool{"images": true, "rootdir": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         false,
			SupportsPruneBackups: false,
			SupportsShared:       false,
		},
		"zfspool": {
			Content:              map[string]bool{"images": true, "rootdir": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         false,
			SupportsPruneBackups: false,
			SupportsShared:       false,
		},
		"rbd": {
			Content:              map[string]bool{"images": true, "rootdir": true, "vm-vol": true, "vm-state": true, "ct-vol": true},
			SupportsNone:         false,
			SupportsPruneBackups: false,
			SupportsShared:       false,
		},
		"iscsi": {
			Content:              map[string]bool{"images": true, "vm-vol": true},
			SupportsNone:         true,
			SupportsPruneBackups: false,
			SupportsShared:       false,
		},
	}
)

type storageConfigCreateReq struct {
	Storage      string   `json:"storage"`
	Type         string   `json:"type"` // dir | nfs | cifs | pbs
	Content      []string `json:"content"`
	Path         string   `json:"path"`
	Server       string   `json:"server"`
	Export       string   `json:"export"`
	Share        string   `json:"share"`
	Username     string   `json:"username"`
	Password     string   `json:"password"`
	Domain       string   `json:"domain"`
	Datastore    string   `json:"datastore"`
	Fingerprint  string   `json:"fingerprint"`
	Nodes        string   `json:"nodes"`
	Shared       *bool    `json:"shared"`
	Disable      *bool    `json:"disable"`
	PruneBackups string   `json:"pruneBackups"`
}

func validateContentList(pluginType string, items []string) (string, error) {
	caps, hasCaps := storageCapsByType[pluginType]
	seen := map[string]bool{}
	var out []string
	hasNone := false
	for _, raw := range items {
		c := strings.TrimSpace(raw)
		if c == "" {
			continue
		}
		if !allowedStorageContentTypes[c] {
			return "", fmt.Errorf("不支持的存储内容类型 %q", c)
		}
		if c == "none" {
			if hasCaps && !caps.SupportsNone {
				return "", fmt.Errorf("存储类型 %s 不支持将内容设为 none", pluginType)
			}
			hasNone = true
		} else if hasCaps && !caps.Content[c] {
			return "", fmt.Errorf("存储类型 %s 不支持内容类型 %q", pluginType, c)
		}
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	if hasNone && len(out) > 1 {
		return "", fmt.Errorf("内容类型 none 不能与其他类型同时选择")
	}
	sort.Strings(out)
	return strings.Join(out, ","), nil
}

func validateAndNormalizeNodes(raw string) (string, error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	if hasLineBreak(raw) {
		return "", fmt.Errorf("nodes 参数不能包含换行符")
	}
	seen := map[string]bool{}
	var clean []string
	for _, part := range strings.Split(raw, ",") {
		n := strings.TrimSpace(part)
		if n == "" {
			continue
		}
		if err := pve.ValidateNodeName(n); err != nil {
			return "", fmt.Errorf("nodes 列表包含无效节点名 %q", n)
		}
		if !seen[n] {
			seen[n] = true
			clean = append(clean, n)
		}
	}
	return strings.Join(clean, ","), nil
}

func validateHostLike(s string) bool {
	if s == "" || len(s) > 253 {
		return false
	}
	return !strings.ContainsAny(s, " \t\r\n/\\?#\x00")
}

func buildCreateStorageParams(req storageConfigCreateReq) (url.Values, error) {
	if err := pve.ValidateStorageID(req.Storage); err != nil {
		return nil, err
	}
	stType := strings.TrimSpace(req.Type)
	if !allowedCreateStorageTypes[stType] {
		return nil, fmt.Errorf("暂仅支持通过面板创建 dir、nfs、cifs 或 pbs 类型存储")
	}
	p := url.Values{
		"storage": {req.Storage},
		"type":    {stType},
	}

	if len(req.Content) > 0 {
		cStr, err := validateContentList(stType, req.Content)
		if err != nil {
			return nil, err
		}
		if cStr != "" {
			p.Set("content", cStr)
		}
	}

	switch stType {
	case "dir":
		pathVal := strings.TrimSpace(req.Path)
		if pathVal == "" || hasLineBreak(pathVal) || !strings.HasPrefix(pathVal, "/") || strings.Contains(pathVal, "..") {
			return nil, fmt.Errorf("目录存储的 path 必须为以 / 开头的单行绝对路径且不能包含 ..")
		}
		p.Set("path", pathVal)
		if req.Shared != nil {
			if *req.Shared {
				p.Set("shared", "1")
			} else {
				p.Set("shared", "0")
			}
		}
	case "nfs":
		srv := strings.TrimSpace(req.Server)
		exp := strings.TrimSpace(req.Export)
		if !validateHostLike(srv) {
			return nil, fmt.Errorf("请填写有效的 NFS 服务器地址")
		}
		if exp == "" || hasLineBreak(exp) || !strings.HasPrefix(exp, "/") || strings.Contains(exp, "..") {
			return nil, fmt.Errorf("NFS Export 路径必须为以 / 开头的单行路径")
		}
		p.Set("server", srv)
		p.Set("export", exp)
	case "cifs":
		srv := strings.TrimSpace(req.Server)
		share := strings.TrimSpace(req.Share)
		if !validateHostLike(srv) {
			return nil, fmt.Errorf("请填写有效的 SMB/CIFS 服务器地址")
		}
		if share == "" || hasLineBreak(share) || strings.ContainsAny(share, "/\\") {
			return nil, fmt.Errorf("请填写有效的共享名 (Share)")
		}
		if hasLineBreak(req.Username) || hasLineBreak(req.Password) || hasLineBreak(req.Domain) {
			return nil, fmt.Errorf("凭据字段不能包含换行符")
		}
		p.Set("server", srv)
		p.Set("share", share)
		if u := strings.TrimSpace(req.Username); u != "" {
			p.Set("username", u)
		}
		if req.Password != "" {
			p.Set("password", req.Password)
		}
		if d := strings.TrimSpace(req.Domain); d != "" {
			p.Set("domain", d)
		}
	case "pbs":
		srv := strings.TrimSpace(req.Server)
		ds := strings.TrimSpace(req.Datastore)
		user := strings.TrimSpace(req.Username)
		if !validateHostLike(srv) {
			return nil, fmt.Errorf("请填写有效的 PBS 服务器地址")
		}
		if ds == "" || hasLineBreak(ds) || strings.ContainsAny(ds, " \t/") {
			return nil, fmt.Errorf("请填写有效的 PBS Datastore 名称")
		}
		if user == "" || hasLineBreak(user) || hasLineBreak(req.Password) || hasLineBreak(req.Fingerprint) {
			return nil, fmt.Errorf("请填写有效的 PBS 用户名与单行凭据")
		}
		p.Set("server", srv)
		p.Set("datastore", ds)
		p.Set("username", user)
		if req.Password != "" {
			p.Set("password", req.Password)
		}
		if fp := strings.TrimSpace(req.Fingerprint); fp != "" {
			p.Set("fingerprint", fp)
		}
	}

	if cleanNodes, err := validateAndNormalizeNodes(req.Nodes); err != nil {
		return nil, err
	} else if cleanNodes != "" {
		p.Set("nodes", cleanNodes)
	}
	if req.Disable != nil {
		if *req.Disable {
			p.Set("disable", "1")
		} else {
			p.Set("disable", "0")
		}
	}
	if prune := strings.TrimSpace(req.PruneBackups); prune != "" {
		if hasLineBreak(prune) {
			return nil, fmt.Errorf("pruneBackups 不能包含换行符")
		}
		p.Set("prune-backups", prune)
	}
	return p, nil
}

type storageConfigUpdateReq struct {
	Content      []string `json:"content"`
	Nodes        string   `json:"nodes"`
	Disable      *bool    `json:"disable"`
	Shared       *bool    `json:"shared"`
	PruneBackups string   `json:"pruneBackups"`
	Digest       string   `json:"digest"`
	Delete       []string `json:"delete"`
}

func buildUpdateStorageParams(pluginType string, req storageConfigUpdateReq) (url.Values, error) {
	caps, hasCaps := storageCapsByType[pluginType]
	p := url.Values{}
	if len(req.Content) > 0 {
		cStr, err := validateContentList(pluginType, req.Content)
		if err != nil {
			return nil, err
		}
		if cStr != "" {
			p.Set("content", cStr)
		}
	}
	if cleanNodes, err := validateAndNormalizeNodes(req.Nodes); err != nil {
		return nil, err
	} else if cleanNodes != "" {
		p.Set("nodes", cleanNodes)
	}
	if req.Disable != nil {
		if *req.Disable {
			p.Set("disable", "1")
		} else {
			p.Set("disable", "0")
		}
	}
	if req.Shared != nil {
		if hasCaps && !caps.SupportsShared {
			return nil, fmt.Errorf("存储类型 %s 不支持修改 shared 属性", pluginType)
		}
		if *req.Shared {
			p.Set("shared", "1")
		} else {
			p.Set("shared", "0")
		}
	}
	if prune := strings.TrimSpace(req.PruneBackups); prune != "" {
		if hasCaps && !caps.SupportsPruneBackups {
			return nil, fmt.Errorf("存储类型 %s 不支持设置 prune-backups", pluginType)
		}
		if hasLineBreak(prune) {
			return nil, fmt.Errorf("pruneBackups 不能包含换行符")
		}
		p.Set("prune-backups", prune)
	}
	if len(req.Delete) > 0 {
		var cleanDel []string
		seen := map[string]bool{}
		for _, k := range req.Delete {
			c := strings.TrimSpace(k)
			if c == "" {
				continue
			}
			if !allowedStorageDeleteKeys[c] {
				return nil, fmt.Errorf("不允许删除的存储配置字段 %q", c)
			}
			if c == "shared" && hasCaps && !caps.SupportsShared {
				return nil, fmt.Errorf("存储类型 %s 不支持删除 shared 属性", pluginType)
			}
			if c == "prune-backups" && hasCaps && !caps.SupportsPruneBackups {
				return nil, fmt.Errorf("存储类型 %s 不支持删除 prune-backups 属性", pluginType)
			}
			if p.Has(c) {
				return nil, fmt.Errorf("字段 %q 不能同时设置和删除", c)
			}
			if !seen[c] {
				seen[c] = true
				cleanDel = append(cleanDel, c)
			}
		}
		if len(cleanDel) > 0 {
			p.Set("delete", strings.Join(cleanDel, ","))
		}
	}
	if len(p) == 0 {
		return nil, fmt.Errorf("未提供任何需要更新的存储配置字段")
	}
	if d := strings.TrimSpace(req.Digest); d != "" {
		if hasLineBreak(d) {
			return nil, fmt.Errorf("digest 不能包含换行符")
		}
		p.Set("digest", d)
	}
	return p, nil
}

func (s *Server) handleListStorageConfigs(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, err := cl.ListStorageConfigs(r.Context())
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Storage < items[j].Storage })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleCreateStorageConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	var req storageConfigCreateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	params, err := buildCreateStorageParams(req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.CreateStorageConfig(r.Context(), params)
	// Audit summary intentionally excludes any password/secret
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s", id, req.Storage), "storage.config.create", fmt.Sprintf("%s (%s)", req.Storage, req.Type), "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleUpdateStorageConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	storageID := urlParamDecoded(r, "storage")
	if err := pve.ValidateStorageID(storageID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var req storageConfigUpdateReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	// Resolve plugin type from live config so per-plugin schema constraints are enforced cleanly
	existing, err := cl.GetStorageConfig(r.Context(), storageID)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	params, err := buildUpdateStorageParams(existing.Type, req)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	err = cl.UpdateStorageConfig(r.Context(), storageID, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s", id, storageID), "storage.config.update", storageID, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteStorageConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	storageID := urlParamDecoded(r, "storage")
	if err := pve.ValidateStorageID(storageID); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if storageID == "local" {
		writeErr(w, http.StatusBadRequest, "系统默认 local 存储不允许通过面板删除")
		return
	}
	if r.Header.Get("X-Confirm-Target") != storageID {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.DeleteStorageConfig(r.Context(), storageID)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s", id, storageID), "storage.config.delete", storageID, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
