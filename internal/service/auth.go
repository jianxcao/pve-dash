package service

import (
	"context"
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/oklog/ulid/v2"
)

var (
	ErrAlreadyInitialized = errors.New("system is already initialized")
	ErrInvalidCredentials = errors.New("invalid username or password")
	ErrUnauthorized       = errors.New("unauthorized")
	ErrMFARequired        = errors.New("mfa verification required")
	ErrInvalidMFACode     = errors.New("invalid or expired verification code")
)

const (
	minPasswordLen   = 8
	maxPasswordLen   = 128
	authUserCacheTTL = 2 * time.Second
)

// Precomputed Argon2id hash evaluated on unknown/inactive usernames to prevent timing enumeration.
var dummyArgonHash string

func init() {
	h, err := crypto.HashPassword("pve-dash-dummy-timing-guard")
	if err == nil {
		dummyArgonHash = h
	}
}

type Claims struct {
	Purpose      string `json:"purpose,omitempty"`
	UserID       string `json:"uid"`
	Username     string `json:"uname"`
	Role         string `json:"role"`
	TokenVersion int    `json:"tv,omitempty"`
	jwt.RegisteredClaims
}

type authCachedUser struct {
	user      store.User
	expiresAt time.Time
}

type AuthService struct {
	store     *store.Store
	jwtSecret []byte
	box       *crypto.Box
	setupMu   sync.Mutex

	userMu    sync.RWMutex
	userCache map[string]authCachedUser
}

func NewAuthService(st *store.Store, jwtSecret []byte) *AuthService {
	a := &AuthService{
		store:     st,
		jwtSecret: jwtSecret,
		userCache: make(map[string]authCachedUser),
	}
	if st != nil {
		st.OnUserMutated(func(userID string) {
			if userID == "" {
				a.InvalidateAllUsers()
			} else {
				a.InvalidateUser(userID)
			}
		})
	}
	return a
}

// SetCryptoBox attaches the master AES-256-GCM box used to encrypt TOTP secrets at rest.
func (a *AuthService) SetCryptoBox(box *crypto.Box) {
	a.userMu.Lock()
	a.box = box
	a.userMu.Unlock()
}

// InvalidateUser evicts userID from the short-lived active user cache.
func (a *AuthService) InvalidateUser(userID string) {
	if userID == "" {
		return
	}
	a.userMu.Lock()
	delete(a.userCache, userID)
	a.userMu.Unlock()
	if a.store != nil {
		a.store.InvalidateUserCache(userID)
	}
}

// InvalidateAllUsers flushes all entries from the short-lived active user cache.
func (a *AuthService) InvalidateAllUsers() {
	a.userMu.Lock()
	clear(a.userCache)
	a.userMu.Unlock()
	if a.store != nil {
		a.store.InvalidateAllUserCache()
	}
}

func (a *AuthService) IsInitialized(ctx context.Context) (bool, error) {
	n, err := a.store.CountUsers(ctx)
	return n > 0, err
}

func (a *AuthService) SetupAdminAndLogin(ctx context.Context, username, displayName, password, deviceName, clientIP string) (*TokenPair, error) {
	a.setupMu.Lock()
	defer a.setupMu.Unlock()

	username = strings.TrimSpace(username)
	if len(username) < 2 || len(username) > 64 {
		return nil, errors.New("username must be between 2 and 64 chars")
	}
	if len(password) < minPasswordLen || len(password) > maxPasswordLen {
		return nil, errors.New("password must be between 8 and 128 chars")
	}
	init, err := a.IsInitialized(ctx)
	if err != nil {
		return nil, err
	}
	if init {
		return nil, ErrAlreadyInitialized
	}
	if displayName == "" {
		displayName = username
	}
	hash, err := crypto.HashPassword(password)
	if err != nil {
		return nil, err
	}
	u := &store.User{
		ID:           ulid.Make().String(),
		Username:     username,
		DisplayName:  displayName,
		PasswordHash: hash,
		Role:         "admin",
		IsActive:     true,
	}
	if err := a.store.CreateFirstAdmin(ctx, u); err != nil {
		if errors.Is(err, store.ErrAlreadyInitialized) {
			return nil, ErrAlreadyInitialized
		}
		return nil, err
	}
	return a.issueTokens(ctx, u, deviceName, clientIP)
}

