package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base32"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
)

const (
	mfaChallengeTTL      = 5 * time.Minute
	totpPeriodSeconds    = 30
	recoveryCodeCount    = 8
	recoveryCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
	totpIssuerName       = "PVE Dash"
)

type MFAChallengeResponse struct {
	MFARequired              bool     `json:"mfaRequired"`
	MFAToken                 string   `json:"mfaToken"`
	Methods                  []string `json:"methods"`
	WebAuthnAvailableForHost bool     `json:"webauthnAvailableForHost"`
	HasOtherHostPasskeys     bool     `json:"hasOtherHostPasskeys"`
	Username                 string   `json:"username"`
}

type PasskeySummary struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	RPID           string   `json:"rpId"`
	AAGUID         string   `json:"aaguid,omitempty"`
	BackupEligible bool     `json:"backupEligible"`
	BackupState    bool     `json:"backupState"`
	Transports     []string `json:"transports"`
	CreatedAt      string   `json:"createdAt"`
	LastUsedAt     string   `json:"lastUsedAt,omitempty"`
}

type SecurityStatus struct {
	MFAEnabled               bool             `json:"mfaEnabled"`
	TOTPEnabled              bool             `json:"totpEnabled"`
	Passkeys                 []PasskeySummary `json:"passkeys"`
	RecoveryCodesRemaining   int              `json:"recoveryCodesRemaining"`
	UnusedRecoveryCodes      int              `json:"unusedRecoveryCodes"`
	CurrentRPID              string           `json:"currentRpId,omitempty"`
	WebAuthnAvailableForHost bool             `json:"webauthnAvailableForHost"`
	WebAuthnSupportedForHost bool             `json:"webauthnSupportedForHost"`
	HasOtherHostPasskeys     bool             `json:"hasOtherHostPasskeys"`
}

type TOTPSetupResponse struct {
	Secret      string `json:"secret"`
	OTPAuthURL  string `json:"otpauthUrl"`
	QRSVG       string `json:"qrSvg"`
	Issuer      string `json:"issuer"`
	AccountName string `json:"accountName"`
}

type TOTPEnableResponse struct {
	OK            bool     `json:"ok"`
	TOTPEnabled   bool     `json:"totpEnabled"`
	RecoveryCodes []string `json:"recoveryCodes,omitempty"`
}

type PasskeyRegisterBeginResponse struct {
	ChallengeToken string         `json:"challengeToken"`
	Options        map[string]any `json:"options"`
	PublicKey      map[string]any `json:"publicKey,omitempty"`
}

type PasskeyRegisterFinishResponse struct {
	OK            bool           `json:"ok"`
	Credential    PasskeySummary `json:"credential"`
	Passkey       PasskeySummary `json:"passkey"`
	RecoveryCodes []string       `json:"recoveryCodes,omitempty"`
}

type PasskeyLoginBeginResponse struct {
	ChallengeToken string         `json:"challengeToken"`
	Options        map[string]any `json:"options"`
	PublicKey      map[string]any `json:"publicKey,omitempty"`
}

type ceremonyClaims struct {
	Purpose      string `json:"purpose"`
	UserID       string `json:"uid"`
	Username     string `json:"uname,omitempty"`
	TokenVersion int    `json:"tv"`
	Challenge    string `json:"chal,omitempty"`
	RPID         string `json:"rpId,omitempty"`
	Origin       string `json:"origin,omitempty"`
	jwt.RegisteredClaims
}

// IsValidWebAuthnRPID checks whether host is a valid W3C WebAuthn Relying Party ID
// (`localhost` or a domain name, never a raw IPv4/IPv6 address literal).
func IsValidWebAuthnRPID(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return false
	}
	if hostOnly, _, err := net.SplitHostPort(h); err == nil {
		h = hostOnly
	}
	h = strings.Trim(h, "[]")
	if h == "" {
		return false
	}
	if net.ParseIP(h) != nil {
		return false
	}
	return true
}

// ResolveWebAuthnRP derives the effective WebAuthn (rpID, origin) from an incoming HTTP request.
func ResolveWebAuthnRP(rHost, originHeader, publicURL string, isTLS bool) (rpID string, origin string, err error) {
	if rawOrigin := strings.TrimSpace(originHeader); rawOrigin != "" {
		u, pErr := url.Parse(rawOrigin)
		if pErr != nil || u.Scheme == "" || u.Host == "" {
			return "", "", errors.New("invalid Origin header for WebAuthn ceremony")
		}
		hostname := strings.ToLower(u.Hostname())
		if !IsValidWebAuthnRPID(hostname) {
			return "", "", fmt.Errorf("WebAuthn Passkey 不支持裸 IP 地址 (%s)，请使用 localhost 或 HTTPS 域名访问", hostname)
		}
		if u.Scheme != "https" && hostname != "localhost" && !strings.HasSuffix(hostname, ".localhost") {
			return "", "", errors.New("WebAuthn Passkey 要求 HTTPS 安全上下文（仅 localhost 例外）")
		}
		return hostname, u.Scheme + "://" + u.Host, nil
	}

	if pub := strings.TrimSpace(publicURL); pub != "" {
		if u, pErr := url.Parse(pub); pErr == nil && u.Host != "" && IsValidWebAuthnRPID(u.Hostname()) {
			return strings.ToLower(u.Hostname()), u.Scheme + "://" + u.Host, nil
		}
	}

	host := strings.TrimSpace(rHost)
	hostname := host
	if h, _, sErr := net.SplitHostPort(host); sErr == nil {
		hostname = h
	}
	hostname = strings.ToLower(strings.Trim(hostname, "[]"))
	if !IsValidWebAuthnRPID(hostname) {
		return "", "", fmt.Errorf("WebAuthn Passkey 不支持裸 IP 地址 (%s)，请使用 localhost 或 HTTPS 域名访问", hostname)
	}
	scheme := "http"
	if isTLS {
		scheme = "https"
	}
	if scheme != "https" && hostname != "localhost" && !strings.HasSuffix(hostname, ".localhost") {
		return "", "", errors.New("WebAuthn Passkey 要求 HTTPS 安全上下文（仅 localhost 例外）")
	}
	return hostname, scheme + "://" + host, nil
}

