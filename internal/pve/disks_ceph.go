package pve

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// --- Phase 4A: Node Disk Stacks (ZFS / LVM / LVM-Thin / Directory), Ceph & Storage Config CRUD ---

var (
	// Matches PVE::JSONSchema::parse_id (min length 2, starts with letter, ends with alphanumeric)
	validStorageIDRegex = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,62}[A-Za-z0-9]$`)
	validZFSNameRegex   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]{0,63}$`)
)

func ValidateStorageID(id string) error {
	if !validStorageIDRegex.MatchString(id) || strings.Contains(id, "..") {
		return fmt.Errorf("无效的存储池标识 %q（长度至少 2 位，需以字母开头、字母或数字结尾，仅含字母/数字/点/下划线/短横线）", id)
	}
	return nil
}

func ValidateZFSName(name string) error {
	if !validZFSNameRegex.MatchString(name) || strings.Contains(name, "..") {
		return fmt.Errorf("无效的 ZFS 池名称 %q", name)
	}
	return nil
}

// --- ZFS ---

type ZFSVDevNode struct {
	Name     string        `json:"name"`
	State    string        `json:"state,omitempty"`
	Read     FlexInt       `json:"read,omitempty"`
	Write    FlexInt       `json:"write,omitempty"`
	CKSum    FlexInt       `json:"cksum,omitempty"`
	Msg      string        `json:"msg,omitempty"`
	Leaf     FlexInt       `json:"leaf,omitempty"`
	Children []ZFSVDevNode `json:"children,omitempty"`
}

type ZFSPoolSummary struct {
	Name     string        `json:"name"`
	Health   string        `json:"health"`
	Size     FlexInt       `json:"size"`
	Alloc    FlexInt       `json:"alloc"`
	Free     FlexInt       `json:"free"`
	Frag     FlexInt       `json:"frag"`
	Dedup    FlexFloat     `json:"dedup"`
	Scan     string        `json:"scan,omitempty"`
	Errors   string        `json:"errors,omitempty"`
	Children []ZFSVDevNode `json:"children,omitempty"`
}

type ZFSPoolDetail struct {
	Name     string        `json:"name"`
	State    string        `json:"state"`
	Scan     string        `json:"scan,omitempty"`
	Errors   string        `json:"errors,omitempty"`
	Action   string        `json:"action,omitempty"`
	Children []ZFSVDevNode `json:"children,omitempty"`
}

func (c *Client) ListNodeZFS(ctx context.Context, node string) ([]ZFSPoolSummary, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	var out []ZFSPoolSummary
	path := fmt.Sprintf("/nodes/%s/disks/zfs", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []ZFSPoolSummary{}
	}
	return out, nil
}