func (a *AuthService) SetupAdmin(ctx context.Context, username, displayName, password string) (*store.User, error) {
	pair, err := a.SetupAdminAndLogin(ctx, username, displayName, password, "", "")
	if err != nil {
		return nil, err
	}
	return pair.User, nil
}

type TokenPair struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"-"`
	ExpiresIn    int         `json:"expiresIn"`
	User         *store.User `json:"user"`
}

// AuthenticatePrimary validates primary username + password credentials in constant-ish time
// without issuing a session yet so callers can check 2FA requirements via BuildLoginChallenge.
func (a *AuthService) AuthenticatePrimary(ctx context.Context, username, password string) (*store.User, error) {
	if len(password) < minPasswordLen || len(password) > maxPasswordLen {
		return nil, ErrInvalidCredentials
	}
	u, err := a.store.GetUserByUsername(ctx, strings.TrimSpace(username))
	if err != nil {
		if len(password) <= maxPasswordLen && dummyArgonHash != "" {
			_ = crypto.VerifyPassword(password, dummyArgonHash)
		}
		return nil, ErrInvalidCredentials
	}
	if !u.IsActive {
		if len(password) <= maxPasswordLen && dummyArgonHash != "" {
			_ = crypto.VerifyPassword(password, dummyArgonHash)
		}
		return nil, ErrInvalidCredentials
	}
	if !crypto.VerifyPassword(password, u.PasswordHash) {
		return nil, ErrInvalidCredentials
	}
	return u, nil
}

// IssueSession creates a refresh session and access JWT for an already-authenticated user.
func (a *AuthService) IssueSession(ctx context.Context, u *store.User, deviceName, clientIP string) (*TokenPair, error) {
	return a.issueTokens(ctx, u, deviceName, clientIP)
}

func (a *AuthService) Login(ctx context.Context, username, password, deviceName, clientIP string) (*TokenPair, error) {
	u, err := a.AuthenticatePrimary(ctx, username, password)
	if err != nil {
		return nil, err
	}
	if hasMFA, mfaErr := a.HasActiveMFA(ctx, u.ID); mfaErr != nil {
		return nil, mfaErr
	} else if hasMFA {
		return nil, ErrMFARequired
	}
	return a.issueTokens(ctx, u, deviceName, clientIP)
}

func (a *AuthService) Refresh(ctx context.Context, rawRefresh, deviceName, clientIP string) (*TokenPair, error) {
	if rawRefresh == "" {
		return nil, ErrUnauthorized
	}
	now := time.Now()
	rawNewRefresh, err := crypto.RandomTokenHex(32)
	if err != nil {
		return nil, err
	}
	newSess := &store.RefreshSession{
		ID:         ulid.Make().String(),
		TokenHash:  crypto.SHA256Hex(rawNewRefresh),
		DeviceName: deviceName,
		ClientIP:   clientIP,
		CreatedAt:  now,
		ExpiresAt:  now.Add(14 * 24 * time.Hour),
	}
	u, err := a.store.RotateRefreshSession(ctx, crypto.SHA256Hex(rawRefresh), newSess)
	if err != nil {
		return nil, ErrUnauthorized
	}
	if !u.IsActive {
		a.InvalidateUser(u.ID)
		return nil, ErrUnauthorized
	}
	_ = a.store.PruneExpiredRefreshSessions(ctx)
	return a.signAccessTokenForSession(u, rawNewRefresh, now)
}

func (a *AuthService) IsUserActive(ctx context.Context, userID string) bool {
	u, err := a.GetActiveUser(ctx, userID)
	return err == nil && u.IsActive
}

func (a *AuthService) GetActiveUser(ctx context.Context, userID string) (*store.User, error) {
	if userID == "" {
		return nil, ErrUnauthorized
	}
	now := time.Now()
	a.userMu.RLock()
	if entry, ok := a.userCache[userID]; ok && now.Before(entry.expiresAt) {
		if !entry.user.IsActive {
			a.userMu.RUnlock()
			return nil, ErrUnauthorized
		}
		cp := entry.user
		a.userMu.RUnlock()
		return &cp, nil
	}
	a.userMu.RUnlock()

	u, err := a.store.GetUserByID(ctx, userID)
	if err != nil || !u.IsActive {
		a.InvalidateUser(userID)
		return nil, ErrUnauthorized
	}

	a.userMu.Lock()
	if len(a.userCache) > 256 {
		for k, v := range a.userCache {
			if now.After(v.expiresAt) {
				delete(a.userCache, k)
			}
		}
	}
	a.userCache[userID] = authCachedUser{user: *u, expiresAt: now.Add(authUserCacheTTL)}
	a.userMu.Unlock()

	cp := *u
	return &cp, nil
}

func (a *AuthService) IssueTokensForUser(ctx context.Context, u *store.User, deviceName, clientIP string) (*TokenPair, error) {
	return a.issueTokens(ctx, u, deviceName, clientIP)
}

func (a *AuthService) Logout(ctx context.Context, rawRefresh string) {
	if rawRefresh != "" {
		_ = a.store.DeleteRefreshSessionByHash(ctx, crypto.SHA256Hex(rawRefresh))
	}
}

func (a *AuthService) signAccessTokenForSession(u *store.User, rawRefresh string, now time.Time) (*TokenPair, error) {
	accessTTL := 2 * time.Hour
	tv := u.TokenVersion
	if tv < 1 {
		tv = 1
	}
	claims := Claims{
		UserID:       u.ID,
		Username:     u.Username,
		Role:         u.Role,
		TokenVersion: tv,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   u.ID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(accessTTL)),
		},
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	accessStr, err := tok.SignedString(a.jwtSecret)
	if err != nil {
		return nil, err
	}
	return &TokenPair{
		AccessToken:  accessStr,
		RefreshToken: rawRefresh,
		ExpiresIn:    int(accessTTL.Seconds()),
		User:         u,
	}, nil
}

func (a *AuthService) issueTokens(ctx context.Context, u *store.User, deviceName, clientIP string) (*TokenPair, error) {
	now := time.Now()
	rawRefresh, err := crypto.RandomTokenHex(32)
	if err != nil {
		return nil, err
	}
	sess := &store.RefreshSession{
		ID:         ulid.Make().String(),
		UserID:     u.ID,
		TokenHash:  crypto.SHA256Hex(rawRefresh),
		DeviceName: deviceName,
		ClientIP:   clientIP,
		CreatedAt:  now,
		ExpiresAt:  now.Add(14 * 24 * time.Hour),
	}
	if err := a.store.CreateRefreshSession(ctx, sess); err != nil {
		return nil, err
	}
	return a.signAccessTokenForSession(u, rawRefresh, now)
}

func (a *AuthService) ParseAccessToken(tokenStr string) (*Claims, error) {
	tok, err := jwt.ParseWithClaims(tokenStr, &Claims{}, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, ErrUnauthorized
		}
		return a.jwtSecret, nil
	})
	if err != nil || !tok.Valid {
		return nil, ErrUnauthorized
	}
	claims, ok := tok.Claims.(*Claims)
	if !ok {
		return nil, ErrUnauthorized
	}
	// Reject MFA challenge tokens (`mfa_challenge`) and WebAuthn ceremony tokens (`webauthn_*`)
	if claims.Purpose != "" && claims.Purpose != "access" {
		return nil, ErrUnauthorized
	}
	return claims, nil
}
