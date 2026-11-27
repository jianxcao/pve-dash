package pve

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
)

type APIError struct {
	StatusCode int
	Status     string
	Body       string
	Endpoint   string
}

func (e *APIError) Error() string {
	msg := strings.TrimSpace(e.Body)
	if len(msg) > 300 {
		msg = msg[:300]
	}
	if msg != "" {
		return fmt.Sprintf("PVE API %s (%d): %s", e.Status, e.StatusCode, msg)
	}
	return fmt.Sprintf("PVE API %s (%d)", e.Status, e.StatusCode)
}

type CertMismatchError struct {
	Endpoint            string
	ExpectedFingerprint string
	ObservedFingerprint string
}

func (e *CertMismatchError) Error() string {
	if e.ExpectedFingerprint == "" {
		return fmt.Sprintf("untrusted certificate fingerprint %s on %s", e.ObservedFingerprint, e.Endpoint)
	}
	return fmt.Sprintf("certificate fingerprint changed on %s: expected %s, got %s", e.Endpoint, e.ExpectedFingerprint, e.ObservedFingerprint)
}

type EndpointConfig struct {
	ID              string
	URL             string
	Priority        int
	CertFingerprint string
}

type ClientConfig struct {
	InstanceID     string
	AuthMode       string // token | ticket | hybrid
	TokenID        string // user@realm!tokenid
	TokenSecret    string
	TicketUsername string // user@realm
	TicketPassword string
	TLSMode        string // strict | tofu | insecure
	CACertPEM      string
	Endpoints      []EndpointConfig
	OnTOFUTrust    func(endpointID, fingerprint string)
}

type endpointState struct {
	cfg           EndpointConfig
	httpClient    *http.Client
	tlsConfig     *tls.Config
	cooldownUntil time.Time
	lastObserved  string
}

type ticketState struct {
	ticket    string
	csrfToken string
	expiresAt time.Time
}

type Client struct {
	cfg ClientConfig

	mu        sync.Mutex
	endpoints []*endpointState
	ticket    *ticketState
}

func NewClient(cfg ClientConfig) (*Client, error) {
	if len(cfg.Endpoints) == 0 {
		return nil, errors.New("at least one PVE endpoint is required")
	}
	eps := make([]EndpointConfig, len(cfg.Endpoints))
	copy(eps, cfg.Endpoints)
	sort.Slice(eps, func(i, j int) bool {
		if eps[i].Priority != eps[j].Priority {
			return eps[i].Priority < eps[j].Priority
		}
		return eps[i].URL < eps[j].URL
	})

	c := &Client{cfg: cfg}
	for _, ep := range eps {
		ep.URL = strings.TrimRight(strings.TrimSpace(ep.URL), "/")
		st := &endpointState{cfg: ep}
		tlsCfg, err := c.buildTLSConfig(st)
		if err != nil {
			return nil, fmt.Errorf("build TLS config for %s: %w", ep.URL, err)
		}
		st.tlsConfig = tlsCfg
		st.httpClient = &http.Client{
			Transport: &http.Transport{
				TLSClientConfig:     tlsCfg,
				MaxIdleConns:        16,
				MaxIdleConnsPerHost: 8,
				IdleConnTimeout:     60 * time.Second,
			},
			Timeout: 30 * time.Second,
		}
		c.endpoints = append(c.endpoints, st)
	}
	return c, nil
}

