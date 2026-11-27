package pve

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

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
	Tools        map[string]bool
	Drivers      map[string]string
	DiskPCI      map[string]string
	StandbyDisks map[string]bool
	DiskSMART    map[string]*smartctlJSON
	IntelGPUs    []sshIntelGPU
	Nvidia       []sshNvidiaGPU
	AmdGPUs      []sshAmdGPU
	Sensors      []SensorReading
}

var (
	sshUserAllowlist     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
	sshHostnameAllowlist = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`)
)

func parseSSHHostTarget(sshHost string) (target string, port string, err error) {
	h := strings.TrimSpace(sshHost)
	if h == "" {
		return "", "", nil
	}
	if strings.HasPrefix(h, "-") {
		return "", "", fmt.Errorf("无效的 SSH Host %q（仅允许 user@host[:port] 或别名，禁止以 '-' 开头或含特殊符号）", sshHost)
	}

	var userPart string
	hostPortPart := h
	if at := strings.IndexByte(h, '@'); at >= 0 {
		userPart = h[:at]
		hostPortPart = h[at+1:]
		if !sshUserAllowlist.MatchString(userPart) || strings.Contains(hostPortPart, "@") {
			return "", "", fmt.Errorf("无效的 SSH 用户名或目标 %q", sshHost)
		}
	}

	var hostOnly, portPart string
	switch {
	case strings.HasPrefix(hostPortPart, "["):
		closeIdx := strings.IndexByte(hostPortPart, ']')
		if closeIdx <= 1 {
			return "", "", fmt.Errorf("无效的 IPv6 SSH Host %q", sshHost)
		}
		inside := hostPortPart[1:closeIdx]
		ip := net.ParseIP(inside)
		if ip == nil || ip.To4() != nil {
			return "", "", fmt.Errorf("无效的括号 IPv6 地址 %q", inside)
		}
		hostOnly = inside // Strip '[' and ']' because OpenSSH CLI takes bare IPv6 hostnames
		if closeIdx < len(hostPortPart)-1 {
			if hostPortPart[closeIdx+1] != ':' || closeIdx+2 >= len(hostPortPart) {
				return "", "", fmt.Errorf("无效的 SSH Host %q", sshHost)
			}
			portPart = hostPortPart[closeIdx+2:]
		}
	case strings.Count(hostPortPart, ":") >= 2:
		// Bare IPv6 address without port (e.g. 2001:db8::1 or root@fe80::1)
		ip := net.ParseIP(hostPortPart)
		if ip == nil || ip.To4() != nil {
			return "", "", fmt.Errorf("无效的 IPv6 SSH Host %q", sshHost)
		}
		hostOnly = hostPortPart
	default:
		if colon := strings.IndexByte(hostPortPart, ':'); colon >= 0 {
			hostOnly = hostPortPart[:colon]
			portPart = hostPortPart[colon+1:]
			if portPart == "" {
				return "", "", fmt.Errorf("无效的 SSH 端口 %q", sshHost)
			}
		} else {
			hostOnly = hostPortPart
		}
		if hostOnly == "" || strings.HasPrefix(hostOnly, "-") || !sshHostnameAllowlist.MatchString(hostOnly) {
			return "", "", fmt.Errorf("无效的 SSH Host %q（仅允许字母/数字/点/短横线或 user@host[:port]）", sshHost)
		}
	}

	if portPart != "" {
		pNum, pErr := strconv.Atoi(portPart)
		if pErr != nil || pNum < 1 || pNum > 65535 || strconv.Itoa(pNum) != portPart {
			return "", "", fmt.Errorf("无效的 SSH 端口 %q（应为 1..65535）", portPart)
		}
		port = portPart
	}

	if hostOnly == "" || strings.HasPrefix(hostOnly, "-") {
		return "", "", fmt.Errorf("无效的 SSH Host %q", sshHost)
	}
	if userPart != "" {
		target = userPart + "@" + hostOnly
	} else {
		target = hostOnly
	}
	return target, port, nil
}

// ValidateSSHHost strictly validates an optional SSH target (`user@host[:port]` or `~/.ssh/config` alias)
// to prevent OpenSSH option injection (leading '-') or shell metacharacters.
func ValidateSSHHost(sshHost string) error {
	_, _, err := parseSSHHostTarget(sshHost)
	return err
}

func isDirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".pve-dash-wcheck-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func isKnownHostsFileWritable(path string) bool {
	info, err := os.Stat(path)
	if err != nil {
		return os.IsNotExist(err)
	}
	if !info.Mode().IsRegular() {
		return false
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

func isFileReadable(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

func quoteSSHConfigPath(p string) string {
	if strings.ContainsAny(p, " \t\"") {
		return `"` + strings.ReplaceAll(p, `"`, `\"`) + `"`
	}
	return p
}

func resolveSSHKnownHostsOverride() string {
	var roKnownHosts string
	if home, err := os.UserHomeDir(); err == nil && strings.TrimSpace(home) != "" {
		sshDir := filepath.Join(home, ".ssh")
		khPath := filepath.Join(sshDir, "known_hosts")
		if info, statErr := os.Stat(sshDir); statErr == nil && info.IsDir() {
			if isDirWritable(sshDir) && isKnownHostsFileWritable(khPath) {
				return ""
			}
			if isFileReadable(khPath) {
				roKnownHosts = khPath
			}
		} else if mkErr := os.MkdirAll(sshDir, 0o700); mkErr == nil && isDirWritable(sshDir) {
			return ""
		}
	}

	// Graceful writable fallback for Docker `:ro` `~/.ssh:/root/.ssh:ro` mounts or missing `$HOME/.ssh`:
	// prefer persistent `PVE_DASH_DATA_DIR/ssh/known_hosts` before `/tmp/pve-dash-ssh/known_hosts`.
	var writableKH string
	var candidateDirs []string
	if dataDir := strings.TrimSpace(os.Getenv("PVE_DASH_DATA_DIR")); dataDir != "" {
		candidateDirs = append(candidateDirs, filepath.Join(dataDir, "ssh"))
	} else if dbPath := strings.TrimSpace(os.Getenv("PVE_DASH_DB_PATH")); dbPath != "" && dbPath != ":memory:" {
		candidateDirs = append(candidateDirs, filepath.Join(filepath.Dir(dbPath), "ssh"))
	}
	candidateDirs = append(candidateDirs, filepath.Join(os.TempDir(), "pve-dash-ssh"))

	for _, dir := range candidateDirs {
		if os.MkdirAll(dir, 0o700) == nil && isDirWritable(dir) {
			cand := filepath.Join(dir, "known_hosts")
			if isKnownHostsFileWritable(cand) {
				writableKH = cand
				break
			}
		}
	}
	if writableKH == "" {
		fallbackDir := filepath.Join(os.TempDir(), "pve-dash-ssh")
		_ = os.MkdirAll(fallbackDir, 0o700)
		writableKH = filepath.Join(fallbackDir, "known_hosts")
	}

	if roKnownHosts != "" && filepath.Clean(roKnownHosts) != filepath.Clean(writableKH) {
		return quoteSSHConfigPath(writableKH) + " " + quoteSSHConfigPath(roKnownHosts)
	}
	return quoteSSHConfigPath(writableKH)
}

func buildSSHCommandArgs(target, port, script string) []string {
	args := []string{
		"-T", "-n",
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=5",
		"-o", "StrictHostKeyChecking=accept-new",
		"-o", "PermitLocalCommand=no",
		"-o", "ClearAllForwardings=yes",
		"-o", "ForwardAgent=no",
		"-o", "ForwardX11=no",
	}
	if kh := resolveSSHKnownHostsOverride(); kh != "" {
		args = append(args, "-o", "UserKnownHostsFile="+kh)
	}
	if port != "" {
		args = append(args, "-p", port)
	}
	args = append(args, "--", target, script)
	return args
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

const fullSSHProbeScript = `
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

const alertStandbySSHProbeScript = `
echo "===TOOLS==="
for c in smartctl sensors nvme; do
  if command -v "$c" >/dev/null 2>&1; then echo "$c=1"; else echo "$c=0"; fi
done
echo "===SENSORS==="
if command -v sensors >/dev/null 2>&1; then
  sensors 2>/dev/null || true
fi
echo "===SMART_STANDBY==="
if command -v smartctl >/dev/null 2>&1; then
  for blk in /sys/block/sd* /sys/block/nvme* /sys/block/hd* /sys/block/vd*; do
    [ -e "$blk" ] || continue
    bname=$(basename "$blk")
    dev="/dev/$bname"
    [ -b "$dev" ] || continue
    echo "@@DISK|$dev"
    smartctl -j -A -H -n standby,0 "$dev" 2>/dev/null || true
    echo ""
  done
fi
`

func execSSHProbe(parentCtx context.Context, sshHost, script string, timeout time.Duration) (*sshHostProbeData, error) {
	target, port, err := parseSSHHostTarget(sshHost)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()

	args := buildSSHCommandArgs(target, port, script)
	cmd := exec.CommandContext(ctx, "ssh", args...)
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

func runSSHHostProbe(parentCtx context.Context, sshHost string) (*sshHostProbeData, error) {
	return execSSHProbe(parentCtx, sshHost, fullSSHProbeScript, 12*time.Second)
}

func runSSHAlertProbe(parentCtx context.Context, sshHost string) (*sshHostProbeData, error) {
	return execSSHProbe(parentCtx, sshHost, alertStandbySSHProbeScript, 10*time.Second)
}

func parseSSHProbeOutput(raw string) *sshHostProbeData {
	data := &sshHostProbeData{
		Tools:        map[string]bool{},
		Drivers:      map[string]string{},
		DiskPCI:      map[string]string{},
		StandbyDisks: map[string]bool{},
		DiskSMART:    map[string]*smartctlJSON{},
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

	// Parse standby-safe per-disk smartctl JSON output (from alert sweeps)
	if smartLines := sections["SMART_STANDBY"]; len(smartLines) > 0 {
		curDev := ""
		var curBuf strings.Builder
		flushDisk := func() {
			if curDev == "" {
				return
			}
			blob := strings.TrimSpace(curBuf.String())
			curBuf.Reset()
			if blob == "" {
				return
			}
			if isStandbySmartOutput(blob) {
				data.StandbyDisks[curDev] = true
				return
			}
			var doc smartctlJSON
			if json.Unmarshal([]byte(blob), &doc) == nil {
				doc.RawText = blob
				cp := doc
				data.DiskSMART[curDev] = &cp
				if ser := strings.TrimSpace(doc.SerialNumber); ser != "" {
					data.DiskSMART["serial:"+ser] = &cp
				}
			}
		}
		for _, line := range smartLines {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "@@DISK|") {
				flushDisk()
				curDev = strings.TrimSpace(strings.TrimPrefix(trimmed, "@@DISK|"))
				continue
			}
			if curDev != "" {
				curBuf.WriteString(line)
				curBuf.WriteByte('\n')
			}
		}
		flushDisk()
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
