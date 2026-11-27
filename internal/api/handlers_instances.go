package api

import (
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

// --- PVE Instance CRUD, Probe, NextID & Admin Raw Proxy ---

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
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
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
	if !inst.Enabled {
		if s.console != nil {
			s.console.CloseInstanceSessions(inst.ID)
		}
		pve.InvalidateHardwareCache()
		if s.alerts != nil {
			s.alerts.PurgeInstance(inst.ID)
		}
	}
	s.recordAudit(r, inst.ID, "instance:"+inst.Name, "instance.update", inst.Name, "", nil)
	writeJSON(w, http.StatusOK, toInstanceResponse(inst))
}

func (s *Server) handleDeleteInstance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	existing, err := s.store.GetInstance(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if err := s.store.DeleteInstance(r.Context(), id); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "instance not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.pool.Invalidate(id)
	s.agg.InvalidateCache()
	if s.console != nil {
		s.console.CloseInstanceSessions(id)
	}
	pve.InvalidateHardwareCache()
	if s.alerts != nil {
		s.alerts.PurgeInstance(id)
	}
	s.recordAudit(r, id, "instance:"+existing.Name, "instance.delete", existing.Name, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleProbeInstance(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	s.pool.Invalidate(id)
	inst, err := s.store.GetInstance(r.Context(), id)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "instance not found")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	persistTOFU := !s.cfg.ReadOnly
	cl, err := s.pool.BuildClientFromInstance(inst, persistTOFU)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	defer cl.Close()
	pr := cl.Probe(r.Context())
	if pr.OK && pr.Capabilities != nil {
		if !s.cfg.ReadOnly {
			if b, err := json.Marshal(pr.Capabilities); err == nil {
				_ = s.store.UpdateInstanceDetection(r.Context(), inst.ID, pr.Version.Version, pr.Capabilities.IsCluster, string(b))
			}
		}
		s.agg.InvalidateCache()
	}
	writeJSON(w, http.StatusOK, pr)
}

func (s *Server) handleInstanceCapabilities(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	inst, err := s.store.GetInstance(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	ver, err := cl.GetVersion(r.Context())
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	isCluster := false
	if statusList, stErr := cl.GetClusterStatus(r.Context()); stErr == nil {
		for _, item := range statusList {
			if item.Type == "cluster" {
				isCluster = true
				break
			}
		}
	}
	caps := pve.BuildCapabilities(ver, isCluster)
	writeJSON(w, http.StatusOK, caps)
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

func (s *Server) handleNextID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	nextID, err := cl.GetNextID(r.Context())
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vmid": nextID})
}

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
		s.writePVEError(w, err)
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
		s.writePVEError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_, _ = w.Write(respBody)
}
