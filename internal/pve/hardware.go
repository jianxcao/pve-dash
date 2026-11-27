package pve

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

type PCIDevice struct {
	ID                  string   `json:"id"`
	Class               string   `json:"class"`
	Device              string   `json:"device"`
	DeviceName          string   `json:"device_name"`
	Vendor              string   `json:"vendor"`
	VendorName          string   `json:"vendor_name"`
	SubsystemDevice     string   `json:"subsystem_device,omitempty"`
	SubsystemVendorName string   `json:"subsystem_vendor_name,omitempty"`
	IOMMUGroup          FlexInt  `json:"iommugroup"`
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
		ID        FlexInt `json:"id"`
		Name      string  `json:"name"`
		Raw       string  `json:"raw"`
		Value     FlexInt `json:"value"`
		Worst     FlexInt `json:"worst"`
		Threshold FlexInt `json:"threshold"`
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
	DisksEnumerated     bool                  `json:"-"`
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

func (c *Client) getNodeStatusCombined(ctx context.Context, node string) (*NodeStatus, map[string]any, error) {
	var rawBytes json.RawMessage
	path := fmt.Sprintf("/nodes/%s/status", url.PathEscape(node))
	if err := c.DoJSON(ctx, http.MethodGet, path, nil, &rawBytes); err != nil {
		return nil, nil, err
	}
	var st NodeStatus
	if err := json.Unmarshal(rawBytes, &st); err != nil {
		return nil, nil, err
	}
	var rawMap map[string]any
	_ = json.Unmarshal(rawBytes, &rawMap)
	return &st, rawMap, nil
}

func (c *Client) GetClusterPCIMappings(ctx context.Context) ([]PCIMappingItem, error) {
	var out []PCIMappingItem
	if err := c.DoJSON(ctx, http.MethodGet, "/cluster/mapping/pci", nil, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// --- Hardware Collector with Short TTL & Anti-Stampede Floor ---

const (
	hwCacheDefaultTTL     = 12 * time.Second
	hwAlertCacheTTL       = 30 * time.Second
	hwForceMinRefreshFloor = 5 * time.Second
)

type hardwareCacheEntry struct {
	report *NodeHardwareReport
	at     time.Time
}

var (
	hwCacheMu sync.Mutex
	hwCache   = map[string]hardwareCacheEntry{}
	hwSF      singleflight.Group
)

// InvalidateHardwareCache clears cached hardware reports (for testing or admin reset).
func InvalidateHardwareCache() {
	hwCacheMu.Lock()
	clear(hwCache)
	hwCacheMu.Unlock()
}

// CollectNodeHardware aggregates host non-passthrough hardware (GPU, Disks, CPU, Memory),
// detects VM/LXC passthrough bindings, queries optional SSH live GPU/package diagnostics,
// and enforces a 5s minimum anti-stampede floor even when force == true.
func CollectNodeHardware(ctx context.Context, cl *Client, instanceID, node, sshHost string, force bool) (*NodeHardwareReport, error) {
	cacheKey := "full:" + instanceID + ":" + node + ":" + strings.TrimSpace(sshHost)
	ttl := hwCacheDefaultTTL
	if force {
		ttl = hwForceMinRefreshFloor
	}

	hwCacheMu.Lock()
	if len(hwCache) > 64 {
		for k, v := range hwCache {
			if time.Since(v.at) > 2*time.Minute {
				delete(hwCache, k)
			}
		}
	}
	if entry, ok := hwCache[cacheKey]; ok && time.Since(entry.at) < ttl {
		rep := entry.report
		hwCacheMu.Unlock()
		return rep, nil
	}
	hwCacheMu.Unlock()

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

// CollectNodeAlertHardware performs a lightweight, standby-safe hardware sweep for AlertEngine:
// it skips crawling VM/LXC /config endpoints, skips GPU top sampling, and passes `-n standby,0`
// to SSH `smartctl` so spun-down NAS HDDs are never woken up during background alert checks.
func CollectNodeAlertHardware(ctx context.Context, cl *Client, instID, sshHost, node string, force bool) (*NodeHardwareReport, error) {
	cacheKey := "alert:" + instID + ":" + node + ":" + strings.TrimSpace(sshHost)
	ttl := hwAlertCacheTTL
	if force {
		ttl = hwForceMinRefreshFloor
	}

	hwCacheMu.Lock()
	if entry, ok := hwCache[cacheKey]; ok && time.Since(entry.at) < ttl {
		rep := entry.report
		hwCacheMu.Unlock()
		return rep, nil
	}
	hwCacheMu.Unlock()

	ch := hwSF.DoChan(cacheKey, func() (any, error) {
		runCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		return collectNodeAlertHardwareUncached(runCtx, cl, instID, sshHost, node, cacheKey)
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

func collectNodeAlertHardwareUncached(ctx context.Context, cl *Client, instanceID, sshHost, node, cacheKey string) (*NodeHardwareReport, error) {
	var (
		nodeStatus *NodeStatus
		rawStatus  map[string]any
		diskList   []PhysicalDisk
		sshData    *sshHostProbeData
		sshErrStr  string
		statusErr  error
		disksErr   error
	)

	sshHost = strings.TrimSpace(sshHost)
	var g errgroup.Group
	g.Go(func() error {
		nodeStatus, rawStatus, statusErr = cl.getNodeStatusCombined(ctx, node)
		return nil
	})
	g.Go(func() error {
		diskList, disksErr = cl.GetNodeDisks(ctx, node)
		return nil
	})
	if sshHost != "" {
		g.Go(func() error {
			d, err := runSSHAlertProbe(ctx, sshHost)
			if err != nil {
				sshErrStr = err.Error()
			} else {
				sshData = d
			}
			return nil
		})
	}
	_ = g.Wait()

	if statusErr != nil {
		return nil, statusErr
	}

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

	embeddedSMART := parseEmbeddedSmartFromStatus(rawStatus)
	disks := make([]DiskHardwareItem, len(diskList))

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

			if isStandbyHealthLabel(item.Health) || (sshData != nil && sshData.StandbyDisks[d.DevPath]) {
				item.TelemetryStatus = "partial"
				item.HealthGrade = "unknown"
				item.TelemetryNote = "硬盘处于休眠待机 (STANDBY) 状态，已跳过唤醒检测"
				disks[i] = item
				return nil
			}

			diskSmartMissing := false
			if emb, ok := embeddedSMART[d.Serial]; ok {
				applySmartJSON(&item, emb)
			} else if sshData != nil {
				if doc, ok := sshData.DiskSMART[d.DevPath]; ok {
					applySmartJSON(&item, doc)
				} else if d.Serial != "" {
					if docBySer, okSer := sshData.DiskSMART["serial:"+d.Serial]; okSer {
						applySmartJSON(&item, docBySer)
					}
				}
			} else if d.DevPath != "" && item.Type != "hdd" {
				// Without SSH, only query PVE /disks/smart on non-rotational SSD/NVMe media so spun-down HDDs are never woken.
				sm, err := cl.GetNodeDiskSMART(ctx, node, d.DevPath)
				if err != nil {
					if strings.Contains(strings.ToLower(err.Error()), "smartctl") ||
						strings.Contains(strings.ToLower(err.Error()), "not found") {
						diskSmartMissing = true
					}
				} else if sm != nil {
					applyDiskSMARTResp(&item, sm)
				}
			}

			computeDiskHealth(&item, diskSmartMissing || (sshData != nil && !sshData.Tools["smartctl"]))
			disks[i] = item
			return nil
		})
	}
	_ = dg.Wait()
	sort.Slice(disks, func(i, j int) bool { return disks[i].DevPath < disks[j].DevPath })

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
		GPUs:                []GPUHardwareItem{},
		Disks:               disks,
		Sensors:             sensors,
		PackageChecks:       []PackageDiagnostic{},
		MissingPackages:     []PackageDiagnostic{},
		DisksEnumerated:     disksErr == nil,
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
		nodeStatus, rawStatus, statusErr = cl.getNodeStatusCombined(ctx, node)
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

		if sshData != nil && !gpu.PassthroughActive {
			applySSHGPUTelemetry(&gpu, sshData)
		}

		gpus = append(gpus, gpu)
	}
	sort.Slice(gpus, func(i, j int) bool { return gpus[i].ID < gpus[j].ID })

	// 3. Physical Disks + SMART + Passthrough Detection
	embeddedSMART := parseEmbeddedSmartFromStatus(rawStatus)
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
					applyDiskSMARTResp(&item, sm)
				}
			}

			computeDiskHealth(&item, diskSmartMissing || (sshData != nil && !sshData.Tools["smartctl"]))

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

	// 4. Package Diagnostics
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
			Package:  "smartmontools",
			Command:  "smartctl",
			Category: "disk",
			Status: func() string {
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
	if len(s) == 16 && strings.HasPrefix(s, "00000000:") {
		s = s[4:]
	}
	if strings.Count(s, ":") == 1 {
		s = "0000:" + s
	}
	return s
}

func findPCIBindings(m map[string][]GuestBindingRef, pciID string) []GuestBindingRef {
	var out []GuestBindingRef
	out = append(out, m[pciID]...)
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
