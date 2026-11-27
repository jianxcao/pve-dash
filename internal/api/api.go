package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"regexp"
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
	"github.com/jianxcao/pve-dash/internal/version"
	"github.com/oklog/ulid/v2"
)

type ctxKey string

const ctxClaimsKey ctxKey = "claims"

var validVMIDListRegex = regexp.MustCompile(`^[1-9]\d*(,[1-9]\d*)*$`)

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
	events      *service.EventNotifier
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

// SetEventNotifier wires the asynchronous event notification dispatcher.
func (s *Server) SetEventNotifier(ev *service.EventNotifier) {
	s.events = ev
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	info := version.Info()
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"version": info.Version,
		"time":    time.Now().UTC().Format(time.RFC3339),
	})
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

	r.Get("/healthz", s.handleHealth)
	r.Head("/healthz", s.handleHealth)

	r.Route("/api/v1", func(api chi.Router) {
		api.Use(s.csrfProtect)

		// Public endpoints
		api.Get("/health", s.handleHealth)
		api.Get("/auth/status", s.handleAuthStatus)
		api.With(s.rateLimitAuth).Post("/auth/setup", s.handleAuthSetup)
		api.With(s.rateLimitAuth).Post("/auth/login", s.handleAuthLogin)
		api.With(s.rateLimitAuth).Post("/auth/mfa/totp", s.handleMFATOTPVerify)
		api.With(s.rateLimitAuth).Post("/auth/mfa/recovery", s.handleMFARecoveryVerify)
		api.With(s.rateLimitAuth).Post("/auth/mfa/webauthn/begin", s.handleMFAWebAuthnBegin)
		api.With(s.rateLimitAuth).Post("/auth/mfa/webauthn/finish", s.handleMFAWebAuthnFinish)
		api.With(s.rateLimitAuth).Post("/auth/refresh", s.handleAuthRefresh)
		api.Post("/auth/logout", s.handleAuthLogout)

		// Authenticated endpoints
		api.Group(func(priv chi.Router) {
			priv.Use(s.requireAuth)

			// Console WebSocket requires both authenticated session and single-use sessionId owned by caller
			priv.With(s.requireWritable).Get("/ws/console/{sessionId}", s.handleConsoleWS)

			priv.Get("/system/info", s.handleSystemInfo)
			priv.Get("/auth/me", s.handleAuthMe)
			priv.Get("/auth/security", s.handleGetSecurityStatus)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Post("/auth/mfa/totp/setup", s.handleSetupTOTP)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Post("/auth/mfa/totp/enable", s.handleEnableTOTP)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Post("/auth/mfa/totp/disable", s.handleDisableTOTP)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Post("/auth/mfa/passkeys/register/begin", s.handleBeginPasskeyRegister)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Post("/auth/mfa/passkeys/register/finish", s.handleFinishPasskeyRegister)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Delete("/auth/mfa/passkeys/{credentialId}", s.handleDeletePasskey)
			priv.With(s.requireNotReadOnly, s.rateLimitMFASelf).Post("/auth/mfa/recovery-codes/regenerate", s.handleRegenerateRecoveryCodes)
			priv.With(s.rateLimitAuth).Post("/auth/change-password", s.handleChangePassword)
			priv.Get("/preferences", s.handleGetPreferences)
			priv.Put("/preferences", s.handleSavePreferences)

			// Multi-User RBAC & Encrypted Config Backup/Restore (Admin only)
			priv.With(s.requireAdmin).Get("/users", s.handleListUsers)
			priv.With(s.requireAdmin, s.requireWritable).Post("/users", s.handleCreateUser)
			priv.With(s.requireAdmin, s.requireWritable).Put("/users/{userId}", s.handleUpdateUser)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/users/{userId}", s.handleDeleteUser)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/users/{userId}/mfa", s.handleResetUserMFA)
			priv.With(s.requireAdmin, s.requireWritable).Post("/users/{userId}/revoke-sessions", s.handleRevokeUserSessions)
			priv.With(s.requireAdmin, s.rateLimitAuth).Post("/config/export", s.handleExportConfig)
			priv.With(s.requireAdmin, s.rateLimitAuth).Post("/config/import", s.handleImportConfig)

			// Multi-PVE Aggregated APIs
			priv.Get("/overview", s.handleOverview)
			priv.Get("/guests", s.handleGuests)
			priv.With(s.requireWritable).Post("/guests/batch/tags", s.handleBatchGuestTags)
			priv.Get("/search", s.handleSearch)
			priv.Get("/tasks", s.handleTasks)
			priv.With(s.requireAdmin).Get("/audit", s.handleAuditLogs)
			priv.Get("/events/stream", s.handleEventsSSE)

			// Alerting Engine, Rules, Events & Multi-Channel Notifiers
			priv.Get("/alerts/summary", s.handleAlertSummary)
			priv.Get("/alerts/events", s.handleListAlertEvents)
			priv.With(s.requireWritable).Post("/alerts/events/ack-all", s.handleAckAllAlertEvents)
			priv.With(s.requireWritable).Post("/alerts/events/{eventId}/ack", s.handleAckAlertEvent)
			priv.With(s.requireWritable).Post("/alerts/events/{eventId}/resolve", s.handleResolveAlertEvent)
			priv.With(s.requireWritable).Post("/alerts/evaluate", s.handleEvaluateAlerts)
			priv.Get("/alerts/rules", s.handleListAlertRules)
			priv.With(s.requireWritable).Post("/alerts/rules", s.handleCreateAlertRule)
			priv.With(s.requireWritable).Put("/alerts/rules/{ruleId}", s.handleUpdateAlertRule)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/alerts/rules/{ruleId}", s.handleDeleteAlertRule)
			priv.Get("/alerts/channels", s.handleListAlertChannels)
			priv.With(s.requireAdmin, s.requireWritable).Post("/alerts/channels", s.handleCreateAlertChannel)
			priv.With(s.requireAdmin, s.requireWritable).Put("/alerts/channels/{channelId}", s.handleUpdateAlertChannel)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/alerts/channels/{channelId}", s.handleDeleteAlertChannel)
			priv.With(s.requireAdmin, s.requireWritable).Post("/alerts/channels/{channelId}/test", s.handleTestAlertChannel)
			priv.Get("/alerts/subscriptions", s.handleListAlertSubscriptions)
			priv.With(s.requireAdmin, s.requireWritable).Put("/alerts/subscriptions", s.handleUpdateAlertSubscriptions)

			// Instances CRUD & Probe
			priv.Get("/instances", s.handleListInstances)
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances", s.handleCreateInstance)
			priv.With(s.requireAdmin).Post("/instances/probe", s.handleProbeAdhoc)
			priv.Get("/instances/{instanceId}", s.handleGetInstance)
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}", s.handleUpdateInstance)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}", s.handleDeleteInstance)
			priv.With(s.requireAdmin).Post("/instances/{instanceId}/probe", s.handleProbeInstance)
			priv.Get("/instances/{instanceId}/capabilities", s.handleInstanceCapabilities)
			priv.Get("/instances/{instanceId}/nextid", s.handleNextID)
			priv.Get("/instances/{instanceId}/backups/jobs", s.handleListBackupJobs)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/backups/jobs", s.handleCreateBackupJob)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/backups/jobs/{jobId}", s.handleUpdateBackupJob)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/backups/jobs/{jobId}", s.handleDeleteBackupJob)
			priv.Get("/instances/{instanceId}/backups/not-backed-up", s.handleNotBackedUpGuests)

			// Resource Pools & Cluster Firewall
			priv.Get("/instances/{instanceId}/pools", s.handleListPools)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/pools", s.handleCreatePool)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/pools/{poolId}", s.handleUpdatePool)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/pools/{poolId}", s.handleDeletePool)
			priv.Get("/instances/{instanceId}/firewall", s.makeGetFirewallHandler("cluster"))
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/firewall/options", s.makeUpdateFirewallOptionsHandler("cluster"))
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/firewall/rules", s.makeCreateFirewallRuleHandler("cluster"))
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/firewall/rules/{pos}", s.makeUpdateFirewallRuleHandler("cluster"))
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}/firewall/rules/{pos}", s.makeDeleteFirewallRuleHandler("cluster"))

			// Cluster Storage Definitions CRUD (Admin only for mutations)
			priv.Get("/instances/{instanceId}/storage-configs", s.handleListStorageConfigs)
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/storage-configs", s.handleCreateStorageConfig)
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/storage-configs/{storage}", s.handleUpdateStorageConfig)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}/storage-configs/{storage}", s.handleDeleteStorageConfig)

			// HA High Availability & Hardware Resource Mappings
			priv.Get("/instances/{instanceId}/ha", s.handleGetHA)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/ha/resources", s.handleCreateHAResource)
			priv.With(s.requireWritable).Put("/instances/{instanceId}/ha/resources/{sid}", s.handleUpdateHAResource)
			priv.With(s.requireWritable).Delete("/instances/{instanceId}/ha/resources/{sid}", s.handleDeleteHAResource)
			priv.Get("/instances/{instanceId}/mappings", s.handleListResourceMappings)
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/mappings/{kind}", s.handleCreateResourceMapping)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}/mappings/{kind}/{mappingId}", s.handleDeleteResourceMapping)

			// Node APIs
			priv.Get("/instances/{instanceId}/nodes/{node}/status", s.handleNodeStatus)
			priv.Get("/instances/{instanceId}/nodes/{node}/hardware", s.handleNodeHardware)
			priv.Get("/instances/{instanceId}/nodes/{node}/disks/overview", s.handleNodeDisksOverview)
			priv.Get("/instances/{instanceId}/nodes/{node}/ceph", s.handleNodeCeph)
			priv.Get("/instances/{instanceId}/nodes/{node}/certificates", s.handleNodeCertificates)
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/certificates/acme/renew", s.handleRenewNodeACME)
			priv.Get("/instances/{instanceId}/nodes/{node}/rrd", s.handleNodeRRD)
			priv.Get("/instances/{instanceId}/nodes/{node}/networks", s.handleNodeNetworks)
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/networks", s.handleCreateNodeNetwork)
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/networks/apply", s.handleApplyNodeNetwork)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/networks/revert", s.handleRevertNodeNetwork)
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/networks/{iface}", s.handleUpdateNodeNetwork)
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/networks/{iface}", s.handleDeleteNodeNetwork)
			priv.Get("/instances/{instanceId}/nodes/{node}/firewall", s.makeGetFirewallHandler("node"))
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/firewall/options", s.makeUpdateFirewallOptionsHandler("node"))
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/firewall/rules", s.makeCreateFirewallRuleHandler("node"))
			priv.With(s.requireAdmin, s.requireWritable).Put("/instances/{instanceId}/nodes/{node}/firewall/rules/{pos}", s.makeUpdateFirewallRuleHandler("node"))
			priv.With(s.requireAdmin, s.requireWritable).Delete("/instances/{instanceId}/nodes/{node}/firewall/rules/{pos}", s.makeDeleteFirewallRuleHandler("node"))
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
			priv.With(s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/query-url-metadata", s.handleQueryURLMetadata)
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/power", s.handleNodePower)
			priv.With(s.requireAdmin, s.requireWritable).Post("/instances/{instanceId}/nodes/{node}/console/session", s.handleNodeConsoleSession)
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

			// Unified QEMU & LXC APIs (Guest firewall stays accessible to operator)
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
			if strings.HasSuffix(clean, ".webmanifest") {
				w.Header().Set("Content-Type", "application/manifest+json; charset=utf-8")
			} else if clean == "sw.js" {
				w.Header().Set("Cache-Control", "no-cache")
			}
			http.FileServer(http.FS(s.webFS)).ServeHTTP(w, r)
			return
		}
	}
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		http.NotFound(w, r)
		return
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

