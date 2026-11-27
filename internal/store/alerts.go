package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/oklog/ulid/v2"
)

type AlertChannel struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Type           string `json:"type"` // webhook | feishu | dingtalk | wecom | telegram | bark
	ConfigEnc      []byte `json:"-"`
	Enabled        bool   `json:"enabled"`
	LastTestAt     string `json:"lastTestAt,omitempty"`
	LastTestStatus string `json:"lastTestStatus,omitempty"` // ok | error | ""
	LastTestError  string `json:"lastTestError,omitempty"`
	CreatedAt      string `json:"createdAt"`
	UpdatedAt      string `json:"updatedAt"`
}

type AlertRule struct {
	ID              string   `json:"id"`
	Name            string   `json:"name"`
	Enabled         bool     `json:"enabled"`
	Severity        string   `json:"severity"` // info | warning | critical
	ScopeInstanceID string   `json:"scopeInstanceId"`
	ScopeNode       string   `json:"scopeNode"`
	Metric          string   `json:"metric"` // instance_offline | node_offline | node_cpu | node_mem | storage_usage | guest_cpu | guest_mem | disk_health | disk_temp | backup_uncovered
	Operator        string   `json:"operator"` // gte | lte | eq
	Threshold       float64  `json:"threshold"`
	DurationSec     int      `json:"durationSec"`
	CooldownMin     int      `json:"cooldownMin"`
	ChannelIDs      []string `json:"channelIds"`
	SilenceUntil    string   `json:"silenceUntil"`
	CreatedAt       string   `json:"createdAt"`
	UpdatedAt       string   `json:"updatedAt"`
}

type AlertEvent struct {
	ID              string  `json:"id"`
	RuleID          string  `json:"ruleId"`
	RuleName        string  `json:"ruleName"`
	Fingerprint     string  `json:"fingerprint"`
	Severity        string  `json:"severity"`
	Status          string  `json:"status"` // firing | acknowledged | resolved
	InstanceID      string  `json:"instanceId"`
	InstanceName    string  `json:"instanceName"`
	ResourceType    string  `json:"resourceType"` // instance | node | storage | guest | disk | backup
	ResourceID      string  `json:"resourceId"`
	ResourceName    string  `json:"resourceName"`
	Metric          string  `json:"metric"`
	CurrentValue    float64 `json:"currentValue"`
	Threshold       float64 `json:"threshold"`
	Unit            string  `json:"unit"`
	Message         string  `json:"message"`
	FiredAt         string  `json:"firedAt"`
	LastSeenAt      string  `json:"lastSeenAt"`
	ResolvedAt      string  `json:"resolvedAt,omitempty"`
	AckedBy         string  `json:"ackedBy,omitempty"`
	AckedAt         string  `json:"ackedAt,omitempty"`
	NotifyCount     int     `json:"notifyCount"`
	LastNotifiedAt  string  `json:"lastNotifiedAt,omitempty"`
	LastNotifyError string  `json:"lastNotifyError,omitempty"`
}

type AlertSummaryCounts struct {
	ActiveCount     int `json:"activeCount"`
	FiringCount     int `json:"firingCount"`
	AckedCount      int `json:"ackedCount"`
	CriticalCount   int `json:"criticalCount"`
	WarningCount    int `json:"warningCount"`
	InfoCount       int `json:"infoCount"`
	RulesTotal      int `json:"rulesTotal"`
	RulesEnabled    int `json:"rulesEnabled"`
	ChannelsTotal   int `json:"channelsTotal"`
	ChannelsEnabled int `json:"channelsEnabled"`
}

