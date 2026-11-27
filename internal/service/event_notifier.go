package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/jianxcao/pve-dash/internal/crypto"
	"github.com/jianxcao/pve-dash/internal/store"
)

// EventDispatch describes a discrete operational or security event published asynchronously.
type EventDispatch struct {
	Category     string
	InstanceName string
	ResourceName string
	Title        string
	Message      string
	Severity     string // info | warning | critical
	Failed       bool
	DedupKey     string
	Cooldown     time.Duration
}

// EventNotifier processes operational and security event notifications asynchronously
// without blocking API request handlers.
type EventNotifier struct {
	store *store.Store
	box   *crypto.Box

	queueMu       sync.Mutex
	idleCond      *sync.Cond
	closed        bool
	inFlightCount int
	queue         chan EventDispatch

	stopCtx  context.Context
	cancel   context.CancelFunc
	stopOnce sync.Once
	wg       sync.WaitGroup

	mu       sync.Mutex
	dedup    map[string]time.Time
	knownIPs map[string]map[string]bool // userID -> set of previously seen client IPs
}

func NewEventNotifier(st *store.Store, box *crypto.Box) *EventNotifier {
	ctx, cancel := context.WithCancel(context.Background())
	n := &EventNotifier{
		store:    st,
		box:      box,
		queue:    make(chan EventDispatch, 256),
		stopCtx:  ctx,
		cancel:   cancel,
		dedup:    make(map[string]time.Time),
		knownIPs: make(map[string]map[string]bool),
	}
	n.idleCond = sync.NewCond(&n.queueMu)
	for i := 0; i < 2; i++ {
		n.wg.Add(1)
		go n.worker()
	}
	return n
}

// Stop signals background workers to exit after draining/cancelling in-flight dispatches.
func (n *EventNotifier) Stop() {
	if n == nil {
		return
	}
	n.stopOnce.Do(func() {
		n.cancel()
		n.queueMu.Lock()
		n.closed = true
		close(n.queue)
		n.queueMu.Unlock()
	})
	n.wg.Wait()
}

// WaitIdle blocks until all currently queued events have finished dispatching (used in tests).
func (n *EventNotifier) WaitIdle() {
	if n == nil {
		return
	}
	n.queueMu.Lock()
	for n.inFlightCount > 0 {
		n.idleCond.Wait()
	}
	n.queueMu.Unlock()
}

// Publish enqueues an operational or security event without blocking the caller.
func (n *EventNotifier) Publish(ev EventDispatch) {
	if n == nil || n.store == nil || n.box == nil || strings.TrimSpace(ev.Category) == "" {
		return
	}
	if n.stopCtx.Err() != nil {
		return
	}

	now := time.Now()
	if ev.DedupKey != "" && ev.Cooldown > 0 {
		n.mu.Lock()
		if len(n.dedup) > 512 {
			for k, until := range n.dedup {
				if now.After(until) {
					delete(n.dedup, k)
				}
			}
		}
		if until, ok := n.dedup[ev.DedupKey]; ok && now.Before(until) {
			n.mu.Unlock()
			return
		}
		n.dedup[ev.DedupKey] = now.Add(ev.Cooldown)
		n.mu.Unlock()
	}

	n.queueMu.Lock()
	if n.closed {
		n.queueMu.Unlock()
		return
	}
	select {
	case n.queue <- ev:
		n.inFlightCount++
		n.queueMu.Unlock()
	default:
		n.queueMu.Unlock()
		slog.Warn("event notifier queue full, dropping event", "category", ev.Category, "title", ev.Title)
	}
}

func (n *EventNotifier) worker() {
	defer n.wg.Done()
	for ev := range n.queue {
		n.handleEvent(ev)
		n.queueMu.Lock()
		n.inFlightCount--
		if n.inFlightCount <= 0 {
			n.idleCond.Broadcast()
		}
		n.queueMu.Unlock()
	}
}

