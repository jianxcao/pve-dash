package service

import (
	"context"
	"errors"
	"net"
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
		"http://0.0.0.0:8080/hook",
		"http://0.0.0.1:8080/hook",
		"http://0.42.1.9:9000/hook",
		"http://100.100.100.200/latest/meta-data/",
		"http://[::ffff:100.100.100.200]/latest/meta-data/",
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
		"http://203.0.113.50:9000/webhook",
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

func TestDialValidatedNotifyTargetDualStackFallbackAndDNSRebindBlock(t *testing.T) {
	var attempted []string
	c1, c2 := net.Pipe()
	defer c1.Close()
	defer c2.Close()

	conn, err := dialValidatedNotifyTarget(
		context.Background(),
		func(_ context.Context, _ string) ([]net.IPAddr, error) {
			return []net.IPAddr{
				{IP: net.ParseIP("2001:db8::dead")},
				{IP: net.ParseIP("203.0.113.25")},
			}, nil
		},
		func(_ context.Context, _, target string) (net.Conn, error) {
			attempted = append(attempted, target)
			if strings.HasPrefix(target, "[2001:db8::dead]") {
				return nil, errors.New("dial tcp6: network is unreachable")
			}
			return c1, nil
		},
		"tcp",
		"hooks.example.com:443",
	)
	if err != nil || conn == nil {
		t.Fatalf("expected fallback to IPv4 address to succeed, got (%v, %v)", conn, err)
	}
	if len(attempted) != 2 || attempted[1] != "203.0.113.25:443" {
		t.Fatalf("expected sequential dial across resolved IPs, got %v", attempted)
	}

	// Mixed public + blocked IP (0.0.0.5 or 100.100.100.200) in DNS response must abort with zero dials
	dialCalled := false
	_, err = dialValidatedNotifyTarget(
		context.Background(),
		func(_ context.Context, _ string) ([]net.IPAddr, error) {
			return []net.IPAddr{
				{IP: net.ParseIP("203.0.113.25")},
				{IP: net.ParseIP("100.100.100.200")},
			}, nil
		},
		func(_ context.Context, _, _ string) (net.Conn, error) {
			dialCalled = true
			return nil, errors.New("unexpected")
		},
		"tcp",
		"rebind.example.com:80",
	)
	if err == nil || dialCalled {
		t.Fatalf("expected blocked IP in DNS set to abort before dialing, err=%v dialCalled=%v", err, dialCalled)
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