func (s *Store) seedDefaultAlertRules() error {
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM alert_rules`).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}

	now := time.Now().UTC().Format(time.RFC3339)
	defaults := []AlertRule{
		{
			ID:          ulid.Make().String(),
			Name:        "PVE 节点离线告警",
			Enabled:     true,
			Severity:    "critical",
			Metric:      "node_offline",
			Operator:    "gte",
			Threshold:   1,
			DurationSec: 0,
			CooldownMin: 15,
			ChannelIDs:  []string{},
		},
		{
			ID:          ulid.Make().String(),
			Name:        "宿主机 CPU 持续过载",
			Enabled:     true,
			Severity:    "warning",
			Metric:      "node_cpu",
			Operator:    "gte",
			Threshold:   90,
			DurationSec: 60,
			CooldownMin: 30,
			ChannelIDs:  []string{},
		},
		{
			ID:          ulid.Make().String(),
			Name:        "宿主机物理内存告警",
			Enabled:     true,
			Severity:    "warning",
			Metric:      "node_mem",
			Operator:    "gte",
			Threshold:   90,
			DurationSec: 60,
			CooldownMin: 30,
			ChannelIDs:  []string{},
		},
		{
			ID:          ulid.Make().String(),
			Name:        "存储池容量不足",
			Enabled:     true,
			Severity:    "critical",
			Metric:      "storage_usage",
			Operator:    "gte",
			Threshold:   85,
			DurationSec: 0,
			CooldownMin: 60,
			ChannelIDs:  []string{},
		},
		{
			ID:          ulid.Make().String(),
			Name:        "硬盘 SMART 健康度预警",
			Enabled:     true,
			Severity:    "warning",
			Metric:      "disk_health",
			Operator:    "lte",
			Threshold:   80,
			DurationSec: 0,
			CooldownMin: 120,
			ChannelIDs:  []string{},
		},
		{
			ID:          ulid.Make().String(),
			Name:        "硬盘温度过高预警",
			Enabled:     true,
			Severity:    "warning",
			Metric:      "disk_temp",
			Operator:    "gte",
			Threshold:   55,
			DurationSec: 60,
			CooldownMin: 30,
			ChannelIDs:  []string{},
		},
	}

	for _, r := range defaults {
		_, err := tx.Exec(`
			INSERT INTO alert_rules (
				id, name, enabled, severity, scope_instance_id, scope_node, metric, operator,
				threshold, duration_sec, cooldown_min, channel_ids_json, silence_until, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '', ?, ?)`,
			r.ID, r.Name, boolToInt(r.Enabled), r.Severity, r.ScopeInstanceID, r.ScopeNode,
			r.Metric, r.Operator, r.Threshold, r.DurationSec, r.CooldownMin, now, now,
		)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// --- Alert Channels ---

func (s *Store) ListAlertChannels(ctx context.Context) ([]AlertChannel, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT id, name, type, config_enc, enabled, last_test_at, last_test_status, last_test_error, created_at, updated_at
		FROM alert_channels ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertChannel{}
	for rows.Next() {
		var c AlertChannel
		var enabled int
		if err := rows.Scan(&c.ID, &c.Name, &c.Type, &c.ConfigEnc, &enabled, &c.LastTestAt, &c.LastTestStatus, &c.LastTestError, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Enabled = enabled != 0
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) GetAlertChannel(ctx context.Context, id string) (*AlertChannel, error) {
	var c AlertChannel
	var enabled int
	err := s.readDB.QueryRowContext(ctx, `
		SELECT id, name, type, config_enc, enabled, last_test_at, last_test_status, last_test_error, created_at, updated_at
		FROM alert_channels WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.Type, &c.ConfigEnc, &enabled, &c.LastTestAt, &c.LastTestStatus, &c.LastTestError, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	c.Enabled = enabled != 0
	return &c, nil
}

func (s *Store) CreateAlertChannel(ctx context.Context, c *AlertChannel) error {
	now := time.Now().UTC().Format(time.RFC3339)
	c.CreatedAt = now
	c.UpdatedAt = now
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO alert_channels (id, name, type, config_enc, enabled, last_test_at, last_test_status, last_test_error, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, '', '', '', ?, ?)`,
		c.ID, c.Name, c.Type, c.ConfigEnc, boolToInt(c.Enabled), c.CreatedAt, c.UpdatedAt,
	)
	return err
}

func (s *Store) UpdateAlertChannel(ctx context.Context, c *AlertChannel) error {
	c.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE alert_channels SET name=?, type=?, config_enc=?, enabled=?, updated_at=? WHERE id=?`,
		c.Name, c.Type, c.ConfigEnc, boolToInt(c.Enabled), c.UpdatedAt, c.ID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) UpdateAlertChannelTestStatus(ctx context.Context, id, status, errMsg string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	_, err := s.db.ExecContext(ctx, `
		UPDATE alert_channels SET last_test_at=?, last_test_status=?, last_test_error=? WHERE id=?`,
		now, status, errMsg, id,
	)
	return err
}

