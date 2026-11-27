package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// ChannelConfig holds decrypted configuration for an alert notification channel.
type ChannelConfig struct {
	URL       string            `json:"url,omitempty"`       // notify / webhook / feishu / dingtalk / wecom / bark server URL
	Secret    string            `json:"secret,omitempty"`    // Bearer token (notify) or HMAC signing secret (webhook / feishu / dingtalk)
	AppID     string            `json:"appId,omitempty"`     // jianxcao/notify application ID
	Targets   string            `json:"targets,omitempty"`   // jianxcao/notify comma-separated target list
	PanelURL  string            `json:"panelUrl,omitempty"`  // Optional panel jump link included in notifications
	BotToken  string            `json:"botToken,omitempty"`  // Telegram bot token
	ChatID    string            `json:"chatId,omitempty"`    // Telegram chat ID
	ThreadID  string            `json:"threadId,omitempty"`  // Telegram topic thread ID (optional)
	DeviceKey string            `json:"deviceKey,omitempty"` // Bark device key (optional if embedded in URL)
	Headers   map[string]string `json:"headers,omitempty"`   // Custom headers for generic webhook
	AtAll     bool              `json:"atAll,omitempty"`     // DingTalk / WeCom @all on critical
}

// AlertNotice is the normalized payload rendered into each provider's native format.
type AlertNotice struct {
	EventType    string  `json:"eventType"` // firing | resolved | test | ops | security
	Severity     string  `json:"severity"`  // info | warning | critical
	Title        string  `json:"title"`
	Message      string  `json:"message"`
	RuleName     string  `json:"ruleName"`
	InstanceName string  `json:"instanceName,omitempty"`
	ResourceName string  `json:"resourceName,omitempty"`
	Metric       string  `json:"metric,omitempty"`
	CurrentValue float64 `json:"currentValue,omitempty"`
	Threshold    float64 `json:"threshold,omitempty"`
	Unit         string  `json:"unit,omitempty"`
	Timestamp    string  `json:"timestamp"`
}

var telegramTokenRegex = regexp.MustCompile(`^\d+:[A-Za-z0-9_-]{10,}$`)

func isBlockedNotifyIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// Block 0.0.0.0/8 ("this network" routes to loopback on Linux/macOS) and Alibaba Cloud ECS metadata (100.100.100.200)
		if ip4[0] == 0 || ip4.Equal(net.IPv4(100, 100, 100, 200)) {
			return true
		}
	}
	// Block loopback, link-local/cloud metadata (169.254.0.0/16, fe80::/10), multicast, and unspecified
	return ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsMulticast() || ip.IsUnspecified()
}

func ValidateWebhookURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("通知地址必须为有效的 http:// 或 https:// URL")
	}
	host := strings.ToLower(u.Hostname())
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return errors.New("禁止指向本机回环地址")
	}
	if ip := net.ParseIP(host); ip != nil && isBlockedNotifyIP(ip) {
		return errors.New("禁止指向回环、链路本地或云元数据地址")
	}
	return nil
}

func ValidateTelegramToken(token string) error {
	if !telegramTokenRegex.MatchString(strings.TrimSpace(token)) {
		return errors.New("Telegram Bot Token 格式无效（应为 数字:字母数字下划线）")
	}
	return nil
}

var notifyDialer = &net.Dialer{Timeout: 6 * time.Second}

func dialValidatedNotifyTarget(
	ctx context.Context,
	lookupFn func(context.Context, string) ([]net.IPAddr, error),
	dialFn func(context.Context, string, string) (net.Conn, error),
	network, addr string,
) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := lookupFn(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("DNS lookup failed for %s", host)
	}
	for _, ipa := range ips {
		if isBlockedNotifyIP(ipa.IP) {
			return nil, fmt.Errorf("blocked destination IP for %s", host)
		}
	}
	var lastErr error
	for _, ipa := range ips {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		conn, dialErr := dialFn(ctx, network, net.JoinHostPort(ipa.IP.String(), port))
		if dialErr == nil {
			return conn, nil
		}
		lastErr = dialErr
	}
	return nil, lastErr
}

var notifyHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
	Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			return dialValidatedNotifyTarget(ctx, net.DefaultResolver.LookupIPAddr, notifyDialer.DialContext, network, addr)
		},
		MaxIdleConns:        16,
		IdleConnTimeout:     30 * time.Second,
		TLSHandshakeTimeout: 6 * time.Second,
	},
}

func MaskChannelConfig(channelType string, cfg ChannelConfig) map[string]any {
	maskSecret := func(s string) string {
		s = strings.TrimSpace(s)
		if s == "" {
			return ""
		}
		if len(s) <= 8 {
			return "••••"
		}
		return s[:4] + "••••" + s[len(s)-4:]
	}
	maskURL := func(raw string) string {
		u, err := url.Parse(strings.TrimSpace(raw))
		if err != nil || u.Host == "" {
			return maskSecret(raw)
		}
		segs := strings.Split(strings.Trim(u.Path, "/"), "/")
		if len(segs) > 0 && segs[len(segs)-1] != "" {
			last := segs[len(segs)-1]
			if len(last) > 4 {
				segs[len(segs)-1] = "•••" + last[len(last)-4:]
			} else {
				segs[len(segs)-1] = "••••"
			}
		}
		maskedPath := ""
		if len(segs) > 0 && !(len(segs) == 1 && segs[0] == "") {
			maskedPath = "/" + strings.Join(segs, "/")
		}
		if u.RawQuery != "" {
			return fmt.Sprintf("%s://%s%s?•••", u.Scheme, u.Host, maskedPath)
		}
		return fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, maskedPath)
	}

	out := map[string]any{
		"hasSecret": strings.TrimSpace(cfg.Secret) != "",
		"atAll":     cfg.AtAll,
	}
	switch channelType {
	case "notify":
		out["urlPreview"] = maskURL(cfg.URL)
		out["appId"] = strings.TrimSpace(cfg.AppID)
		out["targets"] = strings.TrimSpace(cfg.Targets)
		out["panelUrl"] = strings.TrimSpace(cfg.PanelURL)
	case "telegram":
		out["botTokenPreview"] = maskSecret(cfg.BotToken)
		out["chatId"] = cfg.ChatID
		out["threadId"] = cfg.ThreadID
	case "bark":
		out["urlPreview"] = maskURL(cfg.URL)
		out["deviceKeyPreview"] = maskSecret(cfg.DeviceKey)
	default:
		out["urlPreview"] = maskURL(cfg.URL)
	}
	return out
}

// ResolveNotifyEndpoint builds and validates the full `POST /api/v1/notify/:appid` endpoint URL
// for a `jianxcao/notify` channel configuration.
func ResolveNotifyEndpoint(cfg ChannelConfig) (string, error) {
	rawURL := strings.TrimSpace(cfg.URL)
	appID := strings.TrimSpace(cfg.AppID)
	if rawURL == "" {
		return "", errors.New("Notify 服务地址不能为空")
	}
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		if vErr := ValidateWebhookURL(rawURL); vErr != nil {
			return "", fmt.Errorf("Notify 服务地址无效: %w", vErr)
		}
		return "", errors.New("Notify 服务地址无效")
	}

	const notifyPrefix = "/api/v1/notify/"
	trimmedPath := strings.TrimRight(u.Path, "/")
	if idx := strings.Index(u.Path, notifyPrefix); idx >= 0 {
		after := strings.Trim(u.Path[idx+len(notifyPrefix):], "/")
		if after == "" {
			if appID == "" {
				return "", errors.New("Notify 通道需提供完整 /api/v1/notify/<appId> 地址或填写应用 ID (AppID)")
			}
			prefixPath := strings.TrimRight(u.Path[:idx], "/")
			escapedPrefix := u.EscapedPath()
			if escIdx := strings.Index(escapedPrefix, "/api/v1/notify"); escIdx >= 0 {
				escapedPrefix = strings.TrimRight(escapedPrefix[:escIdx], "/")
			}
			u.Path = prefixPath + notifyPrefix + appID
			u.RawPath = escapedPrefix + notifyPrefix + url.PathEscape(appID)
		}
	} else if strings.HasSuffix(trimmedPath, "/api/v1/notify") {
		if appID == "" {
			return "", errors.New("Notify 通道需提供完整 /api/v1/notify/<appId> 地址或填写应用 ID (AppID)")
		}
		prefixPath := strings.TrimSuffix(trimmedPath, "/api/v1/notify")
		escapedPrefix := strings.TrimSuffix(strings.TrimRight(u.EscapedPath(), "/"), "/api/v1/notify")
		u.Path = prefixPath + notifyPrefix + appID
		u.RawPath = escapedPrefix + notifyPrefix + url.PathEscape(appID)
	} else if appID != "" {
		escapedBase := strings.TrimRight(u.EscapedPath(), "/")
		u.Path = trimmedPath + notifyPrefix + appID
		u.RawPath = escapedBase + notifyPrefix + url.PathEscape(appID)
	} else {
		return "", errors.New("Notify 通道需提供完整 /api/v1/notify/<appId> 地址或填写应用 ID (AppID)")
	}

	endpoint := u.String()
	if err := ValidateWebhookURL(endpoint); err != nil {
		return "", fmt.Errorf("Notify 服务地址无效: %w", err)
	}
	if panel := strings.TrimSpace(cfg.PanelURL); panel != "" {
		pu, err := url.Parse(panel)
		if err != nil || (pu.Scheme != "http" && pu.Scheme != "https") || pu.Host == "" {
			return "", errors.New("面板跳转地址必须为有效的 http:// 或 https:// URL")
		}
	}
	return endpoint, nil
}

