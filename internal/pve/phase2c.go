package pve

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type NodeServiceItem struct {
	Service     string `json:"service"`
	Name        string `json:"name"`
	Desc        string `json:"desc"`
	State       string `json:"state"`
	ActiveState string `json:"active-state"`
	UnitState   string `json:"unit-state"`
}

type SyslogLine struct {
	N int    `json:"n"`
	T string `json:"t"`
}

type APTUpdatePkg struct {
	Package      string `json:"Package"`
	Title        string `json:"Title"`
	OldVersion   string `json:"OldVersion"`
	Version      string `json:"Version"`
	Origin       string `json:"Origin"`
	Priority     string `json:"Priority"`
	Section      string `json:"Section"`
	Description  string `json:"Description"`
	NotifyStatus string `json:"NotifyStatus"`
}

type APTRepoSummary struct {
	Digest        string           `json:"digest"`
	Files         []map[string]any `json:"files"`
	Errors        []map[string]any `json:"errors"`
	Infos         []map[string]any `json:"infos"`
	StandardRepos []map[string]any `json:"standard-repos"`
}

type BackupJob struct {
	ID           string   `json:"id"`
	Schedule     string   `json:"schedule"`
	Storage      string   `json:"storage"`
	Mode         string   `json:"mode"`
	Compress     string   `json:"compress"`
	VMID         string   `json:"vmid,omitempty"`
	Exclude      string   `json:"exclude,omitempty"`
	All          FlexBool `json:"all,omitempty"`
	Enabled      FlexBool `json:"enabled"`
	Node         string   `json:"node,omitempty"`
	PruneBackups string   `json:"prune-backups,omitempty"`
	NotesTemp    string   `json:"notes-template,omitempty"`
	Comment      string   `json:"comment,omitempty"`
	Type         string   `json:"type,omitempty"`
}

type NotBackedUpGuest struct {
	VMID FlexInt `json:"vmid"`
	Name string  `json:"name"`
	Type string  `json:"type"`
}

// --- Node Services, Syslog & APT ---

func (c *Client) GetNodeServices(ctx context.Context, node string) ([]NodeServiceItem, error) {
	var out []NodeServiceItem
	path := fmt.Sprintf("/nodes/%s/services", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) ControlNodeService(ctx context.Context, node, service, action string) (string, error) {
	switch action {
	case "start", "stop", "restart", "reload":
	default:
		return "", fmt.Errorf("unsupported service action: %s", action)
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/services/%s/%s", url.PathEscape(node), url.PathEscape(service), action)
	if err := c.DoJSON(ctx, http.MethodPost, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) GetNodeSyslog(ctx context.Context, node string, limit int, service, since, until string) ([]SyslogLine, error) {
	if limit <= 0 {
		limit = 200
	}
	fetchWindow := func(sinceVal string, fetchLimit int) ([]SyslogLine, error) {
		q := url.Values{}
		q.Set("limit", strconv.Itoa(fetchLimit))
		if strings.TrimSpace(service) != "" {
			q.Set("service", strings.TrimSpace(service))
		}
		if strings.TrimSpace(sinceVal) != "" {
			q.Set("since", strings.TrimSpace(sinceVal))
		}
		if strings.TrimSpace(until) != "" {
			q.Set("until", strings.TrimSpace(until))
		}
		var out []SyslogLine
		path := fmt.Sprintf("/nodes/%s/syslog", url.PathEscape(node))
		if err := c.DoJSON(ctx, http.MethodGet, path, q, &out); err != nil {
			return nil, err
		}
		return out, nil
	}

	// Fetch a slightly wider buffer so we can return the latest tail lines of the window
	// instead of only the oldest entries from the start of journald.
	fetchCap := limit
	if fetchCap < 1000 {
		fetchCap = 1000
	}

	var out []SyslogLine
	var err error
	if strings.TrimSpace(since) != "" {
		out, err = fetchWindow(since, fetchCap)
		if err != nil {
			return nil, err
		}
	} else {
		// Default to recent 2h; widen to 24h or all if host is quiet or clocks differ.
		for _, candidate := range []string{
			time.Now().Add(-2 * time.Hour).Format("2006-01-02 15:04:05"),
			time.Now().Add(-24 * time.Hour).Format("2006-01-02 15:04:05"),
			"",
		} {
			out, err = fetchWindow(candidate, fetchCap)
			if err != nil {
				return nil, err
			}
			if len(out) > 0 {
				break
			}
		}
	}

	if len(out) > limit {
		out = out[len(out)-limit:]
	}
	return out, nil
}

func (c *Client) GetNodeAPTUpdates(ctx context.Context, node string) ([]APTUpdatePkg, error) {
	var out []APTUpdatePkg
	path := fmt.Sprintf("/nodes/%s/apt/update", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) RefreshNodeAPT(ctx context.Context, node string) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/apt/update", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPost, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) GetNodeAPTRepositories(ctx context.Context, node string) (*APTRepoSummary, error) {
	var out APTRepoSummary
	path := fmt.Sprintf("/nodes/%s/apt/repositories", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// --- Backups & Restore ---

func (c *Client) RunVZDump(ctx context.Context, node string, params url.Values) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/vzdump", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) UpdateVolumeConfig(ctx context.Context, node, storage, volid string, notes *string, protected *bool) error {
	params := url.Values{}
	if notes != nil {
		params.Set("notes", *notes)
	}
	if protected != nil {
		if *protected {
			params.Set("protected", "1")
		} else {
			params.Set("protected", "0")
		}
	}
	if len(params) == 0 {
		return fmt.Errorf("nothing to update")
	}
	path := fmt.Sprintf("/nodes/%s/storage/%s/content/%s", url.PathEscape(node), url.PathEscape(storage), url.PathEscape(volid))
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) RestoreBackup(ctx context.Context, node, guestType string, vmid int, archive, storage string, force, start bool) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	params := url.Values{
		"vmid": {strconv.Itoa(vmid)},
	}
	if guestType == "lxc" {
		params.Set("ostemplate", strings.TrimSpace(archive))
		params.Set("restore", "1")
	} else {
		params.Set("archive", strings.TrimSpace(archive))
	}
	if strings.TrimSpace(storage) != "" {
		params.Set("storage", strings.TrimSpace(storage))
	}
	if force {
		params.Set("force", "1")
	}
	if start {
		params.Set("start", "1")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s", url.PathEscape(node), guestType)
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) GetClusterBackupJobs(ctx context.Context) ([]BackupJob, error) {
	var out []BackupJob
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/backup", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) CreateClusterBackupJob(ctx context.Context, params url.Values) error {
	return c.DoJSON(ctx, http.MethodPost, "/cluster/backup", params, nil)
}

func (c *Client) UpdateClusterBackupJob(ctx context.Context, jobID string, params url.Values) error {
	path := fmt.Sprintf("/cluster/backup/%s", url.PathEscape(jobID))
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) DeleteClusterBackupJob(ctx context.Context, jobID string) error {
	path := fmt.Sprintf("/cluster/backup/%s", url.PathEscape(jobID))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (c *Client) GetNotBackedUpGuests(ctx context.Context) ([]NotBackedUpGuest, error) {
	var out []NotBackedUpGuest
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/backup-info/not-backed-up", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}