func (s *Store) DeleteAlertChannel(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `DELETE FROM alert_channels WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}

	// Prune the deleted channel ID from any alert rules so they don't hold dangling references.
	rows, err := tx.QueryContext(ctx, `SELECT id, channel_ids_json FROM alert_rules`)
	if err != nil {
		return err
	}
	type rulePatch struct {
		id  string
		raw string
	}
	var patches []rulePatch
	for rows.Next() {
		var rid, chJSON string
		if err := rows.Scan(&rid, &chJSON); err != nil {
			rows.Close()
			return err
		}
		var ids []string
		if json.Unmarshal([]byte(chJSON), &ids) != nil || len(ids) == 0 {
			continue
		}
		filtered := make([]string, 0, len(ids))
		changed := false
		for _, cid := range ids {
			if cid == id {
				changed = true
				continue
			}
			filtered = append(filtered, cid)
		}
		if changed {
			b, _ := json.Marshal(filtered)
			patches = append(patches, rulePatch{id: rid, raw: string(b)})
		}
	}
	rows.Close()

	now := time.Now().UTC().Format(time.RFC3339)
	for _, p := range patches {
		if _, err := tx.ExecContext(ctx, `UPDATE alert_rules SET channel_ids_json=?, updated_at=? WHERE id=?`, p.raw, now, p.id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// --- Alert Rules ---

func (s *Store) ListAlertRules(ctx context.Context) ([]AlertRule, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT id, name, enabled, severity, scope_instance_id, scope_node, metric, operator,
		       threshold, duration_sec, cooldown_min, channel_ids_json, silence_until, created_at, updated_at
		FROM alert_rules ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertRule{}
	for rows.Next() {
		r, err := scanAlertRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *r)
	}
	return out, rows.Err()
}

func (s *Store) GetAlertRule(ctx context.Context, id string) (*AlertRule, error) {
	row := s.readDB.QueryRowContext(ctx, `
		SELECT id, name, enabled, severity, scope_instance_id, scope_node, metric, operator,
		       threshold, duration_sec, cooldown_min, channel_ids_json, silence_until, created_at, updated_at
		FROM alert_rules WHERE id=?`, id)
	r, err := scanAlertRule(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return r, err
}

func (s *Store) CreateAlertRule(ctx context.Context, r *AlertRule) error {
	now := time.Now().UTC().Format(time.RFC3339)
	r.CreatedAt = now
	r.UpdatedAt = now
	if r.ChannelIDs == nil {
		r.ChannelIDs = []string{}
	}
	chJSON, _ := json.Marshal(r.ChannelIDs)
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO alert_rules (
			id, name, enabled, severity, scope_instance_id, scope_node, metric, operator,
			threshold, duration_sec, cooldown_min, channel_ids_json, silence_until, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.ID, r.Name, boolToInt(r.Enabled), r.Severity, r.ScopeInstanceID, r.ScopeNode,
		r.Metric, r.Operator, r.Threshold, r.DurationSec, r.CooldownMin, string(chJSON),
		r.SilenceUntil, r.CreatedAt, r.UpdatedAt,
	)
	return err
}

func (s *Store) UpdateAlertRule(ctx context.Context, r *AlertRule) error {
	r.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if r.ChannelIDs == nil {
		r.ChannelIDs = []string{}
	}
	chJSON, _ := json.Marshal(r.ChannelIDs)
	res, err := s.db.ExecContext(ctx, `
		UPDATE alert_rules SET
			name=?, enabled=?, severity=?, scope_instance_id=?, scope_node=?, metric=?, operator=?,
			threshold=?, duration_sec=?, cooldown_min=?, channel_ids_json=?, silence_until=?, updated_at=?
		WHERE id=?`,
		r.Name, boolToInt(r.Enabled), r.Severity, r.ScopeInstanceID, r.ScopeNode, r.Metric, r.Operator,
		r.Threshold, r.DurationSec, r.CooldownMin, string(chJSON), r.SilenceUntil, r.UpdatedAt, r.ID,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) DeleteAlertRule(ctx context.Context, id string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx, `DELETE FROM alert_rules WHERE id=?`, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	// Resolve any active events belonging to the deleted rule
	now := time.Now().UTC().Format(time.RFC3339)
	if _, err := tx.ExecContext(ctx, `
		UPDATE alert_events SET status='resolved', resolved_at=? WHERE rule_id=? AND status IN ('firing', 'acknowledged')`,
		now, id,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func scanAlertRule(row rowScanner) (*AlertRule, error) {
	var r AlertRule
	var enabled int
	var chJSON string
	err := row.Scan(
		&r.ID, &r.Name, &enabled, &r.Severity, &r.ScopeInstanceID, &r.ScopeNode,
		&r.Metric, &r.Operator, &r.Threshold, &r.DurationSec, &r.CooldownMin,
		&chJSON, &r.SilenceUntil, &r.CreatedAt, &r.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	r.Enabled = enabled != 0
	if err := json.Unmarshal([]byte(chJSON), &r.ChannelIDs); err != nil || r.ChannelIDs == nil {
		r.ChannelIDs = []string{}
	}
	return &r, nil
}

// --- Alert Events ---

func (s *Store) GetAlertEventByID(ctx context.Context, id string) (*AlertEvent, error) {
	row := s.readDB.QueryRowContext(ctx, `
		SELECT id, rule_id, rule_name, fingerprint, severity, status, instance_id, instance_name,
		       resource_type, resource_id, resource_name, metric, current_value, threshold, unit,
		       message, fired_at, last_seen_at, resolved_at, acked_by, acked_at,
		       notify_count, last_notified_at, last_notify_error
		FROM alert_events WHERE id = ?`, id)
	ev, err := scanAlertEvent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return ev, err
}

func (s *Store) GetActiveAlertByFingerprint(ctx context.Context, fp string) (*AlertEvent, error) {
	row := s.readDB.QueryRowContext(ctx, `
		SELECT id, rule_id, rule_name, fingerprint, severity, status, instance_id, instance_name,
		       resource_type, resource_id, resource_name, metric, current_value, threshold, unit,
		       message, fired_at, last_seen_at, resolved_at, acked_by, acked_at,
		       notify_count, last_notified_at, last_notify_error
		FROM alert_events WHERE fingerprint=? AND status IN ('firing', 'acknowledged')
		ORDER BY fired_at DESC LIMIT 1`, fp)
	ev, err := scanAlertEvent(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return ev, err
}

func (s *Store) InsertAlertEvent(ctx context.Context, ev *AlertEvent) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO alert_events (
			id, rule_id, rule_name, fingerprint, severity, status, instance_id, instance_name,
			resource_type, resource_id, resource_name, metric, current_value, threshold, unit,
			message, fired_at, last_seen_at, resolved_at, acked_by, acked_at,
			notify_count, last_notified_at, last_notify_error
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ev.ID, ev.RuleID, ev.RuleName, ev.Fingerprint, ev.Severity, ev.Status, ev.InstanceID, ev.InstanceName,
		ev.ResourceType, ev.ResourceID, ev.ResourceName, ev.Metric, ev.CurrentValue, ev.Threshold, ev.Unit,
		ev.Message, ev.FiredAt, ev.LastSeenAt, ev.ResolvedAt, ev.AckedBy, ev.AckedAt,
		ev.NotifyCount, ev.LastNotifiedAt, ev.LastNotifyError,
	)
	return err
}

func (s *Store) UpdateAlertEventHeartbeat(ctx context.Context, id string, currentVal, threshold float64, severity, ruleName, resourceID, resourceName, message, lastSeenAt string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE alert_events
		SET current_value=?, threshold=?, severity=?, rule_name=?, resource_id=?, resource_name=?, message=?, last_seen_at=?
		WHERE id=?`,
		currentVal, threshold, severity, ruleName, resourceID, resourceName, message, lastSeenAt, id,
	)
	return err
}

