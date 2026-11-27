package pve

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (c *Client) GetVersion(ctx context.Context) (*VersionInfo, error) {
	var v VersionInfo
	if err := c.DoJSON(ctx, http.MethodGet, "/version", nil, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

func (c *Client) GetClusterStatus(ctx context.Context) ([]ClusterStatusItem, error) {
	var out []ClusterStatusItem
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/status", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetClusterResources(ctx context.Context, resType string) ([]ClusterResource, error) {
	var q url.Values
	if resType != "" {
		q = url.Values{"type": {resType}}
	}
	var out []ClusterResource
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/resources", q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetClusterTasks(ctx context.Context) ([]TaskItem, error) {
	var out []TaskItem
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/tasks", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetClusterLog(ctx context.Context, max int) ([]map[string]any, error) {
	q := url.Values{}
	if max > 0 {
		q.Set("max", strconv.Itoa(max))
	}
	var out []map[string]any
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/log", q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetNextID(ctx context.Context) (int, error) {
	var s FlexInt
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/nextid", nil, &s); err != nil {
		return 0, err
	}
	return int(s), nil
}

// --- Node ---

func (c *Client) GetNodeStatus(ctx context.Context, node string) (*NodeStatus, error) {
	var out NodeStatus
	if err := c.DoJSON(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/status", url.PathEscape(node)), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) NodePowerAction(ctx context.Context, node, command string) error {
	if command != "reboot" && command != "shutdown" {
		return fmt.Errorf("invalid node command: %s", command)
	}
	params := url.Values{"command": {command}}
	return c.DoJSON(ctx, http.MethodPost, fmt.Sprintf("/nodes/%s/status", url.PathEscape(node)), params, nil)
}

func (c *Client) GetNodeRRD(ctx context.Context, node, timeframe, cf string) ([]RRDPoint, error) {
	q := rrdParams(timeframe, cf)
	var out []RRDPoint
	if err := c.DoJSON(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/rrddata", url.PathEscape(node)), q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetNodeTasks(ctx context.Context, node string, limit int, vmid string) ([]TaskItem, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if vmid != "" {
		q.Set("vmid", vmid)
	}
	var out []TaskItem
	if err := c.DoJSON(ctx, http.MethodGet, fmt.Sprintf("/nodes/%s/tasks", url.PathEscape(node)), q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetTaskStatus(ctx context.Context, node, upid string) (*TaskStatus, error) {
	var out TaskStatus
	path := fmt.Sprintf("/nodes/%s/tasks/%s/status", url.PathEscape(node), url.PathEscape(upid))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetTaskLog(ctx context.Context, node, upid string, start, limit int) ([]TaskLogLine, error) {
	q := url.Values{}
	if start > 0 {
		q.Set("start", strconv.Itoa(start))
	}
	if limit > 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	var out []TaskLogLine
	path := fmt.Sprintf("/nodes/%s/tasks/%s/log", url.PathEscape(node), url.PathEscape(upid))
	if err := c.DoJSON(ctx, http.MethodGet, path, q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) StopTask(ctx context.Context, node, upid string) error {
	path := fmt.Sprintf("/nodes/%s/tasks/%s", url.PathEscape(node), url.PathEscape(upid))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}

// --- Guest (Unified QEMU & LXC) ---

func validateGuestType(guestType string) error {
	if guestType != "qemu" && guestType != "lxc" {
		return fmt.Errorf("invalid guest type %q (expected qemu or lxc)", guestType)
	}
	return nil
}

func (c *Client) GetGuestCurrent(ctx context.Context, node, guestType string, vmid int) (map[string]any, error) {
	if err := validateGuestType(guestType); err != nil {
		return nil, err
	}
	var out map[string]any
	path := fmt.Sprintf("/nodes/%s/%s/%d/status/current", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetGuestConfig(ctx context.Context, node, guestType string, vmid int) (map[string]any, error) {
	if err := validateGuestType(guestType); err != nil {
		return nil, err
	}
	var out map[string]any
	path := fmt.Sprintf("/nodes/%s/%s/%d/config", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetGuestPending(ctx context.Context, node, guestType string, vmid int) ([]PendingItem, error) {
	if err := validateGuestType(guestType); err != nil {
		return nil, err
	}
	var out []PendingItem
	path := fmt.Sprintf("/nodes/%s/%s/%d/pending", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) UpdateGuestConfig(ctx context.Context, node, guestType string, vmid int, values map[string]string, deleteKeys, revertKeys []string) error {
	if err := validateGuestType(guestType); err != nil {
		return err
	}
	params := url.Values{}
	for k, v := range values {
		k = strings.TrimSpace(k)
		if k != "" {
			params.Set(k, v)
		}
	}
	if len(deleteKeys) > 0 {
		params.Set("delete", strings.Join(deleteKeys, ","))
	}
	if len(revertKeys) > 0 {
		params.Set("revert", strings.Join(revertKeys, ","))
	}
	if len(params) == 0 {
		return fmt.Errorf("no config parameters provided")
	}
	path := fmt.Sprintf("/nodes/%s/%s/%d/config", url.PathEscape(node), guestType, vmid)
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) ResizeGuestDisk(ctx context.Context, node, guestType string, vmid int, disk, size string) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	params := url.Values{
		"disk": {strings.TrimSpace(disk)},
		"size": {strings.TrimSpace(size)},
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/resize", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodPut, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) RegenerateCloudInit(ctx context.Context, node string, vmid int) error {
	path := fmt.Sprintf("/nodes/%s/qemu/%d/cloudinit", url.PathEscape(node), vmid)
	return c.DoJSON(ctx, http.MethodPut, path, nil, nil)
}

func (c *Client) GetQemuAgentOSInfo(ctx context.Context, node string, vmid int) (map[string]any, error) {
	var resp struct {
		Result map[string]any `json:"result"`
	}
	path := fmt.Sprintf("/nodes/%s/qemu/%d/agent/get-osinfo", url.PathEscape(node), vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Result, nil
}

func (c *Client) GetQemuAgentFSInfo(ctx context.Context, node string, vmid int) ([]map[string]any, error) {
	var resp struct {
		Result []map[string]any `json:"result"`
	}
	path := fmt.Sprintf("/nodes/%s/qemu/%d/agent/get-fsinfo", url.PathEscape(node), vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	return resp.Result, nil
}

func (c *Client) GetGuestRRD(ctx context.Context, node, guestType string, vmid int, timeframe, cf string) ([]RRDPoint, error) {
	if err := validateGuestType(guestType); err != nil {
		return nil, err
	}
	var out []RRDPoint
	path := fmt.Sprintf("/nodes/%s/%s/%d/rrddata", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, rrdParams(timeframe, cf), &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GuestPowerAction(ctx context.Context, node, guestType string, vmid int, action string) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	allowed := map[string]bool{
		"start": true, "shutdown": true, "stop": true, "reboot": true,
		"suspend": guestType == "qemu", "resume": guestType == "qemu", "reset": guestType == "qemu",
	}
	if !allowed[action] {
		return "", fmt.Errorf("unsupported action %q for %s", action, guestType)
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/status/%s", url.PathEscape(node), guestType, vmid, action)
	if err := c.DoJSON(ctx, http.MethodPost, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) DeleteGuest(ctx context.Context, node, guestType string, vmid int, purge, destroyUnref bool) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	q := url.Values{}
	if purge {
		q.Set("purge", "1")
	}
	if destroyUnref {
		q.Set("destroy-unreferenced-disks", "1")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodDelete, path, q, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) SendQemuKey(ctx context.Context, node string, vmid int, key string) error {
	path := fmt.Sprintf("/nodes/%s/qemu/%d/sendkey", url.PathEscape(node), vmid)
	return c.DoJSON(ctx, http.MethodPut, path, url.Values{"key": {key}}, nil)
}

func (c *Client) GetGuestSnapshots(ctx context.Context, node, guestType string, vmid int) ([]SnapshotItem, error) {
	if err := validateGuestType(guestType); err != nil {
		return nil, err
	}
	var out []SnapshotItem
	path := fmt.Sprintf("/nodes/%s/%s/%d/snapshot", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) CreateGuestSnapshot(ctx context.Context, node, guestType string, vmid int, snapname, desc string, vmstate bool) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	params := url.Values{"snapname": {snapname}}
	if desc != "" {
		params.Set("description", desc)
	}
	if vmstate && guestType == "qemu" {
		params.Set("vmstate", "1")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/snapshot", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) RollbackGuestSnapshot(ctx context.Context, node, guestType string, vmid int, snapname string) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/snapshot/%s/rollback", url.PathEscape(node), guestType, vmid, url.PathEscape(snapname))
	if err := c.DoJSON(ctx, http.MethodPost, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) DeleteGuestSnapshot(ctx context.Context, node, guestType string, vmid int, snapname string) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/snapshot/%s", url.PathEscape(node), guestType, vmid, url.PathEscape(snapname))
	if err := c.DoJSON(ctx, http.MethodDelete, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// GetGuestIPs returns live IP addresses for both LXC (/interfaces) and QEMU (guest agent).
func (c *Client) GetGuestIPs(ctx context.Context, node, guestType string, vmid int) ([]GuestIPInfo, error) {
	if guestType == "lxc" {
		var ifaces []LXCInterface
		path := fmt.Sprintf("/nodes/%s/lxc/%d/interfaces", url.PathEscape(node), vmid)
		if err := c.DoJSON(ctx, http.MethodGet, path, nil, &ifaces); err != nil {
			return nil, err
		}
		out := make([]GuestIPInfo, 0, len(ifaces))
		for _, iface := range ifaces {
			if iface.Name == "lo" {
				continue
			}
			info := GuestIPInfo{Interface: iface.Name, MAC: iface.HWAddr, IPv4: []string{}, IPv6: []string{}}
			if iface.Inet != "" {
				info.IPv4 = append(info.IPv4, iface.Inet)
			}
			if iface.Inet6 != "" {
				info.IPv6 = append(info.IPv6, iface.Inet6)
			}
			out = append(out, info)
		}
		return out, nil
	}

	var resp struct {
		Result []QemuAgentNetIf `json:"result"`
	}
	path := fmt.Sprintf("/nodes/%s/qemu/%d/agent/network-get-interfaces", url.PathEscape(node), vmid)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &resp); err != nil {
		return nil, err
	}
	out := make([]GuestIPInfo, 0, len(resp.Result))
	for _, iface := range resp.Result {
		if iface.Name == "lo" || strings.HasPrefix(iface.Name, "Loopback") {
			continue
		}
		info := GuestIPInfo{Interface: iface.Name, MAC: iface.HardwareAddr, IPv4: []string{}, IPv6: []string{}}
		for _, ip := range iface.IPAddresses {
			addr := ip.IPAddress
			if ip.Prefix > 0 {
				addr = fmt.Sprintf("%s/%d", ip.IPAddress, ip.Prefix)
			}
			if ip.IPAddressType == "ipv4" {
				info.IPv4 = append(info.IPv4, addr)
			} else if ip.IPAddressType == "ipv6" {
				info.IPv6 = append(info.IPv6, addr)
			}
		}
		out = append(out, info)
	}
	return out, nil
}

// --- Storage ---

func (c *Client) GetStorageContent(ctx context.Context, node, storage, contentFilter string) ([]StorageContentItem, error) {
	q := url.Values{}
	if contentFilter != "" {
		q.Set("content", contentFilter)
	}
	var out []StorageContentItem
	path := fmt.Sprintf("/nodes/%s/storage/%s/content", url.PathEscape(node), url.PathEscape(storage))
	if err := c.DoJSON(ctx, http.MethodGet, path, q, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// --- Console Proxies ---

func (c *Client) RequestVNCProxy(ctx context.Context, node, targetType string, vmid int, explicitTicket, explicitCSRF string) (*ConsoleProxyResp, bool, error) {
	var path string
	switch targetType {
	case "node":
		path = fmt.Sprintf("/nodes/%s/vncshell", url.PathEscape(node))
	case "qemu", "lxc":
		path = fmt.Sprintf("/nodes/%s/%s/%d/vncproxy", url.PathEscape(node), targetType, vmid)
	default:
		return nil, false, fmt.Errorf("invalid vnc target type: %s", targetType)
	}
	params := url.Values{"websocket": {"1"}}
	if targetType == "qemu" {
		params.Set("generate-password", "1")
	}
	var resp ConsoleProxyResp
	if explicitTicket != "" {
		err := c.doJSONInternal(ctx, http.MethodPost, path, params, &resp, true, explicitTicket, explicitCSRF)
		return &resp, true, err
	}
	err := c.DoJSON(ctx, http.MethodPost, path, params, &resp)
	if err == nil {
		return &resp, c.useTicketAuth(), nil
	}
	if !c.useTicketAuth() && c.HasTicketCredentials() {
		var fallbackResp ConsoleProxyResp
		if fbErr := c.doJSONInternal(ctx, http.MethodPost, path, params, &fallbackResp, true, "", ""); fbErr == nil {
			return &fallbackResp, true, nil
		}
	}
	return nil, false, err
}

// RequestTermProxy requests a PVE termproxy session (node shell, LXC shell, or QEMU serial).
// If API token auth fails due to PVE version quirks and fallback credentials exist, it retries with a Ticket.
func (c *Client) RequestTermProxy(ctx context.Context, node, targetType string, vmid int, explicitTicket, explicitCSRF string) (*ConsoleProxyResp, bool, error) {
	var path string
	switch targetType {
	case "node":
		path = fmt.Sprintf("/nodes/%s/termproxy", url.PathEscape(node))
	case "qemu", "lxc":
		path = fmt.Sprintf("/nodes/%s/%s/%d/termproxy", url.PathEscape(node), targetType, vmid)
	default:
		return nil, false, fmt.Errorf("invalid termproxy target type: %s", targetType)
	}

	var resp ConsoleProxyResp
	if explicitTicket != "" {
		err := c.doJSONInternal(ctx, http.MethodPost, path, nil, &resp, true, explicitTicket, explicitCSRF)
		return &resp, true, err
	}

	err := c.DoJSON(ctx, http.MethodPost, path, nil, &resp)
	if err == nil {
		return &resp, c.useTicketAuth(), nil
	}

	// Automatic fallback from API token to configured ticket credentials
	if !c.useTicketAuth() && c.HasTicketCredentials() {
		var fallbackResp ConsoleProxyResp
		if fbErr := c.doJSONInternal(ctx, http.MethodPost, path, nil, &fallbackResp, true, "", ""); fbErr == nil {
			return &fallbackResp, true, nil
		}
	}
	return nil, false, err
}

func (c *Client) RequestSpiceProxy(ctx context.Context, node, targetType string, vmid int) (map[string]any, error) {
	if err := validateGuestType(targetType); err != nil {
		return nil, err
	}
	var out map[string]any
	path := fmt.Sprintf("/nodes/%s/%s/%d/spiceproxy", url.PathEscape(node), targetType, vmid)
	if err := c.DoJSON(ctx, http.MethodPost, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func rrdParams(timeframe, cf string) url.Values {
	q := url.Values{}
	switch timeframe {
	case "hour", "day", "week", "month", "year":
		q.Set("timeframe", timeframe)
	default:
		q.Set("timeframe", "hour")
	}
	switch strings.ToUpper(cf) {
	case "MAX":
		q.Set("cf", "MAX")
	default:
		q.Set("cf", "AVERAGE")
	}
	return q
}