// --- Security, Body Limits & Auth Middleware ---

func (s *Server) csrfProtect(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
		default:
			next.ServeHTTP(w, r)
			return
		}

		authHdr := r.Header.Get("Authorization")
		hasBearer := strings.HasPrefix(authHdr, "Bearer ") && strings.TrimSpace(strings.TrimPrefix(authHdr, "Bearer ")) != ""
		isCookieSessionEndpoint := strings.HasSuffix(r.URL.Path, "/auth/refresh") || strings.HasSuffix(r.URL.Path, "/auth/logout")
		if hasBearer && !isCookieSessionEndpoint {
			next.ServeHTTP(w, r)
			return
		}

		sfs := strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site")))
		if sfs != "" && sfs != "same-origin" && sfs != "none" {
			writeErr(w, http.StatusForbidden, "cross-origin cookie request blocked (CSRF protection)")
			return
		}

		if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
			if !s.isAllowedCookieOrigin(r, origin) {
				writeErr(w, http.StatusForbidden, "cross-origin cookie request blocked (CSRF protection)")
				return
			}
		} else if sfs == "" {
			if referer := strings.TrimSpace(r.Header.Get("Referer")); referer != "" {
				if !s.isAllowedCookieOrigin(r, referer) {
					writeErr(w, http.StatusForbidden, "cross-origin cookie request blocked (CSRF protection)")
					return
				}
			}
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) isAllowedCookieOrigin(r *http.Request, origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return false
	}
	originBase := strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
	hostLower := strings.ToLower(strings.TrimSpace(r.Host))
	if hostLower != "" && (originBase == "http://"+hostLower || originBase == "https://"+hostLower) {
		return true
	}
	if s.cfg != nil && strings.TrimSpace(s.cfg.PublicURL) != "" {
		if pubU, err := url.Parse(strings.TrimSpace(s.cfg.PublicURL)); err == nil && pubU.Scheme != "" && pubU.Host != "" {
			if originBase == strings.ToLower(pubU.Scheme)+"://"+strings.ToLower(pubU.Host) {
				return true
			}
		}
	}
	if s.cfg != nil && s.cfg.DevCORS && isDevAllowedOrigin(origin) {
		return true
	}
	return false
}

