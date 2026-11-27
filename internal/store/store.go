package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound           = errors.New("record not found")
	ErrAlreadyInitialized = errors.New("already initialized")
	ErrDuplicateUsername  = errors.New("username already exists")
	ErrLastAdmin          = errors.New("cannot remove, demote, or disable the last active admin")
)

type Store struct {
	db *sql.DB
}

func OpenSQLite(path string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)", path)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite WAL works best with serialized writers in single process
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate sqlite: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS users (
	id TEXT PRIMARY KEY,
	username TEXT NOT NULL UNIQUE,
	display_name TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'admin',
	is_active INTEGER NOT NULL DEFAULT 1,
	token_version INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	device_name TEXT NOT NULL DEFAULT '',
	client_ip TEXT NOT NULL DEFAULT '',
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_preferences (
	user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
	theme TEXT NOT NULL DEFAULT 'obsidian',
	density TEXT NOT NULL DEFAULT 'compact',
	refresh_sec INTEGER NOT NULL DEFAULT 3,
	locale TEXT NOT NULL DEFAULT 'zh-CN',
	sidebar_mode TEXT NOT NULL DEFAULT 'functional'
);

CREATE TABLE IF NOT EXISTS pve_instances (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	group_name TEXT NOT NULL DEFAULT 'default',
	color TEXT NOT NULL DEFAULT '#22C55E',
	auth_mode TEXT NOT NULL DEFAULT 'token',
	token_id TEXT NOT NULL DEFAULT '',
	token_secret_enc BLOB,
	ticket_username TEXT NOT NULL DEFAULT '',
	ticket_password_enc BLOB,
	tls_mode TEXT NOT NULL DEFAULT 'tofu',
	ca_cert_pem TEXT NOT NULL DEFAULT '',
	ssh_host TEXT NOT NULL DEFAULT '',
	enabled INTEGER NOT NULL DEFAULT 1,
	detected_version TEXT NOT NULL DEFAULT '',
	is_cluster INTEGER NOT NULL DEFAULT 0,
	capabilities_json TEXT NOT NULL DEFAULT '{}',
	last_seen_at TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pve_endpoints (
	id TEXT PRIMARY KEY,
	instance_id TEXT NOT NULL REFERENCES pve_instances(id) ON DELETE CASCADE,
	node_name TEXT NOT NULL DEFAULT '',
	url TEXT NOT NULL,
	priority INTEGER NOT NULL DEFAULT 10,
	cert_fingerprint TEXT NOT NULL DEFAULT '',
	is_healthy INTEGER NOT NULL DEFAULT 1,
	last_error TEXT NOT NULL DEFAULT '',
	last_checked_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_pve_endpoints_instance ON pve_endpoints(instance_id, priority);

CREATE TABLE IF NOT EXISTS audit_logs (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL DEFAULT '',
	username TEXT NOT NULL,
	client_ip TEXT NOT NULL,
	instance_id TEXT NOT NULL DEFAULT '',
	resource_urn TEXT NOT NULL DEFAULT '',
	action TEXT NOT NULL,
	payload_summary TEXT NOT NULL DEFAULT '',
	pve_upid TEXT NOT NULL DEFAULT '',
	status TEXT NOT NULL,
	error_message TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS alert_channels (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	config_enc BLOB NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	last_test_at TEXT NOT NULL DEFAULT '',
	last_test_status TEXT NOT NULL DEFAULT '',
	last_test_error TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_rules (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	enabled INTEGER NOT NULL DEFAULT 1,
	severity TEXT NOT NULL DEFAULT 'warning',
	scope_instance_id TEXT NOT NULL DEFAULT '',
	scope_node TEXT NOT NULL DEFAULT '',
	metric TEXT NOT NULL,
	operator TEXT NOT NULL DEFAULT 'gte',
	threshold REAL NOT NULL DEFAULT 85,
	duration_sec INTEGER NOT NULL DEFAULT 0,
	cooldown_min INTEGER NOT NULL DEFAULT 30,
	channel_ids_json TEXT NOT NULL DEFAULT '[]',
	silence_until TEXT NOT NULL DEFAULT '',
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
	id TEXT PRIMARY KEY,
	rule_id TEXT NOT NULL,
	rule_name TEXT NOT NULL,
	fingerprint TEXT NOT NULL,
	severity TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'firing',
	instance_id TEXT NOT NULL DEFAULT '',
	instance_name TEXT NOT NULL DEFAULT '',
	resource_type TEXT NOT NULL DEFAULT '',
	resource_id TEXT NOT NULL DEFAULT '',
	resource_name TEXT NOT NULL DEFAULT '',
	metric TEXT NOT NULL,
	current_value REAL NOT NULL DEFAULT 0,
	threshold REAL NOT NULL DEFAULT 0,
	unit TEXT NOT NULL DEFAULT '',
	message TEXT NOT NULL,
	fired_at TEXT NOT NULL,
	last_seen_at TEXT NOT NULL,
	resolved_at TEXT NOT NULL DEFAULT '',
	acked_by TEXT NOT NULL DEFAULT '',
	acked_at TEXT NOT NULL DEFAULT '',
	notify_count INTEGER NOT NULL DEFAULT 0,
	last_notified_at TEXT NOT NULL DEFAULT '',
	last_notify_error TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_alert_events_status ON alert_events(status, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_events_fp ON alert_events(fingerprint, status);
`
	_, err := s.db.Exec(schema)
	if err != nil {
		return err
	}
	// Idempotent column migrations for existing databases
	for _, stmt := range []string{
		`ALTER TABLE pve_instances ADD COLUMN ssh_host TEXT NOT NULL DEFAULT ''`,
		`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`,
	} {
		if _, err := s.db.Exec(stmt); err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column name") {
			return fmt.Errorf("migration %q failed: %w", stmt, err)
		}
	}
	if err := s.seedDefaultAlertRules(); err != nil {
		return err
	}
	return nil
}

// --- Models ---

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	PasswordHash string `json:"-"`
	Role         string `json:"role"`
	IsActive     bool   `json:"isActive"`
	TokenVersion int    `json:"-"`
	CreatedAt    string `json:"createdAt"`
	UpdatedAt    string `json:"updatedAt"`
}

type UserPreferences struct {
	UserID      string `json:"userId"`
	Theme       string `json:"theme"`
	Density     string `json:"density"`
	RefreshSec  int    `json:"refreshSec"`
	Locale      string `json:"locale"`
	SidebarMode string `json:"sidebarMode"`
}

type RefreshSession struct {
	ID         string
	UserID     string
	TokenHash  string
	DeviceName string
	ClientIP   string
	ExpiresAt  time.Time
	CreatedAt  time.Time
}

type PVEInstance struct {
	ID                string        `json:"id"`
	Name              string        `json:"name"`
	GroupName         string        `json:"groupName"`
	Color             string        `json:"color"`
	AuthMode          string        `json:"authMode"` // token | ticket | hybrid
	TokenID           string        `json:"tokenId"`
	TokenSecretEnc    []byte        `json:"-"`
	TicketUsername    string        `json:"ticketUsername"`
	TicketPasswordEnc []byte        `json:"-"`
	TLSMode           string        `json:"tlsMode"` // strict | tofu | insecure
	CACertPEM         string        `json:"caCertPem,omitempty"`
	SSHHost           string        `json:"sshHost,omitempty"`
	Enabled           bool          `json:"enabled"`
	DetectedVersion   string        `json:"detectedVersion"`
	IsCluster         bool          `json:"isCluster"`
	CapabilitiesJSON  string        `json:"capabilitiesJson"`
	LastSeenAt        string        `json:"lastSeenAt"`
	CreatedAt         string        `json:"createdAt"`
	UpdatedAt         string        `json:"updatedAt"`
	Endpoints         []PVEEndpoint `json:"endpoints"`
}

type PVEEndpoint struct {
	ID              string `json:"id"`
	InstanceID      string `json:"instanceId"`
	NodeName        string `json:"nodeName"`
	URL             string `json:"url"`
	Priority        int    `json:"priority"`
	CertFingerprint string `json:"certFingerprint"`
	IsHealthy       bool   `json:"isHealthy"`
	LastError       string `json:"lastError"`
	LastCheckedAt   string `json:"lastCheckedAt"`
}

type AuditLog struct {
	ID             string `json:"id"`
	UserID         string `json:"userId"`
	Username       string `json:"username"`
	ClientIP       string `json:"clientIp"`
	InstanceID     string `json:"instanceId"`
	ResourceURN    string `json:"resourceUrn"`
	Action         string `json:"action"`
	PayloadSummary string `json:"payloadSummary"`
	PVEUPID        string `json:"pveUpid"`
	Status         string `json:"status"`
	ErrorMessage   string `json:"errorMessage"`
	CreatedAt      string `json:"createdAt"`
}

// --- User Operations ---

func (s *Store) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (s *Store) CreateUser(ctx context.Context, u *User) error {
	now := time.Now().UTC().Format(time.RFC3339)
	u.CreatedAt = now
	u.UpdatedAt = now
	if u.TokenVersion < 1 {
		u.TokenVersion = 1
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO users (id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.DisplayName, u.PasswordHash, u.Role, boolToInt(u.IsActive), u.TokenVersion, u.CreatedAt, u.UpdatedAt,
	)
	if err != nil {
		return err
	}
	_, _ = s.db.ExecContext(ctx, `INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`, u.ID)
	return nil
}

func (s *Store) CreateFirstAdmin(ctx context.Context, u *User) error {
	now := time.Now().UTC().Format(time.RFC3339)
	u.CreatedAt = now
	u.UpdatedAt = now
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var n int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return ErrAlreadyInitialized
	}
	if u.TokenVersion < 1 {
		u.TokenVersion = 1
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO users (id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.ID, u.Username, u.DisplayName, u.PasswordHash, u.Role, boolToInt(u.IsActive), u.TokenVersion, u.CreatedAt, u.UpdatedAt,
	); err != nil {
		return err
	}
	_, _ = tx.ExecContext(ctx, `INSERT OR IGNORE INTO user_preferences (user_id) VALUES (?)`, u.ID)
	return tx.Commit()
}

func (s *Store) GetUserByUsername(ctx context.Context, username string) (*User, error) {
	u := &User{}
	var active int
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at
		FROM users WHERE username = ?`, username).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &active, &u.TokenVersion, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.IsActive = active != 0
	return u, nil
}

func (s *Store) GetUserByID(ctx context.Context, id string) (*User, error) {
	u := &User{}
	var active int
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at
		FROM users WHERE id = ?`, id).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &active, &u.TokenVersion, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.IsActive = active != 0
	return u, nil
}

func (s *Store) GetPreferences(ctx context.Context, userID string) (*UserPreferences, error) {
	p := &UserPreferences{UserID: userID, Theme: "dark", Density: "compact", RefreshSec: 3, Locale: "zh-CN", SidebarMode: "functional"}
	err := s.db.QueryRowContext(ctx, `
		SELECT theme, density, refresh_sec, locale, sidebar_mode FROM user_preferences WHERE user_id = ?`, userID).
		Scan(&p.Theme, &p.Density, &p.RefreshSec, &p.Locale, &p.SidebarMode)
	if errors.Is(err, sql.ErrNoRows) {
		return p, nil
	}
	return p, err
}

func (s *Store) SavePreferences(ctx context.Context, p *UserPreferences) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_preferences (user_id, theme, density, refresh_sec, locale, sidebar_mode)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			theme=excluded.theme,
			density=excluded.density,
			refresh_sec=excluded.refresh_sec,
			locale=excluded.locale,
			sidebar_mode=excluded.sidebar_mode`,
		p.UserID, p.Theme, p.Density, p.RefreshSec, p.Locale, p.SidebarMode,
	)
	return err
}

// --- Sessions ---

func (s *Store) CreateRefreshSession(ctx context.Context, sess *RefreshSession) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO refresh_sessions (id, user_id, token_hash, device_name, client_ip, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sess.ID, sess.UserID, sess.TokenHash, sess.DeviceName, sess.ClientIP,
		sess.ExpiresAt.UTC().Format(time.RFC3339), sess.CreatedAt.UTC().Format(time.RFC3339),
	)
	return err
}

func (s *Store) GetRefreshSessionByHash(ctx context.Context, hash string) (*RefreshSession, error) {
	sess := &RefreshSession{}
	var expStr, createdStr string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, user_id, token_hash, device_name, client_ip, expires_at, created_at
		FROM refresh_sessions WHERE token_hash = ?`, hash).
		Scan(&sess.ID, &sess.UserID, &sess.TokenHash, &sess.DeviceName, &sess.ClientIP, &expStr, &createdStr)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	sess.ExpiresAt, _ = time.Parse(time.RFC3339, expStr)
	sess.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
	return sess, nil
}

func (s *Store) DeleteRefreshSessionByHash(ctx context.Context, hash string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE token_hash = ?`, hash)
	return err
}

// ConsumeRefreshSession atomically retrieves and deletes a refresh session so concurrent
// refresh requests using the same token cannot mint multiple replacement sessions.
func (s *Store) ConsumeRefreshSession(ctx context.Context, hash string) (*RefreshSession, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	sess := &RefreshSession{}
	var expStr, createdStr string
	err = tx.QueryRowContext(ctx, `
		SELECT id, user_id, token_hash, device_name, client_ip, expires_at, created_at
		FROM refresh_sessions WHERE token_hash = ?`, hash).
		Scan(&sess.ID, &sess.UserID, &sess.TokenHash, &sess.DeviceName, &sess.ClientIP, &expStr, &createdStr)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE token_hash = ?`, hash)
	if err != nil {
		return nil, err
	}
	affected, _ := res.RowsAffected()
	if affected != 1 {
		return nil, ErrNotFound
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	sess.ExpiresAt, _ = time.Parse(time.RFC3339, expStr)
	sess.CreatedAt, _ = time.Parse(time.RFC3339, createdStr)
	return sess, nil
}

// RotateRefreshSession atomically consumes oldHash, verifies expiry and user active state,
// inserts the replacement refresh session, and returns the live user inside a single transaction.
// This eliminates TOCTOU races where an admin revokes sessions between consume and re-issue.
func (s *Store) RotateRefreshSession(ctx context.Context, oldHash string, newSess *RefreshSession) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	var userID, expStr string
	err = tx.QueryRowContext(ctx, `SELECT user_id, expires_at FROM refresh_sessions WHERE token_hash = ?`, oldHash).
		Scan(&userID, &expStr)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE token_hash = ?`, oldHash)
	if err != nil {
		return nil, err
	}
	if affected, _ := res.RowsAffected(); affected != 1 {
		return nil, ErrNotFound
	}
	exp, err := time.Parse(time.RFC3339, expStr)
	if err != nil || time.Now().After(exp) {
		_ = tx.Commit() // keep expired token deleted
		return nil, ErrNotFound
	}

	u := &User{}
	var active int
	err = tx.QueryRowContext(ctx, `
		SELECT id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at
		FROM users WHERE id = ?`, userID).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &active, &u.TokenVersion, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) || active == 0 {
		_ = tx.Commit()
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	u.IsActive = true

	newSess.UserID = u.ID
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO refresh_sessions (id, user_id, token_hash, device_name, client_ip, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		newSess.ID, newSess.UserID, newSess.TokenHash, newSess.DeviceName, newSess.ClientIP,
		newSess.ExpiresAt.UTC().Format(time.RFC3339), newSess.CreatedAt.UTC().Format(time.RFC3339),
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return u, nil
}

func (s *Store) PruneExpiredRefreshSessions(ctx context.Context) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE expires_at < ?`, now)
	return err
}

// --- PVE Instances ---

func (s *Store) ListInstances(ctx context.Context) ([]*PVEInstance, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, group_name, color, auth_mode, token_id, token_secret_enc,
		       ticket_username, ticket_password_enc, tls_mode, ca_cert_pem, ssh_host, enabled,
		       detected_version, is_cluster, capabilities_json, last_seen_at, created_at, updated_at
		FROM pve_instances ORDER BY group_name, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var list []*PVEInstance
	for rows.Next() {
		inst, err := scanInstance(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, inst)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	for _, inst := range list {
		eps, err := s.listEndpoints(ctx, inst.ID)
		if err != nil {
			return nil, err
		}
		inst.Endpoints = eps
	}
	return list, nil
}

func (s *Store) GetInstance(ctx context.Context, id string) (*PVEInstance, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, name, group_name, color, auth_mode, token_id, token_secret_enc,
		       ticket_username, ticket_password_enc, tls_mode, ca_cert_pem, ssh_host, enabled,
		       detected_version, is_cluster, capabilities_json, last_seen_at, created_at, updated_at
		FROM pve_instances WHERE id = ?`, id)
	inst, err := scanInstance(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	eps, err := s.listEndpoints(ctx, inst.ID)
	if err != nil {
		return nil, err
	}
	inst.Endpoints = eps
	return inst, nil
}

func (s *Store) SaveInstance(ctx context.Context, inst *PVEInstance, isNew bool) error {
	now := time.Now().UTC().Format(time.RFC3339)
	if isNew {
		inst.CreatedAt = now
	}
	inst.UpdatedAt = now

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if isNew {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO pve_instances (
				id, name, group_name, color, auth_mode, token_id, token_secret_enc,
				ticket_username, ticket_password_enc, tls_mode, ca_cert_pem, ssh_host, enabled,
				detected_version, is_cluster, capabilities_json, last_seen_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			inst.ID, inst.Name, inst.GroupName, inst.Color, inst.AuthMode, inst.TokenID, inst.TokenSecretEnc,
			inst.TicketUsername, inst.TicketPasswordEnc, inst.TLSMode, inst.CACertPEM, inst.SSHHost, boolToInt(inst.Enabled),
			inst.DetectedVersion, boolToInt(inst.IsCluster), inst.CapabilitiesJSON, inst.LastSeenAt, inst.CreatedAt, inst.UpdatedAt,
		)
	} else {
		_, err = tx.ExecContext(ctx, `
			UPDATE pve_instances SET
				name=?, group_name=?, color=?, auth_mode=?, token_id=?, token_secret_enc=?,
				ticket_username=?, ticket_password_enc=?, tls_mode=?, ca_cert_pem=?, ssh_host=?, enabled=?,
				detected_version=?, is_cluster=?, capabilities_json=?, last_seen_at=?, updated_at=?
			WHERE id=?`,
			inst.Name, inst.GroupName, inst.Color, inst.AuthMode, inst.TokenID, inst.TokenSecretEnc,
			inst.TicketUsername, inst.TicketPasswordEnc, inst.TLSMode, inst.CACertPEM, inst.SSHHost, boolToInt(inst.Enabled),
			inst.DetectedVersion, boolToInt(inst.IsCluster), inst.CapabilitiesJSON, inst.LastSeenAt, inst.UpdatedAt,
			inst.ID,
		)
	}
	if err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM pve_endpoints WHERE instance_id = ?`, inst.ID); err != nil {
		return err
	}
	for _, ep := range inst.Endpoints {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO pve_endpoints (id, instance_id, node_name, url, priority, cert_fingerprint, is_healthy, last_error, last_checked_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			ep.ID, inst.ID, ep.NodeName, ep.URL, ep.Priority, ep.CertFingerprint, boolToInt(ep.IsHealthy), ep.LastError, ep.LastCheckedAt,
		)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

func (s *Store) UpdateInstanceDetection(ctx context.Context, id, version string, isCluster bool, capsJSON string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
		UPDATE pve_instances SET detected_version=?, is_cluster=?, capabilities_json=?, last_seen_at=?, updated_at=? WHERE id=?`,
		version, boolToInt(isCluster), capsJSON, now, now, id,
	)
	return err
}

