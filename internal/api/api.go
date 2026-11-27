package api

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jianxcao/pve-dash/internal/config"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

type ctxKey string

const ctxClaimsKey ctxKey = "claims"

type ipRateBucket struct {
	count   int
	resetAt time.Time
}

type Server struct {
	cfg         *config.Config
	store       *store.Store
	box         *crypto.Box
	auth        *service.AuthService
	pool        *pve.Pool
	agg         *service.AggregatorService
	alerts      *service.AlertEngine
	console     *pve.ConsoleManager
	webFS       fs.FS
	shutdownCtx context.Context

	rateMu      sync.Mutex
	rateBuckets map[string]ipRateBucket
}

func NewServer(
	cfg *config.Config,
	st *store.Store,
	box *crypto.Box,
	auth *service.AuthService,
	pool *pve.Pool,
	agg *service.AggregatorService,
	alerts *service.AlertEngine,
	console *pve.ConsoleManager,
	webFS fs.FS,
	shutdownCtx context.Context,
) *Server {
	if shutdownCtx == nil {
		shutdownCtx = context.Background()
	}
	return &Server{
		cfg:         cfg,
		store:       st,
		box:         box,
		auth:        auth,
		pool:        pool,
		agg:         agg,
		alerts:      alerts,
		console:     console,
		webFS:       webFS,
		shutdownCtx: shutdownCtx,
		rateBuckets: make(map[string]ipRateBucket),
	}
}

