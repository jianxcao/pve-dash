package main

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/service"
	"github.com/jianxcao/pve-dash/internal/store"
)

func TestCLIFlagValidationAndMutualExclusion(t *testing.T) {
	// 1. Empty args -> handled=false so main() boots server normally
	var out, errBuf bytes.Buffer
	if handled, code := runCLIWithDataDir(t.TempDir(), nil, nil, &out, &errBuf); handled || code != 0 {
		t.Fatalf("expected empty args handled=false code=0, got handled=%v code=%d", handled, code)
	}

	// 2. --version and -v
	out.Reset()
	errBuf.Reset()
	if handled, code := runCLIWithDataDir(t.TempDir(), []string{"--version"}, nil, &out, &errBuf); !handled || code != 0 || !strings.Contains(out.String(), "pve-dash ") {
		t.Fatalf("--version failed: handled=%v code=%d out=%q", handled, code, out.String())
	}
	out.Reset()
	if handled, code := runCLIWithDataDir(t.TempDir(), []string{"-v"}, nil, &out, &errBuf); !handled || code != 0 || !strings.Contains(out.String(), "pve-dash ") {
		t.Fatalf("-v failed: handled=%v code=%d out=%q", handled, code, out.String())
	}

	// 3. Mutually exclusive flags, --password-stdin without --reset-password, blank username, and positional plaintext password rejection
	badCases := [][]string{
		{"--list-users", "--reset-mfa", "admin"},
		{"--reset-mfa", "admin", "--reset-password", "admin"},
		{"--version", "--list-users"},
		{"--password-stdin"},
		{"--list-users", "--password-stdin"},
		{"--reset-mfa", "   "},
		{"--reset-password", ""},
		{"--reset-password", "admin", "PlainSecretOnArgv123"},
		{"extra-positional"},
	}
	for _, args := range badCases {
		out.Reset()
		errBuf.Reset()
		handled, code := runCLIWithDataDir(t.TempDir(), args, nil, &out, &errBuf)
		if !handled || code == 0 {
			t.Fatalf("expected args %v rejected with non-zero code, got handled=%v code=%d err=%q", args, handled, code, errBuf.String())
		}
	}
}

