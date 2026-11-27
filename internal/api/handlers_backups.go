package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
)

// --- Backups, Restore & Cluster Backup Schedules ---

var allowedBackupJobDeleteKeys = map[string]bool{
	"node":           true,
	"vmid":           true,
	"all":            true,
	"exclude":        true,
	"comment":        true,
	"prune-backups":  true,
	"notes-template": true,
	"pool":           true,
}

func (s *Server) handleRunVZDump(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
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
	storage := strings.TrimSpace(body.Storage)
	if body.VMID < 100 || storage == "" {
		writeErr(w, http.StatusBadRequest, "vmid and storage are required")
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	params := url.Values{
		"vmid":    {strconv.Itoa(body.VMID)},
		"storage": {storage},
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
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.RunVZDump(r.Context(), node, params)
	s.recordAudit(r, id, fmt.Sprintf("%s:backup:%s:%d", id, node, body.VMID), "backup.vzdump", fmt.Sprintf("#%d -> %s (%s/%s)", body.VMID, storage, params.Get("mode"), params.Get("compress")), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleRestoreBackup(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
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
	if st := strings.TrimSpace(body.Storage); st != "" {
		if err := pve.ValidateStorageID(st); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.RestoreBackup(r.Context(), node, body.Type, body.VMID, body.Archive, body.Storage, body.Force, body.Start)
	s.recordAudit(r, id, fmt.Sprintf("%s:%s:%s:%d", id, body.Type, node, body.VMID), "backup.restore", fmt.Sprintf("%s -> #%d", body.Archive, body.VMID), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleListBackupJobs(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	jobs, err := cl.GetClusterBackupJobs(r.Context())
	if err != nil {
		s.writePVEError(w, err)
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
		Exclude      string `json:"exclude"`
		Node         string `json:"node"`
		Enabled      *bool  `json:"enabled"`
		PruneBackups string `json:"pruneBackups"`
		Comment      string `json:"comment"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	schedule := strings.TrimSpace(body.Schedule)
	storage := strings.TrimSpace(body.Storage)
	if schedule == "" || storage == "" {
		writeErr(w, http.StatusBadRequest, "schedule and storage are required")
		return
	}
	if err := pve.ValidateStorageID(storage); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	vmidRaw := strings.TrimSpace(body.VMID)
	if !body.All && vmidRaw == "" {
		writeErr(w, http.StatusBadRequest, "必须开启全集群备份 (all=true) 或指定至少一个 VMID")
		return
	}

	params := url.Values{
		"schedule": {schedule},
		"storage":  {storage},
		"mode":     {orDefault(body.Mode, "snapshot")},
		"compress": {orDefault(body.Compress, "zstd")},
	}
	if body.All {
		params.Set("all", "1")
	} else {
		vmids, err := normalizeVMIDList(vmidRaw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "vmid "+err.Error())
			return
		}
		params.Set("vmid", vmids)
	}
	if excRaw := strings.TrimSpace(body.Exclude); excRaw != "" {
		exc, err := normalizeVMIDList(excRaw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "exclude "+err.Error())
			return
		}
		params.Set("exclude", exc)
	}
	if node := strings.TrimSpace(body.Node); node != "" {
		if err := pve.ValidateNodeName(node); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		params.Set("node", node)
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
		s.writePVEError(w, err)
		return
	}
	err = cl.CreateClusterBackupJob(r.Context(), params)
	s.recordAudit(r, id, id+":cluster:backup", "cluster.backup.create", fmt.Sprintf("%s -> %s", schedule, storage), "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true})
}

func (s *Server) handleUpdateBackupJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	jobID := strings.TrimSpace(urlParamDecoded(r, "jobId"))
	if jobID == "" || strings.Contains(jobID, "..") || strings.Contains(jobID, "/") || hasControlChars(jobID) {
		writeErr(w, http.StatusBadRequest, "invalid backup job id")
		return
	}
	var body struct {
		Enabled      *bool    `json:"enabled"`
		Schedule     string   `json:"schedule"`
		Storage      string   `json:"storage"`
		Mode         string   `json:"mode"`
		Compress     string   `json:"compress"`
		All          *bool    `json:"all"`
		VMID         string   `json:"vmid"`
		Node         string   `json:"node"`
		Exclude      string   `json:"exclude"`
		PruneBackups string   `json:"pruneBackups"`
		Comment      string   `json:"comment"`
		Delete       []string `json:"delete"`
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
	if st := strings.TrimSpace(body.Storage); st != "" {
		if err := pve.ValidateStorageID(st); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		params.Set("storage", st)
	}
	if strings.TrimSpace(body.Mode) != "" {
		params.Set("mode", strings.TrimSpace(body.Mode))
	}
	if strings.TrimSpace(body.Compress) != "" {
		params.Set("compress", strings.TrimSpace(body.Compress))
	}
	if body.All != nil {
		if *body.All {
			params.Set("all", "1")
		} else {
			params.Set("all", "0")
		}
	}
	if vmidRaw := strings.TrimSpace(body.VMID); vmidRaw != "" {
		vmids, err := normalizeVMIDList(vmidRaw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "vmid "+err.Error())
			return
		}
		params.Set("vmid", vmids)
	}
	if node := strings.TrimSpace(body.Node); node != "" {
		if err := pve.ValidateNodeName(node); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		params.Set("node", node)
	}
	if excRaw := strings.TrimSpace(body.Exclude); excRaw != "" {
		exc, err := normalizeVMIDList(excRaw)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "exclude "+err.Error())
			return
		}
		params.Set("exclude", exc)
	}
	if strings.TrimSpace(body.PruneBackups) != "" {
		params.Set("prune-backups", strings.TrimSpace(body.PruneBackups))
	}
	if body.Comment != "" {
		params.Set("comment", body.Comment)
	}
	if len(body.Delete) > 0 {
		var cleanDel []string
		seen := map[string]bool{}
		for _, k := range body.Delete {
			c := strings.TrimSpace(k)
			if c == "" {
				continue
			}
			if !allowedBackupJobDeleteKeys[c] {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("不允许删除的备份计划字段 %q", c))
				return
			}
			if params.Has(c) {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("字段 %q 不能同时设置和删除", c))
				return
			}
			if !seen[c] {
				seen[c] = true
				cleanDel = append(cleanDel, c)
			}
		}
		if len(cleanDel) > 0 {
			params.Set("delete", strings.Join(cleanDel, ","))
		}
	}
	if len(params) == 0 {
		writeErr(w, http.StatusBadRequest, "未提供任何需要更新的备份计划字段")
		return
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.UpdateClusterBackupJob(r.Context(), jobID, params)
	s.recordAudit(r, id, id+":cluster:backup:"+jobID, "cluster.backup.update", jobID, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleDeleteBackupJob(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	jobID := strings.TrimSpace(urlParamDecoded(r, "jobId"))
	if jobID == "" || strings.Contains(jobID, "..") || strings.Contains(jobID, "/") || hasControlChars(jobID) {
		writeErr(w, http.StatusBadRequest, "invalid backup job id")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.DeleteClusterBackupJob(r.Context(), jobID)
	s.recordAudit(r, id, id+":cluster:backup:"+jobID, "cluster.backup.delete", jobID, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleNotBackedUpGuests(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	items, err := cl.GetNotBackedUpGuests(r.Context())
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if items == nil {
		items = []pve.NotBackedUpGuest{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].VMID < items[j].VMID })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}