func (s *Server) limitJSONBody(maxBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			isMultipart := strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data") || strings.HasSuffix(r.URL.Path, "/upload")
			isStreamOrWS := strings.HasSuffix(r.URL.Path, "/stream") || strings.Contains(r.URL.Path, "/ws/")
			if !isMultipart && !isStreamOrWS {
				_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(30 * time.Second))
			}
			// Skip multipart file uploads which stream multi-GB ISOs via io.Pipe
			if r.Body != nil && !isMultipart {
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
			if s.events != nil {
				s.events.RecordLoginAnomaly("", ip, "认证接口请求触发频率限制 (HTTP 429)")
			}
			writeErr(w, http.StatusTooManyRequests, "登录尝试过于频繁，请 1 分钟后再试")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) rateLimitMFASelf(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := "mfa-self-ip:" + clientIP(r)
		if claims := getClaims(r); claims != nil && claims.UserID != "" {
			key = "mfa-self:" + claims.UserID
		}
		now := time.Now()
		s.rateMu.Lock()
		if len(s.rateBuckets) > 1024 {
			for k, b := range s.rateBuckets {
				if now.After(b.resetAt) {
					delete(s.rateBuckets, k)
				}
			}
		}
		b, ok := s.rateBuckets[key]
		if !ok || now.After(b.resetAt) {
			b = ipRateBucket{count: 0, resetAt: now.Add(time.Minute)}
		}
		b.count++
		s.rateBuckets[key] = b
		s.rateMu.Unlock()

		if b.count > 20 {
			writeErr(w, http.StatusTooManyRequests, "双重验证操作过于频繁，请 1 分钟后再试")
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
		u, err := s.auth.GetActiveUser(r.Context(), claims.UserID)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "account is inactive")
			return
		}
		claimTV := claims.TokenVersion
		if claimTV == 0 {
			claimTV = 1 // backward-compatible with pre-Phase4C tokens until revoked
		}
		dbTV := u.TokenVersion
		if dbTV < 1 {
			dbTV = 1
		}
		if claimTV != dbTV {
			writeErr(w, http.StatusUnauthorized, "session has been revoked")
			return
		}
		// Always reflect live DB role & username so role demotions take effect immediately
		liveClaims := *claims
		liveClaims.Role = u.Role
		liveClaims.Username = u.Username
		liveClaims.TokenVersion = dbTV
		ctx := context.WithValue(r.Context(), ctxClaimsKey, &liveClaims)
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
		if claims := getClaims(r); claims != nil && claims.Role == "viewer" {
			writeErr(w, http.StatusForbidden, "当前账号角色为只读观众 (viewer)，无写操作权限")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) isClaimsSessionValid(ctx context.Context, claims *service.Claims) bool {
	if claims == nil {
		return false
	}
	u, err := s.auth.GetActiveUser(ctx, claims.UserID)
	if err != nil {
		return false
	}
	claimTV := claims.TokenVersion
	if claimTV == 0 {
		claimTV = 1
	}
	dbTV := u.TokenVersion
	if dbTV < 1 {
		dbTV = 1
	}
	return claimTV == dbTV
}

