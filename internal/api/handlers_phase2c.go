package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
)

// --- Node Services, Syslog & APT ---

func (s *Server) handleNodeServices(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.GetNodeServices(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []pve.NodeServiceItem{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Service < items[j].Service })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleNodeServiceAction(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	service := urlParamDecoded(r, "service")
	action := chi.URLParam(r, "action")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.ControlNodeService(r.Context(), node, service, action)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s:service:%s", id, node, service), "node.service."+action, service, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleNodeSyslog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	service := r.URL.Query().Get("service")
	since := r.URL.Query().Get("since")
	until := r.URL.Query().Get("until")
	if since == "" {
		if hrs, err := strconv.Atoi(r.URL.Query().Get("hours")); err == nil && hrs > 0 && hrs <= 720 {
			since = time.Now().Add(-time.Duration(hrs) * time.Hour).Format("2006-01-02 15:04:05")
		}
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	lines, err := cl.GetNodeSyslog(r.Context(), node, limit, service, since, until)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if lines == nil {
		lines = []pve.SyslogLine{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": lines})
}

func (s *Server) handleNodeAPTUpdates(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.GetNodeAPTUpdates(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []pve.APTUpdatePkg{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Package < items[j].Package })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleNodeAPTRefresh(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.RefreshNodeAPT(r.Context(), node)
	s.recordAudit(r, id, fmt.Sprintf("%s:node:%s", id, node), "node.apt.update", "apt-get update", upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleNodeAPTRepositories(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	res, err := cl.GetNodeAPTRepositories(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if res.Files == nil {
		res.Files = []map[string]any{}
	}
	if res.Errors == nil {
		res.Errors = []map[string]any{}
	}
	if res.Infos == nil {
		res.Infos = []map[string]any{}
	}
	if res.StandardRepos == nil {
		res.StandardRepos = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, res)
}

// --- Backups, Restore & Cluster Backup Schedules ---

func (s *Server) handleRunVZDump(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	var body struct {
		VMID          int    `json:"vmid"`
		Storage       string `json:"storage"`
		Mode          string `json:"mode"`     // snapshot | suspend | stop
		Compress      string `json:"compress"` // zstd | lzo | gzip | 0
		NotesTemplate string `json:"notesTemplate"`
		Protected     bool   `json:"protected"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.VMID < 100 || strings.TrimSpace(body.Storage) == "" {
		writeErr(w, http.StatusBadRequest, "vmid and storage are required")
		return
	}
	params := url.Values{
		"vmid":    {strconv.Itoa(body.VMID)},
		"storage": {strings.TrimSpace(body.Storage)},
	}
	if body.Mode != "" {
		params.Set("mode", body.Mode)
	} else {
		params.Set("mode", "snapshot")
	}
	if body.Compress != "" {
		params.Set("compress", body.Compress)
	} else {
		params.Set("compress", "zstd")
	}
	if strings.TrimSpace(body.NotesTemplate) != "" {
		params.Set("notes-template", strings.TrimSpace(body.NotesTemplate))
	}
	if body.Protected {
		params.Set("protected", "1")
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.RunVZDump(r.Context(), node, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:backup:%s:%d", id, node, body.VMID), "backup.vzdump", fmt.Sprintf("#%d -> %s (%s/%s)", body.VMID, body.Storage, params.Get("mode"), params.Get("compress")), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleUpdateVolumeConfig(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	volid := strings.TrimSpace(r.URL.Query().Get("volid"))
	if volid == "" {
		volid = urlParamDecoded(r, "volume")
	}
	if volid == "" {
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.UpdateVolumeConfig(r.Context(), node, storage, volid, body.Notes, body.Protected)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.volume.update", volid, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	var body struct {
		Type    string `json:"type"` // qemu | lxc
		VMID    int    `json:"vmid"`
		Archive string `json:"archive"`
		Storage string `json:"storage"`
		Force   bool   `json:"force"`
		Start   bool   `json:"start"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.VMID < 100 || strings.TrimSpace(body.Archive) == "" {
		writeErr(w, http.StatusBadRequest, "vmid and archive are required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.RestoreBackup(r.Context(), node, body.Type, body.VMID, body.Archive, body.Storage, body.Force, body.Start)
	s.recordAudit(r, id, fmt.Sprintf("%s:%s:%s:%d", id, body.Type, node, body.VMID), "backup.restore", fmt.Sprintf("%s -> #%d", body.Archive, body.VMID), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleListBackupJobs(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	jobs, err := cl.GetClusterBackupJobs(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if jobs == nil {
		jobs = []pve.BackupJob{}
	}
	sort.Slice(jobs, func(i, j int) bool { return jobs[i].ID < jobs[j].ID })
	writeJSON(w, http.StatusOK, map[string]any{"items": jobs})
}

func (s *Server) handleCreateBackupJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	var body struct {
		Schedule     string `json:"schedule"`
		Storage      string `json:"storage"`
		Mode         string `json:"mode"`
		Compress     string `json:"compress"`
		All          bool   `json:"all"`
		VMID         string `json:"vmid"`
		Node         string `json:"node"`
		Enabled      *bool  `json:"enabled"`
		PruneBackups string `json:"pruneBackups"`
		Comment      string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.Schedule) == "" || strings.TrimSpace(body.Storage) == "" {
		writeErr(w, http.StatusBadRequest, "schedule and storage are required")
		return
	}
	params := url.Values{
		"schedule": {strings.TrimSpace(body.Schedule)},
		"storage":  {strings.TrimSpace(body.Storage)},
		"mode":     {orDefault(body.Mode, "snapshot")},
		"compress": {orDefault(body.Compress, "zstd")},
	}
	if body.All {
		params.Set("all", "1")
	} else if strings.TrimSpace(body.VMID) != "" {
		params.Set("vmid", strings.TrimSpace(body.VMID))
	} else {
		params.Set("all", "1")
	}
	if strings.TrimSpace(body.Node) != "" {
		params.Set("node", strings.TrimSpace(body.Node))
	}
	if body.Enabled != nil && !*body.Enabled {
		params.Set("enabled", "0")
	} else {
		params.Set("enabled", "1")
	}
	if strings.TrimSpace(body.PruneBackups) != "" {
		params.Set("prune-backups", strings.TrimSpace(body.PruneBackups))
	}
	if strings.TrimSpace(body.Comment) != "" {
		params.Set("comment", strings.TrimSpace(body.Comment))
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.CreateClusterBackupJob(r.Context(), params)
	s.recordAudit(r, id, id+":cluster:backup", "cluster.backup.create", fmt.Sprintf("%s -> %s", body.Schedule, body.Storage), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleUpdateBackupJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	jobID := urlParamDecoded(r, "jobId")
	var body struct {
		Enabled      *bool  `json:"enabled"`
		Schedule     string `json:"schedule"`
		Storage      string `json:"storage"`
		Mode         string `json:"mode"`
		Compress     string `json:"compress"`
		PruneBackups string `json:"pruneBackups"`
		Comment      string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	params := url.Values{}
	if body.Enabled != nil {
		if *body.Enabled {
			params.Set("enabled", "1")
		} else {
			params.Set("enabled", "0")
		}
	}
	if strings.TrimSpace(body.Schedule) != "" {
		params.Set("schedule", strings.TrimSpace(body.Schedule))
	}
	if strings.TrimSpace(body.Storage) != "" {
		params.Set("storage", strings.TrimSpace(body.Storage))
	}
	if strings.TrimSpace(body.Mode) != "" {
		params.Set("mode", strings.TrimSpace(body.Mode))
	}
	if strings.TrimSpace(body.Compress) != "" {
		params.Set("compress", strings.TrimSpace(body.Compress))
	}
	if strings.TrimSpace(body.PruneBackups) != "" {
		params.Set("prune-backups", strings.TrimSpace(body.PruneBackups))
	}
	if body.Comment != "" {
		params.Set("comment", body.Comment)
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.UpdateClusterBackupJob(r.Context(), jobID, params)
	s.recordAudit(r, id, id+":cluster:backup:"+jobID, "cluster.backup.update", jobID, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteBackupJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	jobID := urlParamDecoded(r, "jobId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.DeleteClusterBackupJob(r.Context(), jobID)
	s.recordAudit(r, id, id+":cluster:backup:"+jobID, "cluster.backup.delete", jobID, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleNotBackedUpGuests(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.GetNotBackedUpGuests(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []pve.NotBackedUpGuest{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].VMID < items[j].VMID })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}