func DispatchNotification(ctx context.Context, channelType string, cfg ChannelConfig, notice AlertNotice) error {
	if notice.Timestamp == "" {
		notice.Timestamp = time.Now().Format("2006-01-02 15:04:05")
	}
	switch channelType {
	case "notify":
		return sendNotify(ctx, cfg, notice)
	case "webhook":
		return sendGenericWebhook(ctx, cfg, notice)
	case "feishu":
		return sendFeishu(ctx, cfg, notice)
	case "dingtalk":
		return sendDingTalk(ctx, cfg, notice)
	case "wecom":
		return sendWeCom(ctx, cfg, notice)
	case "telegram":
		return sendTelegram(ctx, cfg, notice)
	case "bark":
		return sendBark(ctx, cfg, notice)
	default:
		return fmt.Errorf("unsupported channel type: %s", channelType)
	}
}

func severityLabelZH(sev string) string {
	switch sev {
	case "critical":
		return "严重 (Critical)"
	case "warning":
		return "警告 (Warning)"
	default:
		return "提示 (Info)"
	}
}

func eventPrefixZH(ev string) string {
	switch ev {
	case "resolved":
		return "[已恢复]"
	case "test":
		return "[测试通知]"
	case "ops":
		return "[运维事件]"
	case "security":
		return "[安全告警]"
	default:
		return "[告警触发]"
	}
}