func (s *Server) requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		claims := getClaims(r)
		if claims == nil || claims.Role != "admin" {
			writeErr(w, http.StatusForbidden, "需要管理员 (admin) 权限")
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
	ip := clientIP(r)
	u, err := s.auth.AuthenticatePrimary(r.Context(), body.Username, body.Password)
	if err != nil {
		if s.events != nil {
			s.events.RecordLoginAnomaly(body.Username, ip, "用户名或密码错误")
		}
		writeErr(w, http.StatusUnauthorized, "用户名或密码错误")
		return
	}
	rpID, _, _ := s.resolveWebAuthnCeremonyRP(r)
	challenge, err := s.auth.BuildLoginChallenge(r.Context(), u, rpID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to evaluate 2FA challenge")
		return
	}
	if challenge != nil && challenge.MFARequired {
		writeJSON(w, http.StatusOK, challenge)
		return
	}
	pair, err := s.auth.IssueSession(r.Context(), u, r.UserAgent(), ip)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to issue session")
		return
	}
	s.setAuthCookies(w, pair)
	if s.events != nil {
		s.events.RecordLoginSuccess(u.Username, u.ID, u.Role, ip, r.UserAgent())
	}
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
	if s.cfg.ReadOnly {
		writeErr(w, http.StatusForbidden, "server is running in read-only protection mode (PVE_DASH_READ_ONLY=true)")
		return
	}
	claims := getClaims(r)
	var body store.UserPreferences
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	body.UserID = claims.UserID
	body.Theme = strings.TrimSpace(body.Theme)
	if body.Theme == "" {
		body.Theme = "obsidian"
	}
	if len(body.Theme) > 32 || hasControlChars(body.Theme) {
		writeErr(w, http.StatusBadRequest, "theme 长度不能超过 32 个字符")
		return
	}
	body.Density = strings.TrimSpace(body.Density)
	if body.Density == "" {
		body.Density = "compact"
	}
	if body.Density != "compact" && body.Density != "comfortable" {
		writeErr(w, http.StatusBadRequest, "density 必须为 compact 或 comfortable")
		return
	}
	body.SidebarMode = strings.TrimSpace(body.SidebarMode)
	if body.SidebarMode == "" {
		body.SidebarMode = "functional"
	}
	if body.SidebarMode != "functional" && body.SidebarMode != "tree" {
		writeErr(w, http.StatusBadRequest, "sidebarMode 必须为 functional 或 tree")
		return
	}
	if body.RefreshSec == 0 {
		body.RefreshSec = 3
	}
	if body.RefreshSec < 2 || body.RefreshSec > 60 {
		writeErr(w, http.StatusBadRequest, "refreshSec 必须在 2–60 秒之间")
		return
	}
	body.Locale = strings.TrimSpace(body.Locale)
	if body.Locale == "" {
		body.Locale = "zh-CN"
	}
	if len(body.Locale) > 16 || hasControlChars(body.Locale) {
		writeErr(w, http.StatusBadRequest, "locale 格式无效")
		return
	}
	if err := s.store.SavePreferences(r.Context(), &body); err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, body)
}

