package service

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jianxcao/pve-dash/internal/pve"
	"github.com/jianxcao/pve-dash/internal/store"
	"golang.org/x/sync/errgroup"
	"golang.org/x/sync/singleflight"
)

type OverviewSummary struct {
	InstancesTotal   int     `json:"instancesTotal"`
	InstancesOnline  int     `json:"instancesOnline"`
	InstancesOffline int     `json:"instancesOffline"`
	NodesTotal       int     `json:"nodesTotal"`
	NodesOnline      int     `json:"nodesOnline"`
	QemuRunning      int     `json:"qemuRunning"`
	QemuStopped      int     `json:"qemuStopped"`
	LXCRunning       int     `json:"lxcRunning"`
	LXCStopped       int     `json:"lxcStopped"`
	Templates        int     `json:"templates"`
	TotalCPU         int64   `json:"totalCpu"`
	UsedCPU          float64 `json:"usedCpu"`
	TotalMem         int64   `json:"totalMem"`
	UsedMem          int64   `json:"usedMem"`
	TotalDisk        int64   `json:"totalDisk"`
	UsedDisk         int64   `json:"usedDisk"`
	RunningTasks     int     `json:"runningTasks"`
}

type UnifiedNode struct {
	URN           string  `json:"urn"`
	InstanceID    string  `json:"instanceId"`
	InstanceName  string  `json:"instanceName"`
	InstanceColor string  `json:"instanceColor"`
	Node          string  `json:"node"`
	Status        string  `json:"status"`
	IP            string  `json:"ip,omitempty"`
	CPU           float64 `json:"cpu"`
	MaxCPU        int64   `json:"maxcpu"`
	Mem           int64   `json:"mem"`
	MaxMem        int64   `json:"maxmem"`
	Disk          int64   `json:"disk"`
	MaxDisk       int64   `json:"maxdisk"`
	Uptime        int64   `json:"uptime"`
	CgroupMode    int64   `json:"cgroupMode,omitempty"`
}

type UnifiedGuest struct {
	URN           string   `json:"urn"`
	InstanceID    string   `json:"instanceId"`
	InstanceName  string   `json:"instanceName"`
	InstanceColor string   `json:"instanceColor"`
	Node          string   `json:"node"`
	Type          string   `json:"type"` // qemu | lxc
	VMID          int64    `json:"vmid"`
	Name          string   `json:"name"`
	Status        string   `json:"status"`
	Template      bool     `json:"template"`
	Tags          []string `json:"tags"`
	Pool          string   `json:"pool,omitempty"`
	CPU           float64  `json:"cpu"`
	MaxCPU        int64    `json:"maxcpu"`
	Mem           int64    `json:"mem"`
	MaxMem        int64    `json:"maxmem"`
	Disk          int64    `json:"disk"`
	MaxDisk       int64    `json:"maxdisk"`
	NetIn         int64    `json:"netin"`
	NetOut        int64    `json:"netout"`
	DiskRead      int64    `json:"diskread"`
	DiskWrite     int64    `json:"diskwrite"`
	Uptime        int64    `json:"uptime"`
}

type UnifiedStorage struct {
	URN           string   `json:"urn"`
	InstanceID    string   `json:"instanceId"`
	InstanceName  string   `json:"instanceName"`
	InstanceColor string   `json:"instanceColor"`
	Node          string   `json:"node"`
	Storage       string   `json:"storage"`
	PluginType    string   `json:"pluginType"`
	Status        string   `json:"status"`
	Shared        bool     `json:"shared"`
	Content       []string `json:"content"`
	Disk          int64    `json:"disk"`
	MaxDisk       int64    `json:"maxdisk"`
}

type UnifiedTask struct {
	InstanceID    string `json:"instanceId"`
	InstanceName  string `json:"instanceName"`
	InstanceColor string `json:"instanceColor"`
	UPID          string `json:"upid"`
	Node          string `json:"node"`
	Type          string `json:"type"`
	ID            string `json:"id"`
	User          string `json:"user"`
	Status        string `json:"status"`
	Running       bool   `json:"running"`
	StartTime     int64  `json:"starttime"`
	EndTime       int64  `json:"endtime,omitempty"`
}

