package pve

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// --- Phase 3: Node Network Management ---

var validIfaceRegex = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,31}$`)

func ValidateIfaceName(iface string) error {
	if !validIfaceRegex.MatchString(strings.TrimSpace(iface)) {
		return fmt.Errorf("无效的网卡/接口名称 %q", iface)
	}
	return nil
}

func (c *Client) CreateNodeNetwork(ctx context.Context, node string, params url.Values) error {
	path := fmt.Sprintf("/nodes/%s/network", url.PathEscape(node))
	return c.DoJSON(ctx, http.MethodPost, path, params, nil)
}

func (c *Client) UpdateNodeNetwork(ctx context.Context, node, iface string, params url.Values) error {
	if err := ValidateIfaceName(iface); err != nil {
		return err
	}
	path := fmt.Sprintf("/nodes/%s/network/%s", url.PathEscape(node), url.PathEscape(iface))
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) DeleteNodeNetwork(ctx context.Context, node, iface string) error {
	if err := ValidateIfaceName(iface); err != nil {
		return err
	}
	path := fmt.Sprintf("/nodes/%s/network/%s", url.PathEscape(node), url.PathEscape(iface))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (c *Client) ApplyNodeNetwork(ctx context.Context, node string) (string, error) {
	var upid string
	path := fmt.Sprintf("/nodes/%s/network", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPut, path, nil, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) RevertNodeNetwork(ctx context.Context, node string) error {
	path := fmt.Sprintf("/nodes/%s/network", url.PathEscape(node))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}

// --- Phase 3: Resource Pools & Guest Migrate ---

type PoolSummary struct {
	PoolID  string       `json:"poolid"`
	Comment string       `json:"comment,omitempty"`
	Members []PoolMember `json:"members,omitempty"`
}

type PoolMember struct {
	ID       string   `json:"id"`
	Type     string   `json:"type"` // qemu | lxc | storage
	Node     string   `json:"node,omitempty"`
	VMID     FlexInt  `json:"vmid,omitempty"`
	Name     string   `json:"name,omitempty"`
	Storage  string   `json:"storage,omitempty"`
	Status   string   `json:"status,omitempty"`
	Template FlexBool `json:"template,omitempty"`
}

type PoolDetail struct {
	Comment string       `json:"comment,omitempty"`
	Members []PoolMember `json:"members"`
}

var validPoolIDRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

func ValidatePoolID(poolid string) error {
	if !validPoolIDRegex.MatchString(strings.TrimSpace(poolid)) {
		return fmt.Errorf("无效的资源池名称 %q（仅允许字母/数字/点/下划线/短横线）", poolid)
	}
	return nil
}

func (c *Client) ListPools(ctx context.Context) ([]PoolSummary, error) {
	var out []PoolSummary
	if err := c.DoJSON(ctx, http.MethodGet, "/pools", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []PoolSummary{}
	}
	return out, nil
}

func (c *Client) GetPool(ctx context.Context, poolid string) (*PoolDetail, error) {
	var out PoolDetail
	path := fmt.Sprintf("/pools/%s", url.PathEscape(poolid))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out.Members == nil {
		out.Members = []PoolMember{}
	}
	return &out, nil
}

func (c *Client) CreatePool(ctx context.Context, poolid, comment string) error {
	if err := ValidatePoolID(poolid); err != nil {
		return err
	}
	params := url.Values{"poolid": {strings.TrimSpace(poolid)}}
	if strings.TrimSpace(comment) != "" {
		params.Set("comment", strings.TrimSpace(comment))
	}
	return c.DoJSON(ctx, http.MethodPost, "/pools", params, nil)
}

func (c *Client) UpdatePool(ctx context.Context, poolid string, comment *string, vms, storage string, del, allowMove bool) error {
	if err := ValidatePoolID(poolid); err != nil {
		return err
	}
	params := url.Values{}
	if comment != nil {
		params.Set("comment", strings.TrimSpace(*comment))
	}
	if strings.TrimSpace(vms) != "" {
		params.Set("vms", strings.TrimSpace(vms))
	}
	if strings.TrimSpace(storage) != "" {
		params.Set("storage", strings.TrimSpace(storage))
	}
	if del {
		params.Set("delete", "1")
	}
	if allowMove {
		params.Set("allow-move", "1")
	}
	path := fmt.Sprintf("/pools/%s", url.PathEscape(poolid))
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) DeletePool(ctx context.Context, poolid string) error {
	if err := ValidatePoolID(poolid); err != nil {
		return err
	}
	path := fmt.Sprintf("/pools/%s", url.PathEscape(poolid))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}

func (c *Client) MigrateGuest(ctx context.Context, node, guestType string, vmid int, targetNode string, online, restart bool) (string, error) {
	if err := validateGuestType(guestType); err != nil {
		return "", err
	}
	if strings.TrimSpace(targetNode) == "" {
		return "", fmt.Errorf("target node is required")
	}
	params := url.Values{"target": {strings.TrimSpace(targetNode)}}
	if guestType == "qemu" && online {
		params.Set("online", "1")
	}
	if guestType == "lxc" && restart {
		params.Set("restart", "1")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/%s/%d/migrate", url.PathEscape(node), guestType, vmid)
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// MergeGuestTags merges, removes, or replaces Proxmox semicolon-separated tags deterministically.
func MergeGuestTags(existingRaw, mode string, delta []string) string {
	set := map[string]bool{}
	for _, t := range strings.FieldsFunc(existingRaw, func(r rune) bool { return r == ';' || r == ',' || r == ' ' }) {
		clean := strings.TrimSpace(t)
		if clean != "" {
			set[clean] = true
		}
	}
	switch mode {
	case "replace":
		set = map[string]bool{}
		for _, t := range delta {
			if clean := strings.TrimSpace(t); clean != "" {
				set[clean] = true
			}
		}
	case "remove":
		for _, t := range delta {
			delete(set, strings.TrimSpace(t))
		}
	default: // add
		for _, t := range delta {
			if clean := strings.TrimSpace(t); clean != "" {
				set[clean] = true
			}
		}
	}
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return strings.Join(out, ";")
}

// --- Phase 3: 3-Tier Firewall (Cluster / Node / Guest) ---

type FirewallOptions struct {
	Enable    FlexBool `json:"enable"`
	PolicyIn  string   `json:"policy_in,omitempty"`
	PolicyOut string   `json:"policy_out,omitempty"`
	PolicyFwd string   `json:"policy_forward,omitempty"`
	Ebtables  FlexBool `json:"ebtables,omitempty"`
	DHCP      FlexBool `json:"dhcp,omitempty"`
	NDP       FlexBool `json:"ndp,omitempty"`
	MACFilter FlexBool `json:"macfilter,omitempty"`
	IPFilter  FlexBool `json:"ipfilter,omitempty"`
	LogLevelIn  string `json:"log_level_in,omitempty"`
	LogLevelOut string `json:"log_level_out,omitempty"`
	Digest    string   `json:"digest,omitempty"`
}

type FirewallRule struct {
	Pos     FlexInt  `json:"pos"`
	Type    string   `json:"type"`   // in | out | forward | group
	Action  string   `json:"action"` // ACCEPT | DROP | REJECT | <security group>
	Enable  FlexBool `json:"enable"`
	Macro   string   `json:"macro,omitempty"`
	Proto   string   `json:"proto,omitempty"`
	Source  string   `json:"source,omitempty"`
	Dest    string   `json:"dest,omitempty"`
	SPort   string   `json:"sport,omitempty"`
	DPort   string   `json:"dport,omitempty"`
	Iface   string   `json:"iface,omitempty"`
	Log     string   `json:"log,omitempty"`
	Comment string   `json:"comment,omitempty"`
	Digest  string   `json:"digest,omitempty"`
}

type FirewallAlias struct {
	Name    string `json:"name"`
	CIDR    string `json:"cidr"`
	Comment string `json:"comment,omitempty"`
	Digest  string `json:"digest,omitempty"`
}

type FirewallIPSet struct {
	Name    string `json:"name"`
	Comment string `json:"comment,omitempty"`
	Digest  string `json:"digest,omitempty"`
}

type FirewallGroup struct {
	Group   string `json:"group"`
	Comment string `json:"comment,omitempty"`
	Digest  string `json:"digest,omitempty"`
}

func BuildFirewallScopePath(scope, node, guestType string, vmid int) (string, error) {
	switch scope {
	case "cluster":
		return "/cluster/firewall", nil
	case "node":
		if strings.TrimSpace(node) == "" {
			return "", fmt.Errorf("node is required for node firewall")
		}
		return fmt.Sprintf("/nodes/%s/firewall", url.PathEscape(node)), nil
	case "guest":
		if err := validateGuestType(guestType); err != nil {
			return "", err
		}
		if strings.TrimSpace(node) == "" || vmid <= 0 {
			return "", fmt.Errorf("node and vmid are required for guest firewall")
		}
		return fmt.Sprintf("/nodes/%s/%s/%d/firewall", url.PathEscape(node), guestType, vmid), nil
	default:
		return "", fmt.Errorf("invalid firewall scope: %s", scope)
	}
}

func (c *Client) GetFirewallOptions(ctx context.Context, scopePath string) (*FirewallOptions, error) {
	var out FirewallOptions
	if err := c.DoJSON(ctx, http.MethodGet, scopePath+"/options", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateFirewallOptions(ctx context.Context, scopePath string, params url.Values) error {
	return c.DoJSON(ctx, http.MethodPut, scopePath+"/options", params, nil)
}

func (c *Client) ListFirewallRules(ctx context.Context, scopePath string) ([]FirewallRule, error) {
	var out []FirewallRule
	if err := c.DoJSON(ctx, http.MethodGet, scopePath+"/rules", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []FirewallRule{}
	}
	return out, nil
}

func (c *Client) CreateFirewallRule(ctx context.Context, scopePath string, params url.Values) error {
	return c.DoJSON(ctx, http.MethodPost, scopePath+"/rules", params, nil)
}

func (c *Client) UpdateFirewallRule(ctx context.Context, scopePath string, pos int, params url.Values) error {
	if pos < 0 {
		return fmt.Errorf("invalid firewall rule position: %d", pos)
	}
	return c.DoJSON(ctx, http.MethodPut, scopePath+"/rules/"+strconv.Itoa(pos), params, nil)
}

func (c *Client) DeleteFirewallRule(ctx context.Context, scopePath string, pos int) error {
	if pos < 0 {
		return fmt.Errorf("invalid firewall rule position: %d", pos)
	}
	return c.DoJSON(ctx, http.MethodDelete, scopePath+"/rules/"+strconv.Itoa(pos), nil, nil)
}

func (c *Client) ListClusterFirewallAliases(ctx context.Context) ([]FirewallAlias, error) {
	var out []FirewallAlias
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/firewall/aliases", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []FirewallAlias{}
	}
	return out, nil
}

func (c *Client) ListClusterFirewallIPSets(ctx context.Context) ([]FirewallIPSet, error) {
	var out []FirewallIPSet
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/firewall/ipset", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []FirewallIPSet{}
	}
	return out, nil
}

func (c *Client) ListClusterFirewallGroups(ctx context.Context) ([]FirewallGroup, error) {
	var out []FirewallGroup
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/firewall/groups", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []FirewallGroup{}
	}
	return out, nil
}
