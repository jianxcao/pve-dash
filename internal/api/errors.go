package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
)

// writePVEError maps upstream Proxmox VE client, TLS, store, and validation errors
// to accurate HTTP status codes and structured error payloads instead of a blanket 502.
func (s *Server) writePVEError(w http.ResponseWriter, err error) {
	if err == nil || errors.Is(err, context.Canceled) {
		return
	}

	if errors.Is(err, store.ErrNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]any{
			"error": "目标实例或资源不存在",
			"code":  "NOT_FOUND",
		})
		return
	}

	var cm *pve.CertMismatchError
	if errors.As(err, &cm) {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": cm.Error(),
			"code":  "CERT_FINGERPRINT_MISMATCH",
		})
		return
	}

	var apiErr *pve.APIError
	if errors.As(err, &apiErr) {
		msg := formatPVEAPIError(apiErr)
		if prefix := strings.TrimSuffix(err.Error(), apiErr.Error()); prefix != "" && prefix != err.Error() {
			msg = prefix + msg
		}
		switch apiErr.StatusCode {
		case http.StatusBadRequest:
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": msg,
				"code":  "PVE_BAD_REQUEST",
			})
		case http.StatusUnauthorized, http.StatusForbidden:
			// Never return HTTP 401 for upstream PVE auth/ACL errors; 401 is reserved
			// for pve-dash session expiration and would log the user out of the SPA.
			writeJSON(w, http.StatusForbidden, map[string]any{
				"error": msg,
				"code":  "PVE_PERMISSION_DENIED",
			})
		case http.StatusNotFound:
			writeJSON(w, http.StatusNotFound, map[string]any{
				"error": msg,
				"code":  "PVE_NOT_FOUND",
			})
		case http.StatusNotImplemented:
			writeJSON(w, http.StatusNotImplemented, map[string]any{
				"error": msg,
				"code":  "PVE_NOT_IMPLEMENTED",
			})
		default:
			writeJSON(w, http.StatusBadGateway, map[string]any{
				"error": msg,
				"code":  "PVE_UPSTREAM_ERROR",
			})
		}
		return
	}

	rawMsg := err.Error()
	lower := strings.ToLower(rawMsg)
	if strings.Contains(lower, "is disabled") {
		writeJSON(w, http.StatusConflict, map[string]any{
			"error": rawMsg,
			"code":  "INSTANCE_DISABLED",
		})
		return
	}
	if !strings.Contains(lower, "decode pve") && !strings.Contains(lower, "x509:") && !strings.Contains(lower, "tls:") {
		if strings.Contains(lower, "unsupported") ||
			strings.Contains(lower, "invalid") ||
			strings.Contains(lower, "nothing to update") ||
			strings.Contains(lower, "no config parameters") {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": rawMsg,
				"code":  "BAD_REQUEST",
			})
			return
		}
	}

	writeErr(w, http.StatusBadGateway, rawMsg)
}

func formatPVEAPIError(apiErr *pve.APIError) string {
	if apiErr == nil {
		return ""
	}
	body := strings.TrimSpace(apiErr.Body)
	if body != "" {
		var env struct {
			Message string         `json:"message"`
			Errors  map[string]any `json:"errors"`
		}
		if json.Unmarshal([]byte(body), &env) == nil && (len(env.Errors) > 0 || strings.TrimSpace(env.Message) != "") {
			base := fmt.Sprintf("PVE API (%d)", apiErr.StatusCode)
			if m := strings.TrimSpace(env.Message); m != "" {
				base = fmt.Sprintf("PVE API (%d): %s", apiErr.StatusCode, m)
			} else if st := strings.TrimSpace(apiErr.Status); st != "" {
				base = fmt.Sprintf("PVE API %s", st)
			}
			if len(env.Errors) > 0 {
				keys := make([]string, 0, len(env.Errors))
				for k := range env.Errors {
					keys = append(keys, k)
				}
				sort.Strings(keys)
				details := make([]string, 0, len(keys))
				for _, k := range keys {
					v := strings.TrimSpace(fmt.Sprint(env.Errors[k]))
					if v != "" {
						details = append(details, fmt.Sprintf("%s: %s", k, v))
					} else {
						details = append(details, k)
					}
				}
				return base + ": " + strings.Join(details, "; ")
			}
			return base
		}
	}
	return apiErr.Error()
}
