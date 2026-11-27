package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/jianxcao/pve-dash/internal/version"
)

func (s *Server) handleSystemInfo(w http.ResponseWriter, _ *http.Request) {
	info := version.Info()
	writeJSON(w, http.StatusOK, map[string]any{
		"version":   info.Version,
		"commit":    info.Commit,
		"buildTime": info.BuildTime,
		"goVersion": info.GoVersion,
		"readOnly":  s.cfg != nil && s.cfg.ReadOnly,
	})
}

func (s *Server) requireNotReadOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.cfg != nil && s.cfg.ReadOnly {
			writeErr(w, http.StatusForbidden, "server is running in read-only protection mode (PVE_DASH_READ_ONLY=true)")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) isRequestTLS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	if s.cfg != nil && s.cfg.TrustProxy {
		xfp := strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])
		if strings.EqualFold(xfp, "https") {
			return true
		}
		if strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Ssl")), "on") {
			return true
		}
	}
	return false
}

func (s *Server) resolveWebAuthnCeremonyRP(r *http.Request) (string, string, error) {
	originHdr := strings.TrimSpace(r.Header.Get("Origin"))
	if originHdr != "" && !s.isAllowedCookieOrigin(r, originHdr) {
		return "", "", errors.New("untrusted Origin header for WebAuthn ceremony")
	}
	pubURL := ""
	if s.cfg != nil {
		pubURL = s.cfg.PublicURL
	}
	return service.ResolveWebAuthnRP(r.Host, originHdr, pubURL, s.isRequestTLS(r))
}

func (s *Server) resolveSecurityStatusRPID(r *http.Request) string {
	originHdr := strings.TrimSpace(r.Header.Get("Origin"))
	if originHdr != "" {
		if !s.isAllowedCookieOrigin(r, originHdr) {
			originHdr = ""
		}
	} else if referer := strings.TrimSpace(r.Header.Get("Referer")); referer != "" && s.isAllowedCookieOrigin(r, referer) {
		if u, err := url.Parse(referer); err == nil && u.Scheme != "" && u.Host != "" {
			originHdr = u.Scheme + "://" + u.Host
		}
	}
	pubURL := ""
	if s.cfg != nil {
		pubURL = s.cfg.PublicURL
	}
	rpID, _, _ := service.ResolveWebAuthnRP(r.Host, originHdr, pubURL, s.isRequestTLS(r))
	return rpID
}

func writeMFATokenExpired(w http.ResponseWriter) {
	writeJSON(w, http.StatusUnauthorized, map[string]any{
		"error": "二次验证会话已过期，请重新输入账号密码",
		"code":  "MFA_TOKEN_EXPIRED",
	})
}

func writeInvalidMFACode(w http.ResponseWriter, msg string) {
	writeJSON(w, http.StatusBadRequest, map[string]any{
		"error": msg,
		"code":  "INVALID_MFA_CODE",
	})
}

func (s *Server) recordMFALoginAnomaly(r *http.Request, mfaToken, reason string) {
	if s.events == nil {
		return
	}
	username := ""
	if u, err := s.auth.ParseMFAToken(r.Context(), mfaToken); err == nil && u != nil {
		username = u.Username
	}
	s.events.RecordLoginAnomaly(username, clientIP(r), reason)
}

// --- Public 2-Step Login Verification Endpoints ---

