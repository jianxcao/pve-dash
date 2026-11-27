package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/oklog/ulid/v2"
)

type UserMFAState struct {
	UserID         string
	TOTPSecretEnc  []byte
	TOTPPendingEnc []byte
	TOTPEnabled    bool
	TOTPLastStep   int64
}

type WebAuthnCredential struct {
	ID              string   `json:"id"`
	UserID          string   `json:"userId"`
	Name            string   `json:"name"`
	RPID            string   `json:"rpId"`
	CredentialID    []byte   `json:"-"`
	PublicKeyCBOR   []byte   `json:"-"`
	AttestationType string   `json:"attestationType"`
	AAGUID          string   `json:"aaguid,omitempty"`
	SignCount       uint32   `json:"signCount"`
	BackupEligible  bool     `json:"backupEligible"`
	BackupState     bool     `json:"backupState"`
	Transports      []string `json:"transports"`
	CreatedAt       string   `json:"createdAt"`
	LastUsedAt      string   `json:"lastUsedAt,omitempty"`
}

func (s *Store) GetUserMFAState(ctx context.Context, userID string) (*UserMFAState, error) {
	st := &UserMFAState{UserID: userID}
	var enabled int
	err := s.readDB.QueryRowContext(ctx, `
		SELECT totp_secret_enc, totp_pending_enc, totp_enabled, totp_last_step
		FROM users WHERE id = ?`, userID).
		Scan(&st.TOTPSecretEnc, &st.TOTPPendingEnc, &enabled, &st.TOTPLastStep)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	st.TOTPEnabled = enabled != 0
	return st, nil
}

func (s *Store) SetUserTOTPPending(ctx context.Context, userID string, pendingEnc []byte) error {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE users SET totp_pending_enc = ?, updated_at = ? WHERE id = ?`,
		pendingEnc, now, userID,
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ActivateUserTOTP(ctx context.Context, userID string, secretEnc []byte, usedStep int64) error {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE users
		SET totp_secret_enc = ?, totp_pending_enc = NULL, totp_enabled = 1,
		    totp_last_step = CASE WHEN totp_last_step < ? THEN ? ELSE totp_last_step END,
		    updated_at = ?
		WHERE id = ?`,
		secretEnc, usedStep, usedStep, now, userID,
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	s.notifyUserMutated(userID)
	return nil
}

// ConsumeTOTPStep atomically advances totp_last_step to prevent replay of a 6-digit code
// within its 30s time window (or an older skew step).
func (s *Store) ConsumeTOTPStep(ctx context.Context, userID string, step int64) (bool, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE users
		SET totp_last_step = ?, updated_at = ?
		WHERE id = ? AND totp_enabled = 1 AND totp_last_step < ?`,
		step, now, userID, step,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// DisableUserTOTP clears TOTP configuration for userID; if no WebAuthn passkeys remain,
// any unused recovery codes are also cleared inside the same transaction.
func (s *Store) DisableUserTOTP(ctx context.Context, userID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)
	res, err := tx.ExecContext(ctx, `
		UPDATE users SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = 0, updated_at = ?
		WHERE id = ?`, now, userID)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, ErrNotFound
	}

	var passkeyCount int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_webauthn_credentials WHERE user_id = ?`, userID).Scan(&passkeyCount); err != nil {
		return false, err
	}
	if passkeyCount == 0 {
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_recovery_codes WHERE user_id = ?`, userID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	s.notifyUserMutated(userID)
	return passkeyCount > 0, nil
}

func (s *Store) ListWebAuthnCredentials(ctx context.Context, userID string) ([]WebAuthnCredential, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT id, user_id, name, rp_id, credential_id, public_key_cbor, attestation_type,
		       aaguid, sign_count, backup_eligible, backup_state, transports_json, created_at, last_used_at
		FROM user_webauthn_credentials
		WHERE user_id = ?
		ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []WebAuthnCredential{}
	for rows.Next() {
		var c WebAuthnCredential
		var signCount int64
		var be, bs int
		var transportsJSON string
		if err := rows.Scan(
			&c.ID, &c.UserID, &c.Name, &c.RPID, &c.CredentialID, &c.PublicKeyCBOR, &c.AttestationType,
			&c.AAGUID, &signCount, &be, &bs, &transportsJSON, &c.CreatedAt, &c.LastUsedAt,
		); err != nil {
			return nil, err
		}
		if signCount > 0 {
			c.SignCount = uint32(signCount)
		}
		c.BackupEligible = be != 0
		c.BackupState = bs != 0
		if json.Unmarshal([]byte(transportsJSON), &c.Transports) != nil || c.Transports == nil {
			c.Transports = []string{}
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) CreateWebAuthnCredential(ctx context.Context, c *WebAuthnCredential) error {
	if c.ID == "" {
		c.ID = ulid.Make().String()
	}
	if c.CreatedAt == "" {
		c.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	}
	if c.Transports == nil {
		c.Transports = []string{}
	}
	trJSON, _ := json.Marshal(c.Transports)

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_webauthn_credentials (
			id, user_id, name, rp_id, credential_id, public_key_cbor, attestation_type,
			aaguid, sign_count, backup_eligible, backup_state, transports_json, created_at, last_used_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		c.ID, c.UserID, c.Name, c.RPID, c.CredentialID, c.PublicKeyCBOR, c.AttestationType,
		c.AAGUID, int64(c.SignCount), boolToInt(c.BackupEligible), boolToInt(c.BackupState),
		string(trJSON), c.CreatedAt, c.LastUsedAt,
	)
	if err != nil {
		return err
	}
	s.notifyUserMutated(c.UserID)
	return nil
}

func (s *Store) UpdateWebAuthnCredentialUsage(ctx context.Context, id string, signCount uint32, backupState bool) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
		UPDATE user_webauthn_credentials
		SET sign_count = ?, backup_state = ?, last_used_at = ?
		WHERE id = ?`,
		int64(signCount), boolToInt(backupState), now, id,
	)
	return err
}

