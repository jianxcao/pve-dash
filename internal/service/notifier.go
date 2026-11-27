package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// ChannelConfig holds decrypted configuration for an alert notification channel.
type ChannelConfig struct {
	URL         string            `json:"url,omitempty"`         // webhook / feishu / dingtalk / wecom / bark server URL
	Secret      string            `json:"secret,omitempty"`      // HMAC signing secret (webhook / feishu / dingtalk) or Bearer token
	BotToken    string            `json:"botToken,omitempty"`    // Telegram bot token
	ChatID      string            `json:"chatId,omitempty"`      // Telegram chat ID
	ThreadID    string            `json:"threadId,omitempty"`    // Telegram topic thread ID (optional)
	DeviceKey   string            `json:"deviceKey,omitempty"`   // Bark device key (optional if embedded in URL)
	Headers     map[string]string `json:"headers,omitempty"`     // Custom headers for generic webhook
	AtAll       bool              `json:"atAll,omitempty"`       // DingTalk / WeCom @all on critical
}

// AlertNotice is the normalized payload rendered into each provider's native format.
type AlertNotice struct {
	EventType    string  `json:"eventType"` // firing | resolved | test
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

var notifyHTTPClient = &http.Client{
	Timeout: 10 * time.Second,
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
		pathPreview := u.Path
		if len(pathPreview) > 18 {
			pathPreview = pathPreview[:12] + "•••" + pathPreview[len(pathPreview)-4:]
		}
		if u.RawQuery != "" {
			return fmt.Sprintf("%s://%s%s?•••", u.Scheme, u.Host, pathPreview)
		}
		return fmt.Sprintf("%s://%s%s", u.Scheme, u.Host, pathPreview)
	}

	out := map[string]any{
		"hasSecret": strings.TrimSpace(cfg.Secret) != "",
		"atAll":     cfg.AtAll,
	}
	switch channelType {
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

func DispatchNotification(ctx context.Context, channelType string, cfg ChannelConfig, notice AlertNotice) error {
	if notice.Timestamp == "" {
		notice.Timestamp = time.Now().Format("2006-01-02 15:04:05")
	}
	switch channelType {
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
	default:
		return "[告警触发]"
	}
}

func sendGenericWebhook(ctx context.Context, cfg ChannelConfig, n AlertNotice) error {
	if strings.TrimSpace(cfg.URL) == "" {
		return fmt.Errorf("webhook URL is required")
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
	if strings.TrimSpace(cfg.URL) == "" {
		return fmt.Errorf("飞书 Webhook URL 不能为空")
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
	if endpoint == "" {
		return fmt.Errorf("钉钉 Webhook URL 不能为空")
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
	if strings.TrimSpace(cfg.URL) == "" {
		return fmt.Errorf("企业微信 Webhook URL 不能为空")
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

func doNotifyHTTP(req *http.Request) error {
	resp, err := notifyHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
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