func (a *AuthService) totpBox() (*crypto.Box, error) {
	a.userMu.RLock()
	b := a.box
	a.userMu.RUnlock()
	if b != nil {
		return b, nil
	}
	sum := sha256.Sum256(append([]byte("pve-dash-totp-fallback-box:"), a.jwtSecret...))
	return crypto.NewBox(sum[:])
}

const maxTrackedCeremonyNonces = 16384

type ceremonyNonceStore struct {
	mu        sync.Mutex
	used      map[string]time.Time
	lastSweep time.Time
}

var globalCeremonyNonces = &ceremonyNonceStore{
	used: make(map[string]time.Time),
}

func (s *ceremonyNonceStore) makeKey(a *AuthService, kind, nonce string) string {
	return fmt.Sprintf("%p|%s|%s", a, kind, nonce)
}

func (s *ceremonyNonceStore) sweepLocked(now time.Time) {
	for k, exp := range s.used {
		if !now.Before(exp) {
			delete(s.used, k)
		}
	}
	s.lastSweep = now
}

func (a *AuthService) isCeremonyNonceConsumed(kind, nonce string) bool {
	if nonce == "" {
		return true
	}
	now := time.Now()
	key := globalCeremonyNonces.makeKey(a, kind, nonce)
	globalCeremonyNonces.mu.Lock()
	defer globalCeremonyNonces.mu.Unlock()
	exp, ok := globalCeremonyNonces.used[key]
	if !ok {
		return false
	}
	if !now.Before(exp) {
		delete(globalCeremonyNonces.used, key)
		return false
	}
	return true
}

func (a *AuthService) consumeCeremonyNonce(kind, nonce string, expiresAt time.Time) bool {
	if nonce == "" {
		return false
	}
	now := time.Now()
	if expiresAt.IsZero() || !now.Before(expiresAt) {
		expiresAt = now.Add(mfaChallengeTTL + 5*time.Second)
	} else {
		expiresAt = expiresAt.Add(5 * time.Second)
	}
	key := globalCeremonyNonces.makeKey(a, kind, nonce)

	globalCeremonyNonces.mu.Lock()
	defer globalCeremonyNonces.mu.Unlock()

	if len(globalCeremonyNonces.used) >= 512 || (len(globalCeremonyNonces.used) > 0 && now.Sub(globalCeremonyNonces.lastSweep) > time.Minute) {
		globalCeremonyNonces.sweepLocked(now)
	}
	if curExp, ok := globalCeremonyNonces.used[key]; ok && now.Before(curExp) {
		return false
	}
	if len(globalCeremonyNonces.used) >= maxTrackedCeremonyNonces {
		globalCeremonyNonces.sweepLocked(now)
		if len(globalCeremonyNonces.used) >= maxTrackedCeremonyNonces {
			var oldestKey string
			var oldestExp time.Time
			for k, exp := range globalCeremonyNonces.used {
				if oldestKey == "" || exp.Before(oldestExp) {
					oldestKey = k
					oldestExp = exp
				}
			}
			if oldestKey != "" {
				delete(globalCeremonyNonces.used, oldestKey)
			}
		}
	}
	globalCeremonyNonces.used[key] = expiresAt
	return true
}

func ceremonyExpiryTime(c *ceremonyClaims) time.Time {
	if c != nil && c.ExpiresAt != nil {
		return c.ExpiresAt.Time
	}
	return time.Now().Add(mfaChallengeTTL)
}

func (a *AuthService) signCeremonyToken(c ceremonyClaims) (string, error) {
	now := time.Now()
	jti := c.ID
	if jti == "" {
		var nonce [16]byte
		if _, err := rand.Read(nonce[:]); err != nil {
			return "", err
		}
		jti = encodeBase64URL(nonce[:])
	}
	c.RegisteredClaims = jwt.RegisteredClaims{
		ID:        jti,
		Subject:   c.UserID,
		IssuedAt:  jwt.NewNumericDate(now),
		ExpiresAt: jwt.NewNumericDate(now.Add(mfaChallengeTTL)),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, c)
	return tok.SignedString(a.jwtSecret)
}

func (a *AuthService) parseCeremonyToken(ctx context.Context, rawToken, expectedPurpose string) (*ceremonyClaims, *store.User, error) {
	if strings.TrimSpace(rawToken) == "" {
		return nil, nil, ErrUnauthorized
	}
	tok, err := jwt.ParseWithClaims(rawToken, &ceremonyClaims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrUnauthorized
		}
		return a.jwtSecret, nil
	})
	if err != nil || !tok.Valid {
		return nil, nil, ErrUnauthorized
	}
	claims, ok := tok.Claims.(*ceremonyClaims)
	if !ok || claims.Purpose != expectedPurpose || claims.UserID == "" {
		return nil, nil, ErrUnauthorized
	}
	switch expectedPurpose {
	case "mfa_challenge":
		if claims.ID == "" || a.isCeremonyNonceConsumed("mfa", claims.ID) {
			return nil, nil, ErrUnauthorized
		}
	case "webauthn_reg", "webauthn_login":
		if claims.Challenge == "" || a.isCeremonyNonceConsumed("chal", claims.Challenge) {
			return nil, nil, ErrUnauthorized
		}
	}
	u, err := a.GetActiveUser(ctx, claims.UserID)
	if err != nil {
		return nil, nil, ErrUnauthorized
	}
	tv := u.TokenVersion
	if tv < 1 {
		tv = 1
	}
	if claims.TokenVersion != tv {
		return nil, nil, ErrUnauthorized
	}
	return claims, u, nil
}

