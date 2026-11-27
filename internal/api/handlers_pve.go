package api

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

// --- Multi-PVE Aggregated Endpoints ---

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("refresh") == "1"
	ov, err := s.agg.GetOverview(r.Context(), force)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, ov)
}

func (s *Server) handleGuests(w http.ResponseWriter, r *http.Request) {
	ov, err := s.agg.GetOverview(r.Context(), r.URL.Query().Get("refresh") == "1")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	qInst := r.URL.Query().Get("instanceId")
	qNode := r.URL.Query().Get("node")
	qType := r.URL.Query().Get("type")
	qStatus := r.URL.Query().Get("status")
	qTag := strings.ToLower(r.URL.Query().Get("tag"))
	qText := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))

	filtered := make([]service.UnifiedGuest, 0, len(ov.Guests))
	for _, g := range ov.Guests {
		if qInst != "" && g.InstanceID != qInst {
			continue
		}
		if qNode != "" && g.Node != qNode {
			continue
		}
		if qType != "" {
			if qType == "template" {
				if !g.Template {
					continue
				}
			} else if g.Type != qType {
				continue
			}
		}
		if qStatus != "" && g.Status != qStatus {
			continue
		}
		if qTag != "" {
			found := false
			for _, t := range g.Tags {
				if strings.ToLower(t) == qTag {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		if qText != "" {
			vmidStr := strconv.FormatInt(g.VMID, 10)
			if !strings.Contains(strings.ToLower(g.Name), qText) &&
				!strings.Contains(vmidStr, qText) &&
				!strings.Contains(strings.ToLower(g.Node), qText) &&
				!strings.Contains(strings.ToLower(strings.Join(g.Tags, " ")), qText) {
				continue
			}
		}
		filtered = append(filtered, g)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": filtered, "updatedAt": ov.UpdatedAt})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	hits, err := s.agg.Search(r.Context(), r.URL.Query().Get("q"))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if hits == nil {
		hits = []service.SearchHit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": hits})
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request) {
	ov, err := s.agg.GetOverview(r.Context(), r.URL.Query().Get("refresh") == "1")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	qInst := r.URL.Query().Get("instanceId")
	qNode := r.URL.Query().Get("node")
	qID := r.URL.Query().Get("id")

	out := make([]service.UnifiedTask, 0, len(ov.Tasks))
	for _, t := range ov.Tasks {
		if qInst != "" && t.InstanceID != qInst {
			continue
		}
		if qNode != "" && t.Node != qNode {
			continue
		}
		if qID != "" && t.ID != qID {
			continue
		}
		out = append(out, t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out, "updatedAt": ov.UpdatedAt})
}

func (s *Server) handleEventsSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	sendSnapshot := func() {
		ov, err := s.agg.GetOverview(r.Context(), false)
		if err != nil {
			return
		}
		b, err := json.Marshal(ov)
		if err != nil {
			return
		}
		fmt.Fprintf(w, "event: overview\ndata: %s\n\n", b)
		flusher.Flush()
	}

	sendSnapshot()
	intervalSec := 3
	if v, err := strconv.Atoi(r.URL.Query().Get("interval")); err == nil && v >= 2 && v <= 30 {
		intervalSec = v
	}
	ticker := time.NewTicker(time.Duration(intervalSec) * time.Second)
	pingTicker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	defer pingTicker.Stop()

	claims := getClaims(r)
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.shutdownCtx.Done():
			return
		case <-ticker.C:
			if !s.isClaimsSessionValid(r.Context(), claims) {
				fmt.Fprint(w, "event: auth_expired\ndata: {\"error\":\"session revoked\"}\n\n")
				flusher.Flush()
				return
			}
			sendSnapshot()
		case <-pingTicker.C:
			if !s.isClaimsSessionValid(r.Context(), claims) {
				return
			}
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}

// --- Instance CRUD & Probe ---

type instancePayload struct {
	InstanceID     string `json:"instanceId"` // Optional: used by adhoc probe in Edit dialog to reuse saved secrets
	Name           string `json:"name"`
	GroupName      string `json:"groupName"`
	Color          string `json:"color"`
	AuthMode       string `json:"authMode"` // token | ticket | hybrid
	TokenID        string `json:"tokenId"`
	TokenSecret    string `json:"tokenSecret"`
	TicketUsername string `json:"ticketUsername"`
	TicketPassword string `json:"ticketPassword"`
	TLSMode        string `json:"tlsMode"` // strict | tofu | insecure
	CACertPEM      string `json:"caCertPem"`
	SSHHost        string `json:"sshHost"`
	Enabled        *bool  `json:"enabled"`
	Endpoints      []struct {
		ID              string `json:"id"`
		NodeName        string `json:"nodeName"`
		URL             string `json:"url"`
		Priority        int    `json:"priority"`
		CertFingerprint string `json:"certFingerprint"`
	} `json:"endpoints"`
}

type instanceResponse struct {
	*store.PVEInstance
	HasTokenSecret    bool              `json:"hasTokenSecret"`
	HasTicketPassword bool              `json:"hasTicketPassword"`
	Capabilities      *pve.Capabilities `json:"capabilities,omitempty"`
}

func toInstanceResponse(inst *store.PVEInstance) instanceResponse {
	r := instanceResponse{
		PVEInstance:       inst,
		HasTokenSecret:    len(inst.TokenSecretEnc) > 0,
		HasTicketPassword: len(inst.TicketPasswordEnc) > 0,
	}
	if inst.CapabilitiesJSON != "" && inst.CapabilitiesJSON != "{}" {
		var c pve.Capabilities
		if json.Unmarshal([]byte(inst.CapabilitiesJSON), &c) == nil {
			r.Capabilities = &c
		}
	}
	return r
}

func (s *Server) handleListInstances(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListInstances(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out := make([]instanceResponse, 0, len(list))
	for _, inst := range list {
		out = append(out, toInstanceResponse(inst))
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": out})
}

func (s *Server) handleGetInstance(w http.ResponseWriter, r *http.Request) {
	inst, err := s.store.GetInstance(r.Context(), chi.URLParam(r, "instanceId"))
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			status = http.StatusNotFound
		}
		writeErr(w, status, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, toInstanceResponse(inst))
}

func normalizeAndValidateEndpointURL(raw string) (string, error) {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if u == "" {
		return "", errors.New("empty endpoint URL")
	}
	lower := strings.ToLower(u)
	if !strings.HasPrefix(lower, "https://") && !strings.HasPrefix(lower, "http://") {
		u = "https://" + u
	}
	parsed, err := url.Parse(u)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return "", fmt.Errorf("无效的 PVE 节点地址: %q", raw)
	}
	return strings.TrimRight(parsed.String(), "/"), nil
}

func (s *Server) handleProbeAdhoc(w http.ResponseWriter, r *http.Request) {
	var body instancePayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if len(body.Endpoints) == 0 {
		writeErr(w, http.StatusBadRequest, "at least one endpoint URL is required")
		return
	}

	// If probing from Edit Instance modal with blank secret fields, load saved encrypted secrets
	tokenSecret := strings.TrimSpace(body.TokenSecret)
	ticketPass := body.TicketPassword
	existingFPByURL := map[string]string{}
	if strings.TrimSpace(body.InstanceID) != "" {
		if existing, err := s.store.GetInstance(r.Context(), strings.TrimSpace(body.InstanceID)); err == nil {
			if tokenSecret == "" && len(existing.TokenSecretEnc) > 0 {
				if dec, err := s.box.DecryptString(existing.TokenSecretEnc); err == nil {
					tokenSecret = dec
				}
			}
			if ticketPass == "" && len(existing.TicketPasswordEnc) > 0 {
				if dec, err := s.box.DecryptString(existing.TicketPasswordEnc); err == nil {
					ticketPass = dec
				}
			}
			for _, ep := range existing.Endpoints {
				existingFPByURL[strings.TrimRight(ep.URL, "/")] = ep.CertFingerprint
			}
		}
	}

	eps := make([]pve.EndpointConfig, 0, len(body.Endpoints))
	for i, ep := range body.Endpoints {
		cleanURL, err := normalizeAndValidateEndpointURL(ep.URL)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		prio := ep.Priority
		if prio == 0 {
			prio = (i + 1) * 10
		}
		fp := strings.ToUpper(strings.TrimSpace(ep.CertFingerprint))
		if fp == "" {
			fp = existingFPByURL[cleanURL]
		}
		eps = append(eps, pve.EndpointConfig{
			URL:             cleanURL,
			Priority:        prio,
			CertFingerprint: fp,
		})
	}
	cl, err := pve.NewClient(pve.ClientConfig{
		AuthMode:       body.AuthMode,
		TokenID:        strings.TrimSpace(body.TokenID),
		TokenSecret:    tokenSecret,
		TicketUsername: strings.TrimSpace(body.TicketUsername),
		TicketPassword: ticketPass,
		TLSMode:        body.TLSMode,
		CACertPEM:      body.CACertPEM,
		Endpoints:      eps,
	})
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cl.Close()
	writeJSON(w, http.StatusOK, cl.Probe(r.Context()))
}

func (s *Server) handleCreateInstance(w http.ResponseWriter, r *http.Request) {
	var body instancePayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	inst, err := s.buildInstanceModel(nil, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	// Best-effort initial probe to capture version, capabilities & TOFU fingerprints
	if cl, err := s.pool.BuildClientFromInstance(inst, false); err == nil {
		defer cl.Close()
		if pr := cl.Probe(r.Context()); pr.OK {
			inst.DetectedVersion = pr.Version.Version
			inst.IsCluster = pr.Capabilities.IsCluster
			if b, err := json.Marshal(pr.Capabilities); err == nil {
				inst.CapabilitiesJSON = string(b)
			}
			inst.LastSeenAt = time.Now().UTC().Format(time.RFC3339)
			for i := range inst.Endpoints {
				if inst.Endpoints[i].CertFingerprint == "" {
					if fp, ok := pr.Fingerprints[strings.TrimRight(inst.Endpoints[i].URL, "/")]; ok {
						inst.Endpoints[i].CertFingerprint = fp
					}
				}
			}
		}
	}

	if err := s.store.SaveInstance(r.Context(), inst, true); err != nil {
		s.recordAudit(r, inst.ID, "instance:"+inst.Name, "instance.create", inst.Name, "", err)
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.pool.Invalidate(inst.ID)
	s.agg.InvalidateCache()
	s.recordAudit(r, inst.ID, "instance:"+inst.Name, "instance.create", inst.Name, "", nil)
	writeJSON(w, http.StatusCreated, toInstanceResponse(inst))
}

func (s *Server) handleUpdateInstance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	existing, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}
	var body instancePayload
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	inst, err := s.buildInstanceModel(existing, &body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := s.store.SaveInstance(r.Context(), inst, false); err != nil {
		s.recordAudit(r, inst.ID, "instance:"+inst.Name, "instance.update", inst.Name, "", err)
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.pool.Invalidate(inst.ID)
	s.agg.InvalidateCache()
	s.recordAudit(r, inst.ID, "instance:"+inst.Name, "instance.update", inst.Name, "", nil)
	writeJSON(w, http.StatusOK, toInstanceResponse(inst))
}

func (s *Server) handleDeleteInstance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	if err := s.store.DeleteInstance(r.Context(), id); err != nil {
		writeErr(w, http.StatusNotFound, err.Error())
		return
	}
	s.pool.Invalidate(id)
	s.agg.InvalidateCache()
	s.recordAudit(r, id, "instance:"+id, "instance.delete", id, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleProbeInstance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	s.pool.Invalidate(id)
	inst, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}
	cl, err := s.pool.BuildClientFromInstance(inst, true)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cl.Close()
	pr := cl.Probe(r.Context())
	if pr.OK && pr.Capabilities != nil {
		if b, err := json.Marshal(pr.Capabilities); err == nil {
			_ = s.store.UpdateInstanceDetection(r.Context(), inst.ID, pr.Version.Version, pr.Capabilities.IsCluster, string(b))
		}
		s.agg.InvalidateCache()
	}
	writeJSON(w, http.StatusOK, pr)
}

func (s *Server) handleInstanceCapabilities(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	inst, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}
	if inst.CapabilitiesJSON != "" && inst.CapabilitiesJSON != "{}" {
		var c pve.Capabilities
		if json.Unmarshal([]byte(inst.CapabilitiesJSON), &c) == nil {
			writeJSON(w, http.StatusOK, c)
			return
		}
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	pr := cl.Probe(r.Context())
	if !pr.OK {
		writeErr(w, http.StatusBadGateway, pr.Error)
		return
	}
	writeJSON(w, http.StatusOK, pr.Capabilities)
}

func (s *Server) buildInstanceModel(existing *store.PVEInstance, body *instancePayload) (*store.PVEInstance, error) {
	name := strings.TrimSpace(body.Name)
	if name == "" {
		return nil, errors.New("instance name is required")
	}
	if len(body.Endpoints) == 0 {
		return nil, errors.New("at least one endpoint URL is required")
	}

	inst := &store.PVEInstance{
		ID:        ulid.Make().String(),
		GroupName: "default",
		Color:     "#22C55E",
		AuthMode:  "token",
		TLSMode:   "tofu",
		Enabled:   true,
	}
	if existing != nil {
		*inst = *existing
	}
	inst.Name = name
	if strings.TrimSpace(body.GroupName) != "" {
		inst.GroupName = strings.TrimSpace(body.GroupName)
	}
	if strings.TrimSpace(body.Color) != "" {
		inst.Color = strings.TrimSpace(body.Color)
	}
	if body.AuthMode != "" {
		switch body.AuthMode {
		case "token", "ticket", "hybrid":
			inst.AuthMode = body.AuthMode
		default:
			return nil, fmt.Errorf("unsupported authMode: %s", body.AuthMode)
		}
	}
	if body.TLSMode != "" {
		switch body.TLSMode {
		case "strict", "tofu", "insecure":
			inst.TLSMode = body.TLSMode
		default:
			return nil, fmt.Errorf("unsupported tlsMode: %s", body.TLSMode)
		}
	}
	if body.Enabled != nil {
		inst.Enabled = *body.Enabled
	}
	inst.TokenID = strings.TrimSpace(body.TokenID)
	inst.TicketUsername = strings.TrimSpace(body.TicketUsername)
	inst.CACertPEM = strings.TrimSpace(body.CACertPEM)
	if inst.TLSMode == "strict" && inst.CACertPEM != "" {
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM([]byte(inst.CACertPEM)) {
			return nil, errors.New("自定义 CA 证书 (caCertPem) 不是有效的 PEM 格式")
		}
	}
	if err := pve.ValidateSSHHost(body.SSHHost); err != nil {
		return nil, err
	}
	inst.SSHHost = strings.TrimSpace(body.SSHHost)

	if strings.TrimSpace(body.TokenSecret) != "" {
		enc, err := s.box.EncryptString(strings.TrimSpace(body.TokenSecret))
		if err != nil {
			return nil, err
		}
		inst.TokenSecretEnc = enc
	}
	if body.TicketPassword != "" {
		enc, err := s.box.EncryptString(body.TicketPassword)
		if err != nil {
			return nil, err
		}
		inst.TicketPasswordEnc = enc
	}

	// Preserve existing pinned TOFU fingerprints for matching endpoint URLs when omitted
	prevFPByURL := map[string]string{}
	if existing != nil {
		for _, ep := range existing.Endpoints {
			prevFPByURL[strings.TrimRight(ep.URL, "/")] = ep.CertFingerprint
		}
	}

	eps := make([]store.PVEEndpoint, 0, len(body.Endpoints))
	for i, ep := range body.Endpoints {
		if strings.TrimSpace(ep.URL) == "" {
			continue
		}
		u, err := normalizeAndValidateEndpointURL(ep.URL)
		if err != nil {
			return nil, err
		}
		id := ep.ID
		if id == "" {
			id = ulid.Make().String()
		}
		prio := ep.Priority
		if prio == 0 {
			prio = (i + 1) * 10
		}
		fp := strings.ToUpper(strings.TrimSpace(ep.CertFingerprint))
		if fp == "" {
			fp = prevFPByURL[u]
		}
		eps = append(eps, store.PVEEndpoint{
			ID:              id,
			InstanceID:      inst.ID,
			NodeName:        ep.NodeName,
			URL:             u,
			Priority:        prio,
			CertFingerprint: fp,
			IsHealthy:       true,
		})
	}
	if len(eps) == 0 {
		return nil, errors.New("at least one valid endpoint URL is required")
	}
	inst.Endpoints = eps
	return inst, nil
}

// --- Node Handlers ---

func (s *Server) handleNodeStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	st, err := cl.GetNodeStatus(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	sensors := pve.ParseNodeSensors(st)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  st,
		"sensors": sensors,
	})
}

func (s *Server) handleNodeHardware(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	force := r.URL.Query().Get("refresh") == "1"
	cl, inst, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	report, err := pve.CollectNodeHardware(r.Context(), cl, id, node, inst.SSHHost, force)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}

func (s *Server) handleNodeRRD(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	pts, err := cl.GetNodeRRD(r.Context(), node, r.URL.Query().Get("timeframe"), r.URL.Query().Get("cf"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if pts == nil {
		pts = []pve.RRDPoint{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": pts})
}

func (s *Server) handleNodePower(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	if r.Header.Get("X-Confirm-Target") != node {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	var body struct {
		Command string `json:"command"` // reboot | shutdown
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
	err = cl.NodePowerAction(r.Context(), node, body.Command)
	s.recordAudit(r, id, id+":node:"+node, "node."+body.Command, body.Command, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleStorageContent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	storage := chi.URLParam(r, "storage")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.GetStorageContent(r.Context(), node, storage, r.URL.Query().Get("content"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []pve.StorageContentItem{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// --- Task Status, Log & Live SSE Tailing ---

func urlParamDecoded(r *http.Request, key string) string {
	raw := chi.URLParam(r, key)
	if r.URL.RawPath != "" {
		if decoded, err := url.PathUnescape(raw); err == nil {
			return decoded
		}
	}
	return raw
}

func (s *Server) handleTaskStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	st, err := cl.GetTaskStatus(r.Context(), node, upid)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleTaskLog(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	start, _ := strconv.Atoi(r.URL.Query().Get("start"))
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 {
		limit = 500
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	lines, err := cl.GetTaskLog(r.Context(), node, upid, start, limit)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if lines == nil {
		lines = []pve.TaskLogLine{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": lines})
}

func (s *Server) handleTaskLogSSE(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeErr(w, http.StatusInternalServerError, "streaming unsupported")
		return
	}
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	cursor := 0
	ticker := time.NewTicker(1 * time.Second)
	pingTicker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	defer pingTicker.Stop()

	flushLogs := func() error {
		lines, logErr := cl.GetTaskLog(r.Context(), node, upid, cursor, 500)
		if logErr != nil {
			return logErr
		}
		if len(lines) > 0 {
			for _, l := range lines {
				if l.N >= cursor {
					cursor = l.N + 1
				}
			}
			if b, err := json.Marshal(lines); err == nil {
				fmt.Fprintf(w, "event: log\ndata: %s\n\n", b)
				flusher.Flush()
			}
		}
		return nil
	}

	poll := func() bool {
		logErr := flushLogs()
		st, stErr := cl.GetTaskStatus(r.Context(), node, upid)
		if stErr == nil {
			if b, err := json.Marshal(st); err == nil {
				fmt.Fprintf(w, "event: status\ndata: %s\n\n", b)
				flusher.Flush()
			}
			if st.Status == "stopped" {
				// Perform one final drain so lines emitted between GetTaskLog and GetTaskStatus are never dropped
				_ = flushLogs()
				fmt.Fprintf(w, "event: done\ndata: {\"exitstatus\":%q}\n\n", st.ExitStatus)
				flusher.Flush()
				return true
			}
		} else if logErr != nil {
			errJSON, _ := json.Marshal(map[string]string{"error": stErr.Error()})
			fmt.Fprintf(w, "event: taskerror\ndata: %s\n\n", errJSON)
			flusher.Flush()
			return true
		}
		return false
	}

	claims := getClaims(r)
	if poll() {
		return
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case <-s.shutdownCtx.Done():
			return
		case <-pingTicker.C:
			if !s.isClaimsSessionValid(r.Context(), claims) {
				return
			}
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		case <-ticker.C:
			if !s.isClaimsSessionValid(r.Context(), claims) {
				return
			}
			if poll() {
				return
			}
		}
	}
}

func (s *Server) handleStopTask(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	upid := urlParamDecoded(r, "upid")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.StopTask(r.Context(), node, upid)
	s.recordAudit(r, id, id+":task:"+upid, "task.stop", upid, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// --- Unified QEMU & LXC Handlers ---

func parseGuestRoute(r *http.Request) (instanceID, node, guestType string, vmid int, err error) {
	instanceID = chi.URLParam(r, "instanceId")
	node = urlParamDecoded(r, "node")
	if err = pve.ValidateNodeName(node); err != nil {
		return "", "", "", 0, err
	}
	guestType = chi.URLParam(r, "type")
	if guestType != "qemu" && guestType != "lxc" {
		return "", "", "", 0, errors.New("type must be qemu or lxc")
	}
	vmid, err = strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		return "", "", "", 0, errors.New("invalid vmid")
	}
	return instanceID, node, guestType, vmid, nil
}

func (s *Server) handleGuestDetail(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	current, err := cl.GetGuestCurrent(r.Context(), node, gtype, vmid)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	cfg, _ := cl.GetGuestConfig(r.Context(), node, gtype, vmid)
	pending, _ := cl.GetGuestPending(r.Context(), node, gtype, vmid)
	snaps, _ := cl.GetGuestSnapshots(r.Context(), node, gtype, vmid)
	ips, _ := cl.GetGuestIPs(r.Context(), node, gtype, vmid)
	if pending == nil {
		pending = []pve.PendingItem{}
	}
	if snaps == nil {
		snaps = []pve.SnapshotItem{}
	}
	if ips == nil {
		ips = []pve.GuestIPInfo{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"instanceId": id,
		"node":       node,
		"type":       gtype,
		"vmid":       vmid,
		"current":    current,
		"config":     cfg,
		"pending":    pending,
		"snapshots":  snaps,
		"ips":        ips,
	})
}

func (s *Server) handleGuestRRD(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	pts, err := cl.GetGuestRRD(r.Context(), node, gtype, vmid, r.URL.Query().Get("timeframe"), r.URL.Query().Get("cf"))
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": pts})
}

func (s *Server) handleGuestPower(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	action := chi.URLParam(r, "action")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.GuestPowerAction(r.Context(), node, gtype, vmid, action)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+"."+action, action, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleGuestDelete(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != strconv.Itoa(vmid) {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	purge := r.URL.Query().Get("purge") == "1"
	destroyUnref := r.URL.Query().Get("destroyUnreferencedDisks") == "1"
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.DeleteGuest(r.Context(), node, gtype, vmid, purge, destroyUnref)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".destroy", fmt.Sprintf("purge=%v unref=%v", purge, destroyUnref), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Snapname    string `json:"snapname"`
		Description string `json:"description"`
		VMState     bool   `json:"vmstate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Snapname) == "" {
		writeErr(w, http.StatusBadRequest, "snapname is required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.CreateGuestSnapshot(r.Context(), node, gtype, vmid, strings.TrimSpace(body.Snapname), body.Description, body.VMState)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".snapshot.create", body.Snapname, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleRollbackSnapshot(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	snap := chi.URLParam(r, "snap")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.RollbackGuestSnapshot(r.Context(), node, gtype, vmid, snap)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".snapshot.rollback", snap, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleDeleteSnapshot(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	snap := chi.URLParam(r, "snap")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.DeleteGuestSnapshot(r.Context(), node, gtype, vmid, snap)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".snapshot.delete", snap, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleSendKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	vmid, err := strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "invalid vmid")
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		writeErr(w, http.StatusBadRequest, "key is required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if err := cl.SendQemuKey(r.Context(), node, vmid, body.Key); err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGuestConfigUpdate(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Values map[string]string `json:"values"`
		Delete []string          `json:"delete"`
		Revert []string          `json:"revert"`
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
	err = cl.UpdateGuestConfig(r.Context(), node, gtype, vmid, body.Values, body.Delete, body.Revert)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	keys := make([]string, 0, len(body.Values)+len(body.Delete)+len(body.Revert))
	for k := range body.Values {
		keys = append(keys, k)
	}
	for _, k := range body.Delete {
		keys = append(keys, "-"+k)
	}
	for _, k := range body.Revert {
		keys = append(keys, "revert:"+k)
	}
	s.recordAudit(r, id, urn, gtype+".config.update", strings.Join(keys, ","), "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGuestResizeDisk(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Disk string `json:"disk"`
		Size string `json:"size"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Disk) == "" || strings.TrimSpace(body.Size) == "" {
		writeErr(w, http.StatusBadRequest, "disk and size are required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.ResizeGuestDisk(r.Context(), node, gtype, vmid, body.Disk, body.Size)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".disk.resize", fmt.Sprintf("%s %s", body.Disk, body.Size), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleGuestCloudInitRegen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	vmid, err := strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid vmid")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	err = cl.RegenerateCloudInit(r.Context(), node, vmid)
	urn := fmt.Sprintf("%s:qemu:%s:%d", id, node, vmid)
	s.recordAudit(r, id, urn, "qemu.cloudinit.regen", "regenerate", "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGuestAgentInfo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	vmid, err := strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid vmid")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	osInfo, osErr := cl.GetQemuAgentOSInfo(r.Context(), node, vmid)
	fsInfo, _ := cl.GetQemuAgentFSInfo(r.Context(), node, vmid)
	if fsInfo == nil {
		fsInfo = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": osErr == nil,
		"osInfo":    osInfo,
		"fsInfo":    fsInfo,
	})
}

func (s *Server) handleSpiceProxy(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	data, err := cl.RequestSpiceProxy(r.Context(), node, gtype, vmid)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, data)
}

// --- Console Session & WebSocket ---

func (s *Server) handleNodeConsoleSession(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := chi.URLParam(r, "node")
	var body struct {
		Protocol         string `json:"protocol"`
		FallbackUsername string `json:"fallbackUsername"`
		FallbackPassword string `json:"fallbackPassword"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	if body.Protocol == "" {
		body.Protocol = "xterm"
	}
	claims := getClaims(r)
	uid := ""
	if claims != nil {
		uid = claims.UserID
	}
	out, err := s.console.CreateSession(r.Context(), pve.CreateSessionInput{
		OwnerUserID:      uid,
		InstanceID:       id,
		Node:             node,
		TargetType:       "node",
		Protocol:         body.Protocol,
		FallbackUsername: body.FallbackUsername,
		FallbackPassword: body.FallbackPassword,
	})
	s.recordAudit(r, id, id+":node:"+node, "console."+body.Protocol, "node shell", "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGuestConsoleSession(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Protocol         string `json:"protocol"`
		FallbackUsername string `json:"fallbackUsername"`
		FallbackPassword string `json:"fallbackPassword"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	claims := getClaims(r)
	uid := ""
	if claims != nil {
		uid = claims.UserID
	}
	out, err := s.console.CreateSession(r.Context(), pve.CreateSessionInput{
		OwnerUserID:      uid,
		InstanceID:       id,
		Node:             node,
		TargetType:       gtype,
		VMID:             vmid,
		Protocol:         body.Protocol,
		FallbackUsername: body.FallbackUsername,
		FallbackPassword: body.FallbackPassword,
	})
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, "console."+body.Protocol, gtype, "", err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleConsoleWS(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	claims := getClaims(r)
	uid := ""
	if claims != nil {
		uid = claims.UserID
	}
	var allowedOrigins []string
	if s.cfg.DevCORS {
		allowedOrigins = []string{"localhost:*", "127.0.0.1:*"}
	}
	if s.cfg.PublicURL != "" {
		if u, err := url.Parse(s.cfg.PublicURL); err == nil && u.Host != "" {
			allowedOrigins = append(allowedOrigins, u.Host)
		}
	}
	s.console.ServeWS(w, r, sid, uid, allowedOrigins, s.shutdownCtx)
}

// --- Raw Admin Escape Hatch ---

func (s *Server) handleRawProxy(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil || claims.Role != "admin" {
		writeErr(w, http.StatusForbidden, "admin role required")
		return
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
	case http.MethodPost, http.MethodPut, http.MethodDelete:
		if s.cfg.ReadOnly {
			writeErr(w, http.StatusForbidden, "server is running in read-only protection mode (PVE_DASH_READ_ONLY=true)")
			return
		}
	default:
		writeErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	id := chi.URLParam(r, "instanceId")
	rawPath := "/" + strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if strings.Contains(rawPath, "..") || strings.ContainsAny(rawPath, "?#\r\n\x00") {
		writeErr(w, http.StatusBadRequest, "invalid raw API path")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "request body too large or unreadable")
		return
	}
	// Clone query params and strip any pve-dash auth token before forwarding upstream
	fwdQuery := r.URL.Query()
	fwdQuery.Del("token")

	code, respBody, err := cl.DoRaw(r.Context(), r.Method, rawPath, fwdQuery, body, r.Header.Get("Content-Type"))
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		s.recordAudit(r, id, id+":raw:"+rawPath, "raw."+strings.ToLower(r.Method), rawPath, "", err)
	}
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write(respBody)
}