func sendNotify(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	endpoint, err := ResolveNotifyEndpoint(cfg)
	if err != nil {
		return err
	}

	notifySeverity := "info"
	switch {
	case n.EventType == "resolved":
		notifySeverity = "info"
	case n.Severity == "critical":
		notifySeverity = "error"
	case n.Severity == "warning":
		notifySeverity = "warning"
	}

	level := strings.TrimSpace(n.Severity)
	if level == "" {
		level = "info"
	}

	var summaryLines []string
	summaryLines = append(summaryLines, fmt.Sprintf("级别：%s", severityLabelZH(level)))
	if strings.TrimSpace(n.RuleName) != "" {
		summaryLines = append(summaryLines, fmt.Sprintf("规则：%s", n.RuleName))
	}
	summaryLines = append(summaryLines, fmt.Sprintf("资源：%s", formatResourceLabel(n)))
	summaryLines = append(summaryLines, fmt.Sprintf("详情：%s", n.Message))
	summaryLines = append(summaryLines, fmt.Sprintf("时间：%s", n.Timestamp))
	content := strings.Join(summaryLines, "\n")

	// Compatible with both jianxcao/notify's `default` template and `doc/pve.md` template.
	// Intentionally omits `fields.type` so `doc/pve.md` falls through to render `{{.content}}`.
	payload := map[string]any{
		"title":     fmt.Sprintf("%s %s", eventPrefixZH(n.EventType), n.Title),
		"content":   content,
		"message":   n.Message,
		"level":     level,
		"severity":  notifySeverity,
		"timestamp": n.Timestamp,
		"url":       strings.TrimSpace(cfg.PanelURL),
		"targets":   strings.TrimSpace(cfg.Targets),
		"fields": map[string]any{
			"hostname": formatResourceLabel(n),
			"instance": n.InstanceName,
			"resource": n.ResourceName,
			"rule":     n.RuleName,
			"metric":   n.Metric,
			"event":    n.EventType,
		},
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "PVE-Dash-AlertEngine/1.0")
	if sec := strings.TrimSpace(cfg.Secret); sec != "" {
		sec = strings.TrimSpace(strings.TrimPrefix(sec, "Bearer "))
		req.Header.Set("Authorization", "Bearer "+sec)
	}

	resp, err := notifyHTTPClient.Do(req)
	if err != nil {
		return sanitizeTransportError(err, req.URL)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fmt.Errorf("upstream returned redirect HTTP %d (redirects are disabled)", resp.StatusCode)
	}

	var notifyRes struct {
		Code *int   `json:"code"`
		Msg  string `json:"msg"`
	}
	hasCodeJSON := json.Unmarshal(raw, &notifyRes) == nil && notifyRes.Code != nil

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		if hasCodeJSON && *notifyRes.Code != 0 {
			return fmt.Errorf("Notify 服务返回错误 (HTTP %d, code=%d): %s", resp.StatusCode, *notifyRes.Code, notifyRes.Msg)
		}
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 160 {
			snippet = snippet[:160] + "..."
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet)
	}
	if hasCodeJSON && *notifyRes.Code != 0 {
		return fmt.Errorf("Notify 服务返回错误 (code=%d): %s", *notifyRes.Code, notifyRes.Msg)
	}
	return nil
}