// IssueMFAToken signs a short-lived 5-minute MFA challenge token (`purpose: "mfa_challenge"`),
// which `ParseAccessToken` explicitly rejects for normal API requests.
func (a *AuthService) IssueMFAToken(u *store.User) (string, error) {
	tv := u.TokenVersion
	if tv < 1 {
		tv = 1
	}
	return a.signCeremonyToken(ceremonyClaims{
		Purpose:      "mfa_challenge",
		UserID:       u.ID,
		Username:     u.Username,
		TokenVersion: tv,
	})
}

func (a *AuthService) ParseMFAToken(ctx context.Context, mfaToken string) (*store.User, error) {
	_, u, err := a.parseCeremonyToken(ctx, mfaToken, "mfa_challenge")
	return u, err
}

func (a *AuthService) HasActiveMFA(ctx context.Context, userID string) (bool, error) {
	mfaState, err := a.store.GetUserMFAState(ctx, userID)
	if err != nil {
		return false, err
	}
	if mfaState.TOTPEnabled {
		return true, nil
	}
	creds, err := a.store.ListWebAuthnCredentials(ctx, userID)
	if err != nil {
		return false, err
	}
	return len(creds) > 0, nil
}

// BuildLoginChallenge inspects whether user `u` has active 2FA; if not, it returns `(nil, nil)`.
// When 2FA is active, it mints a 5-minute `mfaToken` and enumerates available second-factor methods for `requestRPID`.
func (a *AuthService) BuildLoginChallenge(ctx context.Context, u *store.User, requestRPID string) (*MFAChallengeResponse, error) {
	mfaState, err := a.store.GetUserMFAState(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	creds, err := a.store.ListWebAuthnCredentials(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	if !mfaState.TOTPEnabled && len(creds) == 0 {
		return nil, nil
	}

	reqRP := strings.ToLower(strings.TrimSpace(requestRPID))
	matchingPasskeys := 0
	if IsValidWebAuthnRPID(reqRP) {
		for _, c := range creds {
			if strings.EqualFold(c.RPID, reqRP) {
				matchingPasskeys++
			}
		}
	}
	webauthnAvail := matchingPasskeys > 0
	hasOtherPasskeys := len(creds) > matchingPasskeys

	unusedRecovery, _ := a.store.CountUnusedRecoveryCodes(ctx, u.ID)

	methods := make([]string, 0, 3)
	if webauthnAvail {
		methods = append(methods, "webauthn")
	}
	if mfaState.TOTPEnabled {
		methods = append(methods, "totp")
	}
	if unusedRecovery > 0 {
		methods = append(methods, "recovery")
	}

	mfaTok, err := a.IssueMFAToken(u)
	if err != nil {
		return nil, err
	}
	return &MFAChallengeResponse{
		MFARequired:              true,
		MFAToken:                 mfaTok,
		Methods:                  methods,
		WebAuthnAvailableForHost: webauthnAvail,
		HasOtherHostPasskeys:     hasOtherPasskeys,
		Username:                 u.Username,
	}, nil
}

func (a *AuthService) GetSecurityStatus(ctx context.Context, userID, currentRPID string) (*SecurityStatus, error) {
	mfaState, err := a.store.GetUserMFAState(ctx, userID)
	if err != nil {
		return nil, err
	}
	creds, err := a.store.ListWebAuthnCredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	unusedRecovery, err := a.store.CountUnusedRecoveryCodes(ctx, userID)
	if err != nil {
		return nil, err
	}

	summaries := make([]PasskeySummary, 0, len(creds))
	matchingPasskeys := 0
	rp := strings.ToLower(strings.TrimSpace(currentRPID))
	validHost := IsValidWebAuthnRPID(rp)
	for _, c := range creds {
		summaries = append(summaries, toPasskeySummary(c))
		if validHost && strings.EqualFold(c.RPID, rp) {
			matchingPasskeys++
		}
	}
	return &SecurityStatus{
		MFAEnabled:               mfaState.TOTPEnabled || len(creds) > 0,
		TOTPEnabled:              mfaState.TOTPEnabled,
		Passkeys:                 summaries,
		RecoveryCodesRemaining:   unusedRecovery,
		UnusedRecoveryCodes:      unusedRecovery,
		CurrentRPID:              rp,
		WebAuthnAvailableForHost: matchingPasskeys > 0,
		WebAuthnSupportedForHost: validHost,
		HasOtherHostPasskeys:     len(creds) > matchingPasskeys,
	}, nil
}

func toPasskeySummary(c store.WebAuthnCredential) PasskeySummary {
	tr := c.Transports
	if tr == nil {
		tr = []string{}
	}
	return PasskeySummary{
		ID:             c.ID,
		Name:           c.Name,
		RPID:           c.RPID,
		AAGUID:         c.AAGUID,
		BackupEligible: c.BackupEligible,
		BackupState:    c.BackupState,
		Transports:     tr,
		CreatedAt:      c.CreatedAt,
		LastUsedAt:     c.LastUsedAt,
	}
}

func (a *AuthService) verifyCurrentPassword(ctx context.Context, userID, currentPassword string) (*store.User, error) {
	if len(currentPassword) == 0 || len(currentPassword) > maxPasswordLen {
		return nil, ErrInvalidCredentials
	}
	// Bypass cache to read password_hash reliably
	u, err := a.store.GetUserByID(ctx, userID)
	if err != nil || !u.IsActive {
		return nil, ErrUnauthorized
	}
	if !crypto.VerifyPassword(currentPassword, u.PasswordHash) {
		return nil, ErrInvalidCredentials
	}
	return u, nil
}

// --- TOTP (RFC 6238 SHA1, 6 digits, 30s period, +-1 step skew, atomic anti-replay) ---

func computeHOTPCode(secret []byte, counter uint64) string {
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], counter)
	mac := hmac.New(sha1.New, secret)
	mac.Write(buf[:])
	sum := mac.Sum(nil)
	offset := sum[len(sum)-1] & 0x0f
	binCode := (uint32(sum[offset]&0x7f) << 24) |
		(uint32(sum[offset+1]) << 16) |
		(uint32(sum[offset+2]) << 8) |
		uint32(sum[offset+3])
	return fmt.Sprintf("%06d", binCode%1_000_000)
}

