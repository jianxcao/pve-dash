package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/jianxcao/pve-dash/internal/crypto"
)

type ConsoleSession struct {
	ID             string
	InstanceID     string
	Node           string
	TargetType     string // node | qemu | lxc
	VMID           int
	Protocol       string // vnc | xterm
	Port           int
	Ticket         string
	User           string
	VNCPassword    string
	UseTicketAuth  bool
	ExplicitTicket string
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

type ConsoleManager struct {
	pool     *Pool
	mu       sync.Mutex
	sessions map[string]*ConsoleSession
}

func NewConsoleManager(pool *Pool) *ConsoleManager {
	cm := &ConsoleManager{
		pool:     pool,
		sessions: make(map[string]*ConsoleSession),
	}
	go cm.gcLoop()
	return cm
}

func (cm *ConsoleManager) gcLoop() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for range ticker.C {
		now := time.Now()
		cm.mu.Lock()
		for k, s := range cm.sessions {
			if now.After(s.ExpiresAt) {
				delete(cm.sessions, k)
			}
		}
		cm.mu.Unlock()
	}
}

type CreateSessionInput struct {
	InstanceID       string
	Node             string
	TargetType       string // node | qemu | lxc
	VMID             int
	Protocol         string // vnc | xterm
	FallbackUsername string
	FallbackPassword string
}

type CreateSessionOutput struct {
	SessionID   string `json:"sessionId"`
	Protocol    string `json:"protocol"`
	WSPath      string `json:"wsPath"`
	VNCPassword string `json:"vncPassword,omitempty"`
}

func (cm *ConsoleManager) CreateSession(ctx context.Context, in CreateSessionInput) (*CreateSessionOutput, error) {
	cl, _, err := cm.pool.Get(ctx, in.InstanceID)
	if err != nil {
		return nil, err
	}

	proto := in.Protocol
	if proto == "" {
		if in.TargetType == "qemu" {
			proto = "vnc"
		} else {
			proto = "xterm"
		}
	}

	var proxyResp *ConsoleProxyResp
	var useTicketAuth bool
	var explicitTicket, explicitCSRF string

	if in.FallbackUsername != "" && in.FallbackPassword != "" {
		t, csrf, err := cl.AcquireTempTicket(ctx, in.FallbackUsername, in.FallbackPassword)
		if err != nil {
			return nil, fmt.Errorf("acquire fallback ticket: %w", err)
		}
		explicitTicket = t
		explicitCSRF = csrf
	}

	switch proto {
	case "vnc":
		proxyResp, useTicketAuth, err = cl.RequestVNCProxy(ctx, in.Node, in.TargetType, in.VMID, explicitTicket, explicitCSRF)
		if err != nil {
			return nil, err
		}
	case "xterm":
		proxyResp, useTicketAuth, err = cl.RequestTermProxy(ctx, in.Node, in.TargetType, in.VMID, explicitTicket, explicitCSRF)
		if err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported console protocol: %s", proto)
	}

	sid, err := crypto.RandomTokenHex(24)
	if err != nil {
		return nil, err
	}

	vncPass := proxyResp.Password
	if vncPass == "" {
		vncPass = proxyResp.Ticket
	}

	sess := &ConsoleSession{
		ID:             sid,
		InstanceID:     in.InstanceID,
		Node:           in.Node,
		TargetType:     in.TargetType,
		VMID:           in.VMID,
		Protocol:       proto,
		Port:           int(proxyResp.Port),
		Ticket:         proxyResp.Ticket,
		User:           proxyResp.User,
		VNCPassword:    vncPass,
		UseTicketAuth:  useTicketAuth,
		ExplicitTicket: explicitTicket,
		CreatedAt:      time.Now(),
		ExpiresAt:      time.Now().Add(45 * time.Second),
	}

	cm.mu.Lock()
	cm.sessions[sid] = sess
	cm.mu.Unlock()

	out := &CreateSessionOutput{
		SessionID: sid,
		Protocol:  proto,
		WSPath:    "/api/v1/ws/console/" + sid,
	}
	if proto == "vnc" {
		out.VNCPassword = vncPass
	}
	return out, nil
}

