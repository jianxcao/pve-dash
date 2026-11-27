package pve

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

// --- Phase 4B: HA High Availability, Node Certificates/ACME & Cluster Resource Mappings ---

var (
	validHASIDRegex     = regexp.MustCompile(`^(vm|ct):[1-9]\d*$`)
	validMappingIDRegex = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{1,63}$`)
	validHAGroupRegex   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,63}$`)
)

func ValidateHASID(sid string) error {
	if !validHASIDRegex.MatchString(sid) {
		return fmt.Errorf("无效的 HA 资源标识 %q（需为 vm:<vmid> 或 ct:<vmid>）", sid)
	}
	return nil
}

func ValidateMappingID(id string) error {
	if !validMappingIDRegex.MatchString(id) {
		return fmt.Errorf("无效的资源映射标识 %q（需以字母开头、2–64 位字母/数字/下划线/连字符）", id)
	}
	return nil
}

func ValidateHAGroupName(group string) error {
	if !validHAGroupRegex.MatchString(group) || strings.Contains(group, "..") {
		return fmt.Errorf("无效的 HA 分组名称 %q", group)
	}
	return nil
}

// --- HA ---

type HAStatusItem struct {
	ID           string    `json:"id"`
	Type         string    `json:"type"` // quorum | master | lrm | service
	Node         string    `json:"node,omitempty"`
	Status       string    `json:"status,omitempty"`
	Quorate      *FlexBool `json:"quorate,omitempty"`
	SID          string    `json:"sid,omitempty"`
	State        string    `json:"state,omitempty"`
	CRMState     string    `json:"crm_state,omitempty"`
	RequestState string    `json:"request_state,omitempty"`
	MaxRestart   *FlexInt  `json:"max_restart,omitempty"`
	MaxRelocate  *FlexInt  `json:"max_relocate,omitempty"`
	Group        string    `json:"group,omitempty"`
	Timestamp    FlexInt   `json:"timestamp,omitempty"`
}

type HAResource struct {
	SID         string   `json:"sid"`
	Type        string   `json:"type,omitempty"`
	State       string   `json:"state,omitempty"`
	Group       string   `json:"group,omitempty"`
	MaxRestart  *FlexInt `json:"max_restart,omitempty"`
	MaxRelocate *FlexInt `json:"max_relocate,omitempty"`
	Comment     string   `json:"comment,omitempty"`
	Digest      string   `json:"digest,omitempty"`
}

type HAGroup struct {
	Group      string    `json:"group"`
	Nodes      string    `json:"nodes"`
	Restricted *FlexBool `json:"restricted,omitempty"`
	NoFailback *FlexBool `json:"nofailback,omitempty"`
	Comment    string    `json:"comment,omitempty"`
	Digest     string    `json:"digest,omitempty"`
}

// HARule represents PVE 9.0+ /cluster/ha/rules entries (replacing legacy HA groups).
type HARule struct {
	Rule      string    `json:"rule"`
	Type      string    `json:"type"`
	Nodes     string    `json:"nodes,omitempty"`
	Resources string    `json:"resources,omitempty"`
	Affinity  string    `json:"affinity,omitempty"`
	Strict    *FlexBool `json:"strict,omitempty"`
	Disable   *FlexBool `json:"disable,omitempty"`
	Comment   string    `json:"comment,omitempty"`
	Digest    string    `json:"digest,omitempty"`
}

func (c *Client) GetHAStatus(ctx context.Context) ([]HAStatusItem, error) {
	var out []HAStatusItem
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/ha/status/current", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []HAStatusItem{}
	}
	return out, nil
}

func (c *Client) ListHAResources(ctx context.Context) ([]HAResource, error) {
	var out []HAResource
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/ha/resources", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []HAResource{}
	}
	return out, nil
}

func (c *Client) ListHAGroups(ctx context.Context) ([]HAGroup, error) {
	var out []HAGroup
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/ha/groups", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []HAGroup{}
	}
	return out, nil
}

func (c *Client) ListHARules(ctx context.Context) ([]HARule, error) {
	var out []HARule
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/ha/rules", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []HARule{}
	}
	return out, nil
}

func (c *Client) CreateHAResource(ctx context.Context, params url.Values) error {
	return c.DoJSON(ctx, http.MethodPost, "/cluster/ha/resources", params, nil)
}

func (c *Client) UpdateHAResource(ctx context.Context, sid string, params url.Values) error {
	if err := ValidateHASID(sid); err != nil {
		return err
	}
	path := fmt.Sprintf("/cluster/ha/resources/%s", url.PathEscape(sid))
	return c.DoJSON(ctx, http.MethodPut, path, params, nil)
}

func (c *Client) DeleteHAResource(ctx context.Context, sid string) error {
	if err := ValidateHASID(sid); err != nil {
		return err
	}
	path := fmt.Sprintf("/cluster/ha/resources/%s", url.PathEscape(sid))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}

// --- Node Certificates & ACME ---

type NodeCertInfo struct {
	Filename      string   `json:"filename"`
	Fingerprint   string   `json:"fingerprint"`
	Issuer        string   `json:"issuer"`
	Subject       string   `json:"subject"`
	SAN           []string `json:"san"`
	NotBefore     FlexInt  `json:"notbefore"`
	NotAfter      FlexInt  `json:"notafter"`
	PublicKeyBits FlexInt  `json:"public-key-bits"`
	PublicKeyType string   `json:"public-key-type"`
}