type InstanceSnapshot struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	GroupName    string            `json:"groupName"`
	Color        string            `json:"color"`
	Enabled      bool              `json:"enabled"`
	State        string            `json:"state"` // online | offline | disabled
	PVEVersion   string            `json:"pveVersion"`
	IsCluster    bool              `json:"isCluster"`
	ClusterName  string            `json:"clusterName,omitempty"`
	Quorate      bool              `json:"quorate"`
	Capabilities *pve.Capabilities `json:"capabilities,omitempty"`
	Error        string            `json:"error,omitempty"`
	LatencyMs    int64             `json:"latencyMs,omitempty"`
	Nodes        []UnifiedNode     `json:"nodes"`
	GuestCount   int               `json:"guestCount"`
	RunningCount int               `json:"runningCount"`
}

type GlobalOverview struct {
	Summary   OverviewSummary    `json:"summary"`
	Instances []InstanceSnapshot `json:"instances"`
	Nodes     []UnifiedNode      `json:"nodes"`
	Guests    []UnifiedGuest     `json:"guests"`
	Storages  []UnifiedStorage   `json:"storages"`
	Tasks     []UnifiedTask      `json:"tasks"`
	UpdatedAt string             `json:"updatedAt"`
}

type SearchHit struct {
	Kind          string   `json:"kind"` // instance | node | qemu | lxc | storage
	Title         string   `json:"title"`
	Subtitle      string   `json:"subtitle"`
	URN           string   `json:"urn"`
	InstanceID    string   `json:"instanceId"`
	InstanceName  string   `json:"instanceName"`
	Node          string   `json:"node,omitempty"`
	GuestType     string   `json:"guestType,omitempty"`
	VMID          int64    `json:"vmid,omitempty"`
	Status        string   `json:"status,omitempty"`
	Tags          []string `json:"tags,omitempty"`
}

type AggregatorService struct {
	store *store.Store
	pool  *pve.Pool

	mu        sync.RWMutex
	cached    *GlobalOverview
	cachedAt  time.Time
	cacheTTL  time.Duration
	sfGroup   singleflight.Group
}

func NewAggregatorService(st *store.Store, pool *pve.Pool) *AggregatorService {
	return &AggregatorService{
		store:    st,
		pool:     pool,
		cacheTTL: 2 * time.Second,
	}
}

func (a *AggregatorService) InvalidateCache() {
	a.mu.Lock()
	a.cached = nil
	a.cachedAt = time.Time{}
	a.mu.Unlock()
}

func (a *AggregatorService) GetOverview(ctx context.Context, forceRefresh bool) (*GlobalOverview, error) {
	if !forceRefresh {
		a.mu.RLock()
		if a.cached != nil && time.Since(a.cachedAt) < a.cacheTTL {
			c := a.cached
			a.mu.RUnlock()
			return c, nil
		}
		a.mu.RUnlock()
	}

	ch := a.sfGroup.DoChan("overview", func() (any, error) {
		runCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		ov, err := a.collectOverview(runCtx)
		if err != nil {
			return nil, err
		}
		a.mu.Lock()
		a.cached = ov
		a.cachedAt = time.Now()
		a.mu.Unlock()
		return ov, nil
	})
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case res := <-ch:
		if res.Err != nil {
			return nil, res.Err
		}
		return res.Val.(*GlobalOverview), nil
	}
}

type perInstanceData struct {
	snap     InstanceSnapshot
	nodes    []UnifiedNode
	guests   []UnifiedGuest
	storages []UnifiedStorage
	tasks    []UnifiedTask
}