func (n *EventNotifier) handleEvent(ev EventDispatch) {
	if n.stopCtx.Err() != nil {
		return
	}
	ctx, cancel := context.WithTimeout(n.stopCtx, 12*time.Second)
	defer cancel()

	sub, err := n.store.GetEventSubscription(ctx, ev.Category)
	if err != nil || sub == nil || !sub.Enabled {
		return
	}
	if sub.TriggerMode == "failed_only" && !ev.Failed {
		return
	}

	channels, err := n.store.ListAlertChannels(ctx)
	if err != nil || len(channels) == 0 {
		return
	}

	channelByID := make(map[string]store.AlertChannel, len(channels))
	enabledAll := make([]store.AlertChannel, 0, len(channels))
	for _, ch := range channels {
		channelByID[ch.ID] = ch
		if ch.Enabled {
			enabledAll = append(enabledAll, ch)
		}
	}

	var targets []store.AlertChannel
	if len(sub.ChannelIDs) > 0 {
		for _, id := range sub.ChannelIDs {
			if ch, ok := channelByID[id]; ok && ch.Enabled {
				targets = append(targets, ch)
			}
		}
	} else {
		targets = enabledAll
	}
	if len(targets) == 0 {
		return
	}

	eventType := "ops"
	if strings.HasPrefix(ev.Category, "security.") {
		eventType = "security"
	}
	sev := strings.TrimSpace(ev.Severity)
	if sev == "" {
		if ev.Failed {
			sev = "warning"
		} else {
			sev = "info"
		}
	}

	notice := AlertNotice{
		EventType:    eventType,
		Severity:     sev,
		Title:        ev.Title,
		Message:      ev.Message,
		RuleName:     eventCategoryLabelZH(ev.Category),
		InstanceName: ev.InstanceName,
		ResourceName: ev.ResourceName,
		Metric:       ev.Category,
		Timestamp:    time.Now().Format("2006-01-02 15:04:05"),
	}

	for _, ch := range targets {
		rawCfg, decErr := n.box.DecryptString(ch.ConfigEnc)
		if decErr != nil {
			slog.Warn("event notification decrypt failed", "channel", ch.Name, "err", decErr)
			continue
		}
		var cfg ChannelConfig
		if json.Unmarshal([]byte(rawCfg), &cfg) != nil {
			continue
		}
		if sendErr := DispatchNotification(ctx, ch.Type, cfg, notice); sendErr != nil {
			slog.Warn("event notification send failed", "category", ev.Category, "channel", ch.Name, "err", sendErr)
		}
	}
}

// RecordLoginSuccess tracks known (userID, ip) pairs in memory and publishes a `security.login_success` event.
func (n *EventNotifier) RecordLoginSuccess(username, userID, role, ip, ua string) {
	if n == nil {
		return
	}
	ip = strings.TrimSpace(ip)
	ua = strings.TrimSpace(ua)
	if len(ua) > 120 {
		ua = ua[:120] + "..."
	}

	isNewIP := false
	if userID != "" && ip != "" {
		n.mu.Lock()
		if len(n.knownIPs) > 256 {
			clear(n.knownIPs)
		}
		ipSet, existed := n.knownIPs[userID]
		if !existed {
			ipSet = make(map[string]bool)
			n.knownIPs[userID] = ipSet
		} else if len(ipSet) > 0 && !ipSet[ip] {
			isNewIP = true
		}
		if len(ipSet) < 64 {
			ipSet[ip] = true
		}
		n.mu.Unlock()
	}

	title := fmt.Sprintf("账号 %s 登录成功", username)
	sev := "info"
	ipNote := ip
	if isNewIP {
		title = fmt.Sprintf("账号 %s 从新 IP 登录", username)
		sev = "warning"
		ipNote = ip + " (首次出现的新来源 IP)"
	}
	msg := fmt.Sprintf("用户 %s (角色: %s) 登录面板成功 · 来源 IP: %s", username, role, ipNote)
	if ua != "" {
		msg += fmt.Sprintf(" · 终端: %s", ua)
	}

	n.Publish(EventDispatch{
		Category:     store.EventCatSecurityLoginSuccess,
		ResourceName: "user:" + username,
		Title:        title,
		Message:      msg,
		Severity:     sev,
	})
}