func (s *Store) RecordAlertNotification(ctx context.Context, id string, anySucceeded bool, notifiedAt, notifyErr string) error {
	if anySucceeded {
		_, err := s.db.ExecContext(ctx, `
			UPDATE alert_events SET notify_count = notify_count + 1, last_notified_at=?, last_notify_error=? WHERE id=?`,
			notifiedAt, notifyErr, id,
		)
		return err
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE alert_events SET last_notify_error=? WHERE id=?`,
		notifyErr, id,
	)
	return err
}

func (s *Store) ResolveAlertEvent(ctx context.Context, id string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE alert_events SET status='resolved', resolved_at=? WHERE id=? AND status != 'resolved'`, now, id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AckAlertEvent(ctx context.Context, id, username string) error {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE alert_events SET status='acknowledged', acked_by=?, acked_at=? WHERE id=? AND status='firing'`,
		username, now, id,
	)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) AckAllFiringAlerts(ctx context.Context, username string) (int64, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `
		UPDATE alert_events SET status='acknowledged', acked_by=?, acked_at=? WHERE status='firing'`,
		username, now,
	)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) ListActiveAlertEvents(ctx context.Context) ([]AlertEvent, error) {
	rows, err := s.readDB.QueryContext(ctx, `
		SELECT id, rule_id, rule_name, fingerprint, severity, status, instance_id, instance_name,
		       resource_type, resource_id, resource_name, metric, current_value, threshold, unit,
		       message, fired_at, last_seen_at, resolved_at, acked_by, acked_at,
		       notify_count, last_notified_at, last_notify_error
		FROM alert_events WHERE status IN ('firing', 'acknowledged')
		ORDER BY fired_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertEvent{}
	for rows.Next() {
		ev, err := scanAlertEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *ev)
	}
	return out, rows.Err()
}

func (s *Store) ListAlertEvents(ctx context.Context, statusFilter, severityFilter string, limit int) ([]AlertEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	clauses := []string{}
	args := []any{}
	switch strings.ToLower(strings.TrimSpace(statusFilter)) {
	case "active":
		clauses = append(clauses, "status IN ('firing', 'acknowledged')")
	case "firing", "acknowledged", "resolved":
		clauses = append(clauses, "status = ?")
		args = append(args, strings.ToLower(strings.TrimSpace(statusFilter)))
	}
	switch strings.ToLower(strings.TrimSpace(severityFilter)) {
	case "critical", "warning", "info":
		clauses = append(clauses, "severity = ?")
		args = append(args, strings.ToLower(strings.TrimSpace(severityFilter)))
	}

	query := `
		SELECT id, rule_id, rule_name, fingerprint, severity, status, instance_id, instance_name,
		       resource_type, resource_id, resource_name, metric, current_value, threshold, unit,
		       message, fired_at, last_seen_at, resolved_at, acked_by, acked_at,
		       notify_count, last_notified_at, last_notify_error
		FROM alert_events`
	if len(clauses) > 0 {
		query += " WHERE " + strings.Join(clauses, " AND ")
	}
	query += " ORDER BY CASE status WHEN 'firing' THEN 0 WHEN 'acknowledged' THEN 1 ELSE 2 END, fired_at DESC LIMIT ?"
	args = append(args, limit)

	rows, err := s.readDB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AlertEvent{}
	for rows.Next() {
		ev, err := scanAlertEvent(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *ev)
	}
	return out, rows.Err()
}

func (s *Store) GetAlertSummaryCounts(ctx context.Context) (*AlertSummaryCounts, error) {
	c := &AlertSummaryCounts{}
	if err := s.readDB.QueryRowContext(ctx, `
		SELECT
			COALESCE(SUM(CASE WHEN status = 'firing' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status IN ('firing', 'acknowledged') AND severity = 'critical' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status IN ('firing', 'acknowledged') AND severity = 'warning' THEN 1 ELSE 0 END), 0),
			COALESCE(SUM(CASE WHEN status IN ('firing', 'acknowledged') AND severity = 'info' THEN 1 ELSE 0 END), 0)
		FROM alert_events`).Scan(
		&c.FiringCount,
		&c.AckedCount,
		&c.CriticalCount,
		&c.WarningCount,
		&c.InfoCount,
	); err != nil {
		return nil, err
	}
	if err := s.readDB.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0)
		FROM alert_rules`).Scan(&c.RulesTotal, &c.RulesEnabled); err != nil {
		return nil, err
	}
	if err := s.readDB.QueryRowContext(ctx, `
		SELECT COUNT(*), COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0)
		FROM alert_channels`).Scan(&c.ChannelsTotal, &c.ChannelsEnabled); err != nil {
		return nil, err
	}
	c.ActiveCount = c.FiringCount + c.AckedCount
	return c, nil
}

func scanAlertEvent(row rowScanner) (*AlertEvent, error) {
	var ev AlertEvent
	err := row.Scan(
		&ev.ID, &ev.RuleID, &ev.RuleName, &ev.Fingerprint, &ev.Severity, &ev.Status,
		&ev.InstanceID, &ev.InstanceName, &ev.ResourceType, &ev.ResourceID, &ev.ResourceName,
		&ev.Metric, &ev.CurrentValue, &ev.Threshold, &ev.Unit, &ev.Message,
		&ev.FiredAt, &ev.LastSeenAt, &ev.ResolvedAt, &ev.AckedBy, &ev.AckedAt,
		&ev.NotifyCount, &ev.LastNotifiedAt, &ev.LastNotifyError,
	)
	if err != nil {
		return nil, err
	}
	return &ev, nil
}