func (c *Client) GetNodeZFSDetail(ctx context.Context, node, name string) (*ZFSPoolDetail, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	if err := ValidateZFSName(name); err != nil {
		return nil, err
	}
	var out ZFSPoolDetail
	path := fmt.Sprintf("/nodes/%s/disks/zfs/%s", url.PathEscape(node), url.PathEscape(name))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// --- LVM / LVM-Thin / Directory ---

type LVMChild struct {
	Name string  `json:"name"`
	Size FlexInt `json:"size"`
	Free FlexInt `json:"free"`
	Leaf FlexInt `json:"leaf,omitempty"`
}

type LVMVolumeGroup struct {
	Name     string     `json:"name"`
	Size     FlexInt    `json:"size"`
	Free     FlexInt    `json:"free"`
	LvCount  FlexInt    `json:"lvcount"`
	Children []LVMChild `json:"children,omitempty"`
}

func (c *Client) ListNodeLVM(ctx context.Context, node string) ([]LVMVolumeGroup, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	var resp struct {
		Children []LVMVolumeGroup `json:"children"`
	}
	path := fmt.Sprintf("/nodes/%s/disks/lvm", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	if resp.Children == nil {
		return []LVMVolumeGroup{}, nil
	}
	return resp.Children, nil
}

type LVMThinPool struct {
	Lv           string  `json:"lv"`
	Vg           string  `json:"vg"`
	LvSize       FlexInt `json:"lv_size"`
	Used         FlexInt `json:"used"`
	MetadataSize FlexInt `json:"metadata_size"`
	MetadataUsed FlexInt `json:"metadata_used"`
	LvState      string  `json:"lv_state,omitempty"`
}

func (c *Client) ListNodeLVMThin(ctx context.Context, node string) ([]LVMThinPool, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	var out []LVMThinPool
	path := fmt.Sprintf("/nodes/%s/disks/lvmthin", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []LVMThinPool{}
	}
	return out, nil
}

type DirectoryMount struct {
	Path     string `json:"path"`
	Device   string `json:"device"`
	Type     string `json:"type"`
	Options  string `json:"options,omitempty"`
	UnitFile string `json:"unitfile,omitempty"`
}

func (c *Client) ListNodeDirectory(ctx context.Context, node string) ([]DirectoryMount, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	var out []DirectoryMount
	path := fmt.Sprintf("/nodes/%s/disks/directory", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []DirectoryMount{}
	}
	return out, nil
}

// --- Ceph Monitoring (Capability-Aware Read-Only) ---

type CephPoolItem struct {
	PoolName    string    `json:"pool_name"`
	Pool        FlexInt   `json:"pool"`
	Size        FlexInt   `json:"size"`
	MinSize     FlexInt   `json:"min_size"`
	PGNum       FlexInt   `json:"pg_num"`
	BytesUsed   FlexInt   `json:"bytes_used"`
	PercentUsed FlexFloat `json:"percent_used"`
	CrushRule   string    `json:"crush_rule_name,omitempty"`
}

type CephMonItem struct {
	Name   string   `json:"name"`
	Host   string   `json:"host,omitempty"`
	Addr   string   `json:"addr,omitempty"`
	Rank   FlexInt  `json:"rank"`
	Quorum FlexBool `json:"quorum"`
	State  string   `json:"state,omitempty"`
}

type CephOverview struct {
	Installed      bool           `json:"installed"`
	Reason         string         `json:"reason,omitempty"`
	Health         string         `json:"health,omitempty"`
	HealthMessages []string       `json:"healthMessages"`
	MonCount       int            `json:"monCount"`
	QuorumCount    int            `json:"quorumCount"`
	MgrActive      string         `json:"mgrActive,omitempty"`
	OSDTotal       int            `json:"osdTotal"`
	OSDUp          int            `json:"osdUp"`
	OSDIn          int            `json:"osdIn"`
	PGTotal        int            `json:"pgTotal"`
	BytesTotal     int64          `json:"bytesTotal"`
	BytesUsed      int64          `json:"bytesUsed"`
	BytesAvail     int64          `json:"bytesAvail"`
	ReadBps        int64          `json:"readBps"`
	WriteBps       int64          `json:"writeBps"`
	ReadOps        int64          `json:"readOps"`
	WriteOps       int64          `json:"writeOps"`
	Pools          []CephPoolItem `json:"pools"`
	Monitors       []CephMonItem  `json:"monitors"`
}

// IsCephNotInstalledError strictly distinguishes unconfigured/uninstalled Ceph from live Ceph outages.
func IsCephNotInstalledError(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *APIError
	if errors.As(err, &apiErr) {
		low := strings.ToLower(apiErr.Body + " " + apiErr.Status)
		if apiErr.StatusCode == http.StatusNotImplemented || apiErr.StatusCode == http.StatusNotFound {
			return true
		}
		if apiErr.StatusCode == http.StatusInternalServerError {
			for _, kw := range []string{
				"not installed",
				"not initialized",
				"not enabled",
				"no ceph",
				"missing '/etc/pve/ceph.conf'",
			} {
				if strings.Contains(low, kw) {
					return true
				}
			}
		}
	}
	return false
}

func (c *Client) GetNodeCephOverview(ctx context.Context, node string) (*CephOverview, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	out := &CephOverview{
		HealthMessages: []string{},
		Pools:          []CephPoolItem{},
		Monitors:       []CephMonItem{},
	}

	var rawStatus map[string]json.RawMessage
	statusPath := fmt.Sprintf("/nodes/%s/ceph/status", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, statusPath, nil, &rawStatus); err != nil {
		if IsCephNotInstalledError(err) {
			out.Installed = false
			out.Reason = "当前节点未安装或未初始化 Ceph 集群"
			return out, nil
		}
		return nil, err
	}

	out.Installed = true

	// Parse health
	if b, ok := rawStatus["health"]; ok {
		var h struct {
			Status string `json:"status"`
			Checks map[string]struct {
				Severity string `json:"severity"`
				Summary  struct {
					Message string `json:"message"`
				} `json:"summary"`
			} `json:"checks"`
		}
		if json.Unmarshal(b, &h) == nil {
			out.Health = h.Status
			for k, chk := range h.Checks {
				msg := strings.TrimSpace(chk.Summary.Message)
				if msg != "" {
					out.HealthMessages = append(out.HealthMessages, fmt.Sprintf("[%s] %s: %s", chk.Severity, k, msg))
				}
			}
			sort.Strings(out.HealthMessages)
		}
	}

	// Parse monmap & quorum
	if b, ok := rawStatus["monmap"]; ok {
		var mm struct {
			NumMons int `json:"num_mons"`
			Mons    []struct {
				Name string `json:"name"`
			} `json:"mons"`
		}
		if json.Unmarshal(b, &mm) == nil {
			if mm.NumMons > 0 {
				out.MonCount = mm.NumMons
			} else {
				out.MonCount = len(mm.Mons)
			}
		}
	}
	if b, ok := rawStatus["quorum"]; ok {
		var q []int
		if json.Unmarshal(b, &q) == nil {
			out.QuorumCount = len(q)
		}
	}

	// Parse mgrmap
	if b, ok := rawStatus["mgrmap"]; ok {
		var mgr struct {
			ActiveName string `json:"active_name"`
		}
		if json.Unmarshal(b, &mgr) == nil {
			out.MgrActive = mgr.ActiveName
		}
	}

	// Parse osdmap (supports both flat and nested osdmap.osdmap formats across Ceph releases)
	if b, ok := rawStatus["osdmap"]; ok {
		var om struct {
			NumOSDs   int `json:"num_osds"`
			NumUpOSDs int `json:"num_up_osds"`
			NumInOSDs int `json:"num_in_osds"`
			Nested    *struct {
				NumOSDs   int `json:"num_osds"`
				NumUpOSDs int `json:"num_up_osds"`
				NumInOSDs int `json:"num_in_osds"`
			} `json:"osdmap"`
		}
		if json.Unmarshal(b, &om) == nil {
			if om.Nested != nil {
				out.OSDTotal = om.Nested.NumOSDs
				out.OSDUp = om.Nested.NumUpOSDs
				out.OSDIn = om.Nested.NumInOSDs
			} else {
				out.OSDTotal = om.NumOSDs
				out.OSDUp = om.NumUpOSDs
				out.OSDIn = om.NumInOSDs
			}
		}
	}

	// Parse pgmap
	if b, ok := rawStatus["pgmap"]; ok {
		var pg struct {
			NumPGs        int   `json:"num_pgs"`
			BytesTotal    int64 `json:"bytes_total"`
			BytesUsed     int64 `json:"bytes_used"`
			BytesAvail    int64 `json:"bytes_avail"`
			ReadBytesSec  int64 `json:"read_bytes_sec"`
			WriteBytesSec int64 `json:"write_bytes_sec"`
			ReadOpPerSec  int64 `json:"read_op_per_sec"`
			WriteOpPerSec int64 `json:"write_op_per_sec"`
		}
		if json.Unmarshal(b, &pg) == nil {
			out.PGTotal = pg.NumPGs
			out.BytesTotal = pg.BytesTotal
			out.BytesUsed = pg.BytesUsed
			out.BytesAvail = pg.BytesAvail
			out.ReadBps = pg.ReadBytesSec
			out.WriteBps = pg.WriteBytesSec
			out.ReadOps = pg.ReadOpPerSec
			out.WriteOps = pg.WriteOpPerSec
		}
	}

	// Note: singular /ceph/pool works across PVE 7.4, 8.x, and 9.x (/ceph/pools was removed in PVE 8.0)
	var pools []CephPoolItem
	if err := c.DoJSON(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/ceph/pool", url.PathEscape(node)), nil, &pools); err == nil && pools != nil {
		sort.Slice(pools, func(i, j int) bool { return pools[i].PoolName < pools[j].PoolName })
		out.Pools = pools
	}
	var mons []CephMonItem
	if err := c.DoJSON(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/ceph/mon", url.PathEscape(node)), nil, &mons); err == nil && mons != nil {
		sort.Slice(mons, func(i, j int) bool { return mons[i].Name < mons[j].Name })
		out.Monitors = mons
	}

	return out, nil
}

// --- Cluster Storage Definitions (/storage CRUD) ---

type StorageConfig struct {
	Storage             string    `json:"storage"`
	Type                string    `json:"type"`
	Content             string    `json:"content,omitempty"`
	Path                string    `json:"path,omitempty"`
	Server              string    `json:"server,omitempty"`
	Export              string    `json:"export,omitempty"`
	Share               string    `json:"share,omitempty"`
	Username            string    `json:"username,omitempty"`
	Datastore           string    `json:"datastore,omitempty"`
	Fingerprint         string    `json:"fingerprint,omitempty"`
	Pool                string    `json:"pool,omitempty"`
	VGName              string    `json:"vgname,omitempty"`
	ThinPool            string    `json:"thinpool,omitempty"`
	Nodes               string    `json:"nodes,omitempty"`
	Shared              *FlexBool `json:"shared,omitempty"`
	Disable             *FlexBool `json:"disable,omitempty"`
	PruneBackups        string    `json:"prune-backups,omitempty"`
	MaxProtectedBackups FlexInt   `json:"max-protected-backups,omitempty"`
	Digest              string    `json:"digest,omitempty"`
}

func (c *Client) ListStorageConfigs(ctx context.Context) ([]StorageConfig, error) {
	var out []StorageConfig
	if err := c.DoJSON(ctx, http.MethodGet, "/storage", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []StorageConfig{}
	}
	return out, nil
}

func (c *Client) GetStorageConfig(ctx context.Context, storageID string) (*StorageConfig, error) {
	if err := ValidateStorageID(storageID); err != nil {
		return nil, err
	}
	var out StorageConfig
	path := fmt.Sprintf("/storage/%s", url.PathEscape(storageID))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CreateStorageConfig(ctx context.Context, params url.Values) error {
	return c.DoJSON(ctx, http.MethodPost, "/storage", params, nil)
}

func (c *Client) UpdateStorageConfig(ctx context.Context, storageID string, params url.Values) error {
	if err := ValidateStorageID(storageID); err != nil {
		return err
	}
	path := fmt.Sprintf("/storage/%s", url.PathEscape(storageID))
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) DeleteStorageConfig(ctx context.Context, storageID string) error {
	if err := ValidateStorageID(storageID); err != nil {
		return err
	}
	path := fmt.Sprintf("/storage/%s", url.PathEscape(storageID))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}