// GenerateTOTPCodeAt computes the 6-digit RFC 6238 TOTP code for a Base32 secret at `at`.
func GenerateTOTPCodeAt(base32Secret string, at time.Time) (string, error) {
	cleaned := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(base32Secret), " ", ""))
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.TrimRight(cleaned, "="))
	if err != nil || len(secret) < 10 {
		return "", errors.New("invalid TOTP secret")
	}
	step := uint64(at.Unix() / totpPeriodSeconds)
	return computeHOTPCode(secret, step), nil
}

func matchTOTPCodeAt(base32Secret, rawCode string, now time.Time) (int64, bool) {
	code := strings.TrimSpace(rawCode)
	if len(code) != 6 {
		return 0, false
	}
	for _, ch := range code {
		if ch < '0' || ch > '9' {
			return 0, false
		}
	}
	cleaned := strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(base32Secret), " ", ""))
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(strings.TrimRight(cleaned, "="))
	if err != nil || len(secret) < 10 {
		return 0, false
	}
	curStep := now.Unix() / totpPeriodSeconds
	for _, delta := range []int64{0, -1, 1} {
		step := curStep + delta
		if step <= 0 {
			continue
		}
		candidate := computeHOTPCode(secret, uint64(step))
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

func (a *AuthService) BeginTOTPSetup(ctx context.Context, userID, currentPassword string) (*TOTPSetupResponse, error) {
	u, err := a.verifyCurrentPassword(ctx, userID, currentPassword)
	if err != nil {
		return nil, err
	}
	rawSecret := make([]byte, 20)
	if _, err := rand.Read(rawSecret); err != nil {
		return nil, err
	}
	secretB32 := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(rawSecret)
	label := url.PathEscape(totpIssuerName + ":" + u.Username)
	q := url.Values{
		"secret":    {secretB32},
		"issuer":    {totpIssuerName},
		"algorithm": {"SHA1"},
		"digits":    {"6"},
		"period":    {"30"},
	}
	otpauthURL := fmt.Sprintf("otpauth://totp/%s?%s", label, q.Encode())
	qrSVG, err := GenerateQRSVG(otpauthURL)
	if err != nil {
		return nil, fmt.Errorf("generate QR SVG: %w", err)
	}

	box, err := a.totpBox()
	if err != nil {
		return nil, err
	}
	pendingEnc, err := box.EncryptString(secretB32)
	if err != nil {
		return nil, err
	}
	if err := a.store.SetUserTOTPPending(ctx, u.ID, pendingEnc); err != nil {
		return nil, err
	}
	return &TOTPSetupResponse{
		Secret:      secretB32,
		OTPAuthURL:  otpauthURL,
		QRSVG:       qrSVG,
		Issuer:      totpIssuerName,
		AccountName: u.Username,
	}, nil
}

func (a *AuthService) ConfirmTOTPSetup(ctx context.Context, userID, code string) (*TOTPEnableResponse, error) {
	mfaState, err := a.store.GetUserMFAState(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(mfaState.TOTPPendingEnc) == 0 {
		return nil, errors.New("请先发起动态口令 (TOTP) 绑定流程")
	}
	box, err := a.totpBox()
	if err != nil {
		return nil, err
	}
	secretB32, err := box.DecryptString(mfaState.TOTPPendingEnc)
	if err != nil || secretB32 == "" {
		return nil, errors.New("待确认的 TOTP 密钥无效，请重新生成")
	}

	matchedStep, ok := matchTOTPCodeAt(secretB32, code, time.Now())
	if !ok || matchedStep <= mfaState.TOTPLastStep {
		return nil, ErrInvalidMFACode
	}

	secretEnc, err := box.EncryptString(secretB32)
	if err != nil {
		return nil, err
	}
	if err := a.store.ActivateUserTOTP(ctx, userID, secretEnc, matchedStep); err != nil {
		return nil, err
	}

	codes, err := a.ensureInitialRecoveryCodes(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &TOTPEnableResponse{
		OK:            true,
		TOTPEnabled:   true,
		RecoveryCodes: codes,
	}, nil
}

func (a *AuthService) VerifyTOTPLogin(ctx context.Context, mfaToken, code, ua, ip string) (*TokenPair, error) {
	mfaClaims, u, err := a.parseCeremonyToken(ctx, mfaToken, "mfa_challenge")
	if err != nil {
		return nil, ErrUnauthorized
	}
	mfaState, err := a.store.GetUserMFAState(ctx, u.ID)
	if err != nil || !mfaState.TOTPEnabled || len(mfaState.TOTPSecretEnc) == 0 {
		return nil, ErrInvalidMFACode
	}
	box, err := a.totpBox()
	if err != nil {
		return nil, err
	}
	secretB32, err := box.DecryptString(mfaState.TOTPSecretEnc)
	if err != nil || secretB32 == "" {
		return nil, ErrInvalidMFACode
	}

	matchedStep, ok := matchTOTPCodeAt(secretB32, code, time.Now())
	if !ok {
		return nil, ErrInvalidMFACode
	}
	consumed, err := a.store.ConsumeTOTPStep(ctx, u.ID, matchedStep)
	if err != nil || !consumed {
		return nil, ErrInvalidMFACode
	}
	if !a.consumeCeremonyNonce("mfa", mfaClaims.ID, ceremonyExpiryTime(mfaClaims)) {
		return nil, ErrUnauthorized
	}
	return a.IssueSession(ctx, u, ua, ip)
}

func (a *AuthService) DisableTOTP(ctx context.Context, userID, currentPassword string) error {
	if _, err := a.verifyCurrentPassword(ctx, userID, currentPassword); err != nil {
		return err
	}
	_, err := a.store.DisableUserTOTP(ctx, userID)
	return err
}

// --- WebAuthn Passkeys (Registration, Login & Management) ---

func encodeBase64URL(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func decodeBase64URL(s string) ([]byte, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(s), "=")
	// Accept standard base64 chars if any client library omitted URL-safe replacement
	trimmed = strings.NewReplacer("+", "-", "/", "_").Replace(trimmed)
	return base64.RawURLEncoding.DecodeString(trimmed)
}

func (a *AuthService) BeginPasskeyRegistration(ctx context.Context, userID, currentPassword, keyName, rpID, origin string) (*PasskeyRegisterBeginResponse, error) {
	u, err := a.verifyCurrentPassword(ctx, userID, currentPassword)
	if err != nil {
		return nil, err
	}
	rpID = strings.ToLower(strings.TrimSpace(rpID))
	origin = strings.TrimSpace(origin)
	if !IsValidWebAuthnRPID(rpID) || origin == "" {
		return nil, errors.New("当前访问地址不支持 WebAuthn 通行密钥（请通过 HTTPS 域名或 localhost 访问）")
	}

	chal := make([]byte, 32)
	if _, err := rand.Read(chal); err != nil {
		return nil, err
	}
	chalB64 := encodeBase64URL(chal)

	tv := u.TokenVersion
	if tv < 1 {
		tv = 1
	}
	challengeToken, err := a.signCeremonyToken(ceremonyClaims{
		Purpose:      "webauthn_reg",
		UserID:       u.ID,
		Username:     u.Username,
		TokenVersion: tv,
		Challenge:    chalB64,
		RPID:         rpID,
		Origin:       origin,
	})
	if err != nil {
		return nil, err
	}

	existingCreds, _ := a.store.ListWebAuthnCredentials(ctx, u.ID)
	excludeList := make([]map[string]any, 0, len(existingCreds))
	for _, ec := range existingCreds {
		if strings.EqualFold(ec.RPID, rpID) {
			item := map[string]any{
				"type": "public-key",
				"id":   encodeBase64URL(ec.CredentialID),
			}
			if len(ec.Transports) > 0 {
				item["transports"] = ec.Transports
			}
			excludeList = append(excludeList, item)
		}
	}

	displayName := strings.TrimSpace(u.DisplayName)
	if displayName == "" {
		displayName = u.Username
	}
	publicKey := map[string]any{
		"rp": map[string]any{
			"name": totpIssuerName,
			"id":   rpID,
		},
		"user": map[string]any{
			"id":          encodeBase64URL([]byte(u.ID)),
			"name":        u.Username,
			"displayName": displayName,
		},
		"challenge": chalB64,
		"pubKeyCredParams": []map[string]any{
			{"type": "public-key", "alg": -7},   // ES256 (Touch ID / iCloud / Android / YubiKey)
			{"type": "public-key", "alg": -8},   // EdDSA (Ed25519)
			{"type": "public-key", "alg": -257}, // RS256 (Windows Hello / TPM)
		},
		"timeout":     60000,
		"attestation": "none",
		"authenticatorSelection": map[string]any{
			"residentKey":      "preferred",
			"userVerification": "preferred",
		},
		"excludeCredentials": excludeList,
	}

	return &PasskeyRegisterBeginResponse{
		ChallengeToken: challengeToken,
		Options:        publicKey,
		PublicKey:      publicKey,
	}, nil
}

type webAuthnRegPayload struct {
	ID       string `json:"id"`
	RawID    string `json:"rawId"`
	Type     string `json:"type"`
	Response struct {
		ClientDataJSON    string   `json:"clientDataJSON"`
		AttestationObject string   `json:"attestationObject"`
		Transports        []string `json:"transports"`
	} `json:"response"`
}

type webAuthnClientData struct {
	Type      string `json:"type"`
	Challenge string `json:"challenge"`
	Origin    string `json:"origin"`
}

func verifyClientDataJSON(rawClientData []byte, expectedType, expectedChallenge, expectedOrigin string) error {
	var cd webAuthnClientData
	if err := json.Unmarshal(rawClientData, &cd); err != nil {
		return errors.New("invalid WebAuthn clientDataJSON")
	}
	if cd.Type != expectedType {
		return fmt.Errorf("unexpected WebAuthn ceremony type %q", cd.Type)
	}
	// Normalize base64url challenge comparison without padding
	gotChal, err := decodeBase64URL(cd.Challenge)
	if err != nil {
		return errors.New("invalid clientDataJSON challenge encoding")
	}
	wantChal, err := decodeBase64URL(expectedChallenge)
	if err != nil || subtle.ConstantTimeCompare(gotChal, wantChal) != 1 {
		return errors.New("WebAuthn challenge mismatch")
	}
	if !strings.EqualFold(strings.TrimRight(cd.Origin, "/"), strings.TrimRight(expectedOrigin, "/")) {
		return fmt.Errorf("WebAuthn origin mismatch: got %q, expected %q", cd.Origin, expectedOrigin)
	}
	return nil
}

func (a *AuthService) FinishPasskeyRegistration(ctx context.Context, userID, challengeToken, keyName, rpID, origin string, rawBody []byte) (*PasskeyRegisterFinishResponse, error) {
	claims, u, err := a.parseCeremonyToken(ctx, challengeToken, "webauthn_reg")
	if err != nil || u.ID != userID {
		return nil, ErrUnauthorized
	}
	// Single-use WebAuthn registration challenge consumption (W3C WebAuthn §7.1)
	if !a.consumeCeremonyNonce("chal", claims.Challenge, ceremonyExpiryTime(claims)) {
		return nil, ErrUnauthorized
	}
	rpID = strings.ToLower(strings.TrimSpace(rpID))
	origin = strings.TrimSpace(origin)
	if !strings.EqualFold(claims.RPID, rpID) || !strings.EqualFold(strings.TrimRight(claims.Origin, "/"), strings.TrimRight(origin, "/")) {
		return nil, errors.New("WebAuthn RP/Origin does not match active ceremony")
	}

	var payload webAuthnRegPayload
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, errors.New("invalid WebAuthn registration credential JSON")
	}
	if payload.Response.ClientDataJSON == "" && payload.Response.AttestationObject == "" {
		var env struct {
			Credential webAuthnRegPayload `json:"credential"`
		}
		if json.Unmarshal(rawBody, &env) == nil && env.Credential.Response.ClientDataJSON != "" {
			payload = env.Credential
		}
	}
	if payload.Type != "" && payload.Type != "public-key" {
		return nil, errors.New("unsupported WebAuthn credential type")
	}

	clientDataBytes, err := decodeBase64URL(payload.Response.ClientDataJSON)
	if err != nil {
		return nil, errors.New("invalid clientDataJSON base64url")
	}
	if err := verifyClientDataJSON(clientDataBytes, "webauthn.create", claims.Challenge, claims.Origin); err != nil {
		return nil, err
	}

	attBytes, err := decodeBase64URL(payload.Response.AttestationObject)
	if err != nil {
		return nil, errors.New("invalid attestationObject base64url")
	}
	parsed, err := parseWebAuthnAttestationObject(attBytes)
	if err != nil {
		return nil, err
	}
	wantRPHash := sha256.Sum256([]byte(rpID))
	if subtle.ConstantTimeCompare(parsed.RPIDHash[:], wantRPHash[:]) != 1 {
		return nil, errors.New("WebAuthn rpIdHash mismatch")
	}
	if !parsed.UserPresent {
		return nil, errors.New("WebAuthn User Present (UP) flag was not set")
	}
	if strings.TrimSpace(payload.RawID) != "" {
		rawIDBytes, decErr := decodeBase64URL(payload.RawID)
		if decErr != nil {
			return nil, errors.New("invalid credential rawId base64url encoding")
		}
		if !bytes.Equal(rawIDBytes, parsed.CredentialID) {
			return nil, errors.New("credential rawId does not match attested credentialId")
		}
	}
	if strings.TrimSpace(payload.ID) != "" {
		idBytes, decErr := decodeBase64URL(payload.ID)
		if decErr != nil {
			return nil, errors.New("invalid credential id base64url encoding")
		}
		if !bytes.Equal(idBytes, parsed.CredentialID) {
			return nil, errors.New("credential id does not match attested credentialId")
		}
	}

	name := strings.TrimSpace(keyName)
	if name == "" {
		name = "Passkey (" + time.Now().Format("2006-01-02") + ")"
	}
	if len(name) > 64 {
		name = name[:64]
	}

	var transports []string
	seenTr := map[string]bool{}
	for _, tr := range payload.Response.Transports {
		t := strings.ToLower(strings.TrimSpace(tr))
		if t != "" && len(t) <= 24 && !seenTr[t] {
			seenTr[t] = true
			transports = append(transports, t)
		}
	}

	cred := &store.WebAuthnCredential{
		UserID:          u.ID,
		Name:            name,
		RPID:            rpID,
		CredentialID:    parsed.CredentialID,
		PublicKeyCBOR:   parsed.PublicKeyCBOR,
		AttestationType: parsed.AttestationType,
		AAGUID:          parsed.AAGUID,
		SignCount:       parsed.SignCount,
		BackupEligible:  parsed.BackupEligible,
		BackupState:     parsed.BackupState,
		Transports:      transports,
	}
	if err := a.store.CreateWebAuthnCredential(ctx, cred); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return nil, errors.New("此通行密钥已注册")
		}
		return nil, err
	}

	codes, err := a.ensureInitialRecoveryCodes(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	summary := toPasskeySummary(*cred)
	return &PasskeyRegisterFinishResponse{
		OK:            true,
		Credential:    summary,
		Passkey:       summary,
		RecoveryCodes: codes,
	}, nil
}

func (a *AuthService) DeletePasskey(ctx context.Context, userID, credID, currentPassword string) error {
	if _, err := a.verifyCurrentPassword(ctx, userID, currentPassword); err != nil {
		return err
	}
	_, err := a.store.DeleteWebAuthnCredential(ctx, userID, credID)
	return err
}

func (a *AuthService) BeginPasskeyLogin(ctx context.Context, mfaToken, rpID, origin string) (*PasskeyLoginBeginResponse, error) {
	u, err := a.ParseMFAToken(ctx, mfaToken)
	if err != nil {
		return nil, ErrUnauthorized
	}
	rpID = strings.ToLower(strings.TrimSpace(rpID))
	origin = strings.TrimSpace(origin)
	if !IsValidWebAuthnRPID(rpID) || origin == "" {
		return nil, errors.New("当前访问域名不支持 WebAuthn 通行密钥验证")
	}

	creds, err := a.store.ListWebAuthnCredentials(ctx, u.ID)
	if err != nil {
		return nil, err
	}
	allowList := make([]map[string]any, 0, len(creds))
	for _, c := range creds {
		if strings.EqualFold(c.RPID, rpID) {
			item := map[string]any{
				"type": "public-key",
				"id":   encodeBase64URL(c.CredentialID),
			}
			if len(c.Transports) > 0 {
				item["transports"] = c.Transports
			}
			allowList = append(allowList, item)
		}
	}
	if len(allowList) == 0 {
		return nil, errors.New("当前域名下未绑定可用的通行密钥，请改用动态口令或恢复码登录")
	}

	chal := make([]byte, 32)
	if _, err := rand.Read(chal); err != nil {
		return nil, err
	}
	chalB64 := encodeBase64URL(chal)

	tv := u.TokenVersion
	if tv < 1 {
		tv = 1
	}
	challengeToken, err := a.signCeremonyToken(ceremonyClaims{
		Purpose:      "webauthn_login",
		UserID:       u.ID,
		Username:     u.Username,
		TokenVersion: tv,
		Challenge:    chalB64,
		RPID:         rpID,
		Origin:       origin,
	})
	if err != nil {
		return nil, err
	}

	publicKey := map[string]any{
		"challenge":        chalB64,
		"rpId":             rpID,
		"timeout":          60000,
		"userVerification": "preferred",
		"allowCredentials": allowList,
	}
	return &PasskeyLoginBeginResponse{
		ChallengeToken: challengeToken,
		Options:        publicKey,
		PublicKey:      publicKey,
	}, nil
}

type webAuthnAssertionPayload struct {
	ID       string `json:"id"`
	RawID    string `json:"rawId"`
	Type     string `json:"type"`
	Response struct {
		ClientDataJSON    string `json:"clientDataJSON"`
		AuthenticatorData string `json:"authenticatorData"`
		Signature         string `json:"signature"`
		UserHandle        string `json:"userHandle,omitempty"`
	} `json:"response"`
}

func (a *AuthService) FinishPasskeyLogin(ctx context.Context, mfaToken, challengeToken, rpID, origin string, rawBody []byte, ua, ip string) (*TokenPair, error) {
	mfaClaims, mfaUser, err := a.parseCeremonyToken(ctx, mfaToken, "mfa_challenge")
	if err != nil {
		return nil, ErrUnauthorized
	}
	claims, chalUser, err := a.parseCeremonyToken(ctx, challengeToken, "webauthn_login")
	if err != nil || chalUser.ID != mfaUser.ID {
		return nil, ErrUnauthorized
	}
	// Single-use WebAuthn assertion challenge consumption (W3C WebAuthn §7.2); prevents 5m synced-passkey signCount=0 replay
	if !a.consumeCeremonyNonce("chal", claims.Challenge, ceremonyExpiryTime(claims)) {
		return nil, ErrUnauthorized
	}
	rpID = strings.ToLower(strings.TrimSpace(rpID))
	origin = strings.TrimSpace(origin)
	if !strings.EqualFold(claims.RPID, rpID) || !strings.EqualFold(strings.TrimRight(claims.Origin, "/"), strings.TrimRight(origin, "/")) {
		return nil, fmt.Errorf("%w: WebAuthn RP/Origin mismatch", ErrInvalidMFACode)
	}

	var payload webAuthnAssertionPayload
	if err := json.Unmarshal(rawBody, &payload); err != nil {
		return nil, fmt.Errorf("%w: invalid WebAuthn assertion JSON", ErrInvalidMFACode)
	}
	if payload.Response.ClientDataJSON == "" && payload.Response.Signature == "" {
		var env struct {
			Credential webAuthnAssertionPayload `json:"credential"`
		}
		if json.Unmarshal(rawBody, &env) == nil && env.Credential.Response.ClientDataJSON != "" {
			payload = env.Credential
		}
	}
	if uh := strings.TrimSpace(payload.Response.UserHandle); uh != "" {
		uhBytes, uhErr := decodeBase64URL(uh)
		if uhErr != nil || subtle.ConstantTimeCompare(uhBytes, []byte(mfaUser.ID)) != 1 {
			return nil, fmt.Errorf("%w: WebAuthn userHandle mismatch", ErrInvalidMFACode)
		}
	}
	rawIDStr := payload.RawID
	if rawIDStr == "" {
		rawIDStr = payload.ID
	}
	credIDBytes, err := decodeBase64URL(rawIDStr)
	if err != nil || len(credIDBytes) == 0 {
		return nil, fmt.Errorf("%w: invalid WebAuthn credential ID", ErrInvalidMFACode)
	}

	creds, err := a.store.ListWebAuthnCredentials(ctx, mfaUser.ID)
	if err != nil {
		return nil, err
	}
	var matched *store.WebAuthnCredential
	for i := range creds {
		if strings.EqualFold(creds[i].RPID, rpID) && bytes.Equal(creds[i].CredentialID, credIDBytes) {
			matched = &creds[i]
			break
		}
	}
	if matched == nil {
		return nil, ErrInvalidMFACode
	}

	clientDataBytes, err := decodeBase64URL(payload.Response.ClientDataJSON)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid clientDataJSON", ErrInvalidMFACode)
	}
	if err := verifyClientDataJSON(clientDataBytes, "webauthn.get", claims.Challenge, claims.Origin); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidMFACode, err)
	}

	authData, err := decodeBase64URL(payload.Response.AuthenticatorData)
	if err != nil || len(authData) < 37 {
		return nil, fmt.Errorf("%w: invalid authenticatorData", ErrInvalidMFACode)
	}
	wantRPHash := sha256.Sum256([]byte(rpID))
	if subtle.ConstantTimeCompare(authData[0:32], wantRPHash[:]) != 1 {
		return nil, fmt.Errorf("%w: WebAuthn rpIdHash mismatch", ErrInvalidMFACode)
	}
	flags := authData[32]
	if (flags & 0x01) == 0 {
		return nil, fmt.Errorf("%w: WebAuthn User Present (UP) flag was not set", ErrInvalidMFACode)
	}
	be := (flags & 0x08) != 0
	bs := (flags & 0x10) != 0
	if !be && bs {
		return nil, fmt.Errorf("%w: invalid authenticator backup flags", ErrInvalidMFACode)
	}

	newSignCount := binary.BigEndian.Uint32(authData[33:37])
	// Synced passkeys (macOS Touch ID / iCloud Keychain, Bitwarden Passkey) report signCount == 0;
	// only enforce monotonic progression when both stored and reported counters are non-zero.
	if matched.SignCount > 0 && newSignCount > 0 && newSignCount <= matched.SignCount {
		return nil, fmt.Errorf("%w: 通行密钥签名计数器异常（疑似克隆设备）", ErrInvalidMFACode)
	}

	sigBytes, err := decodeBase64URL(payload.Response.Signature)
	if err != nil || len(sigBytes) == 0 {
		return nil, fmt.Errorf("%w: invalid WebAuthn signature encoding", ErrInvalidMFACode)
	}
	if err := verifyWebAuthnAssertionSignature(matched.PublicKeyCBOR, authData, clientDataBytes, sigBytes); err != nil {
		return nil, ErrInvalidMFACode
	}

	if !a.consumeCeremonyNonce("mfa", mfaClaims.ID, ceremonyExpiryTime(mfaClaims)) {
		return nil, ErrUnauthorized
	}

	updatedCount := matched.SignCount
	if newSignCount > updatedCount {
		updatedCount = newSignCount
	}
	_ = a.store.UpdateWebAuthnCredentialUsage(ctx, matched.ID, updatedCount, bs)
	return a.IssueSession(ctx, mfaUser, ua, ip)
}