func (c *Client) buildTLSConfig(st *endpointState) (*tls.Config, error) {
	mode := c.cfg.TLSMode
	if mode == "" {
		mode = "tofu"
	}
	switch mode {
	case "insecure":
		return &tls.Config{
			InsecureSkipVerify: true, //nolint:gosec // Explicit user-selected insecure mode
			VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
				if len(rawCerts) > 0 {
					c.mu.Lock()
					st.lastObserved = crypto.CertSHA256Colon(rawCerts[0])
					c.mu.Unlock()
				}
				return nil
			},
		}, nil
	case "strict":
		var pool *x509.CertPool
		if strings.TrimSpace(c.cfg.CACertPEM) != "" {
			pool = x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(c.cfg.CACertPEM)) {
				return nil, errors.New("invalid custom CA PEM certificate")
			}
		}
		return &tls.Config{
			RootCAs:    pool,
			MinVersion: tls.VersionTLS12,
		}, nil
	case "tofu":
		return &tls.Config{
			InsecureSkipVerify: true, //nolint:gosec // Verified via TOFU SHA-256 fingerprint pin below
			MinVersion:         tls.VersionTLS12,
			VerifyPeerCertificate: func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
				if len(rawCerts) == 0 {
					return errors.New("server presented no TLS certificate")
				}
				fp := crypto.CertSHA256Colon(rawCerts[0])
				c.mu.Lock()
				st.lastObserved = fp
				expected := strings.ToUpper(strings.TrimSpace(st.cfg.CertFingerprint))
				if expected == "" {
					// First use: trust and pin automatically
					st.cfg.CertFingerprint = fp
					epID := st.cfg.ID
					c.mu.Unlock()
					if c.cfg.OnTOFUTrust != nil && epID != "" {
						c.cfg.OnTOFUTrust(epID, fp)
					}
					return nil
				}
				c.mu.Unlock()
				if fp != expected {
					return &CertMismatchError{
						Endpoint:            st.cfg.URL,
						ExpectedFingerprint: expected,
						ObservedFingerprint: fp,
					}
				}
				return nil
			},
		}, nil
	default:
		return nil, fmt.Errorf("unknown tls mode: %s", mode)
	}
}

func (c *Client) pickEndpoints() []*endpointState {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	var healthy, cooling []*endpointState
	for _, ep := range c.endpoints {
		if now.After(ep.cooldownUntil) {
			healthy = append(healthy, ep)
		} else {
			cooling = append(cooling, ep)
		}
	}
	return append(healthy, cooling...)
}

func (c *Client) markCooldown(ep *endpointState) {
	c.mu.Lock()
	ep.cooldownUntil = time.Now().Add(30 * time.Second)
	c.mu.Unlock()
}

func (c *Client) ActiveEndpoint() (string, *tls.Config) {
	eps := c.pickEndpoints()
	return eps[0].cfg.URL, eps[0].tlsConfig
}

func (c *Client) ObservedFingerprints() map[string]string {
	c.mu.Lock()
	defer c.mu.Unlock()
	m := make(map[string]string, len(c.endpoints))
	for _, ep := range c.endpoints {
		fp := ep.lastObserved
		if fp == "" {
			fp = ep.cfg.CertFingerprint
		}
		m[ep.cfg.URL] = fp
	}
	return m
}

func (c *Client) useTicketAuth() bool {
	return c.cfg.AuthMode == "ticket" || (c.cfg.TokenID == "" && c.cfg.TicketUsername != "")
}

func (c *Client) HasTicketCredentials() bool {
	return strings.TrimSpace(c.cfg.TicketUsername) != "" && c.cfg.TicketPassword != ""
}

func (c *Client) EnsureTicket(ctx context.Context, ep *endpointState) (*ticketState, error) {
	c.mu.Lock()
	if c.ticket != nil && time.Now().Before(c.ticket.expiresAt) {
		t := *c.ticket
		c.mu.Unlock()
		return &t, nil
	}
	c.mu.Unlock()

	if !c.HasTicketCredentials() {
		return nil, errors.New("no ticket username/password configured")
	}

	form := url.Values{}
	form.Set("username", c.cfg.TicketUsername)
	form.Set("password", c.cfg.TicketPassword)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.cfg.URL+"/api2/json/access/ticket", strings.NewReader(form.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := ep.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return nil, &APIError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(raw), Endpoint: ep.cfg.URL}
	}

	var envelope struct {
		Data struct {
			Ticket              string `json:"ticket"`
			CSRFPreventionToken string `json:"CSRFPreventionToken"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode ticket response: %w", err)
	}
	if envelope.Data.Ticket == "" {
		return nil, errors.New("empty ticket returned by PVE")
	}

	ts := &ticketState{
		ticket:    envelope.Data.Ticket,
		csrfToken: envelope.Data.CSRFPreventionToken,
		expiresAt: time.Now().Add(90 * time.Minute),
	}
	c.mu.Lock()
	c.ticket = ts
	c.mu.Unlock()
	return ts, nil
}

// AcquireTempTicket authenticates once with explicit credentials (e.g., interactive termproxy fallback).
func (c *Client) AcquireTempTicket(ctx context.Context, username, password string) (string, string, error) {
	ep := c.pickEndpoints()[0]
	form := url.Values{}
	form.Set("username", username)
	form.Set("password", password)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, ep.cfg.URL+"/api2/json/access/ticket", strings.NewReader(form.Encode()))
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := ep.httpClient.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return "", "", &APIError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(raw), Endpoint: ep.cfg.URL}
	}
	var env struct {
		Data struct {
			Ticket              string `json:"ticket"`
			CSRFPreventionToken string `json:"CSRFPreventionToken"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return "", "", err
	}
	return env.Data.Ticket, env.Data.CSRFPreventionToken, nil
}