type ACMEAccount struct {
	Name string `json:"name"`
}

func (c *Client) GetNodeCertificates(ctx context.Context, node string) ([]NodeCertInfo, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	var out []NodeCertInfo
	path := fmt.Sprintf("/nodes/%s/certificates/info", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []NodeCertInfo{}
	}
	for i := range out {
		if out[i].SAN == nil {
			out[i].SAN = []string{}
		}
	}
	return out, nil
}

func (c *Client) ListACMEAccounts(ctx context.Context) ([]ACMEAccount, error) {
	var out []ACMEAccount
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/acme/account", nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []ACMEAccount{}
	}
	return out, nil
}

func (c *Client) GetNodeConfig(ctx context.Context, node string) (map[string]any, error) {
	if err := ValidateNodeName(node); err != nil {
		return nil, err
	}
	var out map[string]any
	path := fmt.Sprintf("/nodes/%s/config", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = map[string]any{}
	}
	return out, nil
}

// ParseNodeACMEConfig extracts ACME account name and configured domains from /nodes/{node}/config.
func ParseNodeACMEConfig(cfg map[string]any) (account string, domains []string) {
	domains = []string{}
	if cfg == nil {
		return "", domains
	}
	seen := map[string]bool{}
	addDomain := func(d string) {
		clean := strings.TrimSpace(d)
		if clean != "" && !seen[clean] {
			seen[clean] = true
			domains = append(domains, clean)
		}
	}
	if raw, ok := cfg["acme"].(string); ok && raw != "" {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if strings.HasPrefix(part, "account=") {
				account = strings.TrimPrefix(part, "account=")
			} else if strings.HasPrefix(part, "domains=") {
				for _, d := range strings.Split(strings.TrimPrefix(part, "domains="), ";") {
					addDomain(d)
				}
			}
		}
	}
	// PVE also stores per-plugin domains as acmedomain0..acmedomain4: "domain=example.com,plugin=cf"
	var keys []string
	for k := range cfg {
		if strings.HasPrefix(k, "acmedomain") {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		if raw, ok := cfg[k].(string); ok {
			for _, part := range strings.Split(raw, ",") {
				part = strings.TrimSpace(part)
				if strings.HasPrefix(part, "domain=") {
					addDomain(strings.TrimPrefix(part, "domain="))
				} else if !strings.Contains(part, "=") && part != "" {
					addDomain(part)
				}
			}
		}
	}
	return account, domains
}

func (c *Client) OrderNodeACMECert(ctx context.Context, node string, force bool) (string, error) {
	if err := ValidateNodeName(node); err != nil {
		return "", err
	}
	params := url.Values{}
	if force {
		params.Set("force", "1")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/certificates/acme/certificate", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPost, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

func (c *Client) RenewNodeACMECert(ctx context.Context, node string, force bool) (string, error) {
	if err := ValidateNodeName(node); err != nil {
		return "", err
	}
	params := url.Values{}
	if force {
		params.Set("force", "1")
	}
	var upid string
	path := fmt.Sprintf("/nodes/%s/certificates/acme/certificate", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodPut, path, params, &upid); err != nil {
		return "", err
	}
	return upid, nil
}

// --- Cluster Resource Mappings (PVE 8.0+ PCI / USB, PVE 8.2+ Dir) ---

type ResourceMappingItem struct {
	ID                   string    `json:"id"`
	Kind                 string    `json:"kind,omitempty"`
	Description          string    `json:"description,omitempty"`
	Map                  []string  `json:"map"`
	Mdev                 *FlexBool `json:"mdev,omitempty"`
	LiveMigrationCapable *FlexBool `json:"live-migration-capable,omitempty"`
	Digest               string    `json:"digest,omitempty"`
}

func ValidateMappingKind(kind string) error {
	if kind != "pci" && kind != "usb" && kind != "dir" {
		return fmt.Errorf("不支持的资源映射类型 %q（仅支持 pci、usb、dir）", kind)
	}
	return nil
}

func (c *Client) ListResourceMappings(ctx context.Context, kind string) ([]ResourceMappingItem, error) {
	if err := ValidateMappingKind(kind); err != nil {
		return nil, err
	}
	var out []ResourceMappingItem
	path := fmt.Sprintf("/cluster/mapping/%s", kind)
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	if out == nil {
		out = []ResourceMappingItem{}
	}
	for i := range out {
		out[i].Kind = kind
		if out[i].Map == nil {
			out[i].Map = []string{}
		}
	}
	return out, nil
}

func (c *Client) CreateResourceMapping(ctx context.Context, kind string, params url.Values) error {
	if err := ValidateMappingKind(kind); err != nil {
		return err
	}
	path := fmt.Sprintf("/cluster/mapping/%s", kind)
	return c.DoJSON(ctx, http.MethodPost, path, params, nil)
}

func (c *Client) DeleteResourceMapping(ctx context.Context, kind, id string) error {
	if err := ValidateMappingKind(kind); err != nil {
		return err
	}
	if err := ValidateMappingID(id); err != nil {
		return err
	}
	path := fmt.Sprintf("/cluster/mapping/%s/%s", kind, url.PathEscape(id))
	return c.DoJSON(ctx, http.MethodDelete, path, nil, nil)
}
