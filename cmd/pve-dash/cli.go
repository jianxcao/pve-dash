package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
	"github.com/jianxcao/pve-dash/internal/version"
	"github.com/oklog/ulid/v2"
)

const (
	cliMinPasswordBytes      = 8
	cliMaxPasswordBytes      = 128
	cliGeneratedPasswordLen  = 18
	cliAlphanumericCharset   = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	cliEmptyUsersDBHintFmt   = "数据库中尚无用户 (db: %s)，请确认 PVE_DASH_DATA_DIR 是否指向正确目录\n"
	cliAuditActorUsername    = "system-cli"
	cliAuditActorClientIP    = "local-cli"
)

type cliOptions struct {
	showVersion   bool
	listUsers     bool
	resetMFA      string
	resetPassword string
	passwordStdin bool

	hasResetMFA      bool
	hasResetPassword bool
}

func resolveDataDirFromEnv() string {
	if v := strings.TrimSpace(os.Getenv("PVE_DASH_DATA_DIR")); v != "" {
		return v
	}
	return "./data"
}

// runCLI parses command-line flags and executes any one-shot administrative / recovery command.
// When handled is false, no one-shot CLI action was requested and main() should start the HTTP server.
func runCLI(args []string, stdin io.Reader, stdout, stderr io.Writer) (handled bool, exitCode int) {
	return runCLIWithDataDir(resolveDataDirFromEnv(), args, stdin, stdout, stderr)
}

func runCLIWithDataDir(dataDir string, args []string, stdin io.Reader, stdout, stderr io.Writer) (handled bool, exitCode int) {
	fs := flag.NewFlagSet("pve-dash", flag.ContinueOnError)
	fs.SetOutput(stderr)

	var opts cliOptions
	fs.BoolVar(&opts.showVersion, "version", false, "Print version information and exit")
	fs.BoolVar(&opts.showVersion, "v", false, "Print version information and exit (shorthand)")
	fs.BoolVar(&opts.listUsers, "list-users", false, "List all panel accounts and 2FA/session status")
	fs.StringVar(&opts.resetMFA, "reset-mfa", "", "Disable TOTP, clear Passkeys & recovery codes, and revoke sessions for <username>")
	fs.StringVar(&opts.resetPassword, "reset-password", "", "Reset password, activate account, and revoke sessions for <username>")
	fs.BoolVar(&opts.passwordStdin, "password-stdin", false, "Read new password (1 line, 8..128 bytes) from stdin for --reset-password")

	fs.Usage = func() {
		fmt.Fprintf(stderr, "Usage: pve-dash [options]\n\nOptions:\n")
		fs.PrintDefaults()
		fmt.Fprintf(stderr, "\nExamples:\n")
		fmt.Fprintf(stderr, "  pve-dash --version\n")
		fmt.Fprintf(stderr, "  PVE_DASH_DATA_DIR=./data pve-dash --list-users\n")
		fmt.Fprintf(stderr, "  PVE_DASH_DATA_DIR=./data pve-dash --reset-mfa admin\n")
		fmt.Fprintf(stderr, "  PVE_DASH_DATA_DIR=./data pve-dash --reset-password admin\n")
		fmt.Fprintf(stderr, "  printf 'NewStrongPass#2026\\n' | PVE_DASH_DATA_DIR=./data pve-dash --reset-password admin --password-stdin\n")
	}

	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return true, 0
		}
		return true, 2
	}

	fs.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "reset-mfa":
			opts.hasResetMFA = true
		case "reset-password":
			opts.hasResetPassword = true
		}
	})

	if fs.NArg() > 0 {
		if opts.hasResetPassword {
			fmt.Fprintln(stderr, "错误: 禁止在命令行参数中直接传递明文密码（避免 ps 进程列表泄露）；请省略密码自动生成随机密码，或配合 --password-stdin 从标准输入读取。")
		} else {
			fmt.Fprintf(stderr, "错误: 未识别的位置参数 %v\n", fs.Args())
		}
		return true, 2
	}

	actionCount := 0
	if opts.showVersion {
		actionCount++
	}
	if opts.listUsers {
		actionCount++
	}
	if opts.hasResetMFA {
		actionCount++
	}
	if opts.hasResetPassword {
		actionCount++
	}

	if actionCount > 1 {
		fmt.Fprintln(stderr, "错误: --version、--list-users、--reset-mfa、--reset-password 互斥，每次仅可执行一项操作。")
		return true, 2
	}
	if opts.passwordStdin && !opts.hasResetPassword {
		fmt.Fprintln(stderr, "错误: --password-stdin 仅可与 --reset-password <username> 配合使用。")
		return true, 2
	}
	if actionCount == 0 {
		return false, 0
	}

	if opts.showVersion {
		info := version.Info()
		fmt.Fprintf(stdout, "pve-dash %s (commit: %s, built: %s, go: %s)\n", info.Version, info.Commit, info.BuildTime, info.GoVersion)
		return true, 0
	}

	dbPath := filepath.Join(strings.TrimSpace(dataDir), "pve-dash.db")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	switch {
	case opts.listUsers:
		if err := execCLIListUsers(ctx, dbPath, stdout); err != nil {
			fmt.Fprintf(stderr, "错误: %v\n", err)
			return true, 1
		}
		return true, 0

	case opts.hasResetMFA:
		username := strings.TrimSpace(opts.resetMFA)
		if username == "" {
			fmt.Fprintln(stderr, "错误: --reset-mfa 必须指定非空用户名。")
			return true, 2
		}
		if err := execCLIResetMFA(ctx, dbPath, username, stdout); err != nil {
			fmt.Fprintf(stderr, "错误: %v\n", err)
			return true, 1
		}
		return true, 0

	case opts.hasResetPassword:
		username := strings.TrimSpace(opts.resetPassword)
		if username == "" {
			fmt.Fprintln(stderr, "错误: --reset-password 必须指定非空用户名。")
			return true, 2
		}
		if err := execCLIResetPassword(ctx, dbPath, username, opts.passwordStdin, stdin, stdout); err != nil {
			fmt.Fprintf(stderr, "错误: %v\n", err)
			return true, 1
		}
		return true, 0
	}

	return false, 0
}

