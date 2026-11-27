package service

import (
	"context"
	"errors"
	"strings"
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
)

type Claims struct {
	UserID   string `json:"uid"`
	Username string `json:"uname"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

type AuthService struct {
	store     *store.Store
	jwtSecret []byte
}

func NewAuthService(st *store.Store, jwtSecret []byte) *AuthService {
	return &AuthService{store: st, jwtSecret: jwtSecret}
}

func (a *AuthService) IsInitialized(ctx context.Context) (bool, error) {
	n, err := a.store.CountUsers(ctx)
	return n > 0, err
}

func (a *AuthService) SetupAdmin(ctx context.Context, username, displayName, password string) (*store.User, error) {
	username = strings.TrimSpace(username)
	if len(username) < 2 || len(password) < 6 {
		return nil, errors.New("username must be >= 2 chars and password >= 6 chars")
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
	if err := a.store.CreateUser(ctx, u); err != nil {
		return nil, err
	}
	return u, nil
}

type TokenPair struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"-"`
	ExpiresIn    int         `json:"expiresIn"`
	User         *store.User `json:"user"`
}

func (a *AuthService) Login(ctx context.Context, username, password, deviceName, clientIP string) (*TokenPair, error) {
	u, err := a.store.GetUserByUsername(ctx, strings.TrimSpace(username))
	if err != nil {
		return nil, ErrInvalidCredentials
	}
	if !u.IsActive || !crypto.VerifyPassword(password, u.PasswordHash) {
		return nil, ErrInvalidCredentials
	}
	return a.issueTokens(ctx, u, deviceName, clientIP)
}

func (a *AuthService) Refresh(ctx context.Context, rawRefresh, deviceName, clientIP string) (*TokenPair, error) {
	if rawRefresh == "" {
		return nil, ErrUnauthorized
	}
	hash := crypto.SHA256Hex(rawRefresh)
	sess, err := a.store.GetRefreshSessionByHash(ctx, hash)
	if err != nil || time.Now().After(sess.ExpiresAt) {
		return nil, ErrUnauthorized
	}
	u, err := a.store.GetUserByID(ctx, sess.UserID)
	if err != nil || !u.IsActive {
		return nil, ErrUnauthorized
	}
	_ = a.store.DeleteRefreshSessionByHash(ctx, hash)
	return a.issueTokens(ctx, u, deviceName, clientIP)
}

func (a *AuthService) Logout(ctx context.Context, rawRefresh string) {
	if rawRefresh != "" {
		_ = a.store.DeleteRefreshSessionByHash(ctx, crypto.SHA256Hex(rawRefresh))
	}
}

func (a *AuthService) issueTokens(ctx context.Context, u *store.User, deviceName, clientIP string) (*TokenPair, error) {
	now := time.Now()
	accessTTL := 2 * time.Hour
	claims := Claims{
		UserID:   u.ID,
		Username: u.Username,
		Role:     u.Role,
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

	return &TokenPair{
		AccessToken:  accessStr,
		RefreshToken: rawRefresh,
		ExpiresIn:    int(accessTTL.Seconds()),
		User:         u,
	}, nil
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
	return claims, nil
}