func (s *Server) Router() http.Handler {
	r := chi.NewRouter()
	if s.cfg.TrustProxy {
		r.Use(middleware.RealIP)
	}
	r.Use(middleware.Recoverer)
	r.Use(s.limitJSONBody(4 << 20))
	if s.cfg.DevCORS {
		r.Use(devCORSMiddleware)
	}

	r.Route("/api/v1", func(api chi.Router) {
		// Public endpoints
		api.Get("/health", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "time": time.Now().UTC().Format(time.RFC3339)})
		})
		api.Get("/auth/status", s.handleAuthStatus)
		api.With(s.rateLimitAuth).Post("/auth/setup", s.handleAuthSetup)
		api.With(s.rateLimitAuth).Post("/auth/login", s.handleAuthLogin)
		api.Post("/auth/refresh", s.handleAuthRefresh)
		api.Post("/auth/logout", s.handleAuthLogout)

		// Authenticated endpoints
		api.Group(func(priv chi.Router) {
			priv.Use(s.requireAuth)

			// Console WebSocket requires both authenticated session and single-use sessionId owned by caller
			priv.With(s.requireWritable).Get("/ws/console/{sessionId}", s.handleConsoleWS)

			priv.Get("/auth/me", s.handleAuthMe)
			priv.Get("/preferences", s.handleGetPreferences)
			priv.Put("/preferences", s.handleSavePreferences)

			// Multi-PVE Aggregated APIs
			priv.Get("/overview", s.handleOverview)
			priv.Get("/guests", s.handleGuests)
			priv.With(s.requireWritable).Post("/guests/batch/tags", s.handleBatchGuestTags)
			priv.Get("/search", s.handleSearch)
			priv.Get("/tasks", s.handleTasks)
			priv.Get("/audit", s.handleAuditLogs)
			priv.Get("/events/stream", s.handleEventsSSE)

			// Alerting Engine, Rules, Events & Multi-Channel Notifiers (Phase 2D)
			priv.Get("/alerts/summary", s.handleAlertSummary)
			priv.Get("/alerts/events", s.handleListAlertEvents)
			priv.Post("/alerts/events/ack-all", s.handleAckAllAlertEvents)
			priv.Post("/alerts/events/{eventId}/ack", s.handleAckAlertEvent)
			priv.Post("/alerts/events/{eventId}/resolve", s.handleResolveAlertEvent)
			priv.Post("/alerts/evaluate", s.handleEvaluateAlerts)
			priv.Get("/alerts/rules", s.handleListAlertRules)
			priv.Post("/alerts/rules", s.handleCreateAlertRule)
			priv.Put("/alerts/rules/{ruleId}", s.handleUpdateAlertRule)
			priv.Delete("/alerts/rules/{ruleId}", s.handleDeleteAlertRule)
			priv.Get("/alerts/channels", s.handleListAlertChannels)
			priv.Post("/alerts/channels", s.handleCreateAlertChannel)
			priv.Put("/alerts/channels/{channelId}", s.handleUpdateAlertChannel)
			priv.Delete("/alerts/channels/{channelId}", s.handleDeleteAlertChannel)
			priv.Post("/alerts/channels/{channelId}/test", s.handleTestAlertChannel)

			// Instances CRUD & Probe
			priv.Get("/instances", s.handleListInstances)
			priv.With(s.requireWritable).Post("/instances", s.handleCreateInstance)
			priv.Post("/instances/probe", s.handleProbeAdhoc)
			priv.Get("/instances/{instanceId}", s.handleGetInstance)
			priv.With(s.requireWritable).Put("/instances/{instanceId}", s.handleUpdateInstance)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}", s.handleDeleteInstance)
			priv.Post("/instances/{instanceId}/probe", s.handleProbeInstance)
			priv.Get("/instances/{instanceId}/capabilities", s.handleInstanceCapabilities)
			priv.Get("/instances/{instanceId}/nextid", s.handleNextID)
			priv.Get("/instances/{instanceId}/backups/jobs", s.handleListBackupJobs)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/backups/jobs", s.handleCreateBackupJob)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/backups/jobs/{jobId}", s.handleUpdateBackupJob)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/backups/jobs/{jobId}", s.handleDeleteBackupJob)
			priv.Get("/instances/{instanceId}/backups/not-backed-up", s.handleNotBackedUpGuests)

			// Phase 3: Resource Pools & Cluster Firewall
			priv.Get("/instances/{instanceId}/pools", s.handleListPools)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/pools", s.handleCreatePool)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/pools/{poolId}", s.handleUpdatePool)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/pools/{poolId}", s.handleDeletePool)
			priv.Get("/instances/{instanceId}/firewall", s.makeGetFirewallHandler("cluster"))
			priv.With(s.requireWritable).Put("/instances/{instanceId}/firewall/options", s.makeUpdateFirewallOptionsHandler("cluster"))
			priv.With(s.requireWritable).Post("/instances/{instanceId}/firewall/rules", s.makeCreateFirewallRuleHandler("cluster"))
			priv.With(s.requireWritable).Put("/instances/{instanceId}/firewall/rules/{pos}", s.makeUpdateFirewallRuleHandler("cluster"))
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/firewall/rules/{pos}", s.makeDeleteFirewallRuleHandler("cluster"))

			// Node APIs
			priv.Get("/instances/{instanceId}/nodes/{node}/status", s.handleNodeStatus)
			priv.Get("/instances/{instanceId}/nodes/{node}/hardware", s.handleNodeHardware)
			priv.Get("/instances/{instanceId}/nodes/{node}/rrd", s.handleNodeRRD)
			priv.Get("/instances/{instanceId}/nodes/{node}/networks", s.handleNodeNetworks)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/networks", s.handleCreateNodeNetwork)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/networks/apply", s.handleApplyNodeNetwork)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/networks/revert", s.handleRevertNodeNetwork)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/networks/{iface}", s.handleUpdateNodeNetwork)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/networks/{iface}", s.handleDeleteNodeNetwork)
			priv.Get("/instances/{instanceId}/nodes/{node}/firewall", s.makeGetFirewallHandler("node"))
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/firewall/options", s.makeUpdateFirewallOptionsHandler("node"))
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/firewall/rules", s.makeCreateFirewallRuleHandler("node"))
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/firewall/rules/{pos}", s.makeUpdateFirewallRuleHandler("node"))
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/firewall/rules/{pos}", s.makeDeleteFirewallRuleHandler("node"))
			priv.Get("/instances/{instanceId}/nodes/{node}/services", s.handleNodeServices)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/services/{service}/{action}", s.handleNodeServiceAction)
			priv.Get("/instances/{instanceId}/nodes/{node}/syslog", s.handleNodeSyslog)
			priv.Get("/instances/{instanceId}/nodes/{node}/apt/updates", s.handleNodeAPTUpdates)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/apt/refresh", s.handleNodeAPTRefresh)
			priv.Get("/instances/{instanceId}/nodes/{node}/apt/repositories", s.handleNodeAPTRepositories)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/vzdump", s.handleRunVZDump)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/restore", s.handleRestoreBackup)
			priv.Get("/instances/{instanceId}/nodes/{node}/aplinfo", s.handleListAPLTemplates)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/aplinfo", s.handleDownloadAPLTemplate)
			priv.Post("/instances/{instanceId}/nodes/{node}/query-url-metadata", s.handleQueryURLMetadata)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/power", s.handleNodePower)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/console/session", s.handleNodeConsoleSession)
			priv.Get("/instances/{instanceId}/nodes/{node}/storage/{storage}/content", s.handleStorageContent)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/storage/{storage}/upload", s.handleStorageUpload)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/storage/{storage}/download-url", s.handleStorageDownloadURL)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/storage/{storage}/oci-pull", s.handleStorageOCIPull)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/storage/{storage}/volume/config", s.handleUpdateVolumeConfig)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/storage/{storage}/volume", s.handleDeleteStorageVolume)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/storage/{storage}/content/{volume}/config", s.handleUpdateVolumeConfig)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/storage/{storage}/content/{volume}", s.handleDeleteStorageVolume)

			// Create QEMU VM / LXC Container
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/qemu", s.handleCreateQemu)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/lxc", s.handleCreateLXC)

			// Task Detail & Live SSE Log Stream
			priv.Get("/instances/{instanceId}/nodes/{node}/tasks/{upid}/status", s.handleTaskStatus)
			priv.Get("/instances/{instanceId}/nodes/{node}/tasks/{upid}/log", s.handleTaskLog)
			priv.Get("/instances/{instanceId}/nodes/{node}/tasks/{upid}/log/stream", s.handleTaskLogSSE)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/tasks/{upid}", s.handleStopTask)

			// Unified QEMU & LXC APIs
			priv.Get("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/detail", s.handleGuestDetail)
			priv.Get("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/rrd", s.handleGuestRRD)
			priv.Get("/instances/{instanceId}/nodes/{node}/qemu/{vmid}/agent", s.handleGuestAgentInfo)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/config", s.handleGuestConfigUpdate)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/resize", s.handleGuestResizeDisk)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/qemu/{vmid}/cloudinit", s.handleGuestCloudInitRegen)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/power/{action}", s.handleGuestPower)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/clone", s.handleCloneGuest)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/migrate", s.handleMigrateGuest)
			priv.Get("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/firewall", s.makeGetFirewallHandler("guest"))
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/firewall/options", s.makeUpdateFirewallOptionsHandler("guest"))
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/firewall/rules", s.makeCreateFirewallRuleHandler("guest"))
			priv.With(s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/firewall/rules/{pos}", s.makeUpdateFirewallRuleHandler("guest"))
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/firewall/rules/{pos}", s.makeDeleteFirewallRuleHandler("guest"))
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/{type}/{vmid}", s.handleGuestDelete)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/console/session", s.handleGuestConsoleSession)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/snapshots", s.handleCreateSnapshot)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/snapshots/{snap}/rollback", s.handleRollbackSnapshot)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/snapshots/{snap}", s.handleDeleteSnapshot)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/qemu/{vmid}/sendkey", s.handleSendKey)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/{type}/{vmid}/spice", s.handleSpiceProxy)

			// Admin Escape Hatch (audited raw PVE proxy)
			priv.HandleFunc("/instances/{instanceId}/raw/*", s.handleRawProxy)
		})
	})

	// Serve embedded SPA
	if s.webFS != nil {
		r.NotFound(s.serveSPA)
	}
	return r
}

