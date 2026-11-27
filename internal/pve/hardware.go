package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

type PCIDevice struct {
	ID                  string  `json:"id"`
	Class               string  `json:"class"`
	Device              string  `json:"device"`
	DeviceName          string  `json:"device_name"`
	Vendor              string  `json:"vendor"`
	VendorName          string  `json:"vendor_name"`
	SubsystemDevice     string  `json:"subsystem_device,omitempty"`
	SubsystemVendorName string  `json:"subsystem_vendor_name,omitempty"`
	IOMMUGroup          FlexInt `json:"iommugroup"`
	MDev                FlexBool `json:"mdev,omitempty"`
}

type PhysicalDisk struct {
	DevPath  string  `json:"devpath"`
	ByIDLink string  `json:"by_id_link"`
	Model    string  `json:"model"`
	Serial   string  `json:"serial"`
	Vendor   string  `json:"vendor"`
	Type     string  `json:"type"` // nvme | ssd | hdd
	Size     FlexInt `json:"size"`
	Health   string  `json:"health"`
	Used     string  `json:"used"`
	Wearout  any     `json:"wearout"` // number or "N/A"
	RPM      FlexInt `json:"rpm"`
	GPT      FlexInt `json:"gpt"`
	WWN      string  `json:"wwn"`
}

type DiskSMARTResp struct {
	Health     string `json:"health"`
	Type       string `json:"type"`
	Text       string `json:"text"`
	Wearout    any    `json:"wearout"`
	Attributes []struct {
		ID         FlexInt `json:"id"`
		Name       string  `json:"name"`
		Raw        string  `json:"raw"`
		Value      FlexInt `json:"value"`
		Worst      FlexInt `json:"worst"`
		Threshold  FlexInt `json:"threshold"`
	} `json:"attributes,omitempty"`
}

type PCIMappingItem struct {
	ID  string   `json:"id"`
	Map []string `json:"map"`
}

type GuestBindingRef struct {
	VMID    int64  `json:"vmid"`
	Name    string `json:"name"`
	Type    string `json:"type"` // qemu | lxc
	Running bool   `json:"running"`
}

type GPUHardwareItem struct {
	ID                string            `json:"id"`
	Vendor            string            `json:"vendor"` // intel | nvidia | amd | other
	VendorName        string            `json:"vendorName"`
	Model             string            `json:"model"`
	Class             string            `json:"class"`
	IOMMUGroup        int64             `json:"iommuGroup"`
	SRIOVCapable      bool              `json:"sriovCapable"`
	Passthrough       bool              `json:"passthrough"`
	PassthroughActive bool              `json:"passthroughActive"`
	PassthroughGuests []GuestBindingRef `json:"passthroughGuests"`
	SharedLXCGuests   []GuestBindingRef `json:"sharedLxcGuests"`
	Driver            string            `json:"driver,omitempty"`

	// Live telemetry (populated when available via SSH probe / host telemetry)
	TelemetryAvailable bool     `json:"telemetryAvailable"`
	TelemetrySource    string   `json:"telemetrySource,omitempty"`
	CurFreqMHz         *float64 `json:"curFreqMhz,omitempty"`
	MaxFreqMHz         *float64 `json:"maxFreqMhz,omitempty"`
	RenderBusyPct      *float64 `json:"renderBusyPct,omitempty"`
	VideoBusyPct       *float64 `json:"videoBusyPct,omitempty"`
	BlitterBusyPct     *float64 `json:"blitterBusyPct,omitempty"`
	RC6Pct             *float64 `json:"rc6Pct,omitempty"`
	PowerW             *float64 `json:"powerW,omitempty"`
	TempC              *float64 `json:"tempC,omitempty"`
	VRAMUsedMB         *float64 `json:"vramUsedMb,omitempty"`
	VRAMTotalMB        *float64 `json:"vramTotalMb,omitempty"`
	FanPct             *float64 `json:"fanPct,omitempty"`
	ActiveClients      int      `json:"activeClients,omitempty"`
	MissingPackage     string   `json:"missingPackage,omitempty"`
}

type DiskHardwareItem struct {
	DevPath                    string            `json:"devpath"`
	ByIDLink                   string            `json:"byIdLink,omitempty"`
	Model                      string            `json:"model"`
	Serial                     string            `json:"serial"`
	Type                       string            `json:"type"` // nvme | ssd | hdd
	Size                       int64             `json:"size"`
	Health                     string            `json:"health"`
	Used                       string            `json:"used"`
	HealthPct                  *int              `json:"healthPct,omitempty"`
	HealthGrade                string            `json:"healthGrade,omitempty"` // excellent | good | warning | critical | unknown
	HealthReasons              []string          `json:"healthReasons,omitempty"`
	WearoutPct                 *int              `json:"wearoutPct,omitempty"`
	UsedLifePct                *int              `json:"usedLifePct,omitempty"`
	AvailableSparePct          *int              `json:"availableSparePct,omitempty"`
	AvailableSpareThresholdPct *int              `json:"availableSpareThresholdPct,omitempty"`
	CriticalWarning            *int              `json:"criticalWarning,omitempty"`
	TempC                      *float64          `json:"tempC,omitempty"`
	PowerOnHours               *int64            `json:"powerOnHours,omitempty"`
	PowerCycles                *int64            `json:"powerCycles,omitempty"`
	UnsafeShutdowns            *int64            `json:"unsafeShutdowns,omitempty"`
	DataRead                   string            `json:"dataRead,omitempty"`
	DataWritten                string            `json:"dataWritten,omitempty"`
	MediaErrors                *int64            `json:"mediaErrors,omitempty"`
	ReallocatedSectors         *int64            `json:"reallocatedSectors,omitempty"`
	PendingSectors             *int64            `json:"pendingSectors,omitempty"`
	RPM                        int64             `json:"rpm,omitempty"`
	Passthrough                bool              `json:"passthrough"`
	PassthroughActive          bool              `json:"passthroughActive"`
	PassthroughType            string            `json:"passthroughType,omitempty"` // disk | pci
	PassthroughGuests          []GuestBindingRef `json:"passthroughGuests"`
	SMARTText                  string            `json:"smartText,omitempty"`
	TelemetryStatus            string            `json:"telemetryStatus"` // full | partial | missing_pkg
	TelemetryNote              string            `json:"telemetryNote,omitempty"`
}

type CPUHardwareSummary struct {
	Model         string   `json:"model"`
	Vendor        string   `json:"vendor"`
	Sockets       int64    `json:"sockets"`
	Cores         int64    `json:"cores"`
	Threads       int64    `json:"threads"`
	UsagePct      float64  `json:"usagePct"`
	IOWaitPct     float64  `json:"iowaitPct"`
	CurMHz        float64  `json:"curMhz"`
	MaxMHz        float64  `json:"maxMhz,omitempty"`
	Governor      string   `json:"governor,omitempty"`
	PackageTempC  *float64 `json:"packageTempC,omitempty"`
	PackagePowerW *float64 `json:"packagePowerW,omitempty"`
	LoadAvg       []string `json:"loadavg"`
}

type MemoryHardwareSummary struct {
	Used      int64 `json:"used"`
	Total     int64 `json:"total"`
	Available int64 `json:"available"`
	SwapUsed  int64 `json:"swapUsed"`
	SwapTotal int64 `json:"swapTotal"`
}

type PackageDiagnostic struct {
	Package    string `json:"package"`
	Command    string `json:"command"`
	Category   string `json:"category"` // gpu | disk | sensor
	Status     string `json:"status"`   // installed | missing | unverified
	Reason     string `json:"reason"`
	InstallCmd string `json:"installCmd"`
}

type NodeHardwareReport struct {
	InstanceID          string                `json:"instanceId"`
	Node                string                `json:"node"`
	PVEVersion          string                `json:"pveVersion"`
	KernelVersion       string                `json:"kernelVersion"`
	Uptime              int64                 `json:"uptime"`
	UpdatedAt           string                `json:"updatedAt"`
	SSHTelemetryEnabled bool                  `json:"sshTelemetryEnabled"`
	SSHHost             string                `json:"sshHost,omitempty"`
	SSHError            string                `json:"sshError,omitempty"`
	CPU                 CPUHardwareSummary    `json:"cpu"`
	Memory              MemoryHardwareSummary `json:"memory"`
	GPUs                []GPUHardwareItem     `json:"gpus"`
	Disks               []DiskHardwareItem    `json:"disks"`
	Sensors             []SensorReading       `json:"sensors"`
	PackageChecks       []PackageDiagnostic   `json:"packageChecks"`
	MissingPackages     []PackageDiagnostic   `json:"missingPackages"`
	InstallAllCmd       string                `json:"installAllCmd,omitempty"`
}

