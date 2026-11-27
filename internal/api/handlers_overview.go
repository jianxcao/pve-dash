package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/service"
)

// --- Multi-PVE Aggregated Endpoints, Telemetry SSE & Console WebSocket ---

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("refresh") == "1"
	_, rawJSON, err := s.agg.GetOverviewWithJSON(r.Context(), force)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rawJSON)
	_, _ = w.Write([]byte("\n"))
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
		_, rawJSON, err := s.agg.GetOverviewWithJSON(r.Context(), false)
		if err != nil || len(rawJSON) == 0 {
			return
		}
		fmt.Fprintf(w, "event: overview\ndata: %s\n\n", rawJSON)
		flusher.Flush()
	}

	sendSnapshot()
	intervalSec := 3
	if v, err := strconv.Atoi(r.URL.Query().Get("interval")); err == nil && v >= 2 && v <= 60 {
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
				if claims == nil {
					fmt.Fprint(w, "event: auth_expired\ndata: {\"error\":\"session revoked\"}\n\n")
					flusher.Flush()
					return
				}
				if _, err := s.auth.GetActiveUser(r.Context(), claims.UserID); err != nil {
					fmt.Fprint(w, "event: auth_expired\ndata: {\"error\":\"account inactive\"}\n\n")
					flusher.Flush()
				}
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

func (s *Server) handleConsoleWS(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	claims := getClaims(r)
	uid := ""
	if claims != nil {
		uid = claims.UserID
	}
	var allowedOrigins []string
	if s.cfg.DevCORS {
		allowedOrigins = []string{"localhost:*", "127.0.0.1:*", "[::1]:*"}
	}
	if s.cfg.PublicURL != "" {
		if u, err := url.Parse(s.cfg.PublicURL); err == nil && u.Host != "" {
			allowedOrigins = append(allowedOrigins, u.Host)
		}
	}
	s.console.ServeWS(w, r, sid, uid, allowedOrigins, s.shutdownCtx)
}