func (s *Store) UpdateEndpointFingerprint(ctx context.Context, endpointID, fp string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE pve_endpoints SET cert_fingerprint=? WHERE id=?`, fp, endpointID)
	return err
}

func (s *Store) DeleteInstance(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM pve_instances WHERE id = ?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) listEndpoints(ctx context.Context, instanceID string) ([]PVEEndpoint, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, instance_id, node_name, url, priority, cert_fingerprint, is_healthy, last_error, last_checked_at
		FROM pve_endpoints WHERE instance_id = ? ORDER BY priority ASC, url ASC`, instanceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var eps []PVEEndpoint
	for rows.Next() {
		var ep PVEEndpoint
		var healthy int
		if err := rows.Scan(&ep.ID, &ep.InstanceID, &ep.NodeName, &ep.URL, &ep.Priority, &ep.CertFingerprint, &healthy, &ep.LastError, &ep.LastCheckedAt); err != nil {
			return nil, err
		}
		ep.IsHealthy = healthy != 0
		eps = append(eps, ep)
	}
	return eps, rows.Err()
}

// --- Audit Logs ---

func (s *Store) InsertAuditLog(ctx context.Context, log *AuditLog) error {
	if log.CreatedAt == "" {
		log.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO audit_logs (id, user_id, username, client_ip, instance_id, resource_urn, action, payload_summary, pve_upid, status, error_message, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		log.ID, log.UserID, log.Username, log.ClientIP, log.InstanceID, log.ResourceURN,
		log.Action, log.PayloadSummary, log.PVEUPID, log.Status, log.ErrorMessage, log.CreatedAt,
	)
	return err
}

func (s *Store) ListAuditLogs(ctx context.Context, limit int) ([]AuditLog, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, user_id, username, client_ip, instance_id, resource_urn, action, payload_summary, pve_upid, status, error_message, created_at
		FROM audit_logs ORDER BY created_at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []AuditLog
	for rows.Next() {
		var l AuditLog
		if err := rows.Scan(&l.ID, &l.UserID, &l.Username, &l.ClientIP, &l.InstanceID, &l.ResourceURN,
			&l.Action, &l.PayloadSummary, &l.PVEUPID, &l.Status, &l.ErrorMessage, &l.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, l)
	}
	return list, rows.Err()
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanInstance(r rowScanner) (*PVEInstance, error) {
	inst := &PVEInstance{}
	var enabled, isCluster int
	err := r.Scan(
		&inst.ID, &inst.Name, &inst.GroupName, &inst.Color, &inst.AuthMode, &inst.TokenID, &inst.TokenSecretEnc,
		&inst.TicketUsername, &inst.TicketPasswordEnc, &inst.TLSMode, &inst.CACertPEM, &inst.SSHHost, &enabled,
		&inst.DetectedVersion, &isCluster, &inst.CapabilitiesJSON, &inst.LastSeenAt, &inst.CreatedAt, &inst.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	inst.Enabled = enabled != 0
	inst.IsCluster = isCluster != 0
	return inst, nil
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