func sendGenericWebhook(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	if err := ValidateWebhookURL(cfg.URL); err != nil {
		return err
	}
	body, _ := json.Marshal(map[string]any{
		"source":       "pve-dash",
		"event":        n.EventType,
		"severity":     n.Severity,
		"title":        n.Title,
		"message":      n.Message,
		"ruleName":     n.RuleName,
		"instanceName": n.InstanceName,
		"resourceName": n.ResourceName,
		"metric":       n.Metric,
		"currentValue": n.CurrentValue,
		"threshold":    n.Threshold,
		"unit":         n.Unit,
		"timestamp":    n.Timestamp,
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSpace(cfg.URL), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "PVE-Dash-AlertEngine/1.0")
	if strings.TrimSpace(cfg.Secret) != "" {
		mac := hmac.New(sha256.New, []byte(cfg.Secret))
		mac.Write(body)
		req.Header.Set("X-PVEDash-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	}
	for k, v := range cfg.Headers {
		if strings.TrimSpace(k) != "" {
			req.Header.Set(k, v)
		}
	}
	return doNotifyHTTP(req)
}

func sendFeishu(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	if err := ValidateWebhookURL(cfg.URL); err != nil {
		return fmt.Errorf("飞书 Webhook URL 无效: %w", err)
	}
	templateColor := "blue"
	switch {
	case n.EventType == "resolved":
		templateColor = "green"
	case n.Severity == "critical":
		templateColor = "red"
	case n.Severity == "warning":
		templateColor = "orange"
	}
	md := fmt.Sprintf("**级别**：%s\n**规则**：%s\n**资源**：%s\n**详情**：%s\n**时间**：%s",
		severityLabelZH(n.Severity), n.RuleName, formatResourceLabel(n), n.Message, n.Timestamp)

	payload := map[string]any{
		"msg_type": "interactive",
		"card": map[string]any{
			"header": map[string]any{
				"title": map[string]any{
					"tag":     "plain_text",
					"content": fmt.Sprintf("%s %s", eventPrefixZH(n.EventType), n.Title),
				},
				"template": templateColor,
			},
			"elements": []any{
				map[string]any{
					"tag": "markdown",
					"content": md,
				},
			},
		},
	}
	if strings.TrimSpace(cfg.Secret) != "" {
		ts := strconv.FormatInt(time.Now().Unix(), 10)
		stringToSign := ts + "\n" + cfg.Secret
		mac := hmac.New(sha256.New, []byte(stringToSign))
		payload["timestamp"] = ts
		payload["sign"] = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	}
	return postJSONWithCheck(ctx, strings.TrimSpace(cfg.URL), payload)
}

func sendDingTalk(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	endpoint := strings.TrimSpace(cfg.URL)
	if err := ValidateWebhookURL(endpoint); err != nil {
		return fmt.Errorf("钉钉 Webhook URL 无效: %w", err)
	}
	if strings.TrimSpace(cfg.Secret) != "" {
		ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
		stringToSign := ts + "\n" + cfg.Secret
		mac := hmac.New(sha256.New, []byte(cfg.Secret))
		mac.Write([]byte(stringToSign))
		sign := url.QueryEscape(base64.StdEncoding.EncodeToString(mac.Sum(nil)))
		sep := "?"
		if strings.Contains(endpoint, "?") {
			sep = "&"
		}
		endpoint = fmt.Sprintf("%s%stimestamp=%s&sign=%s", endpoint, sep, ts, sign)
	}
	title := fmt.Sprintf("%s %s", eventPrefixZH(n.EventType), n.Title)
	text := fmt.Sprintf("### %s\n- **级别**：%s\n- **规则**：%s\n- **资源**：%s\n- **详情**：%s\n- **时间**：%s",
		title, severityLabelZH(n.Severity), n.RuleName, formatResourceLabel(n), n.Message, n.Timestamp)
	payload := map[string]any{
		"msgtype": "markdown",
		"markdown": map[string]any{
			"title": title,
			"text":  text,
		},
		"at": map[string]any{
			"isAtAll": cfg.AtAll && n.Severity == "critical" && n.EventType == "firing",
		},
	}
	return postJSONWithCheck(ctx, endpoint, payload)
}

func sendWeCom(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	if err := ValidateWebhookURL(cfg.URL); err != nil {
		return fmt.Errorf("企业微信 Webhook URL 无效: %w", err)
	}
	colorTag := "info"
	if n.EventType == "firing" && (n.Severity == "critical" || n.Severity == "warning") {
		colorTag = "warning"
	}
	content := fmt.Sprintf("<font color=\"%s\">**%s %s**</font>\n> 级别：%s\n> 规则：%s\n> 资源：%s\n> 详情：%s\n> 时间：%s",
		colorTag, eventPrefixZH(n.EventType), n.Title, severityLabelZH(n.Severity), n.RuleName, formatResourceLabel(n), n.Message, n.Timestamp)
	payload := map[string]any{
		"msgtype": "markdown",
		"markdown": map[string]any{
			"content": content,
		},
	}
	return postJSONWithCheck(ctx, strings.TrimSpace(cfg.URL), payload)
}

func sendTelegram(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	token := strings.TrimSpace(cfg.BotToken)
	chatID := strings.TrimSpace(cfg.ChatID)
	if token == "" || chatID == "" {
		return fmt.Errorf("Telegram Bot Token 和 Chat ID 不能为空")
	}
	if err := ValidateTelegramToken(token); err != nil {
		return err
	}
	endpoint := fmt.Sprintf("https://api.telegram.org/bot%s/sendMessage", token)
	escape := func(s string) string {
		r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;")
		return r.Replace(s)
	}
	text := fmt.Sprintf("<b>%s %s</b>\n<b>级别：</b>%s\n<b>规则：</b>%s\n<b>资源：</b>%s\n<b>详情：</b>%s\n<b>时间：</b><code>%s</code>",
		escape(eventPrefixZH(n.EventType)), escape(n.Title),
		escape(severityLabelZH(n.Severity)), escape(n.RuleName),
		escape(formatResourceLabel(n)), escape(n.Message), escape(n.Timestamp))
	payload := map[string]any{
		"chat_id":    chatID,
		"text":       text,
		"parse_mode": "HTML",
	}
	if strings.TrimSpace(cfg.ThreadID) != "" {
		if tid, err := strconv.Atoi(strings.TrimSpace(cfg.ThreadID)); err == nil {
			payload["message_thread_id"] = tid
		}
	}
	return postJSONWithCheck(ctx, endpoint, payload)
}

func sendBark(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	base := strings.TrimRight(strings.TrimSpace(cfg.URL), "/")
	if base == "" {
		base = "https://api.day.app"
	}
	if err := ValidateWebhookURL(base); err != nil {
		return fmt.Errorf("Bark 服务器地址无效: %w", err)
	}
	endpoint := base + "/push"
	level := "active"
	if n.Severity == "critical" && n.EventType == "firing" {
		level = "timeSensitive"
	}
	payload := map[string]any{
		"title": fmt.Sprintf("%s %s", eventPrefixZH(n.EventType), n.Title),
		"body":  fmt.Sprintf("%s\n%s", formatResourceLabel(n), n.Message),
		"group": "PVE Dash",
		"level": level,
	}
	if strings.TrimSpace(cfg.DeviceKey) != "" {
		payload["device_key"] = strings.TrimSpace(cfg.DeviceKey)
	} else {
		// Allow direct Bark full push URL like https://api.day.app/<deviceKey>
		endpoint = base
	}
	return postJSONWithCheck(ctx, endpoint, payload)
}

func formatResourceLabel(n AlertNotice) string {
	if n.InstanceName != "" && n.ResourceName != "" {
		return fmt.Sprintf("%s / %s", n.InstanceName, n.ResourceName)
	}
	if n.ResourceName != "" {
		return n.ResourceName
	}
	if n.InstanceName != "" {
		return n.InstanceName
	}
	return "PVE Dash"
}

func postJSONWithCheck(ctx context.Context, endpoint string, payload any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "PVE-Dash-AlertEngine/1.0")
	return doNotifyHTTP(req)
}

func sanitizeTransportError(err error, reqURL *url.URL) error {
	hostLabel := "upstream"
	if reqURL != nil && reqURL.Host != "" {
		hostLabel = reqURL.Scheme + "://" + reqURL.Host
	}
	var ue *url.Error
	if errors.As(err, &ue) && ue.Err != nil {
		return fmt.Errorf("request to %s failed: %s", hostLabel, ue.Err.Error())
	}
	return fmt.Errorf("request to %s failed", hostLabel)
}

func doNotifyHTTP(req *http.Request) error {
	resp, err := notifyHTTPClient.Do(req)
	if err != nil {
		return sanitizeTransportError(err, req.URL)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		return fmt.Errorf("upstream returned redirect HTTP %d (redirects are disabled)", resp.StatusCode)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		snippet := strings.TrimSpace(string(raw))
		if len(snippet) > 160 {
			snippet = snippet[:160] + "..."
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, snippet)
	}
	// Check common Feishu/DingTalk/WeCom JSON error codes even on HTTP 200
	var codeResp struct {
		Code    *int   `json:"code"`
		ErrCode *int   `json:"errcode"`
		Msg     string `json:"msg"`
		ErrMsg  string `json:"errmsg"`
		OK      *bool  `json:"ok"`
		Desc    string `json:"description"`
	}
	if json.Unmarshal(raw, &codeResp) == nil {
		if codeResp.Code != nil && *codeResp.Code != 0 && *codeResp.Code != 200 {
			return fmt.Errorf("provider error code=%d: %s", *codeResp.Code, codeResp.Msg)
		}
		if codeResp.ErrCode != nil && *codeResp.ErrCode != 0 {
			return fmt.Errorf("provider errcode=%d: %s", *codeResp.ErrCode, codeResp.ErrMsg)
		}
		if codeResp.OK != nil && !*codeResp.OK {
			return fmt.Errorf("telegram error: %s", codeResp.Desc)
		}
	}
	return nil
}