func openExistingStoreForCLI(dbPath string) (*store.Store, bool, error) {
	info, err := os.Stat(dbPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("访问数据库文件 %s 失败: %w", dbPath, err)
	}
	if info.IsDir() {
		return nil, false, fmt.Errorf("数据库路径 %s 是目录而非 SQLite 文件", dbPath)
	}
	st, err := store.OpenSQLite(dbPath)
	if err != nil {
		return nil, false, err
	}
	return st, true, nil
}

func execCLIListUsers(ctx context.Context, dbPath string, stdout io.Writer) error {
	st, exists, err := openExistingStoreForCLI(dbPath)
	if err != nil {
		return err
	}
	if !exists {
		fmt.Fprintf(stdout, cliEmptyUsersDBHintFmt, dbPath)
		return nil
	}
	defer st.Close()

	users, err := st.ListUsers(ctx)
	if err != nil {
		return fmt.Errorf("查询用户列表失败: %w", err)
	}
	if len(users) == 0 {
		fmt.Fprintf(stdout, cliEmptyUsersDBHintFmt, dbPath)
		return nil
	}

	tw := tabwriter.NewWriter(stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "USERNAME\tDISPLAY_NAME\tROLE\tACTIVE\t2FA\tPASSKEYS\tSESSIONS")
	for _, u := range users {
		activeLabel := "no"
		if u.IsActive {
			activeLabel = "yes"
		}
		mfaLabel := "off"
		switch {
		case u.TOTPEnabled && u.PasskeyCount > 0:
			mfaLabel = "totp+passkey"
		case u.TOTPEnabled:
			mfaLabel = "totp"
		case u.PasskeyCount > 0:
			mfaLabel = "passkey"
		case u.MFAEnabled:
			mfaLabel = "on"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%d\t%d\n",
			u.Username, u.DisplayName, u.Role, activeLabel, mfaLabel, u.PasskeyCount, u.ActiveSessions,
		)
	}
	return tw.Flush()
}

func execCLIResetMFA(ctx context.Context, dbPath, username string, stdout io.Writer) error {
	st, exists, err := openExistingStoreForCLI(dbPath)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf(strings.TrimSuffix(cliEmptyUsersDBHintFmt, "\n"), dbPath)
	}
	defer st.Close()

	totalUsers, err := st.CountUsers(ctx)
	if err != nil {
		return fmt.Errorf("读取用户总数失败: %w", err)
	}
	if totalUsers == 0 {
		return fmt.Errorf(strings.TrimSuffix(cliEmptyUsersDBHintFmt, "\n"), dbPath)
	}

	u, err := st.GetUserByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("用户 %q 不存在 (db: %s)", username, dbPath)
		}
		return fmt.Errorf("查询用户 %q 失败: %w", username, err)
	}

	if err := st.ClearAllUserMFA(ctx, u.ID, true); err != nil {
		return fmt.Errorf("重置用户 %q 双因素认证失败: %w", username, err)
	}

	_ = st.InsertAuditLog(ctx, &store.AuditLog{
		ID:             ulid.Make().String(),
		UserID:         u.ID,
		Username:       cliAuditActorUsername,
		ClientIP:       cliAuditActorClientIP,
		ResourceURN:    "user:" + u.Username,
		Action:         "cli.mfa_reset",
		PayloadSummary: fmt.Sprintf("Emergency CLI reset 2FA (TOTP, Passkeys, Recovery Codes) and revoked sessions for %s", u.Username),
		Status:         "success",
	})

	fmt.Fprintf(stdout, "已成功重置账号 %s 的全部双因素认证 (TOTP / 通行密钥 / 恢复码)，并吊销其所有旧登录会话。\n", u.Username)
	return nil
}