func (a *AggregatorService) collectOverview(ctx context.Context) (*GlobalOverview, error) {
	instances, err := a.store.ListInstances(ctx)
	if err != nil {
		return nil, err
	}

	results := make([]perInstanceData, len(instances))
	var g errgroup.Group
	g.SetLimit(8)

	for i, inst := range instances {
		i, inst := i, inst
		g.Go(func() error {
			results[i] = a.fetchInstance(ctx, inst)
			return nil
		})
	}
	_ = g.Wait()

	ov := &GlobalOverview{
		Instances: make([]InstanceSnapshot, 0, len(instances)),
		Nodes:     []UnifiedNode{},
		Guests:    []UnifiedGuest{},
		Storages:  []UnifiedStorage{},
		Tasks:     []UnifiedTask{},
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}

	for _, r := range results {
		ov.Summary.InstancesTotal++
		switch r.snap.State {
		case "online":
			ov.Summary.InstancesOnline++
		case "offline":
			ov.Summary.InstancesOffline++
		}
		ov.Instances = append(ov.Instances, r.snap)
		ov.Nodes = append(ov.Nodes, r.nodes...)
		ov.Guests = append(ov.Guests, r.guests...)
		ov.Storages = append(ov.Storages, r.storages...)
		ov.Tasks = append(ov.Tasks, r.tasks...)

		for _, n := range r.nodes {
			ov.Summary.NodesTotal++
			if n.Status == "online" {
				ov.Summary.NodesOnline++
				ov.Summary.TotalCPU += n.MaxCPU
				ov.Summary.UsedCPU += n.CPU * float64(n.MaxCPU)
				ov.Summary.TotalMem += n.MaxMem
				ov.Summary.UsedMem += n.Mem
			}
		}
		for _, gst := range r.guests {
			if gst.Template {
				ov.Summary.Templates++
				continue
			}
			if gst.Type == "qemu" {
				if gst.Status == "running" {
					ov.Summary.QemuRunning++
				} else {
					ov.Summary.QemuStopped++
				}
			} else if gst.Type == "lxc" {
				if gst.Status == "running" {
					ov.Summary.LXCRunning++
				} else {
					ov.Summary.LXCStopped++
				}
			}
		}
		seenShared := map[string]bool{}
		for _, st := range r.storages {
			if st.Status != "available" {
				continue
			}
			if st.Shared {
				key := st.InstanceID + ":" + st.Storage
				if seenShared[key] {
					continue
				}
				seenShared[key] = true
			}
			ov.Summary.TotalDisk += st.MaxDisk
			ov.Summary.UsedDisk += st.Disk
		}
		for _, t := range r.tasks {
			if t.Running {
				ov.Summary.RunningTasks++
			}
		}
	}

	sort.Slice(ov.Nodes, func(i, j int) bool {
		if ov.Nodes[i].InstanceName != ov.Nodes[j].InstanceName {
			return ov.Nodes[i].InstanceName < ov.Nodes[j].InstanceName
		}
		return ov.Nodes[i].Node < ov.Nodes[j].Node
	})

	sort.Slice(ov.Storages, func(i, j int) bool {
		if ov.Storages[i].InstanceName != ov.Storages[j].InstanceName {
			return ov.Storages[i].InstanceName < ov.Storages[j].InstanceName
		}
		if ov.Storages[i].Node != ov.Storages[j].Node {
			return ov.Storages[i].Node < ov.Storages[j].Node
		}
		return ov.Storages[i].Storage < ov.Storages[j].Storage
	})

	sort.Slice(ov.Guests, func(i, j int) bool {
		if ov.Guests[i].InstanceName != ov.Guests[j].InstanceName {
			return ov.Guests[i].InstanceName < ov.Guests[j].InstanceName
		}
		return ov.Guests[i].VMID < ov.Guests[j].VMID
	})

	sort.Slice(ov.Tasks, func(i, j int) bool {
		if ov.Tasks[i].Running != ov.Tasks[j].Running {
			return ov.Tasks[i].Running
		}
		return ov.Tasks[i].StartTime > ov.Tasks[j].StartTime
	})
	if len(ov.Tasks) > 80 {
		ov.Tasks = ov.Tasks[:80]
	}

	return ov, nil
}

