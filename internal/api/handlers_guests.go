package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
	"golang.org/x/sync/errgroup"
)

// --- Unified QEMU & LXC Route & Validation Helpers ---

func parseGuestRoute(r *http.Request) (instanceID, node, guestType string, vmid int, err error) {
	instanceID = chi.URLParam(r, "instanceId")
	node = urlParamDecoded(r, "node")
	if err = pve.ValidateNodeName(node); err != nil {
		return "", "", "", 0, err
	}
	guestType = chi.URLParam(r, "type")
	if guestType != "qemu" && guestType != "lxc" {
		return "", "", "", 0, errors.New("type must be qemu or lxc")
	}
	vmid, err = strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		return "", "", "", 0, errors.New("invalid vmid")
	}
	return instanceID, node, guestType, vmid, nil
}

// encodePVESSHKeys delegates to pve.EncodeCloudInitSSHKeys after normalizing CRLF/CR line endings.
func encodePVESSHKeys(raw string) string {
	normalized := strings.NewReplacer("\r\n", "\n", "\r", "\n").Replace(strings.TrimSpace(raw))
	return pve.EncodeCloudInitSSHKeys(normalized)
}

func isIndexedKeyInRange(kl, prefix string, maxIdx int) bool {
	if !strings.HasPrefix(kl, prefix) {
		return false
	}
	suffix := strings.TrimPrefix(kl, prefix)
	if suffix == "" {
		return false
	}
	for _, ch := range suffix {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	n, err := strconv.Atoi(suffix)
	return err == nil && n >= 0 && n <= maxIdx
}

func isLXCMountKey(k string) bool {
	kl := strings.ToLower(strings.TrimSpace(k))
	return kl == "rootfs" || isIndexedKeyInRange(kl, "mp", 255)
}

func isHostBindMountValue(v string) bool {
	trimmed := strings.TrimSpace(v)
	if strings.HasPrefix(trimmed, "/") {
		return true
	}
	for _, seg := range strings.Split(trimmed, ",") {
		part := strings.TrimSpace(seg)
		if strings.HasPrefix(strings.ToLower(part), "volume=") {
			vol := strings.TrimSpace(part[len("volume="):])
			if strings.HasPrefix(vol, "/") {
				return true
			}
		}
	}
	return false
}

func isPrivilegedGuestConfigKey(k string) bool {
	kl := strings.ToLower(strings.TrimSpace(k))
	return kl == "args" ||
		kl == "hookscript" ||
		kl == "lxc" ||
		strings.HasPrefix(kl, "lxc.") ||
		strings.HasPrefix(kl, "hostpci") ||
		strings.HasPrefix(kl, "usb") ||
		strings.HasPrefix(kl, "unused") ||
		strings.HasPrefix(kl, "virtiofs") ||
		isIndexedKeyInRange(kl, "dev", 255)
}

func isQemuAgentEnabled(cfg map[string]any) bool {
	if cfg == nil {
		return false
	}
	raw, exists := cfg["agent"]
	if !exists || raw == nil {
		return false
	}
	s := strings.TrimSpace(fmt.Sprint(raw))
	if s == "" || s == "0" {
		return false
	}
	for _, part := range strings.Split(s, ",") {
		kv := strings.TrimSpace(part)
		if kv == "0" || kv == "enabled=0" {
			return false
		}
	}
	return true
}

// --- Guest Creation (QEMU VM, LXC Container, Template Clone) ---

func (s *Server) handleCreateQemu(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	var body struct {
		VMID            int    `json:"vmid"`
		Name            string `json:"name"`
		OSType          string `json:"ostype"`     // l26 | win11 | win10 | other
		ISO             string `json:"iso"`        // e.g. local:iso/ubuntu.iso or ""
		Storage         string `json:"storage"`    // e.g. local-lvm / local
		DiskSizeGB      int    `json:"diskSizeGb"` // e.g. 32
		DiskBus         string `json:"diskBus"`    // scsi | virtio | sata
		SSD             bool   `json:"ssd"`
		Discard         bool   `json:"discard"`
		Cores           int    `json:"cores"`
		Sockets         int    `json:"sockets"`
		CPUType         string `json:"cpuType"` // host | x86-64-v2-AES | kvm64
		MemoryMB        int    `json:"memoryMb"`
		BalloonMB       *int   `json:"balloonMb"`
		Bridge          string `json:"bridge"`   // e.g. vmbr0
		NetModel        string `json:"netModel"` // virtio | e1000 | vmxnet3
		VLANTag         int    `json:"vlanTag"`
		Firewall        bool   `json:"firewall"`
		BIOS            string `json:"bios"`       // seabios | ovmf
		SecureBoot      *bool  `json:"secureBoot"` // UEFI pre-enrolled keys
		TPM             bool   `json:"tpm"`        // TPM 2.0 state disk
		Machine         string `json:"machine"`    // q35 | i440fx
		Agent           bool   `json:"agent"`
		OnBoot          bool   `json:"onboot"`
		StartAfter      bool   `json:"start"`
		Tags            string `json:"tags"`
		Description     string `json:"description"`
		EnableCloudInit bool   `json:"enableCloudInit"`
		CIUser          string `json:"ciuser"`
		CIPassword      string `json:"cipassword"`
		SSHKeys         string `json:"sshkeys"`
		IPConfig0       string `json:"ipconfig0"`
		Nameserver      string `json:"nameserver"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.VMID < 100 || strings.TrimSpace(body.Name) == "" {
		writeErr(w, http.StatusBadRequest, "vmid (>= 100) and name are required")
		return
	}
	diskStorage := strings.TrimSpace(body.Storage)
	if diskStorage != "" {
		if err := pve.ValidateStorageID(diskStorage); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	params := url.Values{}
	params.Set("vmid", strconv.Itoa(body.VMID))
	params.Set("name", strings.TrimSpace(body.Name))
	if body.OSType == "" {
		body.OSType = "l26"
	}
	params.Set("ostype", body.OSType)
	if body.Cores < 1 {
		body.Cores = 2
	}
	if body.Sockets < 1 {
		body.Sockets = 1
	}
	if body.MemoryMB < 256 {
		body.MemoryMB = 2048
	}
	params.Set("cores", strconv.Itoa(body.Cores))
	params.Set("sockets", strconv.Itoa(body.Sockets))
	params.Set("memory", strconv.Itoa(body.MemoryMB))
	if body.BalloonMB != nil && *body.BalloonMB >= 0 {
		params.Set("balloon", strconv.Itoa(*body.BalloonMB))
	}
	if strings.TrimSpace(body.CPUType) != "" {
		params.Set("cpu", strings.TrimSpace(body.CPUType))
	} else {
		params.Set("cpu", "x86-64-v2-AES")
	}
	if body.Machine != "" {
		params.Set("machine", body.Machine)
	}
	if body.BIOS != "" {
		params.Set("bios", body.BIOS)
	}
	params.Set("scsihw", "virtio-scsi-single")

	// Primary disk
	if diskStorage != "" && body.DiskSizeGB > 0 {
		bus := body.DiskBus
		if bus != "virtio" && bus != "sata" {
			bus = "scsi"
		}
		diskKey := bus + "0"
		diskOpts := []string{fmt.Sprintf("%s:%d", diskStorage, body.DiskSizeGB)}
		if bus == "scsi" {
			diskOpts = append(diskOpts, "iothread=1")
			if body.SSD {
				diskOpts = append(diskOpts, "ssd=1")
			}
		}
		if body.Discard {
			diskOpts = append(diskOpts, "discard=on")
		}
		params.Set(diskKey, strings.Join(diskOpts, ","))
		if strings.TrimSpace(body.ISO) != "" {
			params.Set("boot", fmt.Sprintf("order=%s;ide2;net0", diskKey))
		} else {
			params.Set("boot", fmt.Sprintf("order=%s;net0", diskKey))
		}
	}

	// UEFI EFI disk & optional TPM 2.0 state disk
	if body.BIOS == "ovmf" && diskStorage != "" {
		preEnrolledKeys := 0
		if (body.SecureBoot != nil && *body.SecureBoot) || (body.SecureBoot == nil && body.OSType == "win11") {
			preEnrolledKeys = 1
		}
		params.Set("efidisk0", fmt.Sprintf("%s:1,efitype=4m,pre-enrolled-keys=%d", diskStorage, preEnrolledKeys))
	}
	if body.TPM && diskStorage != "" {
		params.Set("tpmstate0", fmt.Sprintf("%s:1,version=v2.0", diskStorage))
	}

	if strings.TrimSpace(body.ISO) != "" {
		params.Set("ide2", fmt.Sprintf("%s,media=cdrom", strings.TrimSpace(body.ISO)))
	}

	if strings.TrimSpace(body.Bridge) != "" {
		model := body.NetModel
		if model == "" {
			model = "virtio"
		}
		netParts := []string{model, "bridge=" + strings.TrimSpace(body.Bridge)}
		if body.VLANTag > 0 {
			netParts = append(netParts, "tag="+strconv.Itoa(body.VLANTag))
		}
		if body.Firewall {
			netParts = append(netParts, "firewall=1")
		}
		params.Set("net0", strings.Join(netParts, ","))
	}

	if body.Agent {
		params.Set("agent", "enabled=1")
	}
	if body.OnBoot {
		params.Set("onboot", "1")
	}
	if body.StartAfter {
		params.Set("start", "1")
	}
	if strings.TrimSpace(body.Tags) != "" {
		params.Set("tags", strings.TrimSpace(body.Tags))
	}
	if strings.TrimSpace(body.Description) != "" {
		params.Set("description", strings.TrimSpace(body.Description))
	}

	if body.EnableCloudInit && diskStorage != "" {
		params.Set("ide0", fmt.Sprintf("%s:cloudinit", diskStorage))
		if strings.TrimSpace(body.CIUser) != "" {
			params.Set("ciuser", strings.TrimSpace(body.CIUser))
		}
		if body.CIPassword != "" {
			params.Set("cipassword", body.CIPassword)
		}
		if strings.TrimSpace(body.SSHKeys) != "" {
			params.Set("sshkeys", encodePVESSHKeys(body.SSHKeys))
		}
		if strings.TrimSpace(body.IPConfig0) != "" {
			params.Set("ipconfig0", strings.TrimSpace(body.IPConfig0))
		}
		if strings.TrimSpace(body.Nameserver) != "" {
			params.Set("nameserver", strings.TrimSpace(body.Nameserver))
		}
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.CreateQemuVM(r.Context(), node, params)
	urn := fmt.Sprintf("%s:qemu:%s:%d", id, node, body.VMID)
	s.recordAudit(r, id, urn, "qemu.create", fmt.Sprintf("#%d %s (%dC/%dM)", body.VMID, body.Name, body.Cores, body.MemoryMB), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "vmid": body.VMID, "upid": upid})
}

func (s *Server) handleCreateLXC(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}

	var body struct {
		VMID          int    `json:"vmid"`
		Hostname      string `json:"hostname"`
		OSTemplate    string `json:"ostemplate"`
		Storage       string `json:"storage"`
		RootfsGB      int    `json:"rootfsGb"`
		Cores         int    `json:"cores"`
		MemoryMB      int    `json:"memoryMb"`
		SwapMB        int    `json:"swapMb"`
		Bridge        string `json:"bridge"`
		IP            string `json:"ip"`      // dhcp | 198.51.100.80/24
		Gateway       string `json:"gateway"` // optional if static IP
		VLANTag       int    `json:"vlanTag"`
		Firewall      bool   `json:"firewall"`
		Password      string `json:"password"`
		SSHPublicKeys string `json:"sshPublicKeys"`
		Unprivileged  *bool  `json:"unprivileged"`
		Nesting       bool   `json:"nesting"`
		Keyctl        bool   `json:"keyctl"`
		OnBoot        bool   `json:"onboot"`
		StartAfter    bool   `json:"start"`
		Tags          string `json:"tags"`
		Description   string `json:"description"`
		Env           string `json:"env"` // Optional OCI environment lines (PVE 9.1+)
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.VMID < 100 || strings.TrimSpace(body.Hostname) == "" || strings.TrimSpace(body.OSTemplate) == "" {
		writeErr(w, http.StatusBadRequest, "vmid (>= 100), hostname, and ostemplate are required")
		return
	}
	rootfsStorage := strings.TrimSpace(body.Storage)
	if rootfsStorage != "" {
		if err := pve.ValidateStorageID(rootfsStorage); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	params := url.Values{}
	params.Set("vmid", strconv.Itoa(body.VMID))
	params.Set("hostname", strings.TrimSpace(body.Hostname))
	params.Set("ostemplate", strings.TrimSpace(body.OSTemplate))
	if rootfsStorage != "" {
		gb := body.RootfsGB
		if gb < 1 {
			gb = 8
		}
		params.Set("rootfs", fmt.Sprintf("%s:%d", rootfsStorage, gb))
	}
	if body.Cores < 1 {
		body.Cores = 2
	}
	if body.MemoryMB < 64 {
		body.MemoryMB = 512
	}
	params.Set("cores", strconv.Itoa(body.Cores))
	params.Set("memory", strconv.Itoa(body.MemoryMB))
	params.Set("swap", strconv.Itoa(max(0, body.SwapMB)))

	unpriv := true
	if body.Unprivileged != nil {
		unpriv = *body.Unprivileged
	}
	if !unpriv {
		if claims := getClaims(r); claims == nil || claims.Role != "admin" {
			writeErr(w, http.StatusForbidden, "创建特权 LXC 容器 (unprivileged=false) 仅允许管理员 (admin) 操作")
			return
		}
	}
	if unpriv {
		params.Set("unprivileged", "1")
	} else {
		params.Set("unprivileged", "0")
	}

	var feats []string
	if body.Nesting {
		feats = append(feats, "nesting=1")
	}
	if body.Keyctl {
		feats = append(feats, "keyctl=1")
	}
	if len(feats) > 0 {
		params.Set("features", strings.Join(feats, ","))
	}

	if strings.TrimSpace(body.Bridge) != "" {
		ipSpec := strings.TrimSpace(body.IP)
		if ipSpec == "" {
			ipSpec = "dhcp"
		}
		netParts := []string{"name=eth0", "bridge=" + strings.TrimSpace(body.Bridge), "ip=" + ipSpec}
		if ipSpec != "dhcp" && strings.TrimSpace(body.Gateway) != "" {
			netParts = append(netParts, "gw="+strings.TrimSpace(body.Gateway))
		}
		if body.VLANTag > 0 {
			netParts = append(netParts, "tag="+strconv.Itoa(body.VLANTag))
		}
		if body.Firewall {
			netParts = append(netParts, "firewall=1")
		}
		params.Set("net0", strings.Join(netParts, ","))
	}

	if body.Password != "" {
		params.Set("password", body.Password)
	}
	if strings.TrimSpace(body.SSHPublicKeys) != "" {
		params.Set("ssh-public-keys", strings.TrimSpace(body.SSHPublicKeys))
	}
	if body.OnBoot {
		params.Set("onboot", "1")
	}
	if body.StartAfter {
		params.Set("start", "1")
	}
	if strings.TrimSpace(body.Tags) != "" {
		params.Set("tags", strings.TrimSpace(body.Tags))
	}
	if strings.TrimSpace(body.Description) != "" {
		params.Set("description", strings.TrimSpace(body.Description))
	}
	if strings.TrimSpace(body.Env) != "" {
		params.Set("env", strings.TrimSpace(body.Env))
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.CreateLXCContainer(r.Context(), node, params)
	urn := fmt.Sprintf("%s:lxc:%s:%d", id, node, body.VMID)
	s.recordAudit(r, id, urn, "lxc.create", fmt.Sprintf("#%d %s (%dC/%dM)", body.VMID, body.Hostname, body.Cores, body.MemoryMB), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "vmid": body.VMID, "upid": upid})
}

func (s *Server) handleCloneGuest(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		NewID       int    `json:"newid"`
		Name        string `json:"name"`
		TargetNode  string `json:"targetNode"`
		Storage     string `json:"storage"`
		Full        bool   `json:"full"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.NewID < 100 {
		writeErr(w, http.StatusBadRequest, "newid (>= 100) is required")
		return
	}
	if target := strings.TrimSpace(body.TargetNode); target != "" {
		if err := pve.ValidateNodeName(target); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	if st := strings.TrimSpace(body.Storage); st != "" {
		if err := pve.ValidateStorageID(st); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.CloneGuest(r.Context(), node, gtype, vmid, body.NewID, body.Name, body.TargetNode, body.Storage, body.Full, body.Description)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".clone", fmt.Sprintf("#%d -> #%d (%s)", vmid, body.NewID, body.Name), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "newid": body.NewID, "upid": upid})
}

func (s *Server) handleMigrateGuest(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		TargetNode     string `json:"targetNode"`
		Online         bool   `json:"online"`
		Restart        bool   `json:"restart"`
		WithLocalDisks bool   `json:"withLocalDisks"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	targetNode := strings.TrimSpace(body.TargetNode)
	if err := pve.ValidateNodeName(targetNode); err != nil {
		writeErr(w, http.StatusBadRequest, "无效的目标节点名称")
		return
	}
	if targetNode == node {
		writeErr(w, http.StatusBadRequest, "目标节点不能与当前所在节点相同")
		return
	}
	if gtype == "lxc" && body.Online {
		writeErr(w, http.StatusBadRequest, "LXC 容器不支持在线热迁移，请使用 restart 模式")
		return
	}
	if gtype == "qemu" && body.Restart {
		writeErr(w, http.StatusBadRequest, "QEMU 虚拟机不支持 restart 参数，请使用 online 参数")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.MigrateGuest(r.Context(), node, gtype, vmid, targetNode, body.Online, body.Restart, body.WithLocalDisks)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".migrate", fmt.Sprintf("%s -> %s", node, targetNode), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleBatchGuestTags(w http.ResponseWriter, r *http.Request) {
	type targetItem struct {
		InstanceID string `json:"instanceId"`
		Node       string `json:"node"`
		Type       string `json:"type"`
		VMID       int    `json:"vmid"`
	}
	var body struct {
		Mode    string       `json:"mode"` // add | remove | replace
		Tags    []string     `json:"tags"`
		Targets []targetItem `json:"targets"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if body.Mode != "add" && body.Mode != "remove" && body.Mode != "replace" {
		writeErr(w, http.StatusBadRequest, "mode 必须为 add、remove 或 replace")
		return
	}
	if len(body.Targets) == 0 || len(body.Targets) > 100 {
		writeErr(w, http.StatusBadRequest, "targets must contain 1–100 guests")
		return
	}
	cleanTags := make([]string, 0, len(body.Tags))
	for _, rawTag := range body.Tags {
		t := strings.TrimSpace(rawTag)
		if t == "" {
			continue
		}
		if err := pve.ValidateGuestTag(t); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		cleanTags = append(cleanTags, strings.ToLower(t))
	}
	if len(cleanTags) == 0 && body.Mode != "replace" {
		writeErr(w, http.StatusBadRequest, "add/remove 模式至少需提供一个有效标签")
		return
	}

	// Validate & deduplicate targets up-front to prevent concurrent read-modify-write races
	seenTargets := map[string]bool{}
	targets := make([]targetItem, 0, len(body.Targets))
	instSet := map[string]bool{}
	for _, t := range body.Targets {
		if strings.TrimSpace(t.InstanceID) == "" {
			writeErr(w, http.StatusBadRequest, "target instanceId is required")
			return
		}
		if err := pve.ValidateNodeName(t.Node); err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		if t.Type != "qemu" && t.Type != "lxc" {
			writeErr(w, http.StatusBadRequest, "target type must be qemu or lxc")
			return
		}
		if t.VMID <= 0 {
			writeErr(w, http.StatusBadRequest, "target vmid must be positive")
			return
		}
		key := fmt.Sprintf("%s:%s:%s:%d", t.InstanceID, t.Node, t.Type, t.VMID)
		if seenTargets[key] {
			continue
		}
		seenTargets[key] = true
		instSet[t.InstanceID] = true
		targets = append(targets, t)
	}

	type batchResult struct {
		InstanceID string `json:"instanceId"`
		Node       string `json:"node"`
		Type       string `json:"type"`
		VMID       int    `json:"vmid"`
		OK         bool   `json:"ok"`
		Tags       string `json:"tags,omitempty"`
		Error      string `json:"error,omitempty"`
	}

	results := make([]batchResult, len(targets))
	var g errgroup.Group
	g.SetLimit(6)
	var okCount int
	var countMu sync.Mutex

	for i, tgt := range targets {
		idx, t := i, tgt
		g.Go(func() error {
			res := batchResult{InstanceID: t.InstanceID, Node: t.Node, Type: t.Type, VMID: t.VMID}
			cl, _, err := s.pool.Get(r.Context(), t.InstanceID)
			if err != nil {
				res.Error = err.Error()
				results[idx] = res
				return nil
			}
			cfg, err := cl.GetGuestConfig(r.Context(), t.Node, t.Type, t.VMID)
			if err != nil {
				res.Error = err.Error()
				results[idx] = res
				return nil
			}
			existingTags, _ := cfg["tags"].(string)
			nextTags := pve.MergeGuestTags(existingTags, body.Mode, cleanTags)
			vals := map[string]string{}
			if digest, _ := cfg["digest"].(string); digest != "" {
				vals["digest"] = digest
			}
			var delKeys []string
			if nextTags == "" {
				delKeys = []string{"tags"}
			} else {
				vals["tags"] = nextTags
			}
			if err := cl.UpdateGuestConfig(r.Context(), t.Node, t.Type, t.VMID, vals, delKeys, nil); err != nil {
				res.Error = err.Error()
				results[idx] = res
				return nil
			}
			res.OK = true
			res.Tags = nextTags
			results[idx] = res
			countMu.Lock()
			okCount++
			countMu.Unlock()
			return nil
		})
	}
	_ = g.Wait()
	if okCount > 0 {
		s.agg.InvalidateCache()
	}
	auditInstID := ""
	if len(instSet) == 1 {
		for k := range instSet {
			auditInstID = k
		}
	}
	var auditErr error
	if okCount < len(targets) {
		auditErr = fmt.Errorf("%d/%d guests failed to update tags", len(targets)-okCount, len(targets))
	}
	s.recordAudit(r, auditInstID, "guests:batch:tags", "guests.batch.tags", fmt.Sprintf("mode=%s tags=%s (%d/%d ok)", body.Mode, strings.Join(cleanTags, ","), okCount, len(targets)), "", auditErr)
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      okCount == len(targets),
		"updated": okCount,
		"total":   len(targets),
		"results": results,
	})
}