func (s *Store) DeleteWebAuthnCredential(ctx context.Context, userID, credID string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `DELETE FROM user_webauthn_credentials WHERE id = ? AND user_id = ?`, credID, userID)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, ErrNotFound
	}

	var totpEnabled int
	if err := tx.QueryRowContext(ctx, `SELECT totp_enabled FROM users WHERE id = ?`, userID).Scan(&totpEnabled); err != nil {
		return false, err
	}
	var remPasskeys int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_webauthn_credentials WHERE user_id = ?`, userID).Scan(&remPasskeys); err != nil {
		return false, err
	}
	hasRemaining := totpEnabled != 0 || remPasskeys > 0
	if !hasRemaining {
		if _, err := tx.ExecContext(ctx, `DELETE FROM user_recovery_codes WHERE user_id = ?`, userID); err != nil {
			return false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	s.notifyUserMutated(userID)
	return hasRemaining, nil
}

func (s *Store) CountUnusedRecoveryCodes(ctx context.Context, userID string) (int, error) {
	var count int
	err := s.readDB.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM user_recovery_codes WHERE user_id = ? AND used_at = ''`, userID).Scan(&count)
	return count, err
}

func (s *Store) ReplaceUserRecoveryCodes(ctx context.Context, userID string, codeHashes []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM user_recovery_codes WHERE user_id = ?`, userID); err != nil {
		return err
	}
	now := time.Now().UTC().Format(time.RFC3339)
	for _, h := range codeHashes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_recovery_codes (id, user_id, code_hash, used_at, created_at)
			VALUES (?, ?, ?, '', ?)`,
			ulid.Make().String(), userID, h, now,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) ConsumeUserRecoveryCode(ctx context.Context, userID, codeHash string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()

	var recID string
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM user_recovery_codes
		WHERE user_id = ? AND code_hash = ? AND used_at = ''
		LIMIT 1`, userID, codeHash).Scan(&recID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}

	now := time.Now().UTC().Format(time.RFC3339)
	res, err := tx.ExecContext(ctx, `UPDATE user_recovery_codes SET used_at = ? WHERE id = ? AND used_at = ''`, now, recID)
	if err != nil {
		return false, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return false, nil
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

// ClearAllUserMFA removes TOTP, all Passkeys, and all Recovery Codes for userID.
// When revokeSessions is true (admin MFA reset), it also increments token_version and deletes refresh sessions.
func (s *Store) ClearAllUserMFA(ctx context.Context, userID string, revokeSessions bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	now := time.Now().UTC().Format(time.RFC3339)
	var res sql.Result
	if revokeSessions {
		res, err = tx.ExecContext(ctx, `
			UPDATE users
			SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = 0, totp_last_step = 0,
			    token_version = token_version + 1, updated_at = ?
			WHERE id = ?`, now, userID)
	} else {
		res, err = tx.ExecContext(ctx, `
			UPDATE users
			SET totp_secret_enc = NULL, totp_pending_enc = NULL, totp_enabled = 0, totp_last_step = 0,
			    updated_at = ?
			WHERE id = ?`, now, userID)
	}
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}

	if _, err := tx.ExecContext(ctx, `DELETE FROM user_webauthn_credentials WHERE user_id = ?`, userID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM user_recovery_codes WHERE user_id = ?`, userID); err != nil {
		return err
	}
	if revokeSessions {
		if _, err := tx.ExecContext(ctx, `DELETE FROM refresh_sessions WHERE user_id = ?`, userID); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	s.notifyUserMutated(userID)
	return nil
}
