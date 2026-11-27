package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"golang.org/x/sync/errgroup"
)

// --- Phase 4A: Node Disk Stacks (ZFS / LVM / LVM-Thin / Directory) ---

func (s *Server) handleNodeDisksOverview(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	var (
		zfsPools []pve.ZFSPoolSummary
		lvmVGs   []pve.LVMVolumeGroup
		lvmThins []pve.LVMThinPool
		dirs     []pve.DirectoryMount
		zfsErr   error
		lvmErr   error
		thinErr  error
		dirErr   error
	)

	var g errgroup.Group
	g.Go(func() error {
		zfsPools, zfsErr = cl.ListNodeZFS(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		lvmVGs, lvmErr = cl.ListNodeLVM(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		lvmThins, thinErr = cl.ListNodeLVMThin(r.Context(), node)
		return nil
	})
	g.Go(func() error {
		dirs, dirErr = cl.ListNodeDirectory(r.Context(), node)
		return nil
	})
	_ = g.Wait()

	if zfsErr != nil && lvmErr != nil && thinErr != nil && dirErr != nil {
		writeErr(w, http.StatusBadGateway, "读取宿主机磁盘栈失败: "+lvmErr.Error())
		return
	}

	// Best-effort enrich ZFS VDEV topology (bounded concurrency, up to 8 pools)
	if zfsErr == nil && len(zfsPools) > 0 {
		var zg errgroup.Group
		zg.SetLimit(4)
		limit := len(zfsPools)
		if limit > 8 {
			limit = 8
		}
		for i := 0; i < limit; i++ {
			idx := i
			zg.Go(func() error {
				if det, err := cl.GetNodeZFSDetail(r.Context(), node, zfsPools[idx].Name); err == nil && det != nil {
					zfsPools[idx].Scan = det.Scan
					zfsPools[idx].Errors = det.Errors
					zfsPools[idx].Children = det.Children
				}
				return nil
			})
		}
		_ = zg.Wait()
	}

	if zfsPools == nil {
		zfsPools = []pve.ZFSPoolSummary{}
	}
	if lvmVGs == nil {
		lvmVGs = []pve.LVMVolumeGroup{}
	}
	if lvmThins == nil {
		lvmThins = []pve.LVMThinPool{}
	}
	if dirs == nil {
		dirs = []pve.DirectoryMount{}
	}

	sort.Slice(zfsPools, func(i, j int) bool { return zfsPools[i].Name < zfsPools[j].Name })
	sort.Slice(lvmVGs, func(i, j int) bool { return lvmVGs[i].Name < lvmVGs[j].Name })
	sort.Slice(lvmThins, func(i, j int) bool { return lvmThins[i].Vg+"/"+lvmThins[i].Lv < lvmThins[j].Vg+"/"+lvmThins[j].Lv })
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Path < dirs[j].Path })

	warnings := map[string]string{}
	var warnMu sync.Mutex
	addWarn := func(k string, e error) {
		if e != nil {
			warnMu.Lock()
			warnings[k] = e.Error()
			warnMu.Unlock()
		}
	}
	addWarn("zfs", zfsErr)
	addWarn("lvm", lvmErr)
	addWarn("lvmthin", thinErr)
	addWarn("directory", dirErr)

	resp := map[string]any{
		"node":        node,
		"zfs":         zfsPools,
		"lvm":         lvmVGs,
		"lvmthin":     lvmThins,
		"directories": dirs,
	}
	if len(warnings) > 0 {
		resp["warnings"] = warnings
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) handleNodeCeph(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	ov, err := cl.GetNodeCephOverview(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

// --- Phase 4A: Cluster Storage Definitions CRUD (/storage) ---

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

func hasLineBreak(s string) bool {
	return strings.ContainsAny(s, "\r\n\x00")
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.ListStorageConfigs(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.CreateStorageConfig(r.Context(), params)
	// Audit summary intentionally excludes any password/secret
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s", id, req.Storage), "storage.config.create", fmt.Sprintf("%s (%s)", req.Storage, req.Type), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	// Resolve plugin type from live config so per-plugin schema constraints are enforced cleanly
	existing, err := cl.GetStorageConfig(r.Context(), storageID)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
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
		writeErr(w, http.StatusBadGateway, err.Error())
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.DeleteStorageConfig(r.Context(), storageID)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s", id, storageID), "storage.config.delete", storageID, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
