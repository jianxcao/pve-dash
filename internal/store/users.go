package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type UserWithSessions struct {
	User
	ActiveSessions int `json:"activeSessions"`
}

func (s *Store) CreateUserUnique(ctx context.Context, u *User) error {
	err := s.CreateUser(ctx, u)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "unique") {
		return ErrDuplicateUsername
	}
	return err
}

func (s *Store) ListUsers(ctx context.Context) ([]UserWithSessions, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := s.db.QueryContext(ctx, `
		SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.token_version, u.created_at, u.updated_at,
		       COALESCE(SUM(CASE WHEN rs.expires_at > ? THEN 1 ELSE 0 END), 0) AS active_sessions
		FROM users u
		LEFT JOIN refresh_sessions rs ON rs.user_id = u.id
		GROUP BY u.id
		ORDER BY u.created_at ASC, u.username ASC`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []UserWithSessions{}
	for rows.Next() {
		var item UserWithSessions
		var active int
		if err := rows.Scan(
			&item.ID, &item.Username, &item.DisplayName, &item.Role, &active, &item.TokenVersion,
			&item.CreatedAt, &item.UpdatedAt, &item.ActiveSessions,
		); err != nil {
			return nil, err
		}
		item.IsActive = active != 0
		out = append(out, item)
	}
	return out, rows.Err()
}

// UpdateUser atomically updates a user's profile, role, active state, and optional password hash.
// It enforces that at least one active admin remains and increments token_version + revokes sessions when deactivated or password-reset.
func (s *Store) UpdateUser(ctx context.Context, id, displayName, role string, isActive bool, newPasswordHash string) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	cur := &User{}
	var curActive int
	err = tx.QueryRowContext(ctx, `
		SELECT id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at
		FROM users WHERE id = ?`, id).
		Scan(&cur.ID, &cur.Username, &cur.DisplayName, &cur.PasswordHash, &cur.Role, &curActive, &cur.TokenVersion, &cur.CreatedAt, &cur.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	cur.IsActive = curActive != 0

	// Last active admin protection
	if cur.Role == "admin" && cur.IsActive && (role != "admin" || !isActive) {
		var adminCount int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1`).Scan(&adminCount); err != nil {
			return nil, err
		}
		if adminCount <= 1 {
			return nil, ErrLastAdmin
		}
	}

	nowStr := time.Now().UTC().Format(time.RFC3339)
	nextTV := cur.TokenVersion
	if nextTV < 1 {
		nextTV = 1
	}
	revoke := !isActive || newPasswordHash != ""
	if revoke {
		nextTV++
	}
	passHash := cur.PasswordHash
	if newPasswordHash != "" {
		passHash = newPasswordHash
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE users
		SET display_name = ?, role = ?, is_active = ?, password_hash = ?, token_version = ?, updated_at = ?
		WHERE id = ?`,
		displayName, role, boolToInt(isActive), passHash, nextTV, nowStr, id,
	); err != nil {
		return nil, err
	}
	if revoke {
		if _, err := tx.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE user_id = ?`, id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}

	cur.DisplayName = displayName
	cur.Role = role
	cur.IsActive = isActive
	cur.PasswordHash = passHash
	cur.TokenVersion = nextTV
	cur.UpdatedAt = nowStr
	return cur, nil
}

// UpdateUserPassword updates a user's password hash, bumps token_version, and deletes all refresh sessions.
func (s *Store) UpdateUserPassword(ctx context.Context, id, newPasswordHash string) (*User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	nowStr := time.Now().UTC().Format(time.RFC3339)
	res, err := tx.ExecContext(ctx, `
		UPDATE users SET password_hash = ?, token_version = token_version + 1, updated_at = ?
		WHERE id = ?`,
		newPasswordHash, nowStr, id,
	)
	if err != nil {
		return nil, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrNotFound
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE user_id = ?`, id); err != nil {
		return nil, err
	}
	u := &User{}
	var active int
	if err := tx.QueryRowContext(ctx, `
		SELECT id, username, display_name, password_hash, role, is_active, token_version, created_at, updated_at
		FROM users WHERE id = ?`, id).
		Scan(&u.ID, &u.Username, &u.DisplayName, &u.PasswordHash, &u.Role, &active, &u.TokenVersion, &u.CreatedAt, &u.UpdatedAt); err != nil {
		return nil, err
	}
	u.IsActive = active != 0
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return u, nil
}

// DeleteUser removes a user account while preventing deletion of the last active admin.
func (s *Store) DeleteUser(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var role string
	var active int
	err = tx.QueryRowContext(ctx, `SELECT role, is_active FROM users WHERE id = ?`, id).Scan(&role, &active)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if role == "admin" && active != 0 {
		var adminCount int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'admin' AND is_active = 1`).Scan(&adminCount); err != nil {
			return err
		}
		if adminCount <= 1 {
			return ErrLastAdmin
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM users WHERE id = ?`, id); err != nil {
		return err
	}
	return tx.Commit()
}

// RevokeUserSessions deletes all refresh sessions for userID and bumps token_version so existing access JWTs are rejected immediately.
func (s *Store) RevokeUserSessions(ctx context.Context, userID string) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	nowStr := time.Now().UTC().Format(time.RFC3339)
	res, err := tx.ExecContext(ctx, `UPDATE users SET token_version = token_version + 1, updated_at = ? WHERE id = ?`, nowStr, userID)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return 0, ErrNotFound
	}
	delRes, err := tx.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE user_id = ?`, userID)
	if err != nil {
		return 0, err
	}
	removed, _ := delRes.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return removed, nil
}

// ImportConfigBatch atomically inserts imported PVE instances, endpoints, alert channels, and alert rules in one transaction.
func (s *Store) ImportConfigBatch(ctx context.Context, instances []*PVEInstance, channels []*AlertChannel, rules []*AlertRule) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)

	for _, inst := range instances {
		inst.CreatedAt = now
		inst.UpdatedAt = now
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO pve_instances (
				id, name, group_name, color, auth_mode, token_id, token_secret_enc,
				ticket_username, ticket_password_enc, tls_mode, ca_cert_pem, ssh_host, enabled,
				detected_version, is_cluster, capabilities_json, last_seen_at, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			inst.ID, inst.Name, inst.GroupName, inst.Color, inst.AuthMode, inst.TokenID, inst.TokenSecretEnc,
			inst.TicketUsername, inst.TicketPasswordEnc, inst.TLSMode, inst.CACertPEM, inst.SSHHost, boolToInt(inst.Enabled),
			inst.DetectedVersion, boolToInt(inst.IsCluster), inst.CapabilitiesJSON, inst.LastSeenAt, inst.CreatedAt, inst.UpdatedAt,
		); err != nil {
			return err
		}
		for _, ep := range inst.Endpoints {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO pve_endpoints (id, instance_id, node_name, url, priority, cert_fingerprint, is_healthy, last_error, last_checked_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				ep.ID, inst.ID, ep.NodeName, ep.URL, ep.Priority, ep.CertFingerprint, boolToInt(ep.IsHealthy), ep.LastError, ep.LastCheckedAt,
			); err != nil {
				return err
			}
		}
	}

	for _, ch := range channels {
		ch.CreatedAt = now
		ch.UpdatedAt = now
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO alert_channels (id, name, type, config_enc, enabled, last_test_at, last_test_status, last_test_error, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, '', '', '', ?, ?)`,
			ch.ID, ch.Name, ch.Type, ch.ConfigEnc, boolToInt(ch.Enabled), ch.CreatedAt, ch.UpdatedAt,
		); err != nil {
			return err
		}
	}

	for _, rl := range rules {
		rl.CreatedAt = now
		rl.UpdatedAt = now
		if rl.ChannelIDs == nil {
			rl.ChannelIDs = []string{}
		}
		chJSON, _ := json.Marshal(rl.ChannelIDs)
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO alert_rules (
				id, name, enabled, severity, scope_instance_id, scope_node, metric, operator,
				threshold, duration_sec, cooldown_min, channel_ids_json, silence_until, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			rl.ID, rl.Name, boolToInt(rl.Enabled), rl.Severity, rl.ScopeInstanceID, rl.ScopeNode,
			rl.Metric, rl.Operator, rl.Threshold, rl.DurationSec, rl.CooldownMin,
			string(chJSON), rl.SilenceUntil, rl.CreatedAt, rl.UpdatedAt,
		); err != nil {
			return err
		}
	}

	return tx.Commit()
}