// RecordLoginAnomaly publishes a `security.login_anomaly` event with a 60s per-IP dedup cooldown.
func (n *EventNotifier) RecordLoginAnomaly(username, ip, reason string) {
	if n == nil {
		return
	}
	ip = strings.TrimSpace(ip)
	username = strings.TrimSpace(username)
	if username == "" {
		username = "(未知账号)"
	}
	dedupKey := "login_anomaly:" + ip
	n.Publish(EventDispatch{
		Category:     store.EventCatSecurityLoginAnomaly,
		ResourceName: "ip:" + ip,
		Title:        fmt.Sprintf("异常登录拦截 (%s)", ip),
		Message:      fmt.Sprintf("尝试账号: %s · 来源 IP: %s · 原因: %s", username, ip, reason),
		Severity:     "warning",
		Failed:       true,
		DedupKey:     dedupKey,
		Cooldown:     60 * time.Second,
	})
}

func eventCategoryLabelZH(cat string) string {
	switch cat {
	case store.EventCatVMLifecycle:
		return "虚拟机/容器生命周期"
	case store.EventCatVMPower:
		return "虚拟机/容器电源变更"
	case store.EventCatVMConfigSnapshot:
		return "实例配置与快照操作"
	case store.EventCatBackupOps:
		return "备份与恢复任务"
	case store.EventCatNodeInfra:
		return "宿主机与集群基础设施"
	case store.EventCatSecurityLoginAnomaly:
		return "安全：异常登录拦截"
	case store.EventCatSecurityLoginSuccess:
		return "安全：登录审计提醒"
	case store.EventCatSecurityAccountChange:
		return "安全：账号与系统配置变更"
	default:
		return cat
	}
}

