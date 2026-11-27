package service

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

func TestValidateWebhookURLAndTelegramToken(t *testing.T) {
	blocked := []string{
		"",
		"ftp://example.com/hook",
		"http://localhost:8080/hook",
		"http://127.0.0.1:8080/hook",
		"http://169.254.169.254/latest/meta-data/",
		"http://[::1]/hook",
	}
	for _, u := range blocked {
		if err := ValidateWebhookURL(u); err == nil {
			t.Errorf("expected URL %q to be blocked", u)
		}
	}

	allowed := []string{
		"https://open.feishu.cn/open-apis/bot/v2/hook/abc123",
		"https://api.day.app",
		"http://192.168.1.50:9000/webhook",
	}
	for _, u := range allowed {
		if err := ValidateWebhookURL(u); err != nil {
			t.Errorf("expected URL %q to be allowed, got: %v", u, err)
		}
	}

	if err := ValidateTelegramToken("123456:AAH_valid_token_99"); err != nil {
		t.Errorf("expected valid telegram token: %v", err)
	}
	if err := ValidateTelegramToken("invalid/../../token"); err == nil {
		t.Error("expected path-traversal telegram token to fail")
	}
}

func TestMaskChannelConfigAndSanitizeError(t *testing.T) {
	// Short Bark key in URL path must still be masked
	m := MaskChannelConfig("bark", ChannelConfig{URL: "https://api.day.app/AbCdEfGh123456"})
	preview, _ := m["urlPreview"].(string)
	if strings.Contains(preview, "AbCdEfGh") {
		t.Fatalf("Bark key leaked in preview: %q", preview)
	}

	// Transport error must not leak bot token or query token
	u, _ := url.Parse("https://api.telegram.org/bot123456:SECRET_TOKEN_XYZ/sendMessage?access_token=MY_SECRET")
	ue := &url.Error{Op: "Post", URL: u.String(), Err: errors.New("dial tcp: i/o timeout")}
	sanitized := sanitizeTransportError(ue, u)
	if strings.Contains(sanitized.Error(), "SECRET_TOKEN_XYZ") || strings.Contains(sanitized.Error(), "MY_SECRET") {
		t.Fatalf("secret leaked in sanitized transport error: %v", sanitized)
	}
}