// --- Guest Detail, Power, Config, Disk, Snapshots & Console ---

func (s *Server) handleGuestDetail(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}

	var (
		current map[string]any
		cfg     map[string]any
		pending []pve.PendingItem
		snaps   []pve.SnapshotItem
		curErr  error
	)

	var g errgroup.Group
	g.Go(func() error {
		current, curErr = cl.GetGuestCurrent(r.Context(), node, gtype, vmid)
		return nil
	})
	g.Go(func() error {
		cfg, _ = cl.GetGuestConfig(r.Context(), node, gtype, vmid)
		return nil
	})
	g.Go(func() error {
		pending, _ = cl.GetGuestPending(r.Context(), node, gtype, vmid)
		return nil
	})
	g.Go(func() error {
		snaps, _ = cl.GetGuestSnapshots(r.Context(), node, gtype, vmid)
		return nil
	})
	_ = g.Wait()

	if curErr != nil {
		s.writePVEError(w, curErr)
		return
	}

	var ips []pve.GuestIPInfo
	statusStr, _ := current["status"].(string)
	if statusStr == "running" && (gtype != "qemu" || isQemuAgentEnabled(cfg)) {
		ipCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		ips, _ = cl.GetGuestIPs(ipCtx, node, gtype, vmid)
		cancel()
	}

	if pending == nil {
		pending = []pve.PendingItem{}
	}
	if snaps == nil {
		snaps = []pve.SnapshotItem{}
	}
	if ips == nil {
		ips = []pve.GuestIPInfo{}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"instanceId": id,
		"node":       node,
		"type":       gtype,
		"vmid":       vmid,
		"current":    current,
		"config":     cfg,
		"pending":    pending,
		"snapshots":  snaps,
		"ips":        ips,
	})
}