// --- Audit Helper ---

func (s *Server) recordAudit(r *http.Request, instanceID, urn, action, summary, upid string, err error) {
	if errors.Is(err, context.Canceled) {
		return
	}
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
	if s.events != nil {
		if cat, labelZH, ok := service.ClassifyAuditAction(action); ok {
			instName := ""
			if instanceID != "" && s.store != nil {
				lookupCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				inst, gErr := s.store.GetInstance(lookupCtx, instanceID)
				cancel()
				if gErr == nil && inst != nil {
					instName = inst.Name
				}
			}
			failed := err != nil
			sev := "info"
			statusLabel := "成功"
			if failed {
				sev = "warning"
				statusLabel = "失败"
			}
			resLabel := strings.TrimSpace(urn)
			if resLabel == "" {
				resLabel = action
			}
			title := fmt.Sprintf("%s%s (%s)", labelZH, statusLabel, resLabel)
			msgParts := []string{
				fmt.Sprintf("操作人: %s (IP: %s)", username, clientIP(r)),
				fmt.Sprintf("动作: %s (%s)", labelZH, action),
			}
			if strings.TrimSpace(summary) != "" {
				msgParts = append(msgParts, fmt.Sprintf("摘要: %s", strings.TrimSpace(summary)))
			}
			if strings.TrimSpace(upid) != "" {
				msgParts = append(msgParts, fmt.Sprintf("PVE UPID: %s", strings.TrimSpace(upid)))
			}
			if failed && errMsg != "" {
				msgParts = append(msgParts, fmt.Sprintf("错误: %s", errMsg))
			}
			s.events.Publish(service.EventDispatch{
				Category:     cat,
				InstanceName: instName,
				ResourceName: resLabel,
				Title:        title,
				Message:      strings.Join(msgParts, " · "),
				Severity:     sev,
				Failed:       failed,
			})
		}
	}
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

// --- JSON, Route & Validation Utilities ---

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func urlParamDecoded(r *http.Request, key string) string {
	raw := chi.URLParam(r, key)
	if r.URL.RawPath != "" {
		if decoded, err := url.PathUnescape(raw); err == nil {
			return decoded
		}
	}
	return raw
}

func hasControlChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func hasLineBreak(s string) bool {
	return strings.ContainsAny(s, "\r\n\x00")
}

func orDefault(v, def string) string {
	if strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return def
}

func normalizeVMIDList(raw string) (string, error) {
	parts := strings.Split(raw, ",")
	clean := make([]string, 0, len(parts))
	for _, p := range parts {
		v := strings.TrimSpace(p)
		if v == "" {
			continue
		}
		clean = append(clean, v)
	}
	joined := strings.Join(clean, ",")
	if joined == "" || !validVMIDListRegex.MatchString(joined) {
		return "", fmt.Errorf("必须为逗号分隔的正整数 VMID 列表")
	}
	return joined, nil
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
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Confirm-Target, X-Requested-With")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
