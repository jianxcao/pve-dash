package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
)

func TestWritePVEErrorMapping(t *testing.T) {
	srv, _, _ := newTestAPIServer(t)

	t.Run("400 with sorted field errors", func(t *testing.T) {
		rr := httptest.NewRecorder()
		srv.writePVEError(rr, &pve.APIError{
			StatusCode: http.StatusBadRequest,
			Status:     "400 Parameter verification failed",
			Body:       `{"data":null,"errors":{"sshkeys":"invalid format - invalid urlencoded string\n","cores":"value must be >= 1"}}`,
		})
		if rr.Code != http.StatusBadRequest {
			t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
		}
		var resp map[string]string
		_ = json.Unmarshal(rr.Body.Bytes(), &resp)
		errMsg := resp["error"]
		coresIdx := strings.Index(errMsg, "cores: value must be >= 1")
		sshIdx := strings.Index(errMsg, "sshkeys: invalid format - invalid urlencoded string")
		if coresIdx < 0 || sshIdx < 0 || coresIdx > sshIdx {
			t.Fatalf("expected sorted field details in error message, got %q", errMsg)
		}
	})

	t.Run("upstream PVE 401 and 403 map to 403 PVE_PERMISSION_DENIED", func(t *testing.T) {
		for _, upstreamCode := range []int{http.StatusUnauthorized, http.StatusForbidden} {
			rr := httptest.NewRecorder()
			srv.writePVEError(rr, fmt.Errorf("读取防火墙选项失败: %w", &pve.APIError{
				StatusCode: upstreamCode,
				Status:     fmt.Sprintf("%d Permission check failed", upstreamCode),
				Body:       `{"message":"Permission check failed (/vms/100, VM.Monitor)"}`,
			}))
			if rr.Code != http.StatusForbidden {
				t.Fatalf("upstream %d must map to 403 (never 401), got %d", upstreamCode, rr.Code)
			}
			var resp map[string]string
			_ = json.Unmarshal(rr.Body.Bytes(), &resp)
			if resp["code"] != "PVE_PERMISSION_DENIED" {
				t.Fatalf("expected code PVE_PERMISSION_DENIED, got %+v", resp)
			}
			if !strings.Contains(resp["error"], "读取防火墙选项失败") {
				t.Fatalf("expected wrapped prefix preserved, got %q", resp["error"])
			}
		}
	})

	t.Run("upstream 404 and 501 preserved", func(t *testing.T) {
		rr404 := httptest.NewRecorder()
		srv.writePVEError(rr404, &pve.APIError{StatusCode: http.StatusNotFound, Status: "404 Not Found"})
		if rr404.Code != http.StatusNotFound {
			t.Fatalf("expected 404, got %d", rr404.Code)
		}

		rr501 := httptest.NewRecorder()
		srv.writePVEError(rr501, &pve.APIError{StatusCode: http.StatusNotImplemented, Status: "501 Not Implemented"})
		if rr501.Code != http.StatusNotImplemented {
			t.Fatalf("expected 501, got %d", rr501.Code)
		}
	})

	t.Run("store.ErrNotFound CertMismatch disabled and validation errors", func(t *testing.T) {
		rrNF := httptest.NewRecorder()
		srv.writePVEError(rrNF, store.ErrNotFound)
		if rrNF.Code != http.StatusNotFound {
			t.Fatalf("expected 404 on store.ErrNotFound, got %d", rrNF.Code)
		}

		rrCM := httptest.NewRecorder()
		srv.writePVEError(rrCM, &pve.CertMismatchError{
			Endpoint:            "https://pve.example.com:8006",
			ExpectedFingerprint: "AA:BB",
			ObservedFingerprint: "CC:DD",
		})
		if rrCM.Code != http.StatusBadGateway || !strings.Contains(rrCM.Body.String(), "CERT_FINGERPRINT_MISMATCH") {
			t.Fatalf("expected 502 CERT_FINGERPRINT_MISMATCH, got %d %s", rrCM.Code, rrCM.Body.String())
		}

		rrDis := httptest.NewRecorder()
		srv.writePVEError(rrDis, errors.New(`instance "lab" is disabled`))
		if rrDis.Code != http.StatusConflict {
			t.Fatalf("expected 409 for disabled instance, got %d", rrDis.Code)
		}

		rrVal := httptest.NewRecorder()
		srv.writePVEError(rrVal, errors.New("nothing to update"))
		if rrVal.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for local validation error, got %d", rrVal.Code)
		}

		rrDecode := httptest.NewRecorder()
		srv.writePVEError(rrDecode, errors.New("decode PVE envelope (/version): invalid character '<' looking for beginning of value"))
		if rrDecode.Code != http.StatusBadGateway {
			t.Fatalf("expected 502 for upstream invalid JSON envelope, got %d", rrDecode.Code)
		}
	})

	t.Run("context.Canceled writes no response and skips failed audit log", func(t *testing.T) {
		rr := httptest.NewRecorder()
		srv.writePVEError(rr, fmt.Errorf("request aborted: %w", context.Canceled))
		if rr.Body.Len() != 0 {
			t.Fatalf("expected empty body on context.Canceled, got %q", rr.Body.String())
		}

		req := httptest.NewRequest(http.MethodPost, "/api/v1/instances/x/nodes/pve/qemu/100/power/start", nil)
		srv.recordAudit(req, "inst1", "inst1:qemu:pve:100", "qemu.start", "start", "", fmt.Errorf("aborted: %w", context.Canceled))
		logs, err := srv.store.ListAuditLogs(context.Background(), 10)
		if err != nil {
			t.Fatal(err)
		}
		if len(logs) != 0 {
			t.Fatalf("expected 0 audit logs for context.Canceled, got %+v", logs)
		}
	})

	t.Run("handleInstanceCapabilities maps upstream 403 via writePVEError", func(t *testing.T) {
		srvCap, adminCap, routerCap := newTestAPIServer(t)
		seedMockPVEInstance(t, srvCap, "inst-cap403", "", func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"message":"Permission check failed"}`))
		})
		rrCap := doJSONReq(t, routerCap, http.MethodGet, "/api/v1/instances/inst-cap403/capabilities", adminCap.AccessToken, nil, nil)
		if rrCap.Code != http.StatusForbidden || !strings.Contains(rrCap.Body.String(), "PVE_PERMISSION_DENIED") {
			t.Fatalf("expected 403 PVE_PERMISSION_DENIED from handleInstanceCapabilities, got %d %s", rrCap.Code, rrCap.Body.String())
		}
	})
}