func (s *Server) handleGuestRRD(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	pts, err := cl.GetGuestRRD(r.Context(), node, gtype, vmid, r.URL.Query().Get("timeframe"), r.URL.Query().Get("cf"))
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": pts})
}

func (s *Server) handleGuestPower(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	action := chi.URLParam(r, "action")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.GuestPowerAction(r.Context(), node, gtype, vmid, action)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+"."+action, action, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleGuestDelete(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if r.Header.Get("X-Confirm-Target") != strconv.Itoa(vmid) {
		writeErr(w, http.StatusBadRequest, "missing or mismatched X-Confirm-Target confirmation header")
		return
	}
	purge := r.URL.Query().Get("purge") == "1"
	destroyUnref := r.URL.Query().Get("destroyUnreferencedDisks") == "1"
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.DeleteGuest(r.Context(), node, gtype, vmid, purge, destroyUnref)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".destroy", fmt.Sprintf("purge=%v unref=%v", purge, destroyUnref), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func validateSnapName(snap string) error {
	if strings.TrimSpace(snap) == "" || strings.Contains(snap, "..") || strings.Contains(snap, "/") || hasControlChars(snap) {
		return errors.New("invalid snapshot name")
	}
	return nil
}

func (s *Server) handleCreateSnapshot(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Snapname    string `json:"snapname"`
		Description string `json:"description"`
		VMState     bool   `json:"vmstate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Snapname) == "" {
		writeErr(w, http.StatusBadRequest, "snapname is required")
		return
	}
	snapName := strings.TrimSpace(body.Snapname)
	if err := validateSnapName(snapName); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.CreateGuestSnapshot(r.Context(), node, gtype, vmid, snapName, body.Description, body.VMState)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".snapshot.create", snapName, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleRollbackSnapshot(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	snap := urlParamDecoded(r, "snap")
	if err := validateSnapName(snap); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.RollbackGuestSnapshot(r.Context(), node, gtype, vmid, snap)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".snapshot.rollback", snap, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleDeleteSnapshot(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	snap := urlParamDecoded(r, "snap")
	if err := validateSnapName(snap); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.DeleteGuestSnapshot(r.Context(), node, gtype, vmid, snap)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".snapshot.delete", snap, upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"upid": upid})
}

func (s *Server) handleSendKey(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	vmid, err := strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid vmid")
		return
	}
	var body struct {
		Key string `json:"key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Key == "" {
		writeErr(w, http.StatusBadRequest, "key is required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.SendQemuKey(r.Context(), node, vmid, body.Key)
	urn := fmt.Sprintf("%s:qemu:%s:%d", id, node, vmid)
	s.recordAudit(r, id, urn, "qemu.sendkey", body.Key, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGuestConfigUpdate(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Values map[string]string `json:"values"`
		Delete []string          `json:"delete"`
		Revert []string          `json:"revert"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}

	claims := getClaims(r)
	isNonAdmin := claims == nil || claims.Role != "admin"
	var mountMutateKeys []string
	if isNonAdmin {
		for k, v := range body.Values {
			if isPrivilegedGuestConfigKey(k) || strings.Contains(v, "/dev/") || (isLXCMountKey(k) && isHostBindMountValue(v)) {
				writeErr(w, http.StatusForbidden, fmt.Sprintf("高危硬件直通或底层配置项 (%s) 仅允许管理员 (admin) 修改", strings.TrimSpace(k)))
				return
			}
			if isLXCMountKey(k) {
				mountMutateKeys = append(mountMutateKeys, strings.ToLower(strings.TrimSpace(k)))
			}
		}
		for _, k := range body.Delete {
			for _, part := range strings.Split(k, ",") {
				if isPrivilegedGuestConfigKey(part) {
					writeErr(w, http.StatusForbidden, fmt.Sprintf("高危硬件直通或底层配置项 (%s) 仅允许管理员 (admin) 删除", strings.TrimSpace(part)))
					return
				}
				if isLXCMountKey(part) {
					mountMutateKeys = append(mountMutateKeys, strings.ToLower(strings.TrimSpace(part)))
				}
			}
		}
		for _, k := range body.Revert {
			for _, part := range strings.Split(k, ",") {
				if isPrivilegedGuestConfigKey(part) {
					writeErr(w, http.StatusForbidden, fmt.Sprintf("高危硬件直通或底层配置项 (%s) 仅允许管理员 (admin) 回滚", strings.TrimSpace(part)))
					return
				}
				if isLXCMountKey(part) {
					mountMutateKeys = append(mountMutateKeys, strings.ToLower(strings.TrimSpace(part)))
				}
			}
		}
	}

	if body.Values != nil {
		for k, v := range body.Values {
			if strings.EqualFold(strings.TrimSpace(k), "sshkeys") {
				trimmed := strings.TrimSpace(v)
				if trimmed == "" {
					body.Values[k] = ""
				} else if strings.ContainsAny(trimmed, " \t\r\n+") {
					body.Values[k] = encodePVESSHKeys(trimmed)
				}
			}
		}
	}

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	if isNonAdmin && len(mountMutateKeys) > 0 {
		existingCfg, cfgErr := cl.GetGuestConfig(r.Context(), node, gtype, vmid)
		if cfgErr != nil {
			s.writePVEError(w, cfgErr)
			return
		}
		pendingVals := map[string]string{}
		if len(body.Revert) > 0 {
			if pend, pErr := cl.GetGuestPending(r.Context(), node, gtype, vmid); pErr == nil {
				for _, item := range pend {
					if item.Pending != nil {
						pendingVals[strings.ToLower(strings.TrimSpace(item.Key))] = fmt.Sprint(item.Pending)
					}
					if item.Value != nil && existingCfg[item.Key] == nil {
						existingCfg[item.Key] = item.Value
					}
				}
			}
		}
		for _, mk := range mountMutateKeys {
			if rawVal, ok := existingCfg[mk]; ok && rawVal != nil && isHostBindMountValue(fmt.Sprint(rawVal)) {
				writeErr(w, http.StatusForbidden, fmt.Sprintf("宿主机目录绑定挂载 (%s) 仅允许管理员 (admin) 修改或移除", mk))
				return
			}
			if pVal, ok := pendingVals[mk]; ok && isHostBindMountValue(pVal) {
				writeErr(w, http.StatusForbidden, fmt.Sprintf("宿主机目录绑定挂载 (%s) 仅允许管理员 (admin) 回滚", mk))
				return
			}
		}
	}
	err = cl.UpdateGuestConfig(r.Context(), node, gtype, vmid, body.Values, body.Delete, body.Revert)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	keys := make([]string, 0, len(body.Values)+len(body.Delete)+len(body.Revert))
	for k := range body.Values {
		keys = append(keys, k)
	}
	for _, k := range body.Delete {
		keys = append(keys, "-"+k)
	}
	for _, k := range body.Revert {
		keys = append(keys, "revert:"+k)
	}
	s.recordAudit(r, id, urn, gtype+".config.update", strings.Join(keys, ","), "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGuestResizeDisk(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Disk string `json:"disk"`
		Size string `json:"size"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Disk) == "" || strings.TrimSpace(body.Size) == "" {
		writeErr(w, http.StatusBadRequest, "disk and size are required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	upid, err := cl.ResizeGuestDisk(r.Context(), node, gtype, vmid, body.Disk, body.Size)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".disk.resize", fmt.Sprintf("%s %s", body.Disk, body.Size), upid, err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleGuestCloudInitRegen(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	vmid, err := strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid vmid")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	err = cl.RegenerateCloudInit(r.Context(), node, vmid)
	urn := fmt.Sprintf("%s:qemu:%s:%d", id, node, vmid)
	s.recordAudit(r, id, urn, "qemu.cloudinit.regen", "regenerate", "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleGuestAgentInfo(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	if err := pve.ValidateNodeName(node); err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	vmid, err := strconv.Atoi(chi.URLParam(r, "vmid"))
	if err != nil || vmid <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid vmid")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	osInfo, osErr := cl.GetQemuAgentOSInfo(r.Context(), node, vmid)
	fsInfo, _ := cl.GetQemuAgentFSInfo(r.Context(), node, vmid)
	if fsInfo == nil {
		fsInfo = []map[string]any{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available": osErr == nil,
		"osInfo":    osInfo,
		"fsInfo":    fsInfo,
	})
}

func (s *Server) handleSpiceProxy(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	data, err := cl.RequestSpiceProxy(r.Context(), node, gtype, vmid)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, "console.spice", gtype, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, data)
}

func (s *Server) handleGuestConsoleSession(w http.ResponseWriter, r *http.Request) {
	id, node, gtype, vmid, err := parseGuestRoute(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	var body struct {
		Protocol         string `json:"protocol"`
		FallbackUsername string `json:"fallbackUsername"`
		FallbackPassword string `json:"fallbackPassword"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	claims := getClaims(r)
	uid := ""
	if claims != nil {
		uid = claims.UserID
	}
	out, err := s.console.CreateSession(r.Context(), pve.CreateSessionInput{
		OwnerUserID:      uid,
		InstanceID:       id,
		Node:             node,
		TargetType:       gtype,
		VMID:             vmid,
		Protocol:         body.Protocol,
		FallbackUsername: body.FallbackUsername,
		FallbackPassword: body.FallbackPassword,
	})
	proto := strings.ToLower(strings.TrimSpace(body.Protocol))
	if out != nil && strings.TrimSpace(out.Protocol) != "" {
		proto = strings.ToLower(strings.TrimSpace(out.Protocol))
	} else if proto == "" {
		if gtype == "lxc" {
			proto = "xterm"
		} else {
			proto = "vnc"
		}
	}
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, "console."+proto, gtype, "", err)
	if err != nil {
		s.writePVEError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}