func (s *Server) serveSPA(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		writeErr(w, http.StatusNotFound, "endpoint not found")
		return
	}
	clean := strings.TrimPrefix(r.URL.Path, "/")
	if clean == "" {
		clean = "index.html"
	}
	if f, err := s.webFS.Open(clean); err == nil {
		stat, _ := f.Stat()
		f.Close()
		if stat != nil && !stat.IsDir() {
			http.FileServer(http.FS(s.webFS)).ServeHTTP(w, r)
			return
		}
	}
	// SPA fallback
	raw, err := fs.ReadFile(s.webFS, "index.html")
	if err != nil {
		http.Error(w, "frontend not built (run npm run build in web/)", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write(raw)
}

// --- Auth Middleware & Handlers ---

func (s *Server) limitJSONBody(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Skip multipart file uploads which stream multi-GB ISOs via io.Pipe
			if r.Body != nil && !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") && !strings.HasSuffix(r.URL.Path, "/upload") {
				r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (s *Server) rateLimitAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := clientIP(r)
		now := time.Now()
		s.rateMu.Lock()
		if len(s.rateBuckets) > 1024 {
			for k, b := range s.rateBuckets {
				if now.After(b.resetAt) {
					delete(s.rateBuckets, k)
				}
			}
		}
		b, ok := s.rateBuckets[ip]
		if !ok || now.After(b.resetAt) {
			b = ipRateBucket{count: 0, resetAt: now.Add(time.Minute)}
		}
		b.count++
		s.rateBuckets[ip] = b
		s.rateMu.Unlock()

		if b.count > 20 {
			writeErr(w, http.StatusTooManyRequests, "登录尝试过于频繁，请 1 分钟后再试")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		token := extractAccessToken(r)
		if token == "" {
			writeErr(w, http.StatusUnauthorized, "authentication required")
			return
		}
		claims, err := s.auth.ParseAccessToken(token)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "invalid or expired token")
			return
		}
		if !s.auth.IsUserActive(r.Context(), claims.UserID) {
			writeErr(w, http.StatusUnauthorized, "account is inactive")
			return
		}
		ctx := context.WithValue(r.Context(), ctxClaimsKey, claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func extractAccessToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	if c, err := r.Cookie("pve_dash_access"); err == nil && c.Value != "" {
		return c.Value
	}
	// Only permit query-param token on SSE/WS stream endpoints (for native Capacitor EventSource);
	// never accept ?token= on general REST or raw proxy endpoints.
	if strings.HasSuffix(r.URL.Path, "/stream") || strings.Contains(r.URL.Path, "/ws/console/") {
		if q := r.URL.Query().Get("token"); q != "" {
			return q
		}
	}
	return ""
}

func getClaims(r *http.Request) *service.Claims {
	c, _ := r.Context().Value(ctxClaimsKey).(*service.Claims)
	return c
}

func (s *Server) setAuthCookies(w http.ResponseWriter, pair *service.TokenPair) {
	http.SetCookie(w, &http.Cookie{
		Name:     "pve_dash_access",
		Value:    pair.AccessToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   pair.ExpiresIn,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "pve_dash_refresh",
		Value:    pair.RefreshToken,
		Path:     "/api/v1/auth",
		HttpOnly: true,
		Secure:   s.cfg.SecureCookie,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   14 * 24 * 3600,
	})
}

func (s *Server) clearAuthCookies(w http.ResponseWriter) {
	for _, spec := range []struct{ name, path string }{
		{"pve_dash_access", "/"},
		{"pve_dash_refresh", "/api/v1/auth"},
	} {
		http.SetCookie(w, &http.Cookie{
			Name:     spec.name,
			Value:    "",
			Path:     spec.path,
			HttpOnly: true,
			Secure:   s.cfg.SecureCookie,
			SameSite: http.SameSiteLaxMode,
			MaxAge:   -1,
		})
	}
}

func (s *Server) requireWritable(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg.ReadOnly {
			writeErr(w, http.StatusForbidden, "server is running in read-only protection mode (PVE_DASH_READ_ONLY=true)")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	init, err := s.auth.IsInitialized(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"initialized": init,
		"readOnly":    s.cfg.ReadOnly,
	})
}

func (s *Server) handleAuthSetup(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Password    string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	pair, err := s.auth.SetupAdminAndLogin(r.Context(), body.Username, body.DisplayName, body.Password, r.UserAgent(), clientIP(r))
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, service.ErrAlreadyInitialized) {
			status = http.StatusConflict
		}
		writeErr(w, status, err.Error())
		return
	}
	s.setAuthCookies(w, pair)
	writeJSON(w, http.StatusCreated, pair)
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	pair, err := s.auth.Login(r.Context(), body.Username, body.Password, r.UserAgent(), clientIP(r))
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	s.setAuthCookies(w, pair)
	writeJSON(w, http.StatusOK, pair)
}