// ClassifyAuditAction maps `recordAudit` action names into one of the 8 event subscription categories.
func ClassifyAuditAction(action string) (category, labelZH string, ok bool) {
	a := strings.ToLower(strings.TrimSpace(action))
	if a == "" {
		return "", "", false
	}

	// 1. VM/LXC Lifecycle
	switch a {
	case "guest.create", "qemu.create", "lxc.create":
		return store.EventCatVMLifecycle, "创建实例", true
	case "guest.clone", "qemu.clone", "lxc.clone":
		return store.EventCatVMLifecycle, "克隆实例", true
	case "guest.template", "qemu.template", "lxc.template":
		return store.EventCatVMLifecycle, "转换为模板", true
	case "guest.delete", "guest.destroy", "qemu.delete", "qemu.destroy", "lxc.delete", "lxc.destroy":
		return store.EventCatVMLifecycle, "销毁实例", true
	case "guest.migrate", "qemu.migrate", "lxc.migrate":
		return store.EventCatVMLifecycle, "在线迁移实例", true
	}

	// 2. VM/LXC Power
	if strings.HasPrefix(a, "guest.power") || a == "batch.power" || a == "guests.batch.power" {
		return store.EventCatVMPower, "实例电源控制", true
	}
	for _, pfx := range []string{"qemu.", "lxc."} {
		if strings.HasPrefix(a, pfx) {
			verb := strings.TrimPrefix(a, pfx)
			switch verb {
			case "start":
				return store.EventCatVMPower, "启动实例", true
			case "stop":
				return store.EventCatVMPower, "强制停止实例", true
			case "shutdown":
				return store.EventCatVMPower, "关机实例", true
			case "reboot":
				return store.EventCatVMPower, "重启实例", true
			case "suspend":
				return store.EventCatVMPower, "挂起实例", true
			case "resume":
				return store.EventCatVMPower, "恢复挂起实例", true
			case "reset":
				return store.EventCatVMPower, "硬重置实例", true
			}
		}
	}

	// 3. VM/LXC Config, Disk Resize, Cloud-Init & Snapshots
	switch {
	case strings.HasPrefix(a, "guest.snapshot"), strings.HasPrefix(a, "qemu.snapshot."), strings.HasPrefix(a, "lxc.snapshot."):
		return store.EventCatVMConfigSnapshot, "实例快照操作", true
	case strings.HasPrefix(a, "guest.config"), strings.HasPrefix(a, "qemu.config."), strings.HasPrefix(a, "lxc.config."), a == "guests.batch.tags":
		return store.EventCatVMConfigSnapshot, "修改实例配置/标签", true
	case a == "guest.resize", a == "qemu.disk.resize", a == "lxc.disk.resize":
		return store.EventCatVMConfigSnapshot, "扩容实例磁盘", true
	case strings.HasPrefix(a, "guest.cloudinit"), strings.HasPrefix(a, "qemu.cloudinit."):
		return store.EventCatVMConfigSnapshot, "重生成 Cloud-Init", true
	}

	// 4. Backup & Restore Operations
	switch {
	case a == "backup.vzdump" || a == "guest.vzdump":
		return store.EventCatBackupOps, "手动执行备份 (VZDump)", true
	case a == "backup.restore" || a == "guest.restore":
		return store.EventCatBackupOps, "从备份归档恢复实例", true
	case strings.HasPrefix(a, "backup.") || strings.HasPrefix(a, "cluster.backup."):
		return store.EventCatBackupOps, "变更集群备份计划", true
	}

	// 5. Security & Account / Config Changes
	switch {
	case strings.HasPrefix(a, "auth.mfa.") || strings.HasPrefix(a, "user.mfa"):
		return store.EventCatSecurityAccountChange, "双因素认证 (2FA) 变更", true
	case strings.HasPrefix(a, "user."):
		return store.EventCatSecurityAccountChange, "面板账号权限变更", true
	case strings.HasPrefix(a, "config."):
		return store.EventCatSecurityAccountChange, "加密系统配置导入/导出", true
	case strings.HasPrefix(a, "alert.channel.") || strings.HasPrefix(a, "alert.rule.") || strings.HasPrefix(a, "alert.subscriptions."):
		return store.EventCatSecurityAccountChange, "告警通道与订阅策略变更", true
	}

	// 6. Node, Storage, Network, Firewall, HA, Pool, Mapping & Instance Infrastructure
	switch {
	case strings.HasPrefix(a, "node.network."):
		return store.EventCatNodeInfra, "节点网络配置变更", true
	case strings.HasPrefix(a, "node.service."):
		return store.EventCatNodeInfra, "节点系统服务控制", true
	case strings.HasPrefix(a, "node."):
		return store.EventCatNodeInfra, "物理宿主机运维操作", true
	case strings.HasPrefix(a, "storage."):
		return store.EventCatNodeInfra, "存储池与镜像操作", true
	case strings.HasPrefix(a, "ha."):
		return store.EventCatNodeInfra, "高可用 (HA) 策略变更", true
	case strings.HasPrefix(a, "firewall."):
		return store.EventCatNodeInfra, "防火墙策略变更", true
	case strings.HasPrefix(a, "pool."):
		return store.EventCatNodeInfra, "资源池变更", true
	case strings.HasPrefix(a, "mapping."):
		return store.EventCatNodeInfra, "硬件直通映射变更", true
	case strings.HasPrefix(a, "instance."):
		return store.EventCatNodeInfra, "PVE 集群接入变更", true
	case strings.HasPrefix(a, "raw."):
		return store.EventCatNodeInfra, "管理员原始 API 变更", true
	case a == "task.stop":
		return store.EventCatNodeInfra, "中止后台任务", true
	}

	return "", "", false
}
