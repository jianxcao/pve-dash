package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jianxcao/pve-dash/internal/pve"
)

// --- Cluster NextID & Node Network Bridges ---

func (s *Server) handleNextID(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	nextID, err := cl.GetNextID(r.Context())
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"vmid": nextID})
}

func (s *Server) handleNodeNetworks(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.GetNodeNetworks(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []pve.NodeNetworkIface{}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].Iface < items[j].Iface })
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

// --- Storage Operations: Streaming Upload, URL Download, APL Templates, OCI Pull, Delete ---

func (s *Server) handleStorageUpload(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")

	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}

	mr, err := r.MultipartReader()
	if err != nil {
		writeErr(w, http.StatusBadRequest, "expected multipart/form-data upload: "+err.Error())
		return
	}

	contentTypeField := "iso"
	var uploadedName string
	var upid string
	fileHandled := false

	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			writeErr(w, http.StatusBadRequest, "read multipart stream: "+err.Error())
			return
		}
		formName := part.FormName()
		if formName == "content" {
			b, _ := io.ReadAll(io.LimitReader(part, 128))
			if v := strings.TrimSpace(string(b)); v != "" {
				contentTypeField = v
			}
			part.Close()
			continue
		}
		if formName == "filename" || formName == "file" {
			rawName := strings.ReplaceAll(strings.TrimSpace(part.FileName()), "\\", "/")
			fname := filepath.Base(rawName)
			if fname == "" || fname == "." || fname == "/" {
				part.Close()
				writeErr(w, http.StatusBadRequest, "missing upload filename")
				return
			}
			uploadedName = fname
			upid, err = cl.UploadStorageStream(r.Context(), node, storage, contentTypeField, fname, part)
			part.Close()
			fileHandled = true
			s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.upload", fmt.Sprintf("%s (%s)", fname, contentTypeField), upid, err)
			if err != nil {
				writeErr(w, http.StatusBadGateway, err.Error())
				return
			}
			break
		}
		part.Close()
	}

	if !fileHandled {
		writeErr(w, http.StatusBadRequest, "no file field found in multipart upload")
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "filename": uploadedName, "upid": upid})
}

func (s *Server) handleQueryURLMetadata(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	var body struct {
		URL         string `json:"url"`
		VerifyCerts *bool  `json:"verifyCerts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.URL) == "" {
		writeErr(w, http.StatusBadRequest, "url is required")
		return
	}
	verify := true
	if body.VerifyCerts != nil {
		verify = *body.VerifyCerts
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	meta, err := cl.QueryURLMetadata(r.Context(), node, body.URL, verify)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) handleStorageDownloadURL(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	var body struct {
		URL               string `json:"url"`
		Filename          string `json:"filename"`
		Content           string `json:"content"` // iso | vztmpl
		Checksum          string `json:"checksum"`
		ChecksumAlgorithm string `json:"checksumAlgorithm"`
		VerifyCerts       *bool  `json:"verifyCerts"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if strings.TrimSpace(body.URL) == "" || strings.TrimSpace(body.Filename) == "" {
		writeErr(w, http.StatusBadRequest, "url and filename are required")
		return
	}
	if body.Content == "" {
		body.Content = "iso"
	}
	verify := true
	if body.VerifyCerts != nil {
		verify = *body.VerifyCerts
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.DownloadURLToStorage(r.Context(), node, storage, body.Content, body.URL, body.Filename, body.Checksum, body.ChecksumAlgorithm, verify)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.download_url", fmt.Sprintf("%s -> %s", body.URL, body.Filename), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleListAPLTemplates(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	items, err := cl.GetNodeAPLTemplates(r.Context(), node)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	if items == nil {
		items = []pve.APLTemplate{}
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].Section != items[j].Section {
			return items[i].Section < items[j].Section
		}
		return items[i].Template < items[j].Template
	})
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
}