func (cm *ConsoleManager) consumeSession(id string) (*ConsoleSession, bool) {
	cm.mu.Lock()
	defer cm.mu.Unlock()
	sess, ok := cm.sessions[id]
	if !ok {
		return nil, false
	}
	delete(cm.sessions, id)
	if time.Now().After(sess.ExpiresAt) {
		return nil, false
	}
	return sess, true
}

func (cm *ConsoleManager) ServeWS(w http.ResponseWriter, r *http.Request, sessionID string) {
	sess, ok := cm.consumeSession(sessionID)
	if !ok {
		http.Error(w, "invalid or expired console session", http.StatusUnauthorized)
		return
	}

	cl, _, err := cm.pool.Get(r.Context(), sess.InstanceID)
	if err != nil {
		http.Error(w, "instance unavailable: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Build upstream wss://.../vncwebsocket URL
	baseURL, tlsCfg := cl.ActiveEndpoint()
	wsBase := strings.Replace(baseURL, "https://", "wss://", 1)
	wsBase = strings.Replace(wsBase, "http://", "ws://", 1)

	var wsPath string
	switch sess.TargetType {
	case "node":
		wsPath = fmt.Sprintf("/api2/json/nodes/%s/vncwebsocket", url.PathEscape(sess.Node))
	default:
		wsPath = fmt.Sprintf("/api2/json/nodes/%s/%s/%d/vncwebsocket", url.PathEscape(sess.Node), sess.TargetType, sess.VMID)
	}
	upstreamURL := fmt.Sprintf("%s%s?port=%d&vncticket=%s", wsBase, wsPath, sess.Port, url.QueryEscape(sess.Ticket))

	authHeaders, err := cl.AuthHeaders(r.Context(), sess.UseTicketAuth, sess.ExplicitTicket)
	if err != nil {
		http.Error(w, "upstream auth failed: "+err.Error(), http.StatusBadGateway)
		return
	}

	// Accept downstream browser WebSocket
	acceptOpts := &websocket.AcceptOptions{
		InsecureSkipVerify: true, // Protected by single-use high-entropy sessionId
	}
	if sess.Protocol == "vnc" {
		acceptOpts.Subprotocols = []string{"binary"}
	}
	clientConn, err := websocket.Accept(w, r, acceptOpts)
	if err != nil {
		slog.Warn("console accept failed", "err", err)
		return
	}
	clientConn.SetReadLimit(4 << 20)
	defer clientConn.CloseNow()

	// Dial upstream PVE WebSocket with dual auth (Header + query vncticket)
	dialCtx, dialCancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer dialCancel()
	dialOpts := &websocket.DialOptions{
		HTTPClient: &http.Client{
			Transport: &http.Transport{
				TLSClientConfig: tlsCfg,
			},
		},
		HTTPHeader: authHeaders,
	}
	if sess.Protocol == "vnc" {
		dialOpts.Subprotocols = []string{"binary"}
	}
	upstreamConn, _, err := websocket.Dial(dialCtx, upstreamURL, dialOpts)
	if err != nil {
		slog.Warn("console upstream dial failed", "url", wsPath, "err", err)
		_ = clientConn.Close(websocket.StatusInternalError, "upstream connect failed: "+err.Error())
		return
	}
	upstreamConn.SetReadLimit(4 << 20)
	defer upstreamConn.CloseNow()

	if sess.Protocol == "xterm" {
		cm.bridgeXterm(r.Context(), clientConn, upstreamConn, sess)
		return
	}
	cm.bridgeVNC(r.Context(), clientConn, upstreamConn)
}

func (cm *ConsoleManager) bridgeVNC(ctx context.Context, client, upstream *websocket.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	var wg sync.WaitGroup
	wg.Add(2)

	// Client -> PVE
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			mt, data, err := client.Read(ctx)
			if err != nil {
				return
			}
			if err := upstream.Write(ctx, mt, data); err != nil {
				return
			}
		}
	}()

	// PVE -> Client
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			mt, data, err := upstream.Read(ctx)
			if err != nil {
				return
			}
			if err := client.Write(ctx, mt, data); err != nil {
				return
			}
		}
	}()

	wg.Wait()
	_ = client.Close(websocket.StatusNormalClosure, "")
	_ = upstream.Close(websocket.StatusNormalClosure, "")
}

