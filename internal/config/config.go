package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Config struct {
	ListenAddr   string
	DataDir      string
	DBPath       string
	MasterKey    []byte // 32 bytes for AES-256-GCM
	JWTSecret    []byte // 32 bytes for HMAC-SHA256 JWT
	PublicURL    string
	SecureCookie bool
	DevCORS      bool
	ReadOnly     bool
}

func Load() (*Config, error) {
	listen := envOr("PVE_DASH_LISTEN", ":8080")
	dataDir := envOr("PVE_DASH_DATA_DIR", "./data")
	if err := os.MkdirAll(dataDir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	masterKey, err := loadOrCreateKey(os.Getenv("PVE_DASH_MASTER_KEY"), filepath.Join(dataDir, ".master.key"))
	if err != nil {
		return nil, fmt.Errorf("load master key: %w", err)
	}
	jwtSecret, err := loadOrCreateKey(os.Getenv("PVE_DASH_JWT_SECRET"), filepath.Join(dataDir, ".jwt.key"))
	if err != nil {
		return nil, fmt.Errorf("load jwt secret: %w", err)
	}

	publicURL := strings.TrimRight(os.Getenv("PVE_DASH_PUBLIC_URL"), "/")
	secureCookie := strings.HasPrefix(publicURL, "https://") || os.Getenv("PVE_DASH_SECURE_COOKIE") == "true"
	devCORS := os.Getenv("PVE_DASH_DEV_CORS") == "true"
	readOnly := os.Getenv("PVE_DASH_READ_ONLY") == "true"

	return &Config{
		ListenAddr:   listen,
		DataDir:      dataDir,
		DBPath:       filepath.Join(dataDir, "pve-dash.db"),
		MasterKey:    masterKey,
		JWTSecret:    jwtSecret,
		PublicURL:    publicURL,
		SecureCookie: secureCookie,
		DevCORS:      devCORS,
		ReadOnly:     readOnly,
	}, nil
}

func envOr(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func loadOrCreateKey(envVal, filePath string) ([]byte, error) {
	if v := strings.TrimSpace(envVal); v != "" {
		if b, err := hex.DecodeString(v); err == nil && len(b) == 32 {
			return b, nil
		}
		if len(v) == 32 {
			return []byte(v), nil
		}
		return nil, fmt.Errorf("key must be 32 raw bytes or 64 hex chars")
	}

	if raw, err := os.ReadFile(filePath); err == nil {
		decoded, err := hex.DecodeString(strings.TrimSpace(string(raw)))
		if err == nil && len(decoded) == 32 {
			return decoded, nil
		}
	}

	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filePath, []byte(hex.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}