func (c *Client) applyAuth(ctx context.Context, req *http.Request, ep *endpointState, forceTicket bool) error {
	if forceTicket || c.useTicketAuth() {
		ts, err := c.EnsureTicket(ctx, ep)
		if err != nil {
			return err
		}
		req.Header.Set("Cookie", "PVEAuthCookie="+ts.ticket)
		if req.Method != http.MethodGet && req.Method != http.MethodHead {
			req.Header.Set("CSRFPreventionToken", ts.csrfToken)
		}
		return nil
	}
	if c.cfg.TokenID == "" || c.cfg.TokenSecret == "" {
		return errors.New("API token credentials are incomplete")
	}
	req.Header.Set("Authorization", fmt.Sprintf("PVEAPIToken=%s=%s", c.cfg.TokenID, c.cfg.TokenSecret))
	return nil
}

// AuthHeaders returns HTTP headers needed for WebSocket upgrade against PVE.
func (c *Client) AuthHeaders(ctx context.Context, forceTicket bool, explicitTicket string) (http.Header, error) {
	h := make(http.Header)
	if explicitTicket != "" {
		h.Set("Cookie", "PVEAuthCookie="+explicitTicket)
		return h, nil
	}
	ep := c.pickEndpoints()[0]
	if forceTicket || c.useTicketAuth() {
		ts, err := c.EnsureTicket(ctx, ep)
		if err != nil {
			return nil, err
		}
		h.Set("Cookie", "PVEAuthCookie="+ts.ticket)
		return h, nil
	}
	h.Set("Authorization", fmt.Sprintf("PVEAPIToken=%s=%s", c.cfg.TokenID, c.cfg.TokenSecret))
	return h, nil
}

func (c *Client) DoJSON(ctx context.Context, method, apiPath string, params url.Values, out any) error {
	return c.doJSONInternal(ctx, method, apiPath, params, out, false, "", "")
}

func (c *Client) doJSONInternal(ctx context.Context, method, apiPath string, params url.Values, out any, forceTicket bool, explicitTicket, explicitCSRF string) error {
	if !strings.HasPrefix(apiPath, "/") {
		apiPath = "/" + apiPath
	}
	eps := c.pickEndpoints()
	var lastErr error

	for idx, ep := range eps {
		fullURL := ep.cfg.URL + "/api2/json" + apiPath
		var bodyReader io.Reader
		if len(params) > 0 {
			if method == http.MethodGet || method == http.MethodDelete {
				sep := "?"
				if strings.Contains(fullURL, "?") {
					sep = "&"
				}
				fullURL += sep + params.Encode()
			} else {
				bodyReader = strings.NewReader(params.Encode())
			}
		}

		req, err := http.NewRequestWithContext(ctx, method, fullURL, bodyReader)
		if err != nil {
			return err
		}
		if bodyReader != nil {
			req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		}
		req.Header.Set("Accept", "application/json")

		if explicitTicket != "" {
			req.Header.Set("Cookie", "PVEAuthCookie="+explicitTicket)
			if method != http.MethodGet && explicitCSRF != "" {
				req.Header.Set("CSRFPreventionToken", explicitCSRF)
			}
		} else {
			if err := c.applyAuth(ctx, req, ep, forceTicket); err != nil {
				return err
			}
		}

		resp, err := ep.httpClient.Do(req)
		if err != nil {
			var certErr *CertMismatchError
			if errors.As(err, &certErr) {
				return certErr
			}
			c.markCooldown(ep)
			lastErr = err
			if method == http.MethodGet && idx+1 < len(eps) {
				continue
			}
			return err
		}

		raw, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
		resp.Body.Close()
		if readErr != nil {
			return readErr
		}

		if resp.StatusCode == http.StatusUnauthorized && (forceTicket || c.useTicketAuth()) && explicitTicket == "" {
			// Clear cached ticket once and retry on same endpoint
			c.mu.Lock()
			c.ticket = nil
			c.mu.Unlock()
			return &APIError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(raw), Endpoint: ep.cfg.URL}
		}

		if resp.StatusCode >= 502 && resp.StatusCode <= 504 && method == http.MethodGet && idx+1 < len(eps) {
			c.markCooldown(ep)
			lastErr = &APIError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(raw), Endpoint: ep.cfg.URL}
			continue
		}

		if resp.StatusCode >= 400 {
			return &APIError{StatusCode: resp.StatusCode, Status: resp.Status, Body: string(raw), Endpoint: ep.cfg.URL}
		}

		if out == nil {
			return nil
		}
		var env struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			return fmt.Errorf("decode PVE envelope (%s): %w", apiPath, err)
		}
		if len(env.Data) == 0 || bytes.Equal(env.Data, []byte("null")) {
			return nil
		}
		if err := json.Unmarshal(env.Data, out); err != nil {
			return fmt.Errorf("decode PVE data (%s): %w", apiPath, err)
		}
		return nil
	}
	return lastErr
}

