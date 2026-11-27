package pve

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// FlexInt unmarshals JSON numbers or numeric strings (PVE returns "8192" in qemu config and 4096 in lxc config).
type FlexInt int64

func (f *FlexInt) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	if strings.HasPrefix(s, `"`) {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		str = strings.TrimSpace(str)
		if str == "" {
			*f = 0
			return nil
		}
		if v, err := strconv.ParseInt(str, 10, 64); err == nil {
			*f = FlexInt(v)
			return nil
		}
		if fv, err := strconv.ParseFloat(str, 64); err == nil {
			*f = FlexInt(int64(fv))
			return nil
		}
		return fmt.Errorf("invalid FlexInt string %q", str)
	}
	var num float64
	if err := json.Unmarshal(b, &num); err != nil {
		return err
	}
	*f = FlexInt(int64(num))
	return nil
}

// FlexFloat unmarshals JSON numbers or numeric strings.
type FlexFloat float64

func (f *FlexFloat) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(string(b))
	if s == "" || s == "null" {
		*f = 0
		return nil
	}
	if strings.HasPrefix(s, `"`) {
		var str string
		if err := json.Unmarshal(b, &str); err != nil {
			return err
		}
		str = strings.TrimSpace(str)
		if str == "" {
			*f = 0
			return nil
		}
		v, err := strconv.ParseFloat(str, 64)
		if err != nil {
			return err
		}
		*f = FlexFloat(v)
		return nil
	}
	var num float64
	if err := json.Unmarshal(b, &num); err != nil {
		return err
	}
	*f = FlexFloat(num)
	return nil
}

// FlexBool handles 0/1, "0"/"1", true/false.
type FlexBool bool

func (f *FlexBool) UnmarshalJSON(b []byte) error {
	s := strings.TrimSpace(strings.Trim(string(b), `"`))
	switch strings.ToLower(s) {
	case "1", "true", "yes", "on":
		*f = true
	default:
		*f = false
	}
	return nil
}

type VersionInfo struct {
	Version string `json:"version"`
	Release string `json:"release"`
	RepoID  string `json:"repoid"`
}

type FeatureFlags struct {
	ResourceMappingPciUsb bool `json:"resourceMappingPciUsb"`
	ResourceMappingDir    bool `json:"resourceMappingDir"`
	SDNCore               bool `json:"sdnCore"`
	SDNFabrics            bool `json:"sdnFabrics"`
	NotificationsV2       bool `json:"notificationsV2"`
	ImportEsxiOva         bool `json:"importEsxiOva"`
	HAGroups              bool `json:"haGroups"`
	HARules               bool `json:"haRules"`
	LXCOciImages          bool `json:"lxcOciImages"`
	APTDeb822             bool `json:"aptDeb822"`
	ACLStrictPVE9         bool `json:"aclStrictPve9"`
	QemuMonitorDeprecated bool `json:"qemuMonitorDeprecated"`
	RemoteMigrate         bool `json:"remoteMigrate"`
}

type Capabilities struct {
	PVEVersion string       `json:"pveVersion"`
	Release    string       `json:"release"`
	Major      int          `json:"major"`
	Minor      int          `json:"minor"`
	Patch      int          `json:"patch"`
	IsCluster  bool         `json:"isCluster"`
	Features   FeatureFlags `json:"features"`
}

type ClusterStatusItem struct {
	ID      string   `json:"id"`
	Type    string   `json:"type"` // cluster | node
	Name    string   `json:"name"`
	IP      string   `json:"ip,omitempty"`
	Online  FlexBool `json:"online,omitempty"`
	Local   FlexBool `json:"local,omitempty"`
	NodeID  FlexInt  `json:"nodeid,omitempty"`
	Nodes   FlexInt  `json:"nodes,omitempty"`
	Quorate FlexBool `json:"quorate,omitempty"`
	Version FlexInt  `json:"version,omitempty"`
}