func (s *Server) handleAuthRefresh(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie("pve_dash_refresh")
	if err != nil || c.Value == "" {
		writeErr(w, http.StatusUnauthorized, "missing refresh token")
		return
	}
	pair, err := s.auth.Refresh(r.Context(), c.Value, r.UserAgent(), clientIP(r))
	if err != nil {
		s.clearAuthCookies(w)
		writeErr(w, http.StatusUnauthorized, "session expired")
		return
	}
	s.setAuthCookies(w, pair)
	writeJSON(w, http.StatusOK, pair)
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("pve_dash_refresh"); err == nil && c.Value != "" {
		s.auth.Logout(r.Context(), c.Value)
	}
	s.clearAuthCookies(w)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleAuthMe(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	u, err := s.store.GetUserByID(r.Context(), claims.UserID)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "user not found")
		return
	}
	prefs, _ := s.store.GetPreferences(r.Context(), u.ID)
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "preferences": prefs})
}

func (s *Server) handleGetPreferences(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	prefs, err := s.store.GetPreferences(r.Context(), claims.UserID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, prefs)
}

func (s *Server) handleSavePreferences(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	var body store.UserPreferences
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	body.UserID = claims.UserID
	if body.RefreshSec < 1 {
		body.RefreshSec = 3
	}
	if err := s.store.SavePreferences(r.Context(), &body); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// --- Audit Helper ---

func (s *Server) recordAudit(r *http.Request, instanceID, urn, action, summary, upid string, err error) {
	claims := getClaims(r)
	userID, username := "", "system"
	if claims != nil {
		userID = claims.UserID
		username = claims.Username
	}
	status := "success"
	errMsg := ""
	if err != nil {
		status = "failed"
		errMsg = err.Error()
	}
	_ = s.store.InsertAuditLog(context.Background(), &store.AuditLog{
		ID:             ulid.Make().String(),
		UserID:         userID,
		Username:       username,
		ClientIP:       clientIP(r),
		InstanceID:     instanceID,
		ResourceURN:    urn,
		Action:         action,
		PayloadSummary: summary,
		PVEUPID:        upid,
		Status:         status,
		ErrorMessage:   errMsg,
	})
}

func (s *Server) handleAuditLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := s.store.ListAuditLogs(r.Context(), 100)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	if logs == nil {
		logs = []store.AuditLog{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": logs})
}

// --- JSON & Network Utilities ---

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isDevAllowedOrigin(origin string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	h := strings.ToLower(u.Hostname())
	return h == "localhost" || h == "127.0.0.1" || h == "::1"
}

func devCORSMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && isDevAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Confirm-Target")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