func TestCLIEmptyDBAndEmergencyRecoveryFlows(t *testing.T) {
	dataDir := t.TempDir()
	dbPath := filepath.Join(dataDir, "pve-dash.db")

	// 1. Missing DB file: --list-users prints helpful hint and exits 0 without creating stray files; --reset-* exits 1
	var out, errBuf bytes.Buffer
	handled, code := runCLIWithDataDir(dataDir, []string{"--list-users"}, nil, &out, &errBuf)
	if !handled || code != 0 || !strings.Contains(out.String(), "PVE_DASH_DATA_DIR") || !strings.Contains(out.String(), dbPath) {
		t.Fatalf("--list-users on missing DB unexpected: handled=%v code=%d out=%q err=%q", handled, code, out.String(), errBuf.String())
	}
	out.Reset()
	errBuf.Reset()
	if handled, code := runCLIWithDataDir(dataDir, []string{"--reset-mfa", "admin"}, nil, &out, &errBuf); !handled || code != 1 {
		t.Fatalf("--reset-mfa on missing DB expected exit 1, got handled=%v code=%d", handled, code)
	}

	// 2. Keep an active Store WAL instance open (simulating live pve-dash server on :8080 / :18080!)
	liveStore, err := store.OpenSQLite(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer liveStore.Close()
	ctx := context.Background()

	// Empty initialized DB -> --list-users prints hint & exits 0; --reset-password exits 1
	out.Reset()
	if handled, code := runCLIWithDataDir(dataDir, []string{"--list-users"}, nil, &out, &errBuf); !handled || code != 0 || !strings.Contains(out.String(), "尚无用户") {
		t.Fatalf("--list-users on 0-user DB unexpected: code=%d out=%q", code, out.String())
	}
	errBuf.Reset()
	if handled, code := runCLIWithDataDir(dataDir, []string{"--reset-password", "admin"}, nil, &out, &errBuf); !handled || code != 1 {
		t.Fatalf("--reset-password on 0-user DB expected code=1, got %d", code)
	}

	// Seed admin with active TOTP + Passkey + Recovery Codes + Refresh Session, plus a disabled operator account
	box, _ := crypto.NewBox(bytes.Repeat([]byte{0x42}, 32))
	auth := service.NewAuthService(liveStore, bytes.Repeat([]byte{0x53}, 32))
	auth.SetCryptoBox(box)

	adminPair, err := auth.SetupAdminAndLogin(ctx, "admin", "Super Admin", "InitialPass#123", "test-cli", "203.0.113.10")
	if err != nil {
		t.Fatalf("SetupAdminAndLogin: %v", err)
	}
	uid := adminPair.User.ID

	setupRes, err := auth.BeginTOTPSetup(ctx, uid, "InitialPass#123")
	if err != nil {
		t.Fatalf("BeginTOTPSetup: %v", err)
	}
	code6, _ := service.GenerateTOTPCodeAt(setupRes.Secret, time.Now())
	if _, err := auth.ConfirmTOTPSetup(ctx, uid, code6); err != nil {
		t.Fatalf("ConfirmTOTPSetup: %v", err)
	}
	if err := liveStore.CreateWebAuthnCredential(ctx, &store.WebAuthnCredential{
		ID:              "pk-cli-1",
		UserID:          uid,
		Name:            "Touch ID",
		RPID:            "dash.example.com",
		CredentialID:    []byte("cred-cli-1"),
		PublicKeyCBOR:   []byte{0xa1, 0x01, 0x02},
		AttestationType: "none",
	}); err != nil {
		t.Fatalf("CreateWebAuthnCredential: %v", err)
	}

	opHash, _ := crypto.HashPassword("LockedPass#123")
	opUser := &store.User{
		ID:           "u-locked-op",
		Username:     "locked_ops",
		DisplayName:  "Locked Operator",
		PasswordHash: opHash,
		Role:         "operator",
		IsActive:     false, // disabled/locked account
	}
	if err := liveStore.CreateUser(ctx, opUser); err != nil {
		t.Fatalf("CreateUser: %v", err)
	}

	// 3. --list-users prints aligned table showing totp+passkey, passkeys=1, sessions=1, and locked_ops active=no
	out.Reset()
	errBuf.Reset()
	if handled, code := runCLIWithDataDir(dataDir, []string{"--list-users"}, nil, &out, &errBuf); !handled || code != 0 {
		t.Fatalf("--list-users failed: code=%d err=%q", code, errBuf.String())
	}
	tableOut := out.String()
	for _, want := range []string{"USERNAME", "DISPLAY_NAME", "2FA", "PASSKEYS", "SESSIONS", "admin", "totp+passkey", "locked_ops"} {
		if !strings.Contains(tableOut, want) {
			t.Fatalf("expected --list-users output to contain %q, got:\n%s", want, tableOut)
		}
	}

	// Unknown user on --reset-mfa and --reset-password returns exit code 1
	if _, code := runCLIWithDataDir(dataDir, []string{"--reset-mfa", "nobody"}, nil, &out, &errBuf); code != 1 {
		t.Fatalf("expected exit 1 for unknown user on --reset-mfa, got %d", code)
	}
	if _, code := runCLIWithDataDir(dataDir, []string{"--reset-password", "nobody"}, nil, &out, &errBuf); code != 1 {
		t.Fatalf("expected exit 1 for unknown user on --reset-password, got %d", code)
	}

	// 4. --reset-mfa admin clears TOTP, Passkeys, Recovery Codes, revokes sessions, bumps token_version, and writes cli.mfa_reset audit log
	out.Reset()
	errBuf.Reset()
	if handled, code := runCLIWithDataDir(dataDir, []string{"--reset-mfa", "admin"}, nil, &out, &errBuf); !handled || code != 0 {
		t.Fatalf("--reset-mfa admin failed: code=%d err=%q", code, errBuf.String())
	}
	liveStore.InvalidateAllUserCache()
	auth.InvalidateAllUsers()

	// Admin can now log in directly without 2FA, and old refresh token is revoked!
	if _, err := auth.Refresh(ctx, adminPair.RefreshToken, "ua", "203.0.113.10"); err == nil {
		t.Fatal("expected old refresh session revoked after --reset-mfa")
	}
	if _, err := auth.Login(ctx, "admin", "InitialPass#123", "ua", "203.0.113.10"); err != nil {
		t.Fatalf("expected direct password Login after --reset-mfa to succeed without ErrMFARequired, got %v", err)
	}

	// 5. --reset-password locked_ops (random CSPRNG 18-char password) re-activates account & prints generated password
	out.Reset()
	errBuf.Reset()
	if handled, code := runCLIWithDataDir(dataDir, []string{"--reset-password", "locked_ops"}, nil, &out, &errBuf); !handled || code != 0 {
		t.Fatalf("--reset-password locked_ops failed: code=%d err=%q", code, errBuf.String())
	}
	const marker = "："
	idx := strings.LastIndex(out.String(), marker)
	if idx < 0 {
		t.Fatalf("expected generated password printed after %q, got %q", marker, out.String())
	}
	genPass := strings.TrimSpace(out.String()[idx+len(marker):])
	if len(genPass) != cliGeneratedPasswordLen {
		t.Fatalf("expected %d-char generated password, got len=%d (%q)", cliGeneratedPasswordLen, len(genPass), genPass)
	}
	liveStore.InvalidateAllUserCache()
	auth.InvalidateAllUsers()
	if _, err := auth.Login(ctx, "locked_ops", genPass, "ua", "203.0.113.11"); err != nil {
		t.Fatalf("expected locked_ops re-activated and able to log in with generated password, got %v", err)
	}

	// 6. --reset-password admin --password-stdin (rejects <8 / >128 bytes; accepts valid stdin line trimming \r\n only)
	if _, code := runCLIWithDataDir(dataDir, []string{"--reset-password", "admin", "--password-stdin"}, strings.NewReader("short\n"), &out, &errBuf); code != 1 {
		t.Fatalf("expected <8 byte stdin password rejected with code=1, got %d", code)
	}
	if _, code := runCLIWithDataDir(dataDir, []string{"--reset-password", "admin", "--password-stdin"}, strings.NewReader(strings.Repeat("A", 129)+"\n"), &out, &errBuf); code != 1 {
		t.Fatalf("expected >128 byte stdin password rejected with code=1, got %d", code)
	}

	out.Reset()
	errBuf.Reset()
	stdinPass := "StdinRecovery#2026! "
	if handled, code := runCLIWithDataDir(dataDir, []string{"--reset-password", "admin", "--password-stdin"}, strings.NewReader(stdinPass+"\r\n"), &out, &errBuf); !handled || code != 0 {
		t.Fatalf("--reset-password --password-stdin failed: code=%d err=%q", code, errBuf.String())
	}
	if strings.Contains(out.String(), stdinPass) {
		t.Fatal("--password-stdin must NOT echo plaintext password to stdout")
	}
	liveStore.InvalidateAllUserCache()
	auth.InvalidateAllUsers()
	if _, err := auth.Login(ctx, "admin", stdinPass, "ua", "203.0.113.10"); err != nil {
		t.Fatalf("expected Login with --password-stdin password (preserving trailing space, stripping \\r\\n) to succeed, got %v", err)
	}

	// Verify forensic audit_logs entries recorded for both cli.mfa_reset and cli.password_reset
	logs, err := liveStore.ListAuditLogs(ctx, 20)
	if err != nil {
		t.Fatalf("ListAuditLogs: %v", err)
	}
	var sawMFAReset, sawPassReset bool
	for _, l := range logs {
		if l.Username == "system-cli" && l.ClientIP == "local-cli" && l.Status == "success" {
			switch l.Action {
			case "cli.mfa_reset":
				if l.ResourceURN == "user:admin" {
					sawMFAReset = true
				}
			case "cli.password_reset":
				sawPassReset = true
			}
		}
	}
	if !sawMFAReset || !sawPassReset {
		t.Fatalf("expected both cli.mfa_reset and cli.password_reset audit logs, got sawMFA=%v sawPass=%v logs=%+v", sawMFAReset, sawPassReset, logs)
	}
}

func TestCLIConcurrentAgainstActiveWALStore(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("PVE_DASH_DATA_DIR", dataDir)
	dbPath := filepath.Join(dataDir, "pve-dash.db")

	liveStore, err := store.OpenSQLite(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLite: %v", err)
	}
	defer liveStore.Close()
	ctx := context.Background()

	pwHash, _ := crypto.HashPassword("BasePassword#123")
	if err := liveStore.CreateFirstAdmin(ctx, &store.User{
		ID:           "u-wal-admin",
		Username:     "admin",
		DisplayName:  "WAL Admin",
		PasswordHash: pwHash,
		Role:         "admin",
		IsActive:     true,
	}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 4; i++ {
		uName := fmt.Sprintf("ops_%d", i)
		if err := liveStore.CreateUser(ctx, &store.User{
			ID:           fmt.Sprintf("u-wal-%d", i),
			Username:     uName,
			DisplayName:  uName,
			PasswordHash: pwHash,
			Role:         "operator",
			IsActive:     true,
		}); err != nil {
			t.Fatal(err)
		}
	}

	var serverWG, cliWG sync.WaitGroup
	errCh := make(chan error, 64)

	// Background server WAL read/write activity running simultaneously throughout all CLI invocations
	stopServerLoad := make(chan struct{})
	serverWG.Add(1)
	go func() {
		defer serverWG.Done()
		for i := 0; ; i++ {
			select {
			case <-stopServerLoad:
				return
			default:
			}
			_, _ = liveStore.ListUsers(ctx)
			_, _ = liveStore.ListAuditLogs(ctx, 20)
			_ = liveStore.SavePreferences(ctx, &store.UserPreferences{
				UserID:      "u-wal-admin",
				Theme:       "obsidian",
				Density:     "comfortable",
				RefreshSec:  3,
				Locale:      "zh-CN",
				SidebarMode: "functional",
				FontScale:   "md",
			})
			if i%3 == 0 {
				_ = liveStore.ActivateUserTOTP(ctx, "u-wal-0", []byte("enc-secret"), int64(1000+i))
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()

	// Concurrent CLI invocations (--list-users, --reset-mfa, --reset-password random & --password-stdin)
	for g := 0; g < 4; g++ {
		g := g
		cliWG.Add(1)
		go func() {
			defer cliWG.Done()
			targetUser := fmt.Sprintf("ops_%d", g)
			for iter := 0; iter < 2; iter++ {
				var out, errBuf bytes.Buffer
				if handled, code := runCLI([]string{"--list-users"}, nil, &out, &errBuf); !handled || code != 0 {
					errCh <- fmt.Errorf("--list-users failed (code=%d): %s", code, errBuf.String())
					return
				}
				out.Reset()
				errBuf.Reset()
				if handled, code := runCLI([]string{"--reset-mfa", targetUser}, nil, &out, &errBuf); !handled || code != 0 {
					errCh <- fmt.Errorf("--reset-mfa %s failed (code=%d): %s", targetUser, code, errBuf.String())
					return
				}
				out.Reset()
				errBuf.Reset()
				if iter%2 == 0 {
					if handled, code := runCLI([]string{"--reset-password", targetUser}, nil, &out, &errBuf); !handled || code != 0 {
						errCh <- fmt.Errorf("--reset-password %s (random) failed (code=%d): %s", targetUser, code, errBuf.String())
						return
					}
				} else {
					stdin := strings.NewReader(fmt.Sprintf("ConcurrentPass#%d-%d\n", g, iter))
					if handled, code := runCLI([]string{"--reset-password", targetUser, "--password-stdin"}, stdin, &out, &errBuf); !handled || code != 0 {
						errCh <- fmt.Errorf("--reset-password %s (stdin) failed (code=%d): %s", targetUser, code, errBuf.String())
						return
					}
				}
			}
		}()
	}

	cliWG.Wait()
	close(stopServerLoad)
	serverWG.Wait()
	close(errCh)

	for err := range errCh {
		if err != nil {
			t.Fatal(err)
		}
	}
}
