package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/jianxcao/pve-dash/internal/service"
)

func TestAlertChannelUpdateValidationAndClearSecret(t *testing.T) {
	srv, adminPair, router := newTestAPIServer(t)

	// Create a valid webhook channel with a signing secret
	rr := doJSONReq(t, router, http.MethodPost, "/api/v1/alerts/channels", adminPair.AccessToken, map[string]any{
		"name":    "Ops Hook",
		"type":    "webhook",
		"enabled": true,
		"config": map[string]any{
			"url":    "https://hooks.example.com/alerts",
			"secret": "initial-hmac-secret",
		},
	}, nil)
	if rr.Code != http.StatusCreated {
		t.Fatalf("create alert channel failed: %d %s", rr.Code, rr.Body.String())
	}
	var created alertChannelDTO
	_ = json.Unmarshal(rr.Body.Bytes(), &created)

	// 1. PUT with invalid channel type (e.g. "slack") must return 400 and leave stored type unchanged
	rrBad := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/channels/"+created.ID, adminPair.AccessToken, map[string]any{
		"type": "slack",
	}, nil)
	if rrBad.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for unsupported channel type 'slack', got %d %s", rrBad.Code, rrBad.Body.String())
	}
	stored, err := srv.store.GetAlertChannel(context.Background(), created.ID)
	if err != nil || stored.Type != "webhook" {
		t.Fatalf("expected stored channel type preserved as 'webhook', got %+v err=%v", stored, err)
	}

	// 2. Partial PUT (rename only) preserves existing signing secret
	rrRename := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/channels/"+created.ID, adminPair.AccessToken, map[string]any{
		"name": "Ops Hook Renamed",
	}, nil)
	if rrRename.Code != http.StatusOK {
		t.Fatalf("rename channel failed: %d %s", rrRename.Code, rrRename.Body.String())
	}
	stored, _ = srv.store.GetAlertChannel(context.Background(), created.ID)
	rawCfg, _ := srv.box.DecryptString(stored.ConfigEnc)
	var cfg service.ChannelConfig
	_ = json.Unmarshal([]byte(rawCfg), &cfg)
	if cfg.Secret != "initial-hmac-secret" {
		t.Fatalf("expected secret preserved on rename, got %q", cfg.Secret)
	}

	// 3. PUT with clearSecret=true clears the stored secret cleanly
	rrClear := doJSONReq(t, router, http.MethodPut, "/api/v1/alerts/channels/"+created.ID, adminPair.AccessToken, map[string]any{
		"config": map[string]any{
			"clearSecret": true,
		},
	}, nil)
	if rrClear.Code != http.StatusOK {
		t.Fatalf("clearSecret PUT failed: %d %s", rrClear.Code, rrClear.Body.String())
	}
	stored, _ = srv.store.GetAlertChannel(context.Background(), created.ID)
	rawCfg, _ = srv.box.DecryptString(stored.ConfigEnc)
	cfg = service.ChannelConfig{}
	_ = json.Unmarshal([]byte(rawCfg), &cfg)
	if cfg.Secret != "" || cfg.URL != "https://hooks.example.com/alerts" {
		t.Fatalf("expected secret cleared and URL preserved, got %+v", cfg)
	}
}