func (s *Server) handleDownloadAPLTemplate(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	var body struct {
		Storage  string `json:"storage"`
		Template string `json:"template"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Storage) == "" || strings.TrimSpace(body.Template) == "" {
		writeErr(w, http.StatusBadRequest, "storage and template are required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.DownloadAPLTemplate(r.Context(), node, body.Storage, body.Template)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, body.Storage), "storage.apl_download", body.Template, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleStorageOCIPull(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	var body struct {
		Reference string `json:"reference"`
		Filename  string `json:"filename"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Reference) == "" {
		writeErr(w, http.StatusBadRequest, "reference is required (e.g. docker.io/library/alpine:latest)")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.PullOCIToStorage(r.Context(), node, storage, body.Reference, body.Filename)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.oci_pull", body.Reference, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

func (s *Server) handleDeleteStorageVolume(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")
	storage := urlParamDecoded(r, "storage")
	volid := strings.TrimSpace(r.URL.Query().Get("volid"))
	if volid == "" {
		volid = urlParamDecoded(r, "volume")
	}
	if volid == "" {
		writeErr(w, http.StatusBadRequest, "volume is required")
		return
	}
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.DeleteStorageVolume(r.Context(), node, storage, volid)
	s.recordAudit(r, id, fmt.Sprintf("%s:storage:%s:%s", id, node, storage), "storage.volume.delete", volid, upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upid": upid})
}

// --- Guest Creation (QEMU VM, LXC Container, Template Clone) ---

func (s *Server) handleCreateQemu(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")

	var body struct {
		VMID            int    `json:"vmid"`
		Name            string `json:"name"`
		OSType          string `json:"ostype"`          // l26 | win11 | win10 | other
		ISO             string `json:"iso"`             // e.g. local:iso/ubuntu.iso or ""
		Storage         string `json:"storage"`         // e.g. local-lvm / local
		DiskSizeGB      int    `json:"diskSizeGb"`      // e.g. 32
		DiskBus         string `json:"diskBus"`         // scsi | virtio | sata
		SSD             bool   `json:"ssd"`
		Discard         bool   `json:"discard"`
		Cores           int    `json:"cores"`
		Sockets         int    `json:"sockets"`
		CPUType         string `json:"cpuType"`         // host | x86-64-v2-AES | kvm64
		MemoryMB        int    `json:"memoryMb"`
		BalloonMB       *int   `json:"balloonMb"`
		Bridge          string `json:"bridge"`          // e.g. vmbr0
		NetModel        string `json:"netModel"`        // virtio | e1000 | vmxnet3
		VLANTag         int    `json:"vlanTag"`
		Firewall        bool   `json:"firewall"`
		BIOS            string `json:"bios"`            // seabios | ovmf
		Machine         string `json:"machine"`         // q35 | i440fx
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
	if strings.TrimSpace(body.Storage) != "" && body.DiskSizeGB > 0 {
		bus := body.DiskBus
		if bus != "virtio" && bus != "sata" {
			bus = "scsi"
		}
		diskKey := bus + "0"
		diskOpts := []string{fmt.Sprintf("%s:%d", strings.TrimSpace(body.Storage), body.DiskSizeGB)}
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
		if body.BIOS == "ovmf" {
			params.Set("efidisk0", fmt.Sprintf("%s:1,efitype=4m,pre-enrolled-keys=1", strings.TrimSpace(body.Storage)))
		}
		if strings.TrimSpace(body.ISO) != "" {
			params.Set("boot", fmt.Sprintf("order=%s;ide2;net0", diskKey))
		} else {
			params.Set("boot", fmt.Sprintf("order=%s;net0", diskKey))
		}
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

	if body.EnableCloudInit && strings.TrimSpace(body.Storage) != "" {
		params.Set("ide0", fmt.Sprintf("%s:cloudinit", strings.TrimSpace(body.Storage)))
		if strings.TrimSpace(body.CIUser) != "" {
			params.Set("ciuser", strings.TrimSpace(body.CIUser))
		}
		if body.CIPassword != "" {
			params.Set("cipassword", body.CIPassword)
		}
		if strings.TrimSpace(body.SSHKeys) != "" {
			// PVE's URI::Escape::uri_unescape expects %20 for spaces (not '+' from QueryEscape)
			params.Set("sshkeys", url.PathEscape(strings.TrimSpace(body.SSHKeys)))
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.CreateQemuVM(r.Context(), node, params)
	urn := fmt.Sprintf("%s:qemu:%s:%d", id, node, body.VMID)
	s.recordAudit(r, id, urn, "qemu.create", fmt.Sprintf("#%d %s (%dC/%dM)", body.VMID, body.Name, body.Cores, body.MemoryMB), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "vmid": body.VMID, "upid": upid})
}

func (s *Server) handleCreateLXC(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "instanceId")
	node := urlParamDecoded(r, "node")

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
		IP            string `json:"ip"`      // dhcp | 192.168.1.80/24
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

	params := url.Values{}
	params.Set("vmid", strconv.Itoa(body.VMID))
	params.Set("hostname", strings.TrimSpace(body.Hostname))
	params.Set("ostemplate", strings.TrimSpace(body.OSTemplate))
	if strings.TrimSpace(body.Storage) != "" {
		gb := body.RootfsGB
		if gb < 1 {
			gb = 8
		}
		params.Set("rootfs", fmt.Sprintf("%s:%d", strings.TrimSpace(body.Storage), gb))
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
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.CreateLXCContainer(r.Context(), node, params)
	urn := fmt.Sprintf("%s:lxc:%s:%d", id, node, body.VMID)
	s.recordAudit(r, id, urn, "lxc.create", fmt.Sprintf("#%d %s (%dC/%dM)", body.VMID, body.Hostname, body.Cores, body.MemoryMB), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
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
	cl, _, err := s.pool.Get(r.Context(), id)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	upid, err := cl.CloneGuest(r.Context(), node, gtype, vmid, body.NewID, body.Name, body.TargetNode, body.Storage, body.Full, body.Description)
	urn := fmt.Sprintf("%s:%s:%s:%d", id, gtype, node, vmid)
	s.recordAudit(r, id, urn, gtype+".clone", fmt.Sprintf("#%d -> #%d (%s)", vmid, body.NewID, body.Name), upid, err)
	if err != nil {
		writeErr(w, http.StatusBadGateway, err.Error())
		return
	}
	s.agg.InvalidateCache()
	writeJSON(w, http.StatusCreated, map[string]any{"ok": true, "newid": body.NewID, "upid": upid})
}