type ClusterResource struct {
	ID         string    `json:"id"`
	Type       string    `json:"type"` // node | qemu | lxc | storage | pool | sdn | network
	Node       string    `json:"node,omitempty"`
	VMID       FlexInt   `json:"vmid,omitempty"`
	Name       string    `json:"name,omitempty"`
	Status     string    `json:"status,omitempty"`
	Template   FlexBool  `json:"template,omitempty"`
	Tags       string    `json:"tags,omitempty"`
	Pool       string    `json:"pool,omitempty"`
	Storage    string    `json:"storage,omitempty"`
	PluginType string    `json:"plugintype,omitempty"`
	Content    string    `json:"content,omitempty"`
	Shared     FlexBool  `json:"shared,omitempty"`
	CPU        FlexFloat `json:"cpu,omitempty"`
	MaxCPU     FlexInt   `json:"maxcpu,omitempty"`
	Mem        FlexInt   `json:"mem,omitempty"`
	MaxMem     FlexInt   `json:"maxmem,omitempty"`
	Disk       FlexInt   `json:"disk,omitempty"`
	MaxDisk    FlexInt   `json:"maxdisk,omitempty"`
	DiskRead   FlexInt   `json:"diskread,omitempty"`
	DiskWrite  FlexInt   `json:"diskwrite,omitempty"`
	NetIn      FlexInt   `json:"netin,omitempty"`
	NetOut     FlexInt   `json:"netout,omitempty"`
	Uptime     FlexInt   `json:"uptime,omitempty"`
	HAState    string    `json:"hastate,omitempty"`
	CgroupMode FlexInt   `json:"cgroup-mode,omitempty"`
}

type NodeStatus struct {
	CPU     FlexFloat `json:"cpu"`
	Wait    FlexFloat `json:"wait"`
	Uptime  FlexInt   `json:"uptime"`
	LoadAvg []string  `json:"loadavg"`
	KVersion string   `json:"kversion"`
	PVEVersion string `json:"pveversion"`
	CPUInfo struct {
		Cores   FlexInt   `json:"cores"`
		CPUs    FlexInt   `json:"cpus"`
		Sockets FlexInt   `json:"sockets"`
		Model   string    `json:"model"`
		MHz     FlexFloat `json:"mhz"`
		Vendor  string    `json:"vendor"`
	} `json:"cpuinfo"`
	Memory struct {
		Total     FlexInt `json:"total"`
		Used      FlexInt `json:"used"`
		Free      FlexInt `json:"free"`
		Available FlexInt `json:"available"`
	} `json:"memory"`
	Swap struct {
		Total FlexInt `json:"total"`
		Used  FlexInt `json:"used"`
		Free  FlexInt `json:"free"`
	} `json:"swap"`
	RootFS struct {
		Total FlexInt `json:"total"`
		Used  FlexInt `json:"used"`
		Free  FlexInt `json:"free"`
		Avail FlexInt `json:"avail"`
	} `json:"rootfs"`
	CurrentKernel struct {
		Release string `json:"release"`
		Machine string `json:"machine"`
	} `json:"current-kernel"`
	// Optional community sensor mod fields (present on modded homelab PVEs)
	ThermalState string `json:"thermalstate,omitempty"`
	CPUFreq      string `json:"cpuFreq,omitempty"`
}

type SensorReading struct {
	Label string  `json:"label"`
	Value float64 `json:"value"`
	Unit  string  `json:"unit"`
}

type RRDPoint struct {
	Time      FlexInt   `json:"time"`
	CPU       FlexFloat `json:"cpu,omitempty"`
	MaxCPU    FlexFloat `json:"maxcpu,omitempty"`
	Mem       FlexFloat `json:"mem,omitempty"`
	MemUsed   FlexFloat `json:"memused,omitempty"`
	MemTotal  FlexFloat `json:"memtotal,omitempty"`
	MaxMem    FlexFloat `json:"maxmem,omitempty"`
	NetIn     FlexFloat `json:"netin,omitempty"`
	NetOut    FlexFloat `json:"netout,omitempty"`
	DiskRead  FlexFloat `json:"diskread,omitempty"`
	DiskWrite FlexFloat `json:"diskwrite,omitempty"`
	LoadAvg   FlexFloat `json:"loadavg,omitempty"`
	IOWait    FlexFloat `json:"iowait,omitempty"`
	RootUsed  FlexFloat `json:"rootused,omitempty"`
	RootTotal FlexFloat `json:"roottotal,omitempty"`
}

type TaskItem struct {
	UPID      string  `json:"upid"`
	Node      string  `json:"node"`
	PID       FlexInt `json:"pid"`
	PStart    FlexInt `json:"pstart"`
	StartTime FlexInt `json:"starttime"`
	EndTime   FlexInt `json:"endtime,omitempty"`
	Type      string  `json:"type"`
	ID        string  `json:"id"`
	User      string  `json:"user"`
	Status    string  `json:"status,omitempty"`
	Saved     string  `json:"saved,omitempty"`
}