type xtermClientMsg struct {
	Type string `json:"type"` // data | resize | ping
	Data string `json:"data,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
}

func (cm *ConsoleManager) bridgeXterm(ctx context.Context, client, upstream *websocket.Conn, sess *ConsoleSession) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Step 1: PVE termproxy wire authentication handshake: "{user}:{ticket}\n" -> "OK"
	authMsg := fmt.Sprintf("%s:%s\n", sess.User, sess.Ticket)
	if err := upstream.Write(ctx, websocket.MessageBinary, []byte(authMsg)); err != nil {
		_ = client.Close(websocket.StatusInternalError, "termproxy auth write failed")
		return
	}
	hsCtx, hsCancel := context.WithTimeout(ctx, 10*time.Second)
	_, okBytes, err := upstream.Read(hsCtx)
	hsCancel()
	if err != nil {
		_ = client.Close(websocket.StatusInternalError, "termproxy auth read failed")
		return
	}
	if !strings.HasPrefix(string(okBytes), "OK") {
		_ = client.Close(websocket.StatusPolicyViolation, "termproxy auth rejected: "+string(okBytes))
		return
	}

	// If PVE sent any extra initial PTY bytes after "OK", forward them immediately
	if len(okBytes) > 2 {
		_ = client.Write(ctx, websocket.MessageBinary, okBytes[2:])
	}

	var writeMu sync.Mutex
	writeUpstream := func(payload string) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return upstream.Write(ctx, websocket.MessageBinary, []byte(payload))
	}

	var wg sync.WaitGroup
	wg.Add(3)

	// 1. Keepalive heartbeat every 30s ("2:") to prevent PVE's 5-minute idle drop
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := writeUpstream("2"); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	// 2. Client -> PVE (encode JSON frames into PVE "0:<utf8ByteLen>:<data>" and "1:<cols>:<rows>:")
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, raw, err := client.Read(ctx)
			if err != nil {
				return
			}
			var msg xtermClientMsg
			if err := json.Unmarshal(raw, &msg); err != nil {
				// Raw fallback
				frame := fmt.Sprintf("0:%d:%s", len(raw), string(raw))
				if err := writeUpstream(frame); err != nil {
					return
				}
				continue
			}
			switch msg.Type {
			case "data":
				if msg.Data == "" {
					continue
				}
				byteLen := len([]byte(msg.Data))
				if err := writeUpstream(fmt.Sprintf("0:%d:%s", byteLen, msg.Data)); err != nil {
					return
				}
			case "resize":
				if msg.Cols > 0 && msg.Rows > 0 {
					if err := writeUpstream(fmt.Sprintf("1:%d:%d:", msg.Cols, msg.Rows)); err != nil {
						return
					}
				}
			case "ping":
				if err := writeUpstream("2"); err != nil {
					return
				}
			}
		}
	}()

	// 3. PVE -> Client (1:1 raw PTY bytes)
	go func() {
		defer wg.Done()
		defer cancel()
		for {
			_, data, err := upstream.Read(ctx)
			if err != nil {
				var closeErr websocket.CloseError
				if !errors.As(err, &closeErr) {
					slog.Debug("xterm upstream read ended", "err", err)
				}
				return
			}
			if len(data) == 0 {
				continue
			}
			if err := client.Write(ctx, websocket.MessageBinary, data); err != nil {
				return
			}
		}
	}()

	wg.Wait()
	_ = client.Close(websocket.StatusNormalClosure, "")
	_ = upstream.Close(websocket.StatusNormalClosure, "")
}