// --- Recovery Codes & Admin MFA Reset ---

func normalizeRecoveryCode(raw string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(strings.TrimSpace(raw)) {
		if r == '-' || r == ' ' {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func (a *AuthService) hashRecoveryCode(userID, rawCode string) string {
	norm := normalizeRecoveryCode(rawCode)
	mac := hmac.New(sha256.New, a.jwtSecret)
	mac.Write([]byte("recovery:" + userID + ":" + norm))
	return hex.EncodeToString(mac.Sum(nil))
}

func (a *AuthService) generateAndStoreRecoveryCodes(ctx context.Context, userID string) ([]string, error) {
	plain := make([]string, recoveryCodeCount)
	hashes := make([]string, recoveryCodeCount)
	var rnd [8]byte

	for i := 0; i < recoveryCodeCount; i++ {
		if _, err := rand.Read(rnd[:]); err != nil {
			return nil, err
		}
		var chars [8]byte
		for j := 0; j < 8; j++ {
			chars[j] = recoveryCodeAlphabet[int(rnd[j])%len(recoveryCodeAlphabet)]
		}
		formatted := string(chars[:4]) + "-" + string(chars[4:])
		plain[i] = formatted
		hashes[i] = a.hashRecoveryCode(userID, formatted)
	}

	if err := a.store.ReplaceUserRecoveryCodes(ctx, userID, hashes); err != nil {
		return nil, err
	}
	return plain, nil
}

func (a *AuthService) ensureInitialRecoveryCodes(ctx context.Context, userID string) ([]string, error) {
	unused, err := a.store.CountUnusedRecoveryCodes(ctx, userID)
	if err != nil {
		return nil, err
	}
	if unused > 0 {
		return nil, nil
	}
	return a.generateAndStoreRecoveryCodes(ctx, userID)
}

func (a *AuthService) VerifyRecoveryCodeLogin(ctx context.Context, mfaToken, code, ua, ip string) (*TokenPair, error) {
	mfaClaims, u, err := a.parseCeremonyToken(ctx, mfaToken, "mfa_challenge")
	if err != nil {
		return nil, ErrUnauthorized
	}
	norm := normalizeRecoveryCode(code)
	if len(norm) != 8 {
		return nil, ErrInvalidMFACode
	}
	ok, err := a.store.ConsumeUserRecoveryCode(ctx, u.ID, a.hashRecoveryCode(u.ID, norm))
	if err != nil || !ok {
		return nil, ErrInvalidMFACode
	}
	if !a.consumeCeremonyNonce("mfa", mfaClaims.ID, ceremonyExpiryTime(mfaClaims)) {
		return nil, ErrUnauthorized
	}
	return a.IssueSession(ctx, u, ua, ip)
}

func (a *AuthService) RegenerateRecoveryCodes(ctx context.Context, userID, currentPassword string) ([]string, error) {
	if _, err := a.verifyCurrentPassword(ctx, userID, currentPassword); err != nil {
		return nil, err
	}
	hasMFA, err := a.HasActiveMFA(ctx, userID)
	if err != nil {
		return nil, err
	}
	if !hasMFA {
		return nil, errors.New("请先启用动态口令 (TOTP) 或绑定通行密钥 (Passkey) 后再生成恢复码")
	}
	return a.generateAndStoreRecoveryCodes(ctx, userID)
}

// ResetUserMFA allows an admin to clear all 2FA factors (TOTP, Passkeys, Recovery Codes) on targetUserID,
// bumping token_version and revoking active sessions immediately.
func (a *AuthService) ResetUserMFA(ctx context.Context, targetUserID string) error {
	if strings.TrimSpace(targetUserID) == "" {
		return store.ErrNotFound
	}
	err := a.store.ClearAllUserMFA(ctx, targetUserID, true)
	a.InvalidateUser(targetUserID)
	return err
}