type TaskStatus struct {
	Status     string  `json:"status"` // running | stopped
	ExitStatus string  `json:"exitstatus,omitempty"`
	UPID       string  `json:"upid"`
	Node       string  `json:"node"`
	Type       string  `json:"type"`
	ID         string  `json:"id"`
	User       string  `json:"user"`
	StartTime  FlexInt `json:"starttime"`
	PID        FlexInt `json:"pid"`
}

type TaskLogLine struct {
	N int    `json:"n"`
	T string `json:"t"`
}

type PendingItem struct {
	Key     string `json:"key"`
	Value   any    `json:"value,omitempty"`
	Pending any    `json:"pending,omitempty"`
	Delete  FlexInt `json:"delete,omitempty"`
}

type SnapshotItem struct {
	Name        string   `json:"name"`
	Description string   `json:"description,omitempty"`
	Parent      string   `json:"parent,omitempty"`
	SnapTime    FlexInt  `json:"snaptime,omitempty"`
	VMState     FlexBool `json:"vmstate,omitempty"`
}

type StorageContentItem struct {
	VolID   string  `json:"volid"`
	Content string  `json:"content"`
	Format  string  `json:"format"`
	Size    FlexInt `json:"size"`
	Used    FlexInt `json:"used,omitempty"`
	VMID    FlexInt `json:"vmid,omitempty"`
	CTime   FlexInt `json:"ctime,omitempty"`
	Notes   string  `json:"notes,omitempty"`
	Protected FlexBool `json:"protected,omitempty"`
}

type ConsoleProxyResp struct {
	Port     FlexInt `json:"port"`
	Ticket   string  `json:"ticket"`
	User     string  `json:"user"`
	UPID     string  `json:"upid,omitempty"`
	Password string  `json:"password,omitempty"`
	Cert     string  `json:"cert,omitempty"`
}

type GuestIPInfo struct {
	Interface string   `json:"interface"`
	MAC       string   `json:"mac,omitempty"`
	IPv4      []string `json:"ipv4"`
	IPv6      []string `json:"ipv6"`
}

type LXCInterface struct {
	Name   string `json:"name"`
	HWAddr string `json:"hwaddr"`
	Inet   string `json:"inet"`
	Inet6  string `json:"inet6"`
}

type QemuAgentNetIf struct {
	Name        string `json:"name"`
	HardwareAddr string `json:"hardware-address"`
	IPAddresses []struct {
		IPAddress     string `json:"ip-address"`
		IPAddressType string `json:"ip-address-type"`
		Prefix        int    `json:"prefix"`
	} `json:"ip-addresses"`
}

// ParseNodeSensors extracts optional CPU temp / package watt from modded node status.
func ParseNodeSensors(st *NodeStatus) []SensorReading {
	var out []SensorReading
	if st == nil {
		return out
	}
	if st.CPUFreq != "" {
		for _, line := range strings.Split(st.CPUFreq, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "pkgwatt:") {
				if v, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(line, "pkgwatt:")), 64); err == nil {
					out = append(out, SensorReading{Label: "CPU 功耗", Value: v, Unit: "W"})
				}
			}
		}
	}
	if st.ThermalState != "" {
		var section string
		for _, line := range strings.Split(st.ThermalState, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			if !strings.Contains(trimmed, ":") {
				section = trimmed
				continue
			}
			if strings.HasPrefix(trimmed, "Package id 0:") {
				if v, ok := extractTempC(trimmed); ok {
					out = append(out, SensorReading{Label: "CPU 封装温度", Value: v, Unit: "°C"})
				}
			} else if strings.HasPrefix(trimmed, "Composite:") && strings.HasPrefix(section, "nvme-") {
				if v, ok := extractTempC(trimmed); ok {
					out = append(out, SensorReading{Label: section, Value: v, Unit: "°C"})
				}
			}
		}
	}
	sortSensors(out)
	return out
}

func extractTempC(line string) (float64, bool) {
	idx := strings.Index(line, "+")
	if idx < 0 {
		return 0, false
	}
	rest := line[idx+1:]
	var num strings.Builder
	for _, r := range rest {
		if (r >= '0' && r <= '9') || r == '.' {
			num.WriteRune(r)
		} else {
			break
		}
	}
	if num.Len() == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(num.String(), 64)
	return v, err == nil
}