func execCLIResetPassword(ctx context.Context, dbPath, username string, fromStdin bool, stdin io.Reader, stdout io.Writer) error {
	st, exists, err := openExistingStoreForCLI(dbPath)
	if err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf(strings.TrimSuffix(cliEmptyUsersDBHintFmt, "\n"), dbPath)
	}
	defer st.Close()

	totalUsers, err := st.CountUsers(ctx)
	if err != nil {
		return fmt.Errorf("读取用户总数失败: %w", err)
	}
	if totalUsers == 0 {
		return fmt.Errorf(strings.TrimSuffix(cliEmptyUsersDBHintFmt, "\n"), dbPath)
	}

	u, err := st.GetUserByUsername(ctx, username)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			return fmt.Errorf("用户 %q 不存在 (db: %s)", username, dbPath)
		}
		return fmt.Errorf("查询用户 %q 失败: %w", username, err)
	}

	var plainPassword string
	var generated bool
	if fromStdin {
		pw, err := readPasswordLineFromStdin(stdin)
		if err != nil {
			return err
		}
		plainPassword = pw
	} else {
		pw, err := generateCSPRNGAlphanumericPassword(cliGeneratedPasswordLen)
		if err != nil {
			return fmt.Errorf("生成安全随机密码失败: %w", err)
		}
		plainPassword = pw
		generated = true
	}

	hash, err := crypto.HashPassword(plainPassword)
	if err != nil {
		return fmt.Errorf("计算 Argon2id 密码哈希失败: %w", err)
	}

	updatedUser, err := st.ResetUserPasswordAndActivate(ctx, u.ID, hash)
	if err != nil {
		return fmt.Errorf("更新用户 %q 密码失败: %w", username, err)
	}

	modeSummary := "generated random password"
	if fromStdin {
		modeSummary = "password-stdin"
	}
	_ = st.InsertAuditLog(ctx, &store.AuditLog{
		ID:             ulid.Make().String(),
		UserID:         updatedUser.ID,
		Username:       cliAuditActorUsername,
		ClientIP:       cliAuditActorClientIP,
		ResourceURN:    "user:" + updatedUser.Username,
		Action:         "cli.password_reset",
		PayloadSummary: fmt.Sprintf("Emergency CLI password reset (%s), activated account, and revoked sessions for %s", modeSummary, updatedUser.Username),
		Status:         "success",
	})

	fmt.Fprintf(stdout, "已成功重置账号 %s 的登录密码（账号已确保启用，旧会话已全部吊销）。\n", updatedUser.Username)
	if generated {
		fmt.Fprintf(stdout, "生成的临时随机密码（仅显示一次，请登录后立即修改）：%s\n", plainPassword)
	}
	return nil
}

func readPasswordLineFromStdin(stdin io.Reader) (string, error) {
	if stdin == nil {
		return "", errors.New("标准输入不可用")
	}
	br := bufio.NewReader(io.LimitReader(stdin, 4096))
	line, err := br.ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", fmt.Errorf("读取标准输入密码失败: %w", err)
	}
	pw := strings.TrimRight(line, "\r\n")
	if len(pw) < cliMinPasswordBytes || len(pw) > cliMaxPasswordBytes {
		return "", fmt.Errorf("密码长度必须为 %d 到 %d 字节（当前 %d 字节）", cliMinPasswordBytes, cliMaxPasswordBytes, len(pw))
	}
	return pw, nil
}

func generateCSPRNGAlphanumericPassword(length int) (string, error) {
	const alphaLen = len(cliAlphanumericCharset) // 62
	const maxUnbiased = 256 - (256 % alphaLen)   // 248 (eliminates modulo bias)

	out := make([]byte, 0, length)
	var buf [64]byte
	for len(out) < length {
		if _, err := rand.Read(buf[:]); err != nil {
			return "", err
		}
		for _, b := range buf {
			if int(b) < maxUnbiased {
				out = append(out, cliAlphanumericCharset[int(b)%alphaLen])
				if len(out) == length {
					break
				}
			}
		}
	}
	return string(out), nil
}