func (a *AggregatorService) fetchInstance(parentCtx context.Context, inst *store.PVEInstance) perInstanceData {
	snap := InstanceSnapshot{
		ID:         inst.ID,
		Name:       inst.Name,
		GroupName:  inst.GroupName,
		Color:      inst.Color,
		Enabled:    inst.Enabled,
		PVEVersion: inst.DetectedVersion,
		IsCluster:  inst.IsCluster,
		Nodes:      []UnifiedNode{},
	}
	if inst.CapabilitiesJSON != "" && inst.CapabilitiesJSON != "{}" {
		var caps pve.Capabilities
		if json.Unmarshal([]byte(inst.CapabilitiesJSON), &caps) == nil {
			snap.Capabilities = &caps
		}
	}

	if !inst.Enabled {
		snap.State = "disabled"
		return perInstanceData{snap: snap}
	}

	// Strict per-instance timeout so an offline PVE never blocks the global overview
	ctx, cancel := context.WithTimeout(parentCtx, 4*time.Second)
	defer cancel()

	start := time.Now()
	cl, _, err := a.pool.Get(ctx, inst.ID)
	if err != nil {
		snap.State = "offline"
		snap.Error = err.Error()
		return perInstanceData{snap: snap}
	}

	var (
		resources   []pve.ClusterResource
		clusterStat []pve.ClusterStatusItem
		tasks       []pve.TaskItem
		verInfo     *pve.VersionInfo
		resErr      error
	)

	var subG errgroup.Group
	subG.Go(func() error {
		resources, resErr = cl.GetClusterResources(ctx, "")
		return nil
	})
	subG.Go(func() error {
		clusterStat, _ = cl.GetClusterStatus(ctx)
		return nil
	})
	subG.Go(func() error {
		tasks, _ = cl.GetClusterTasks(ctx)
		return nil
	})
	if inst.DetectedVersion == "" || inst.CapabilitiesJSON == "" || inst.CapabilitiesJSON == "{}" {
		subG.Go(func() error {
			verInfo, _ = cl.GetVersion(ctx)
			return nil
		})
	}
	_ = subG.Wait()

	if resErr != nil {
		snap.State = "offline"
		snap.Error = resErr.Error()
		return perInstanceData{snap: snap}
	}

	snap.State = "online"
	snap.LatencyMs = time.Since(start).Milliseconds()

	nodeIPs := map[string]string{}
	snap.Quorate = true
	for _, cs := range clusterStat {
		if cs.Type == "cluster" {
			snap.IsCluster = true
			snap.ClusterName = cs.Name
			snap.Quorate = bool(cs.Quorate)
		} else if cs.Type == "node" && cs.IP != "" {
			nodeIPs[cs.Name] = cs.IP
		}
	}

	if verInfo != nil {
		caps := pve.BuildCapabilities(verInfo, snap.IsCluster)
		snap.PVEVersion = verInfo.Version
		snap.Capabilities = &caps
		if b, err := json.Marshal(caps); err == nil {
			_ = a.store.UpdateInstanceDetection(context.Background(), inst.ID, verInfo.Version, snap.IsCluster, string(b))
		}
	}

	out := perInstanceData{snap: snap}
	for _, r := range resources {
		switch r.Type {
		case "node":
			un := UnifiedNode{
				URN:           inst.ID + ":node:" + r.Node,
				InstanceID:    inst.ID,
				InstanceName:  inst.Name,
				InstanceColor: inst.Color,
				Node:          r.Node,
				Status:        r.Status,
				IP:            nodeIPs[r.Node],
				CPU:           float64(r.CPU),
				MaxCPU:        int64(r.MaxCPU),
				Mem:           int64(r.Mem),
				MaxMem:        int64(r.MaxMem),
				Disk:          int64(r.Disk),
				MaxDisk:       int64(r.MaxDisk),
				Uptime:        int64(r.Uptime),
				CgroupMode:    int64(r.CgroupMode),
			}
			out.nodes = append(out.nodes, un)
			out.snap.Nodes = append(out.snap.Nodes, un)
		case "qemu", "lxc":
			tags := splitTags(r.Tags)
			ug := UnifiedGuest{
				URN:           inst.ID + ":" + r.Type + ":" + r.Node + ":" + strconv.FormatInt(int64(r.VMID), 10),
				InstanceID:    inst.ID,
				InstanceName:  inst.Name,
				InstanceColor: inst.Color,
				Node:          r.Node,
				Type:          r.Type,
				VMID:          int64(r.VMID),
				Name:          r.Name,
				Status:        r.Status,
				Template:      bool(r.Template),
				Tags:          tags,
				Pool:          r.Pool,
				CPU:           float64(r.CPU),
				MaxCPU:        int64(r.MaxCPU),
				Mem:           int64(r.Mem),
				MaxMem:        int64(r.MaxMem),
				Disk:          int64(r.Disk),
				MaxDisk:       int64(r.MaxDisk),
				NetIn:         int64(r.NetIn),
				NetOut:        int64(r.NetOut),
				DiskRead:      int64(r.DiskRead),
				DiskWrite:     int64(r.DiskWrite),
				Uptime:        int64(r.Uptime),
			}
			out.guests = append(out.guests, ug)
			if !ug.Template {
				out.snap.GuestCount++
				if ug.Status == "running" {
					out.snap.RunningCount++
				}
			}
		case "storage":
			content := []string{}
			for _, part := range strings.Split(r.Content, ",") {
				if p := strings.TrimSpace(part); p != "" {
					content = append(content, p)
				}
			}
			sort.Strings(content)
			out.storages = append(out.storages, UnifiedStorage{
				URN:           inst.ID + ":storage:" + r.Node + ":" + r.Storage,
				InstanceID:    inst.ID,
				InstanceName:  inst.Name,
				InstanceColor: inst.Color,
				Node:          r.Node,
				Storage:       r.Storage,
				PluginType:    r.PluginType,
				Status:        r.Status,
				Shared:        bool(r.Shared),
				Content:       content,
				Disk:          int64(r.Disk),
				MaxDisk:       int64(r.MaxDisk),
			})
		}
	}

	for _, t := range tasks {
		running := t.EndTime == 0 && t.Status == ""
		out.tasks = append(out.tasks, UnifiedTask{
			InstanceID:    inst.ID,
			InstanceName:  inst.Name,
			InstanceColor: inst.Color,
			UPID:          t.UPID,
			Node:          t.Node,
			Type:          t.Type,
			ID:            t.ID,
			User:          t.User,
			Status:        t.Status,
			Running:       running,
			StartTime:     int64(t.StartTime),
			EndTime:       int64(t.EndTime),
		})
	}
	sort.Slice(out.snap.Nodes, func(i, j int) bool {
		return out.snap.Nodes[i].Node < out.snap.Nodes[j].Node
	})
	return out
}