func (s *Server) handleMFATOTPVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MFAToken string `json:"mfaToken"`
		Code     string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	ip := clientIP(r)
	pair, err := s.auth.VerifyTOTPLogin(r.Context(), body.MFAToken, body.Code, r.UserAgent(), ip)
	if err != nil {
		s.recordMFALoginAnomaly(r, body.MFAToken, "二步验证动态口令 (TOTP) 校验失败")
		if errors.Is(err, service.ErrInvalidMFACode) {
			writeInvalidMFACode(w, "动态口令无效或已被使用，请等待下一个 30 秒周期重试")
			return
		}
		if errors.Is(err, service.ErrUnauthorized) {
			writeMFATokenExpired(w)
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.setAuthCookies(w, pair)
	if s.events != nil && pair.User != nil {
		s.events.RecordLoginSuccess(pair.User.Username, pair.User.ID, pair.User.Role, ip, r.UserAgent())
	}
	writeJSON(w, http.StatusOK, pair)
}

func (s *Server) handleMFARecoveryVerify(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MFAToken     string `json:"mfaToken"`
		RecoveryCode string `json:"recoveryCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	ip := clientIP(r)
	pair, err := s.auth.VerifyRecoveryCodeLogin(r.Context(), body.MFAToken, body.RecoveryCode, r.UserAgent(), ip)
	if err != nil {
		s.recordMFALoginAnomaly(r, body.MFAToken, "二步验证应急恢复码校验失败")
		if errors.Is(err, service.ErrInvalidMFACode) {
			writeInvalidMFACode(w, "恢复码无效或已被使用")
			return
		}
		if errors.Is(err, service.ErrUnauthorized) {
			writeMFATokenExpired(w)
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.setAuthCookies(w, pair)
	if s.events != nil && pair.User != nil {
		s.events.RecordLoginSuccess(pair.User.Username, pair.User.ID, pair.User.Role, ip, r.UserAgent())
	}
	writeJSON(w, http.StatusOK, pair)
}

func (s *Server) handleMFAWebAuthnBegin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		MFAToken string `json:"mfaToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	rpID, origin, err := s.resolveWebAuthnCeremonyRP(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.auth.BeginPasskeyLogin(r.Context(), body.MFAToken, rpID, origin)
	if err != nil {
		if errors.Is(err, service.ErrUnauthorized) {
			writeMFATokenExpired(w)
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleMFAWebAuthnFinish(w http.ResponseWriter, r *http.Request) {
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	var body struct {
		MFAToken       string          `json:"mfaToken"`
		ChallengeToken string          `json:"challengeToken"`
		Credential     json.RawMessage `json:"credential"`
	}
	if err := json.Unmarshal(rawBody, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	rpID, origin, err := s.resolveWebAuthnCeremonyRP(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	credRaw := rawBody
	if len(bytes.TrimSpace(body.Credential)) > 0 {
		credRaw = body.Credential
	}
	ip := clientIP(r)
	pair, err := s.auth.FinishPasskeyLogin(r.Context(), body.MFAToken, body.ChallengeToken, rpID, origin, credRaw, r.UserAgent(), ip)
	if err != nil {
		s.recordMFALoginAnomaly(r, body.MFAToken, "通行密钥 (Passkey) 签名断言校验失败")
		if errors.Is(err, service.ErrInvalidMFACode) {
			writeInvalidMFACode(w, "通行密钥签名验证失败或不属于当前账号")
			return
		}
		if errors.Is(err, service.ErrUnauthorized) {
			writeMFATokenExpired(w)
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.setAuthCookies(w, pair)
	if s.events != nil && pair.User != nil {
		s.events.RecordLoginSuccess(pair.User.Username, pair.User.ID, pair.User.Role, ip, r.UserAgent())
	}
	writeJSON(w, http.StatusOK, pair)
}

// --- Authenticated Self-Service 2FA Security Endpoints ---

func (s *Server) handleGetSecurityStatus(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	rpID := s.resolveSecurityStatusRPID(r)
	status, err := s.auth.GetSecurityStatus(r.Context(), claims.UserID, rpID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, status)
}

func (s *Server) handleSetupTOTP(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	res, err := s.auth.BeginTOTPSetup(r.Context(), claims.UserID, body.CurrentPassword)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			writeErr(w, http.StatusBadRequest, "当前密码不正确")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleEnableTOTP(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	res, err := s.auth.ConfirmTOTPSetup(r.Context(), claims.UserID, body.Code)
	if err != nil {
		if errors.Is(err, service.ErrInvalidMFACode) {
			writeErr(w, http.StatusBadRequest, "6 位动态验证码不正确或已过期，请核对手机系统时间后重试")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.recordAudit(r, "", "user:"+claims.Username, "auth.mfa.totp.enable", claims.Username, "", nil)
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleDisableTOTP(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := s.auth.DisableTOTP(r.Context(), claims.UserID, body.CurrentPassword); err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			writeErr(w, http.StatusBadRequest, "当前密码不正确")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.recordAudit(r, "", "user:"+claims.Username, "auth.mfa.totp.disable", claims.Username, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleBeginPasskeyRegister(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		Name            string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	rpID, origin, err := s.resolveWebAuthnCeremonyRP(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	res, err := s.auth.BeginPasskeyRegistration(r.Context(), claims.UserID, body.CurrentPassword, body.Name, rpID, origin)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			writeErr(w, http.StatusBadRequest, "当前密码不正确")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleFinishPasskeyRegister(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	rawBody, err := io.ReadAll(r.Body)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "failed to read request body")
		return
	}
	var body struct {
		ChallengeToken string          `json:"challengeToken"`
		Name           string          `json:"name"`
		Credential     json.RawMessage `json:"credential"`
	}
	if err := json.Unmarshal(rawBody, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	rpID, origin, err := s.resolveWebAuthnCeremonyRP(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	credRaw := rawBody
	if len(bytes.TrimSpace(body.Credential)) > 0 {
		credRaw = body.Credential
	}
	res, err := s.auth.FinishPasskeyRegistration(r.Context(), claims.UserID, body.ChallengeToken, body.Name, rpID, origin, credRaw)
	if err != nil {
		// Map expired/invalid/replayed ceremony challengeToken to 400 (never 401 on authenticated endpoints)
		if errors.Is(err, service.ErrUnauthorized) {
			writeErr(w, http.StatusBadRequest, "通行密钥注册挑战已过期或已使用，请重新点击添加通行密钥")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.recordAudit(r, "", "user:"+claims.Username, "auth.mfa.passkey.register", res.Credential.Name+" (rpId="+res.Credential.RPID+")", "", nil)
	writeJSON(w, http.StatusCreated, res)
}

func (s *Server) handleDeletePasskey(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	credID := strings.TrimSpace(urlParamDecoded(r, "credentialId"))
	if credID == "" {
		writeErr(w, http.StatusBadRequest, "missing credentialId")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if err := s.auth.DeletePasskey(r.Context(), claims.UserID, credID, body.CurrentPassword); err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			writeErr(w, http.StatusBadRequest, "当前密码不正确")
			return
		}
		if errors.Is(err, store.ErrNotFound) {
			writeErr(w, http.StatusNotFound, "通行密钥不存在")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.recordAudit(r, "", "user:"+claims.Username, "auth.mfa.passkey.delete", credID, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleRegenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	claims := getClaims(r)
	if claims == nil {
		writeErr(w, http.StatusUnauthorized, "authentication required")
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	codes, err := s.auth.RegenerateRecoveryCodes(r.Context(), claims.UserID, body.CurrentPassword)
	if err != nil {
		if errors.Is(err, service.ErrInvalidCredentials) {
			writeErr(w, http.StatusBadRequest, "当前密码不正确")
			return
		}
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.recordAudit(r, "", "user:"+claims.Username, "auth.mfa.recovery.regenerate", claims.Username, "", nil)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":            true,
		"recoveryCodes": codes,
	})
}