// --- PVE REST Hardware Endpoints ---

func (c *Client) GetNodePCI(ctx context.Context, node string) ([]PCIDevice, error) {
	var out []PCIDevice
	path := fmt.Sprintf("/nodes/%s/hardware/pci", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetNodeDisks(ctx context.Context, node string) ([]PhysicalDisk, error) {
	var out []PhysicalDisk
	path := fmt.Sprintf("/nodes/%s/disks/list", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetNodeDiskSMART(ctx context.Context, node, devpath string) (*DiskSMARTResp, error) {
	var out DiskSMARTResp
	q := url.Values{"disk": {devpath}}
	path := fmt.Sprintf("/nodes/%s/disks/smart", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, q, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetNodeStatusRaw(ctx context.Context, node string) (map[string]any, error) {
	var out map[string]any
	path := fmt.Sprintf("/nodes/%s/status", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) GetClusterPCIMappings(ctx context.Context) ([]PCIMappingItem, error) {
	var out []PCIMappingItem
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/mapping/pci", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// --- Hardware Collector with Short TTL Cache ---

type hardwareCacheEntry struct {
	report *NodeHardwareReport
	at     time.Time
}

var (
	hwCacheMu sync.Mutex
	hwCache   = map[string]hardwareCacheEntry{}
	hwSF      singleflight.Group
)

// CollectNodeHardware aggregates host non-passthrough hardware (GPU, Disks, CPU, Memory),
// detects VM/LXC passthrough bindings, queries optional SSH live GPU/package diagnostics,
// and returns deterministic missing-package recommendations.
func CollectNodeHardware(ctx context.Context, cl *Client, instanceID, node, sshHost string, force bool) (*NodeHardwareReport, error) {
	cacheKey := instanceID + ":" + node + ":" + sshHost
	if !force {
		hwCacheMu.Lock()
		// Opportunistically evict stale cache entries to bound memory
		if len(hwCache) > 64 {
			for k, v := range hwCache {
				if time.Since(v.at) > 2*time.Minute {
					delete(hwCache, k)
				}
			}
		}
		if entry, ok := hwCache[cacheKey]; ok && time.Since(entry.at) < 12*time.Second {
			rep := entry.report
			hwCacheMu.Unlock()
			return rep, nil
		}
		hwCacheMu.Unlock()
	}

	ch := hwSF.DoChan(cacheKey, func() (any, error) {
		runCtx, cancel := context.WithTimeout(context.Background(), 22*time.Second)
		defer cancel()
		return collectNodeHardwareUncached(runCtx, cl, instanceID, node, sshHost, cacheKey)
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return res.Val.(*NodeHardwareReport), nil
	}
}

func collectNodeHardwareUncached(ctx context.Context, cl *Client, instanceID, node, sshHost, cacheKey string) (*NodeHardwareReport, error) {

	var (
		nodeStatus  *NodeStatus
		rawStatus   map[string]any
		pciList     []PCIDevice
		diskList    []PhysicalDisk
		resources   []ClusterResource
		pciMappings []PCIMappingItem
		statusErr   error
	)

	var g errgroup.Group
	g.Go(func() error {
		nodeStatus, statusErr = cl.GetNodeStatus(ctx, node)
		return nil
	})
	g.Go(func() error {
		rawStatus, _ = cl.GetNodeStatusRaw(ctx, node)
		return nil
	})
	g.Go(func() error {
		pciList, _ = cl.GetNodePCI(ctx, node)
		return nil
	})
	g.Go(func() error {
		diskList, _ = cl.GetNodeDisks(ctx, node)
		return nil
	})
	g.Go(func() error {
		resources, _ = cl.GetClusterResources(ctx, "vm")
		return nil
	})
	g.Go(func() error {
		pciMappings, _ = cl.GetClusterPCIMappings(ctx)
		return nil
	})
	_ = g.Wait()

	if statusErr != nil {
		return nil, statusErr
	}

	// Build mapping name -> []pciID on this node
	mappingToPCI := map[string][]string{}
	for _, mp := range pciMappings {
		for _, entry := range mp.Map {
			var mNode, mPath string
			for _, kv := range strings.Split(entry, ",") {
				if strings.HasPrefix(kv, "node=") {
					mNode = strings.TrimPrefix(kv, "node=")
				} else if strings.HasPrefix(kv, "path=") {
					mPath = strings.TrimPrefix(kv, "path=")
				}
			}
			if (mNode == "" || mNode == node) && mPath != "" {
				mappingToPCI[mp.ID] = append(mappingToPCI[mp.ID], normalizePCI(mPath))
			}
		}
	}

	// Fetch configs for guests on this node to accurately detect passthrough & LXC GPU sharing
	type guestCfg struct {
		ref GuestBindingRef
		cfg map[string]any
	}
	var nodeGuests []ClusterResource
	for _, r := range resources {
		if r.Node == node && (r.Type == "qemu" || r.Type == "lxc") && !bool(r.Template) {
			nodeGuests = append(nodeGuests, r)
		}
	}
	guestConfigs := make([]guestCfg, len(nodeGuests))
	var cg errgroup.Group
	cg.SetLimit(6)
	for i, gr := range nodeGuests {
		i, gr := i, gr
		cg.Go(func() error {
			cfg, err := cl.GetGuestConfig(ctx, node, gr.Type, int(gr.VMID))
			if err == nil {
				guestConfigs[i] = guestCfg{
					ref: GuestBindingRef{
						VMID:    int64(gr.VMID),
						Name:    gr.Name,
						Type:    gr.Type,
						Running: gr.Status == "running",
					},
					cfg: cfg,
				}
			}
			return nil
		})
	}

	// Optional SSH host telemetry probe in parallel with guest config reads
	var sshData *sshHostProbeData
	var sshErrStr string
	sshHost = strings.TrimSpace(sshHost)
	if sshHost != "" {
		cg.Go(func() error {
			d, err := runSSHHostProbe(ctx, sshHost)
			if err != nil {
				sshErrStr = err.Error()
			} else {
				sshData = d
			}
			return nil
		})
	}
	_ = cg.Wait()

	// Build passthrough maps
	pciPassthroughMap := map[string][]GuestBindingRef{}
	diskPassthroughMap := map[string][]GuestBindingRef{}
	lxcDRIGuests := []GuestBindingRef{}

	for _, gc := range guestConfigs {
		if gc.cfg == nil {
			continue
		}
		if gc.ref.Type == "qemu" {
			for k, v := range gc.cfg {
				val := fmt.Sprint(v)
				if strings.HasPrefix(k, "hostpci") {
					// e.g. "0000:00:02.1,pcie=1" or "mapping=gpu0,pcie=1"
					first := strings.Split(val, ",")[0]
					if strings.HasPrefix(first, "mapping=") {
						mid := strings.TrimPrefix(first, "mapping=")
						for _, pid := range mappingToPCI[mid] {
							pciPassthroughMap[pid] = append(pciPassthroughMap[pid], gc.ref)
						}
					} else {
						pid := normalizePCI(first)
						if pid != "" {
							pciPassthroughMap[pid] = append(pciPassthroughMap[pid], gc.ref)
						}
					}
				} else if strings.HasPrefix(k, "scsi") || strings.HasPrefix(k, "sata") || strings.HasPrefix(k, "virtio") || strings.HasPrefix(k, "ide") {
					first := strings.Split(val, ",")[0]
					if strings.HasPrefix(first, "/dev/") {
						diskPassthroughMap[first] = append(diskPassthroughMap[first], gc.ref)
					}
				}
			}
		} else if gc.ref.Type == "lxc" {
			hasDRI := false
			for k, v := range gc.cfg {
				val := fmt.Sprint(v)
				if (k == "lxc" || strings.HasPrefix(k, "dev") || strings.HasPrefix(k, "lxc.")) && strings.Contains(val, "/dev/dri") {
					hasDRI = true
					break
				}
			}
			if hasDRI {
				lxcDRIGuests = append(lxcDRIGuests, gc.ref)
			}
		}
	}
	sort.Slice(lxcDRIGuests, func(i, j int) bool { return lxcDRIGuests[i].VMID < lxcDRIGuests[j].VMID })

	// 1. CPU & Memory + Sensors
	sensors := ParseNodeSensors(nodeStatus)
	if len(sensors) == 0 && sshData != nil && len(sshData.Sensors) > 0 {
		sensors = sshData.Sensors
	}
	sortSensors(sensors)

	cpuSummary := buildCPUSummary(nodeStatus, sensors)
	memSummary := MemoryHardwareSummary{
		Used:      int64(nodeStatus.Memory.Used),
		Total:     int64(nodeStatus.Memory.Total),
		Available: int64(nodeStatus.Memory.Available),
		SwapUsed:  int64(nodeStatus.Swap.Used),
		SwapTotal: int64(nodeStatus.Swap.Total),
	}

	// 2. GPUs (PCI class 0x03*)
	var gpus []GPUHardwareItem
	hasIntelGPU, hasNvidiaGPU, hasAmdGPU := false, false, false

	for _, dev := range pciList {
		cls := strings.ToLower(strings.TrimSpace(dev.Class))
		if !strings.HasPrefix(cls, "0x03") {
			continue
		}
		normID := normalizePCI(dev.ID)
		vendorKind := detectGPUVendor(dev.Vendor, dev.VendorName)
		switch vendorKind {
		case "intel":
			hasIntelGPU = true
		case "nvidia":
			hasNvidiaGPU = true
		case "amd":
			hasAmdGPU = true
		}

		// Match exact PCI ID or same bus:slot (if function .0 without function specified)
		ptGuests := findPCIBindings(pciPassthroughMap, normID)
		ptActive := false
		for _, r := range ptGuests {
			if r.Running {
				ptActive = true
			}
		}

		model := strings.TrimSpace(dev.DeviceName)
		if model == "" {
			model = fmt.Sprintf("%s [%s:%s]", dev.VendorName, dev.Vendor, dev.Device)
		}

		gpu := GPUHardwareItem{
			ID:                normID,
			Vendor:            vendorKind,
			VendorName:        dev.VendorName,
			Model:             model,
			Class:             dev.Class,
			IOMMUGroup:        int64(dev.IOMMUGroup),
			SRIOVCapable:      bool(dev.MDev),
			Passthrough:       len(ptGuests) > 0,
			PassthroughActive: ptActive,
			PassthroughGuests: nonNilRefs(ptGuests),
			SharedLXCGuests:   []GuestBindingRef{},
		}
		if !gpu.PassthroughActive && len(lxcDRIGuests) > 0 {
			gpu.SharedLXCGuests = lxcDRIGuests
		}

		// Attach live telemetry from SSH probe if available
		if sshData != nil && !gpu.PassthroughActive {
			applySSHGPUTelemetry(&gpu, sshData)
		}

		gpus = append(gpus, gpu)
	}
	sort.Slice(gpus, func(i, j int) bool { return gpus[i].ID < gpus[j].ID })

	// 3. Physical Disks + SMART + Passthrough Detection
	embeddedSMART := parseEmbeddedSmartFromStatus(rawStatus)
	// Map NVMe PCI controllers passed through to VMs (if any)
	nvmePCIPassthrough := map[string][]GuestBindingRef{}
	for _, dev := range pciList {
		if strings.HasPrefix(strings.ToLower(dev.Class), "0x0108") {
			normID := normalizePCI(dev.ID)
			if refs := findPCIBindings(pciPassthroughMap, normID); len(refs) > 0 {
				nvmePCIPassthrough[normID] = refs
			}
		}
	}

	disks := make([]DiskHardwareItem, len(diskList))
	smartMissingErr := false
	var smartMu sync.Mutex

	var dg errgroup.Group
	dg.SetLimit(4)
	for i, d := range diskList {
		i, d := i, d
		dg.Go(func() error {
			item := DiskHardwareItem{
				DevPath:           d.DevPath,
				ByIDLink:          d.ByIDLink,
				Model:             strings.TrimSpace(d.Model),
				Serial:            strings.TrimSpace(d.Serial),
				Type:              strings.ToLower(strings.TrimSpace(d.Type)),
				Size:              int64(d.Size),
				Health:            strings.TrimSpace(d.Health),
				Used:              strings.TrimSpace(d.Used),
				RPM:               int64(d.RPM),
				PassthroughGuests: []GuestBindingRef{},
			}
			if w, ok := parseIntAny(d.Wearout); ok && w >= 0 && w <= 100 {
				item.WearoutPct = &w
				used := 100 - w
				item.UsedLifePct = &used
			}

			// Detect direct block device passthrough (/dev/disk/by-id/... or /dev/sdX)
			var ptRefs []GuestBindingRef
			if d.ByIDLink != "" {
				ptRefs = append(ptRefs, diskPassthroughMap[d.ByIDLink]...)
			}
			ptRefs = append(ptRefs, diskPassthroughMap[d.DevPath]...)
			if len(ptRefs) > 0 {
				item.Passthrough = true
				item.PassthroughType = "disk"
				item.PassthroughGuests = dedupRefs(ptRefs)
				for _, r := range item.PassthroughGuests {
					if r.Running {
						item.PassthroughActive = true
					}
				}
			}

			// Check embedded SMART JSON first (instant, zero extra PVE API roundtrip), then fallback to /disks/smart
			diskSmartMissing := false
			if emb, ok := embeddedSMART[d.Serial]; ok {
				applySmartJSON(&item, emb)
			} else if d.DevPath != "" {
				sm, err := cl.GetNodeDiskSMART(ctx, node, d.DevPath)
				if err != nil {
					if strings.Contains(strings.ToLower(err.Error()), "smartctl") ||
						strings.Contains(strings.ToLower(err.Error()), "not found") {
						diskSmartMissing = true
						smartMu.Lock()
						smartMissingErr = true
						smartMu.Unlock()
					}
				} else if sm != nil {
					if sm.Health != "" {
						item.Health = sm.Health
					}
					item.SMARTText = sm.Text
					parseSmartText(&item, sm.Text)
					for _, attr := range sm.Attributes {
						lower := strings.ToLower(attr.Name)
						if (strings.Contains(lower, "temperature") || attr.ID == 194 || attr.ID == 190) && item.TempC == nil {
							if v, ok := extractFirstFloat(attr.Raw); ok && v > 0 && v < 120 {
								item.TempC = &v
							}
						} else if (attr.ID == 9 || strings.Contains(lower, "power_on_hours")) && item.PowerOnHours == nil {
							if v, ok := extractFirstInt64(attr.Raw); ok {
								item.PowerOnHours = &v
							}
						} else if (attr.ID == 12 || strings.Contains(lower, "power_cycle")) && item.PowerCycles == nil {
							if v, ok := extractFirstInt64(attr.Raw); ok {
								item.PowerCycles = &v
							}
						} else if (attr.ID == 5 || strings.Contains(lower, "reallocated_sector")) && item.ReallocatedSectors == nil {
							if v, ok := extractFirstInt64(attr.Raw); ok {
								item.ReallocatedSectors = &v
							}
						} else if (attr.ID == 197 || strings.Contains(lower, "current_pending_sector")) && item.PendingSectors == nil {
							if v, ok := extractFirstInt64(attr.Raw); ok {
								item.PendingSectors = &v
							}
						} else if (attr.ID == 198 || strings.Contains(lower, "offline_uncorrectable")) && item.MediaErrors == nil {
							if v, ok := extractFirstInt64(attr.Raw); ok {
								item.MediaErrors = &v
							}
						} else if (attr.ID == 231 || attr.ID == 233 || strings.Contains(lower, "ssd_life_left") || strings.Contains(lower, "media_wearout")) && item.WearoutPct == nil {
							val := int(attr.Value)
							if val >= 0 && val <= 100 {
								item.WearoutPct = &val
								u := 100 - val
								item.UsedLifePct = &u
							}
						} else if (attr.ID == 232 || strings.Contains(lower, "available_reservd_space")) && item.AvailableSparePct == nil {
							val := int(attr.Value)
							if val >= 0 && val <= 100 {
								item.AvailableSparePct = &val
							}
						}
					}
				}
			}

			computeDiskHealth(&item, diskSmartMissing || (sshData != nil && !sshData.Tools["smartctl"]))

			// Match NVMe PCI passthrough if SSH provided dev->pci map
			if !item.Passthrough && sshData != nil {
				if pciID, ok := sshData.DiskPCI[d.DevPath]; ok {
					if refs := nvmePCIPassthrough[normalizePCI(pciID)]; len(refs) > 0 {
						item.Passthrough = true
						item.PassthroughType = "pci"
						item.PassthroughGuests = dedupRefs(refs)
						for _, r := range item.PassthroughGuests {
							if r.Running {
								item.PassthroughActive = true
							}
						}
					}
				}
			}

			disks[i] = item
			return nil
		})
	}
	_ = dg.Wait()
	sort.Slice(disks, func(i, j int) bool { return disks[i].DevPath < disks[j].DevPath })

	// 4. Package Diagnostics (installed vs missing vs unverified)
	hasNVMe := false
	for _, d := range disks {
		if d.Type == "nvme" {
			hasNVMe = true
			break
		}
	}
	pkgChecks, missingPkgs, installAllCmd := buildPackageDiagnostics(
		sshData,
		smartMissingErr,
		len(sensors) > 0,
		hasIntelGPU,
		hasNvidiaGPU,
		hasAmdGPU,
		hasNVMe,
	)

	// Attach per-GPU missing package hint (also warn when only partial drm sysfs is available)
	for i := range gpus {
		if gpus[i].PassthroughActive {
			continue
		}
		switch gpus[i].Vendor {
		case "intel":
			if !gpus[i].TelemetryAvailable || (sshData != nil && !sshData.Tools["intel_gpu_top"]) {
				gpus[i].MissingPackage = "intel-gpu-tools"
			}
		case "nvidia":
			if !gpus[i].TelemetryAvailable || (sshData != nil && !sshData.Tools["nvidia-smi"]) {
				gpus[i].MissingPackage = "nvidia-driver"
			}
		case "amd":
			if !gpus[i].TelemetryAvailable || (sshData != nil && !sshData.Tools["radeontop"]) {
				gpus[i].MissingPackage = "radeontop"
			}
		}
	}

	report := &NodeHardwareReport{
		InstanceID:          instanceID,
		Node:                node,
		PVEVersion:          nodeStatus.PVEVersion,
		KernelVersion:       nodeStatus.KVersion,
		Uptime:              int64(nodeStatus.Uptime),
		UpdatedAt:           time.Now().UTC().Format(time.RFC3339),
		SSHTelemetryEnabled: sshHost != "" && sshData != nil,
		SSHHost:             sshHost,
		SSHError:            sshErrStr,
		CPU:                 cpuSummary,
		Memory:              memSummary,
		GPUs:                gpus,
		Disks:               disks,
		Sensors:             sensors,
		PackageChecks:       pkgChecks,
		MissingPackages:     missingPkgs,
		InstallAllCmd:       installAllCmd,
	}
	if report.GPUs == nil {
		report.GPUs = []GPUHardwareItem{}
	}
	if report.Disks == nil {
		report.Disks = []DiskHardwareItem{}
	}
	if report.Sensors == nil {
		report.Sensors = []SensorReading{}
	}

	hwCacheMu.Lock()
	hwCache[cacheKey] = hardwareCacheEntry{report: report, at: time.Now()}
	hwCacheMu.Unlock()

	return report, nil
}

// --- SSH Lightweight Read-Only Host Telemetry Probe ---

type sshIntelGPU struct {
	PCIID          string
	CurFreqMHz     *float64
	MaxFreqMHz     *float64
	RenderBusyPct  *float64
	VideoBusyPct   *float64
	BlitterBusyPct *float64
	RC6Pct         *float64
	PowerW         *float64
	ActiveClients  int
}

type sshNvidiaGPU struct {
	PCIID       string
	Name        string
	UtilPct     float64
	VRAMUsedMB  float64
	VRAMTotalMB float64
	TempC       float64
	PowerW      float64
	FanPct      float64
	CurFreqMHz  float64
	MaxFreqMHz  float64
}

type sshAmdGPU struct {
	PCIID       string
	UtilPct     *float64
	VRAMUsedMB  *float64
	VRAMTotalMB *float64
	TempC       *float64
}

type sshHostProbeData struct {
	Tools     map[string]bool
	Drivers   map[string]string
	DiskPCI   map[string]string
	IntelGPUs []sshIntelGPU
	Nvidia    []sshNvidiaGPU
	AmdGPUs   []sshAmdGPU
	Sensors   []SensorReading
}

var sshHostAllowlist = regexp.MustCompile(`^([A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?([A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9a-fA-F:]+\])$`)

// ValidateSSHHost strictly validates an optional SSH target (user@host or ~/.ssh/config alias)
// to prevent OpenSSH option injection (leading '-') or shell metacharacters.
func ValidateSSHHost(sshHost string) error {
	h := strings.TrimSpace(sshHost)
	if h == "" {
		return nil
	}
	if strings.HasPrefix(h, "-") || !sshHostAllowlist.MatchString(h) {
		return fmt.Errorf("无效的 SSH Host %q（仅允许字母/数字/点/短横线或 user@host，禁止以 '-' 开头或含特殊符号）", sshHost)
	}
	return nil
}

type limitedBuffer struct {
	buf bytes.Buffer
	max int
}

func (l *limitedBuffer) Write(p []byte) (int, error) {
	origLen := len(p)
	rem := l.max - l.buf.Len()
	if rem > 0 {
		if len(p) > rem {
			p = p[:rem]
		}
		_, _ = l.buf.Write(p)
	}
	return origLen, nil
}

func (l *limitedBuffer) String() string { return l.buf.String() }

func runSSHHostProbe(parentCtx context.Context, sshHost string) (*sshHostProbeData, error) {
	sshHost = strings.TrimSpace(sshHost)
	if err := ValidateSSHHost(sshHost); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parentCtx, 12*time.Second)
	defer cancel()

	// Single read-only probe script executed on the remote PVE host
	script := `
echo "===TOOLS==="
for c in smartctl sensors nvme intel_gpu_top nvidia-smi radeontop; do
  if command -v "$c" >/dev/null 2>&1; then echo "$c=1"; else echo "$c=0"; fi
done
echo "===DRM==="
for card in /sys/class/drm/card[0-9]*; do
  [ -d "$card/device" ] || continue
  base=$(basename "$card")
  case "$base" in *-*) continue;; esac
  pci=$(basename "$(readlink -f "$card/device" 2>/dev/null)")
  drv=$(basename "$(readlink -f "$card/device/driver" 2>/dev/null)" 2>/dev/null)
  cur=$(cat "$card/gt_cur_freq_mhz" 2>/dev/null || true)
  max=$(cat "$card/gt_max_freq_mhz" 2>/dev/null || true)
  busy=$(cat "$card/device/gpu_busy_percent" 2>/dev/null || true)
  vu=$(cat "$card/device/mem_info_vram_used" 2>/dev/null || true)
  vt=$(cat "$card/device/mem_info_vram_total" 2>/dev/null || true)
  t=$(cat "$card/device/hwmon"/hwmon*/temp1_input 2>/dev/null | head -n1 || true)
  echo "CARD|$pci|$drv|$cur|$max|$busy|$vu|$vt|$t"
done
echo "===DISKPCI==="
for blk in /sys/block/nvme*; do
  [ -e "$blk/device" ] || continue
  bname=$(basename "$blk")
  p=$(readlink -f "$blk/device/device" 2>/dev/null || readlink -f "$blk/device" 2>/dev/null)
  echo "/dev/$bname|$(basename "$p")"
done
echo "===INTEL_TOP==="
if command -v intel_gpu_top >/dev/null 2>&1; then
  timeout -k 1 1.0 intel_gpu_top -J -s 300 2>/dev/null || true
fi
echo ""
echo "===NVIDIA==="
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,fan.speed,clocks.gr,clocks.max.gr --format=csv,noheader,nounits 2>/dev/null || true
fi
echo "===SENSORS==="
if command -v sensors >/dev/null 2>&1; then
  sensors 2>/dev/null || true
fi
`
	cmd := exec.CommandContext(ctx, "ssh",
		"-T", "-n",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=5",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "PermitLocalCommand=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
		"--",
		sshHost,
		script,
	)
	stdout := &limitedBuffer{max: 2 << 20}
	stderr := &limitedBuffer{max: 256 << 10}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("SSH probe (%s): %s", sshHost, msg)
	}

	return parseSSHProbeOutput(stdout.String()), nil
}

func parseSSHProbeOutput(raw string) *sshHostProbeData {
	data := &sshHostProbeData{
		Tools:   map[string]bool{},
		Drivers: map[string]string{},
		DiskPCI: map[string]string{},
	}

	sections := map[string][]string{}
	curSec := ""
	for _, line := range strings.Split(raw, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "===") && strings.HasSuffix(trimmed, "===") {
			curSec = strings.Trim(trimmed, "=")
			continue
		}
		if curSec != "" {
			sections[curSec] = append(sections[curSec], line)
		}
	}

	for _, line := range sections["TOOLS"] {
		parts := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(parts) == 2 {
			data.Tools[parts[0]] = parts[1] == "1"
		}
	}

	for _, line := range sections["DISKPCI"] {
		parts := strings.SplitN(strings.TrimSpace(line), "|", 2)
		if len(parts) == 2 && parts[0] != "" && parts[1] != "" {
			data.DiskPCI[parts[0]] = normalizePCI(parts[1])
		}
	}

	var intelCards []sshIntelGPU
	for _, line := range sections["DRM"] {
		if !strings.HasPrefix(line, "CARD|") {
			continue
		}
		f := strings.Split(strings.TrimSpace(line), "|")
		if len(f) < 9 {
			continue
		}
		pci := normalizePCI(f[1])
		drv := f[2]
		if pci != "" && drv != "" {
			data.Drivers[pci] = drv
		}
		if drv == "i915" || drv == "xe" || f[3] != "" || f[4] != "" {
			ig := sshIntelGPU{PCIID: pci}
			if v, err := strconv.ParseFloat(f[3], 64); err == nil {
				ig.CurFreqMHz = &v
			}
			if v, err := strconv.ParseFloat(f[4], 64); err == nil {
				ig.MaxFreqMHz = &v
			}
			intelCards = append(intelCards, ig)
		} else if drv == "amdgpu" {
			ag := sshAmdGPU{PCIID: pci}
			if v, err := strconv.ParseFloat(f[5], 64); err == nil {
				ag.UtilPct = &v
			}
			if v, err := strconv.ParseFloat(f[6], 64); err == nil {
				mb := v / (1024 * 1024)
				ag.VRAMUsedMB = &mb
			}
			if v, err := strconv.ParseFloat(f[7], 64); err == nil {
				mb := v / (1024 * 1024)
				ag.VRAMTotalMB = &mb
			}
			if v, err := strconv.ParseFloat(f[8], 64); err == nil {
				c := v / 1000.0
				ag.TempC = &c
			}
			data.AmdGPUs = append(data.AmdGPUs, ag)
		}
	}

	// Parse intel_gpu_top -J output (streaming JSON array cut by timeout, extract complete objects)
	intelRaw := strings.TrimSpace(strings.Join(sections["INTEL_TOP"], "\n"))
	if intelRaw != "" {
		if sample := parseLastIntelTopSample(intelRaw); sample != nil {
			if len(intelCards) == 0 {
				intelCards = append(intelCards, sshIntelGPU{})
			}
			target := &intelCards[0]
			if sample.FreqActual != nil {
				target.CurFreqMHz = sample.FreqActual
			}
			if sample.RenderBusy != nil {
				target.RenderBusyPct = sample.RenderBusy
			}
			if sample.VideoBusy != nil {
				target.VideoBusyPct = sample.VideoBusy
			}
			if sample.BlitterBusy != nil {
				target.BlitterBusyPct = sample.BlitterBusy
			}
			if sample.RC6 != nil {
				target.RC6Pct = sample.RC6
			}
			if sample.PowerGPU != nil {
				target.PowerW = sample.PowerGPU
			}
			target.ActiveClients = sample.ClientsCount
		}
	}
	data.IntelGPUs = intelCards

	// Parse nvidia-smi CSV lines
	for _, line := range sections["NVIDIA"] {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		cols := strings.Split(trimmed, ",")
		if len(cols) < 10 {
			continue
		}
		pf := func(s string) float64 {
			v, _ := strconv.ParseFloat(strings.TrimSpace(s), 64)
			return v
		}
		data.Nvidia = append(data.Nvidia, sshNvidiaGPU{
			PCIID:       normalizePCI(strings.TrimSpace(cols[0])),
			Name:        strings.TrimSpace(cols[1]),
			UtilPct:     pf(cols[2]),
			VRAMUsedMB:  pf(cols[3]),
			VRAMTotalMB: pf(cols[4]),
			TempC:       pf(cols[5]),
			PowerW:      pf(cols[6]),
			FanPct:      pf(cols[7]),
			CurFreqMHz:  pf(cols[8]),
			MaxFreqMHz:  pf(cols[9]),
		})
	}

	// Parse sensors output via existing ParseNodeSensors logic
	sensorRaw := strings.Join(sections["SENSORS"], "\n")
	if strings.TrimSpace(sensorRaw) != "" {
		data.Sensors = ParseNodeSensors(&NodeStatus{ThermalState: sensorRaw})
	}

	return data
}

type intelTopParsed struct {
	FreqActual   *float64
	RenderBusy   *float64
	VideoBusy    *float64
	BlitterBusy  *float64
	RC6          *float64
	PowerGPU     *float64
	ClientsCount int
}

func parseLastIntelTopSample(raw string) *intelTopParsed {
	// intel_gpu_top -J emits `[ { ... }, { ... }` and gets cut off by timeout.
	// Find complete top-level JSON objects inside the array.
	type rawSample struct {
		Frequency struct {
			Actual    float64 `json:"actual"`
			Requested float64 `json:"requested"`
		} `json:"frequency"`
		RC6 struct {
			Value float64 `json:"value"`
		} `json:"rc6"`
		Power struct {
			GPU float64 `json:"GPU"`
		} `json:"power"`
		Engines map[string]struct {
			Busy float64 `json:"busy"`
		} `json:"engines"`
		Clients map[string]any `json:"clients"`
	}

	var last *rawSample
	depth := 0
	start := -1
	inStr := false
	esc := false
	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		if inStr {
			if esc {
				esc = false
			} else if ch == '\\' {
				esc = true
			} else if ch == '"' {
				inStr = false
			}
			continue
		}
		switch ch {
		case '"':
			inStr = true
		case '{':
			if depth == 0 {
				start = i
			}
			depth++
		case '}':
			depth--
			if depth == 0 && start >= 0 {
				var obj rawSample
				if json.Unmarshal([]byte(raw[start:i+1]), &obj) == nil {
					cp := obj
					last = &cp
				}
				start = -1
			}
		}
	}
	if last == nil {
		return nil
	}

	out := &intelTopParsed{
		ClientsCount: len(last.Clients),
	}
	freq := last.Frequency.Actual
	if freq == 0 && last.Frequency.Requested > 0 {
		freq = last.Frequency.Requested
	}
	out.FreqActual = &freq
	rc6 := last.RC6.Value
	out.RC6 = &rc6
	pw := last.Power.GPU
	out.PowerGPU = &pw

	for name, eng := range last.Engines {
		lname := strings.ToLower(name)
		b := eng.Busy
		if strings.Contains(lname, "render") || strings.Contains(lname, "3d") {
			out.RenderBusy = &b
		} else if lname == "video" {
			out.VideoBusy = &b
		} else if strings.Contains(lname, "blitter") {
			out.BlitterBusy = &b
		}
	}
	return out
}

func applySSHGPUTelemetry(gpu *GPUHardwareItem, sshData *sshHostProbeData) {
	if drv, ok := sshData.Drivers[gpu.ID]; ok {
		gpu.Driver = drv
	}
	switch gpu.Vendor {
	case "intel":
		for _, ig := range sshData.IntelGPUs {
			if ig.PCIID == "" || ig.PCIID == gpu.ID {
				gpu.CurFreqMHz = ig.CurFreqMHz
				gpu.MaxFreqMHz = ig.MaxFreqMHz
				gpu.RenderBusyPct = ig.RenderBusyPct
				gpu.VideoBusyPct = ig.VideoBusyPct
				gpu.BlitterBusyPct = ig.BlitterBusyPct
				gpu.RC6Pct = ig.RC6Pct
				gpu.PowerW = ig.PowerW
				gpu.ActiveClients = ig.ActiveClients
				if ig.CurFreqMHz != nil || ig.RenderBusyPct != nil {
					gpu.TelemetryAvailable = true
					if sshData.Tools["intel_gpu_top"] {
						gpu.TelemetrySource = "intel_gpu_top + drm"
					} else {
						gpu.TelemetrySource = "drm sysfs"
					}
				}
				return
			}
		}
	case "nvidia":
		for _, ng := range sshData.Nvidia {
			if ng.PCIID == gpu.ID || strings.HasSuffix(ng.PCIID, gpu.ID) || strings.HasSuffix(gpu.ID, ng.PCIID) {
				u, vu, vt, t, p, f, cf, mf := ng.UtilPct, ng.VRAMUsedMB, ng.VRAMTotalMB, ng.TempC, ng.PowerW, ng.FanPct, ng.CurFreqMHz, ng.MaxFreqMHz
				gpu.RenderBusyPct = &u
				gpu.VRAMUsedMB = &vu
				gpu.VRAMTotalMB = &vt
				gpu.TempC = &t
				gpu.PowerW = &p
				gpu.FanPct = &f
				gpu.CurFreqMHz = &cf
				gpu.MaxFreqMHz = &mf
				gpu.TelemetryAvailable = true
				gpu.TelemetrySource = "nvidia-smi"
				return
			}
		}
	case "amd":
		for _, ag := range sshData.AmdGPUs {
			if ag.PCIID == gpu.ID {
				gpu.RenderBusyPct = ag.UtilPct
				gpu.VRAMUsedMB = ag.VRAMUsedMB
				gpu.VRAMTotalMB = ag.VRAMTotalMB
				gpu.TempC = ag.TempC
				if ag.UtilPct != nil || ag.TempC != nil {
					gpu.TelemetryAvailable = true
					gpu.TelemetrySource = "amdgpu sysfs"
				}
				return
			}
		}
	}
}

// --- Helpers ---

func buildCPUSummary(st *NodeStatus, sensors []SensorReading) CPUHardwareSummary {
	s := CPUHardwareSummary{
		Model:     st.CPUInfo.Model,
		Vendor:    st.CPUInfo.Vendor,
		Sockets:   int64(st.CPUInfo.Sockets),
		Cores:     int64(st.CPUInfo.Cores),
		Threads:   int64(st.CPUInfo.CPUs),
		UsagePct:  float64(st.CPU) * 100,
		IOWaitPct: float64(st.Wait) * 100,
		CurMHz:    float64(st.CPUInfo.MHz),
		LoadAvg:   st.LoadAvg,
	}
	if s.LoadAvg == nil {
		s.LoadAvg = []string{}
	}
	if st.CPUFreq != "" {
		for _, line := range strings.Split(st.CPUFreq, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "gov:") {
				s.Governor = strings.TrimSpace(strings.TrimPrefix(line, "gov:"))
			} else if strings.HasPrefix(line, "max:") {
				if khz, err := strconv.ParseFloat(strings.TrimSpace(strings.TrimPrefix(line, "max:")), 64); err == nil && khz > 0 {
					s.MaxMHz = khz / 1000.0
				}
			}
		}
	}
	for _, sr := range sensors {
		if sr.Label == "CPU 封装温度" && s.PackageTempC == nil {
			v := sr.Value
			s.PackageTempC = &v
		} else if sr.Label == "CPU 功耗" && s.PackagePowerW == nil {
			v := sr.Value
			s.PackagePowerW = &v
		}
	}
	return s
}

func buildPackageDiagnostics(
	sshData *sshHostProbeData,
	smartMissingErr bool,
	hasSensors bool,
	hasIntelGPU, hasNvidiaGPU, hasAmdGPU, hasNVMe bool,
) ([]PackageDiagnostic, []PackageDiagnostic, string) {
	statusOf := func(cmd string, fallbackInstalled bool) string {
		if sshData != nil {
			if sshData.Tools[cmd] {
				return "installed"
			}
			return "missing"
		}
		if fallbackInstalled {
			return "installed"
		}
		return "unverified"
	}

	checks := []PackageDiagnostic{
		{
			Package:    "smartmontools",
			Command:    "smartctl",
			Category:   "disk",
			Status:     func() string {
				if smartMissingErr {
					return "missing"
				}
				return statusOf("smartctl", true)
			}(),
			Reason:     "采集物理硬盘温度、健康状态 (PASSED/FAILED)、通电时长与 SMART 详情",
			InstallCmd: "apt install -y smartmontools",
		},
		{
			Package:    "lm-sensors",
			Command:    "sensors",
			Category:   "sensor",
			Status:     statusOf("sensors", hasSensors),
			Reason:     "采集宿主机 CPU 封装温度、主板芯片组与 NVMe 实时温度",
			InstallCmd: "apt install -y lm-sensors",
		},
	}

	if hasNVMe {
		checks = append(checks, PackageDiagnostic{
			Package:    "nvme-cli",
			Command:    "nvme",
			Category:   "disk",
			Status:     statusOf("nvme", hasSensors),
			Reason:     "采集 NVMe 固态硬盘详细 SMART 日志、磨损度与写入量",
			InstallCmd: "apt install -y nvme-cli",
		})
	}
	if hasIntelGPU {
		checks = append(checks, PackageDiagnostic{
			Package:    "intel-gpu-tools",
			Command:    "intel_gpu_top",
			Category:   "gpu",
			Status:     statusOf("intel_gpu_top", false),
			Reason:     "采集 Intel 核显 / 独显实时 Render/Video 占用率、频率、功耗与 RC6 节能态",
			InstallCmd: "apt install -y intel-gpu-tools",
		})
	}
	if hasNvidiaGPU {
		checks = append(checks, PackageDiagnostic{
			Package:    "nvidia-driver",
			Command:    "nvidia-smi",
			Category:   "gpu",
			Status:     statusOf("nvidia-smi", false),
			Reason:     "采集 NVIDIA 显卡核心占用率、显存使用量、温度、功耗与风扇转速",
			InstallCmd: "apt install -y nvidia-driver",
		})
	}
	if hasAmdGPU {
		checks = append(checks, PackageDiagnostic{
			Package:    "radeontop",
			Command:    "radeontop",
			Category:   "gpu",
			Status:     statusOf("radeontop", false),
			Reason:     "采集 AMD 显卡实时渲染负载与显存使用率",
			InstallCmd: "apt install -y radeontop",
		})
	}

	var missing []PackageDiagnostic
	var aptPkgs []string
	for _, c := range checks {
		if c.Status == "missing" {
			missing = append(missing, c)
			aptPkgs = append(aptPkgs, c.Package)
		}
	}
	installAll := ""
	if len(aptPkgs) > 0 {
		installAll = "apt update && apt install -y " + strings.Join(aptPkgs, " ")
	}
	if missing == nil {
		missing = []PackageDiagnostic{}
	}
	return checks, missing, installAll
}

func detectGPUVendor(vendorID, vendorName string) string {
	vid := strings.ToLower(vendorID)
	vname := strings.ToLower(vendorName)
	switch {
	case vid == "0x8086" || strings.Contains(vname, "intel"):
		return "intel"
	case vid == "0x10de" || strings.Contains(vname, "nvidia"):
		return "nvidia"
	case vid == "0x1002" || strings.Contains(vname, "amd") || strings.Contains(vname, "advanced micro"):
		return "amd"
	default:
		return "other"
	}
}

func normalizePCI(raw string) string {
	s := strings.ToLower(strings.TrimSpace(raw))
	if s == "" {
		return ""
	}
	// Strip 8-char nvidia domain "00000000:01:00.0" -> "0000:01:00.0"
	if len(s) == 16 && strings.HasPrefix(s, "00000000:") {
		s = s[4:]
	}
	// If missing domain like "00:02.0", prepend "0000:"
	if strings.Count(s, ":") == 1 {
		s = "0000:" + s
	}
	return s
}

func findPCIBindings(m map[string][]GuestBindingRef, pciID string) []GuestBindingRef {
	var out []GuestBindingRef
	out = append(out, m[pciID]...)
	// Also check if VM passed whole slot without ".0" (e.g. "0000:01:00")
	if dot := strings.LastIndex(pciID, "."); dot > 0 {
		base := pciID[:dot]
		out = append(out, m[base]...)
	}
	return dedupRefs(out)
}

func dedupRefs(in []GuestBindingRef) []GuestBindingRef {
	if len(in) == 0 {
		return []GuestBindingRef{}
	}
	seen := map[string]bool{}
	out := make([]GuestBindingRef, 0, len(in))
	for _, r := range in {
		k := fmt.Sprintf("%s:%d", r.Type, r.VMID)
		if !seen[k] {
			seen[k] = true
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].VMID < out[j].VMID })
	return out
}

func nonNilRefs(in []GuestBindingRef) []GuestBindingRef {
	if in == nil {
		return []GuestBindingRef{}
	}
	return in
}

func sortSensors(sensors []SensorReading) {
	prio := func(label string) int {
		switch label {
		case "CPU 封装温度":
			return 0
		case "CPU 功耗":
			return 1
		default:
			return 2
		}
	}
	sort.Slice(sensors, func(i, j int) bool {
		pi, pj := prio(sensors[i].Label), prio(sensors[j].Label)
		if pi != pj {
			return pi < pj
		}
		return sensors[i].Label < sensors[j].Label
	})
}

type smartctlJSON struct {
	RawText      string `json:"-"`
	SerialNumber string `json:"serial_number"`
	SmartStatus  struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	Temperature struct {
		Current float64 `json:"current"`
	} `json:"temperature"`
	PowerOnTime struct {
		Hours int64 `json:"hours"`
	} `json:"power_on_time"`
	PowerCycleCount int64 `json:"power_cycle_count"`
	SpareAvailable  *struct {
		CurrentPercent   *int `json:"current_percent"`
		ThresholdPercent *int `json:"threshold_percent"`
	} `json:"spare_available"`
	EnduranceUsed *struct {
		CurrentPercent *int `json:"current_percent"`
	} `json:"endurance_used"`
	NVMeLog struct {
		CriticalWarning         int     `json:"critical_warning"`
		Temperature             float64 `json:"temperature"`
		AvailableSpare          *int    `json:"available_spare"`
		AvailableSpareThreshold *int    `json:"available_spare_threshold"`
		PercentageUsed          *int    `json:"percentage_used"`
		DataUnitsRead           int64   `json:"data_units_read"`
		DataUnitsWritten        int64   `json:"data_units_written"`
		MediaErrors             int64   `json:"media_errors"`
		UnsafeShutdowns         int64   `json:"unsafe_shutdowns"`
		PowerOnHours            int64   `json:"power_on_hours"`
		PowerCycles             int64   `json:"power_cycles"`
	} `json:"nvme_smart_health_information_log"`
	ATASmartAttributes *struct {
		Table []struct {
			ID     int    `json:"id"`
			Name   string `json:"name"`
			Value  int    `json:"value"`
			Worst  int    `json:"worst"`
			Thresh int    `json:"thresh"`
			Raw    struct {
				Value  int64  `json:"value"`
				String string `json:"string"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
}

func parseEmbeddedSmartFromStatus(raw map[string]any) map[string]*smartctlJSON {
	out := map[string]*smartctlJSON{}
	for k, v := range raw {
		if !strings.HasPrefix(k, "nvme") && !strings.HasPrefix(k, "sd") {
			continue
		}
		s, ok := v.(string)
		if !ok || !strings.HasPrefix(strings.TrimSpace(s), "{") {
			continue
		}
		var doc smartctlJSON
		if json.Unmarshal([]byte(s), &doc) == nil && doc.SerialNumber != "" {
			doc.RawText = strings.TrimSpace(s)
			cp := doc
			out[strings.TrimSpace(doc.SerialNumber)] = &cp
		}
	}
	return out
}

func formatNVMeDataUnits(units int64) string {
	bytes := float64(units) * 512000.0
	if bytes >= 1e12 {
		return fmt.Sprintf("%.2f TB", bytes/1e12)
	}
	return fmt.Sprintf("%.1f GB", bytes/1e9)
}

func applySmartJSON(item *DiskHardwareItem, doc *smartctlJSON) {
	if doc.RawText != "" && item.SMARTText == "" {
		item.SMARTText = doc.RawText
	}
	if doc.SmartStatus.Passed && item.Health == "" {
		item.Health = "PASSED"
	} else if !doc.SmartStatus.Passed && item.Health == "" && doc.RawText != "" {
		item.Health = "FAILED"
	}
	temp := doc.Temperature.Current
	if temp == 0 {
		temp = doc.NVMeLog.Temperature
	}
	if temp > 0 && temp < 120 {
		item.TempC = &temp
	}
	poh := doc.PowerOnTime.Hours
	if poh == 0 {
		poh = doc.NVMeLog.PowerOnHours
	}
	if poh > 0 {
		item.PowerOnHours = &poh
	}
	pc := doc.PowerCycleCount
	if pc == 0 {
		pc = doc.NVMeLog.PowerCycles
	}
	if pc > 0 {
		item.PowerCycles = &pc
	}
	if doc.SpareAvailable != nil {
		if doc.SpareAvailable.CurrentPercent != nil {
			v := *doc.SpareAvailable.CurrentPercent
			item.AvailableSparePct = &v
		}
		if doc.SpareAvailable.ThresholdPercent != nil {
			v := *doc.SpareAvailable.ThresholdPercent
			item.AvailableSpareThresholdPct = &v
		}
	}
	if doc.EnduranceUsed != nil && doc.EnduranceUsed.CurrentPercent != nil {
		used := *doc.EnduranceUsed.CurrentPercent
		if used >= 0 && used <= 100 {
			item.UsedLifePct = &used
			if item.WearoutPct == nil {
				rem := 100 - used
				item.WearoutPct = &rem
			}
		}
	}
	if doc.NVMeLog.DataUnitsRead > 0 {
		item.DataRead = formatNVMeDataUnits(doc.NVMeLog.DataUnitsRead)
	}
	if doc.NVMeLog.DataUnitsWritten > 0 {
		item.DataWritten = formatNVMeDataUnits(doc.NVMeLog.DataUnitsWritten)
	}
	if item.Type == "nvme" {
		cw := doc.NVMeLog.CriticalWarning
		item.CriticalWarning = &cw
		me := doc.NVMeLog.MediaErrors
		item.MediaErrors = &me
		if doc.NVMeLog.UnsafeShutdowns > 0 {
			us := doc.NVMeLog.UnsafeShutdowns
			item.UnsafeShutdowns = &us
		}
		if doc.NVMeLog.AvailableSpare != nil && item.AvailableSparePct == nil {
			v := *doc.NVMeLog.AvailableSpare
			item.AvailableSparePct = &v
		}
		if doc.NVMeLog.AvailableSpareThreshold != nil && item.AvailableSpareThresholdPct == nil {
			v := *doc.NVMeLog.AvailableSpareThreshold
			item.AvailableSpareThresholdPct = &v
		}
		if doc.NVMeLog.PercentageUsed != nil {
			used := *doc.NVMeLog.PercentageUsed
			if used >= 0 && used <= 255 {
				item.UsedLifePct = &used
				if item.WearoutPct == nil {
					rem := 100 - used
					if rem < 0 {
						rem = 0
					}
					item.WearoutPct = &rem
				}
			}
		}
	}
	if doc.ATASmartAttributes != nil {
		for _, attr := range doc.ATASmartAttributes.Table {
			lower := strings.ToLower(attr.Name)
			switch {
			case attr.ID == 5 || strings.Contains(lower, "reallocated_sector"):
				v := attr.Raw.Value
				item.ReallocatedSectors = &v
			case attr.ID == 197 || strings.Contains(lower, "current_pending_sector"):
				v := attr.Raw.Value
				item.PendingSectors = &v
			case attr.ID == 198 || strings.Contains(lower, "offline_uncorrectable"):
				v := attr.Raw.Value
				item.MediaErrors = &v
			case (attr.ID == 231 || attr.ID == 233 || strings.Contains(lower, "ssd_life_left") || strings.Contains(lower, "media_wearout")) && item.WearoutPct == nil:
				if attr.Value >= 0 && attr.Value <= 100 {
					v := attr.Value
					item.WearoutPct = &v
					u := 100 - v
					item.UsedLifePct = &u
				}
			case (attr.ID == 232 || strings.Contains(lower, "available_reservd_space")) && item.AvailableSparePct == nil:
				if attr.Value >= 0 && attr.Value <= 100 {
					v := attr.Value
					item.AvailableSparePct = &v
				}
			}
		}
	}
}

func computeDiskHealth(item *DiskHardwareItem, smartPkgMissing bool) {
	healthUpper := strings.ToUpper(strings.TrimSpace(item.Health))
	hasSmartData := item.SMARTText != "" || item.WearoutPct != nil || item.TempC != nil || item.PowerOnHours != nil ||
		healthUpper == "PASSED" || healthUpper == "OK" || healthUpper == "FAILED"

	if smartPkgMissing && !hasSmartData {
		item.TelemetryStatus = "missing_pkg"
		item.HealthGrade = "unknown"
		item.TelemetryNote = "宿主机未安装 smartmontools，无法采集硬盘健康度百分比、温度与 SMART 属性"
		return
	}
	if !hasSmartData {
		item.TelemetryStatus = "partial"
		item.HealthGrade = "unknown"
		item.TelemetryNote = "此设备未返回 SMART 数据（可能为虚拟盘、RAID 控制器屏蔽或设备休眠）"
		return
	}

	if item.SMARTText != "" && (item.TempC != nil || item.WearoutPct != nil || item.PowerOnHours != nil) {
		item.TelemetryStatus = "full"
	} else {
		item.TelemetryStatus = "partial"
	}

	// Synthesize transparent 0-100 health score
	score := 100
	var reasons []string

	if item.WearoutPct != nil {
		score = *item.WearoutPct
		if item.UsedLifePct != nil {
			reasons = append(reasons, fmt.Sprintf("剩余寿命 %d%%（已损耗 %d%%）", *item.WearoutPct, *item.UsedLifePct))
		} else {
			reasons = append(reasons, fmt.Sprintf("剩余寿命 %d%%", *item.WearoutPct))
		}
	} else if healthUpper == "PASSED" || healthUpper == "OK" {
		reasons = append(reasons, "SMART 自检通过 (PASSED)")
	}

	if healthUpper == "FAILED" {
		if score > 15 {
			score = 15
		}
		reasons = append(reasons, "SMART 总体状态 FAILED（严重风险）")
	}

	if item.CriticalWarning != nil && *item.CriticalWarning != 0 {
		if score > 30 {
			score = 30
		}
		reasons = append(reasons, fmt.Sprintf("NVMe 触发关键告警标志 (0x%x)", *item.CriticalWarning))
	}

	if item.AvailableSparePct != nil {
		thresh := 10
		if item.AvailableSpareThresholdPct != nil && *item.AvailableSpareThresholdPct > 0 {
			thresh = *item.AvailableSpareThresholdPct
		}
		if *item.AvailableSparePct <= thresh {
			score -= 35
			reasons = append(reasons, fmt.Sprintf("可用备用块 %d%% 低于安全阈值 (%d%%)", *item.AvailableSparePct, thresh))
		} else if *item.AvailableSparePct < 50 {
			score -= 10
			reasons = append(reasons, fmt.Sprintf("可用备用块降至 %d%%", *item.AvailableSparePct))
		} else {
			reasons = append(reasons, fmt.Sprintf("可用备用块 %d%%", *item.AvailableSparePct))
		}
	}

	if item.MediaErrors != nil && *item.MediaErrors > 0 {
		pen := int(*item.MediaErrors) * 5
		if pen > 40 {
			pen = 40
		}
		score -= pen
		reasons = append(reasons, fmt.Sprintf("检测到 %d 个介质/不可纠正错误", *item.MediaErrors))
	}
	if item.ReallocatedSectors != nil && *item.ReallocatedSectors > 0 {
		pen := int(*item.ReallocatedSectors) * 2
		if pen > 30 {
			pen = 30
		}
		score -= pen
		reasons = append(reasons, fmt.Sprintf("重映射扇区 %d 个", *item.ReallocatedSectors))
	}
	if item.PendingSectors != nil && *item.PendingSectors > 0 {
		pen := int(*item.PendingSectors) * 4
		if pen > 35 {
			pen = 35
		}
		score -= pen
		reasons = append(reasons, fmt.Sprintf("待映射不稳定扇区 %d 个", *item.PendingSectors))
	}
	if item.TempC != nil {
		if *item.TempC >= 72 {
			score -= 10
			reasons = append(reasons, fmt.Sprintf("温度偏高 (%.0f°C)", *item.TempC))
		} else if *item.TempC >= 62 {
			score -= 4
			reasons = append(reasons, fmt.Sprintf("温度略高 (%.0f°C)", *item.TempC))
		}
	}

	if score < 0 {
		score = 0
	}
	if score > 100 {
		score = 100
	}
	item.HealthPct = &score
	item.HealthReasons = reasons

	switch {
	case score >= 90 && healthUpper != "FAILED":
		item.HealthGrade = "excellent"
	case score >= 75 && healthUpper != "FAILED":
		item.HealthGrade = "good"
	case score >= 45 && healthUpper != "FAILED":
		item.HealthGrade = "warning"
	default:
		item.HealthGrade = "critical"
	}
}

var (
	reTemp         = regexp.MustCompile(`(?i)Temperature:\s+(\d+(?:\.\d+)?)\s*Celsius`)
	rePOH          = regexp.MustCompile(`(?i)Power On Hours:\s+([\d,]+)`)
	rePC           = regexp.MustCompile(`(?i)Power Cycles:\s+([\d,]+)`)
	reUnsafe       = regexp.MustCompile(`(?i)Unsafe Shutdowns:\s+([\d,]+)`)
	reRead         = regexp.MustCompile(`(?i)Data Units Read:.*\[([^\]]+)\]`)
	reWritten      = regexp.MustCompile(`(?i)Data Units Written:.*\[([^\]]+)\]`)
	reMediaE       = regexp.MustCompile(`(?i)Media and Data Integrity Errors:\s+([\d,]+)`)
	rePctUsed      = regexp.MustCompile(`(?i)Percentage Used:\s+(\d+)%`)
	reAvailSpare   = regexp.MustCompile(`(?i)Available Spare:\s+(\d+)%`)
	reSpareThresh  = regexp.MustCompile(`(?i)Available Spare Threshold:\s+(\d+)%`)
	reCritWarn     = regexp.MustCompile(`(?i)Critical Warning:\s+0x([0-9a-fA-F]+)`)
)

func parseSmartText(item *DiskHardwareItem, text string) {
	if text == "" {
		return
	}
	if m := reTemp.FindStringSubmatch(text); len(m) == 2 && item.TempC == nil {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			item.TempC = &v
		}
	}
	if m := rePOH.FindStringSubmatch(text); len(m) == 2 && item.PowerOnHours == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.PowerOnHours = &v
		}
	}
	if m := rePC.FindStringSubmatch(text); len(m) == 2 && item.PowerCycles == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.PowerCycles = &v
		}
	}
	if m := reUnsafe.FindStringSubmatch(text); len(m) == 2 && item.UnsafeShutdowns == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.UnsafeShutdowns = &v
		}
	}
	if m := reRead.FindStringSubmatch(text); len(m) == 2 && item.DataRead == "" {
		item.DataRead = strings.TrimSpace(m[1])
	}
	if m := reWritten.FindStringSubmatch(text); len(m) == 2 && item.DataWritten == "" {
		item.DataWritten = strings.TrimSpace(m[1])
	}
	if m := reMediaE.FindStringSubmatch(text); len(m) == 2 && item.MediaErrors == nil {
		if v, err := strconv.ParseInt(strings.ReplaceAll(m[1], ",", ""), 10, 64); err == nil {
			item.MediaErrors = &v
		}
	}
	if m := rePctUsed.FindStringSubmatch(text); len(m) == 2 {
		if used, err := strconv.Atoi(m[1]); err == nil && used >= 0 && used <= 255 {
			item.UsedLifePct = &used
			if item.WearoutPct == nil {
				rem := 100 - used
				if rem < 0 {
					rem = 0
				}
				item.WearoutPct = &rem
			}
		}
	}
	if m := reAvailSpare.FindStringSubmatch(text); len(m) == 2 && item.AvailableSparePct == nil {
		if v, err := strconv.Atoi(m[1]); err == nil && v >= 0 && v <= 100 {
			item.AvailableSparePct = &v
		}
	}
	if m := reSpareThresh.FindStringSubmatch(text); len(m) == 2 && item.AvailableSpareThresholdPct == nil {
		if v, err := strconv.Atoi(m[1]); err == nil && v >= 0 && v <= 100 {
			item.AvailableSpareThresholdPct = &v
		}
	}
	if m := reCritWarn.FindStringSubmatch(text); len(m) == 2 && item.CriticalWarning == nil {
		if v, err := strconv.ParseInt(m[1], 16, 32); err == nil {
			iv := int(v)
			item.CriticalWarning = &iv
		}
	}
}

func parseIntAny(v any) (int, bool) {
	switch x := v.(type) {
	case float64:
		return int(x), true
	case int:
		return x, true
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(x))
		return n, err == nil
	default:
		return 0, false
	}
}

var reFirstNum = regexp.MustCompile(`-?\d+(?:\.\d+)?`)

func extractFirstFloat(s string) (float64, bool) {
	m := reFirstNum.FindString(s)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseFloat(m, 64)
	return v, err == nil
}

func extractFirstInt64(s string) (int64, bool) {
	m := reFirstNum.FindString(s)
	if m == "" {
		return 0, false
	}
	v, err := strconv.ParseInt(strings.Split(m, ".")[0], 10, 64)
	return v, err == nil
}