func (a *AggregatorService) Search(ctx context.Context, query string) ([]SearchHit, error) {
	ov, err := a.GetOverview(ctx, false)
	if err != nil {
		return nil, err
	}
	q := strings.ToLower(strings.TrimSpace(query))
	var hits []SearchHit

	match := func(fields ...string) bool {
		if q == "" {
			return true
		}
		for _, f := range fields {
			if strings.Contains(strings.ToLower(f), q) {
				return true
			}
		}
		return false
	}

	for _, g := range ov.Guests {
		vmidStr := strconv.FormatInt(g.VMID, 10)
		if match(g.Name, vmidStr, g.Node, g.InstanceName, g.Type, strings.Join(g.Tags, " ")) {
			hits = append(hits, SearchHit{
				Kind:         g.Type,
				Title:        g.Name,
				Subtitle:     g.InstanceName + " / " + g.Node + " · #" + vmidStr,
				URN:          g.URN,
				InstanceID:   g.InstanceID,
				InstanceName: g.InstanceName,
				Node:         g.Node,
				GuestType:    g.Type,
				VMID:         g.VMID,
				Status:       g.Status,
				Tags:         g.Tags,
			})
		}
	}
	for _, n := range ov.Nodes {
		if match(n.Node, n.InstanceName, n.IP) {
			hits = append(hits, SearchHit{
				Kind:         "node",
				Title:        n.Node,
				Subtitle:     n.InstanceName + " · " + n.IP,
				URN:          n.URN,
				InstanceID:   n.InstanceID,
				InstanceName: n.InstanceName,
				Node:         n.Node,
				Status:       n.Status,
			})
		}
	}
	for _, s := range ov.Storages {
		if match(s.Storage, s.Node, s.InstanceName, s.PluginType) {
			hits = append(hits, SearchHit{
				Kind:         "storage",
				Title:        s.Storage,
				Subtitle:     s.InstanceName + " / " + s.Node + " (" + s.PluginType + ")",
				URN:          s.URN,
				InstanceID:   s.InstanceID,
				InstanceName: s.InstanceName,
				Node:         s.Node,
				Status:       s.Status,
			})
		}
	}

	if len(hits) > 30 {
		hits = hits[:30]
	}
	return hits, nil
}

func splitTags(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool { return r == ';' || r == ',' || r == ' ' })
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}