// DoRaw proxies an arbitrary PVE /api2/json/* call for the admin escape hatch.
func (c *Client) DoRaw(ctx context.Context, method, apiPath string, query url.Values, body []byte, contentType string) (int, []byte, error) {
	if !strings.HasPrefix(apiPath, "/") {
		apiPath = "/" + apiPath
	}
	ep := c.pickEndpoints()[0]
	fullURL := ep.cfg.URL + "/api2/json" + apiPath
	if len(query) > 0 {
		fullURL += "?" + query.Encode()
	}
	var br io.Reader
	if len(body) > 0 {
		br = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, fullURL, br)
	if err != nil {
		return 0, nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if err := c.applyAuth(ctx, req, ep, false); err != nil {
		return 0, nil, err
	}
	resp, err := ep.httpClient.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	return resp.StatusCode, raw, err
}

type ProbeResult struct {
	OK           bool              `json:"ok"`
	Version      *VersionInfo      `json:"version,omitempty"`
	Capabilities *Capabilities     `json:"capabilities,omitempty"`
	ClusterName  string            `json:"clusterName,omitempty"`
	Nodes        []string          `json:"nodes,omitempty"`
	Fingerprints map[string]string `json:"fingerprints,omitempty"`
	CertMismatch *CertMismatchInfo `json:"certMismatch,omitempty"`
	Error        string            `json:"error,omitempty"`
}

type CertMismatchInfo struct {
	Endpoint            string `json:"endpoint"`
	ExpectedFingerprint string `json:"expectedFingerprint"`
	ObservedFingerprint string `json:"observedFingerprint"`
}

func (c *Client) Probe(ctx context.Context) *ProbeResult {
	res := &ProbeResult{}
	ver, err := c.GetVersion(ctx)
	res.Fingerprints = c.ObservedFingerprints()
	if err != nil {
		var cm *CertMismatchError
		if errors.As(err, &cm) {
			res.CertMismatch = &CertMismatchInfo{
				Endpoint:            cm.Endpoint,
				ExpectedFingerprint: cm.ExpectedFingerprint,
				ObservedFingerprint: cm.ObservedFingerprint,
			}
		}
		res.Error = err.Error()
		return res
	}
	res.Version = ver

	statusList, err := c.GetClusterStatus(ctx)
	isCluster := false
	if err == nil {
		for _, item := range statusList {
			if item.Type == "cluster" {
				isCluster = true
				res.ClusterName = item.Name
			} else if item.Type == "node" {
				res.Nodes = append(res.Nodes, item.Name)
			}
		}
	}
	caps := BuildCapabilities(ver, isCluster)
	res.Capabilities = &caps
	res.OK = true
	return res
}
