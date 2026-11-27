import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Cloud,
  Cpu,
  Disc,
  Edit3,
  Expand,
  HardDrive,
  Info,
  Loader2,
  MemoryStick,
  Network,
  Plus,
  RefreshCw,
  Shield,
  SlidersHorizontal,
  Undo2,
  Usb,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType, PendingItem } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { formatBytes } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import {
  isPrivilegedGuestConfigKey,
  parseGuestConfig,
  strVal,
  type ParsedDisk,
} from './guestConfigParser'
import {
  GuestCloudInitDialog,
  GuestDiskResizeDialog,
  GuestRawKvDialog,
  GuestResourcesDialog,
} from './GuestResourceDialogs'
import { cn } from '@/lib/utils'

interface GuestHardwarePanelProps {
  instanceId: string
  node: string
  guestType: GuestType
  vmid: number
  isRunning: boolean
  config: Record<string, unknown>
  pendingChanges: PendingItem[]
  onUpdated: () => void
}

const ADMIN_PRIVILEGED_KV_TITLE =
  '仅管理员 (admin) 可修改宿主机直通或特权配置项 (args / hookscript / hostpci* / usb* / lxc.*)'

export function GuestHardwarePanel({
  instanceId,
  node,
  guestType,
  vmid,
  isRunning,
  config,
  pendingChanges,
  onUpdated,
}: GuestHardwarePanelProps) {
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')

  const [rawOpen, setRawOpen] = useState(false)
  const [revertingKey, setRevertingKey] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [resizeTarget, setResizeTarget] = useState<ParsedDisk | null>(null)
  const [ciOpen, setCiOpen] = useState(false)
  const [ciRegenBusy, setCiRegenBusy] = useState(false)
  const [rawKvModal, setRawKvModal] = useState<{ key: string; value: string } | null>(null)

  const { data: agentInfo, isFetching: agentLoading, refetch: refetchAgent } = useQuery({
    queryKey: ['guest-agent', instanceId, node, vmid],
    queryFn: () => api.getGuestAgentInfo(instanceId, node, vmid),
    enabled: guestType === 'qemu' && isRunning && Boolean(instanceId && node && vmid > 0),
    staleTime: 15_000,
    retry: false,
  })

  const { disks, nics, passthroughs, hasCloudInitDrive, cloudInitValues, configEntries } =
    useMemo(() => parseGuestConfig(config), [config])

  const handleRevertPending = async (key: string, val?: unknown) => {
    if (!isAdmin && isPrivilegedGuestConfigKey(key, val)) {
      toast.error(ADMIN_PRIVILEGED_KV_TITLE)
      return
    }
    setRevertingKey(key)
    try {
      await api.updateGuestConfig(instanceId, node, guestType, vmid, { revert: [key] })
      toast.success(`已撤销待生效项 "${key}"`)
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销失败')
    } finally {
      setRevertingKey(null)
    }
  }

  const handleRegenCloudInit = async () => {
    setCiRegenBusy(true)
    try {
      await api.regenerateCloudInit(instanceId, node, vmid)
      toast.success('已重新生成 Cloud-Init 镜像')
      onUpdated()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新生成失败')
    } finally {
      setCiRegenBusy(false)
    }
  }

  const hasCloudInitConfig =
    hasCloudInitDrive ||
    Boolean(cloudInitValues.ciuser || cloudInitValues.ipconfig0 || cloudInitValues.sshkeys)

  const osInfo = agentInfo?.osInfo
  const fsList = (agentInfo?.fsInfo ?? []).filter((fs) => {
    const total = Number(fs['total-bytes'] ?? 0)
    const mp = strVal(fs.mountpoint)
    return total > 0 && mp !== '' && !mp.startsWith('/snap')
  })

  return (
    <div className="space-y-5">
      {/* 1. Pending Diff Card with 1-Click Revert */}
      {pendingChanges.length > 0 && (
        <Card className="border-warning/50">
          <CardHeader className="py-3 bg-warning/10">
            <CardTitle className="flex items-center gap-2 text-sm text-warning">
              <AlertTriangle className="h-4 w-4" />
              <span>待重启生效的配置变更 (Pending Diff · {pendingChanges.length} 项)</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/60 text-xs">
              {pendingChanges.map((item) => {
                const isPriv = isPrivilegedGuestConfigKey(item.key, item.pending ?? item.value)
                const blocked = readOnly || (!isAdmin && isPriv)
                return (
                  <div
                    key={item.key}
                    className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
                  >
                    <span className="font-mono-num font-semibold text-foreground">{item.key}</span>
                    <div className="flex flex-wrap items-center gap-2 font-mono-num">
                      <span className="text-muted-foreground line-through">
                        {item.value !== undefined ? String(item.value) : '(未设置)'}
                      </span>
                      <span className="text-warning">→</span>
                      <span className="text-warning font-semibold">
                        {item.delete ? '(待删除)' : String(item.pending)}
                      </span>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={blocked || revertingKey === item.key}
                        title={
                          !isAdmin && isPriv
                            ? ADMIN_PRIVILEGED_KV_TITLE
                            : readOnly
                              ? '写保护已开启'
                              : '撤销该项待生效变更'
                        }
                        onClick={() => handleRevertPending(item.key, item.pending ?? item.value)}
                      >
                        {revertingKey === item.key ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Undo2 className="h-3 w-3" />
                        )}
                        撤销
                      </Button>
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* 2. Core Compute, Memory & Boot Options Summary + Edit Button */}
      <Card>
        <CardHeader className="py-3.5">
          <CardTitle className="flex items-center gap-2">
            <Cpu className="h-4.5 w-4.5 text-accent" />
            <span>核心计算与启动选项</span>
          </CardTitle>
          <Button
            variant="outline"
            size="xs"
            disabled={readOnly}
            title={readOnly ? '写保护已开启，请先在顶栏解锁' : '编辑 CPU / 内存 / 自启与标签'}
            onClick={() => setEditOpen(true)}
          >
            <Edit3 className="h-3.5 w-3.5" />
            编辑资源与选项
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">CPU 规格</div>
            <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
              {guestType === 'qemu'
                ? `${strVal(config.cores || 1)}C × ${strVal(config.sockets || 1)}S`
                : `${strVal(config.cores || '不限')} vCPU`}
            </div>
            {Boolean(config.cpu) && (
              <div className="mt-0.5 font-mono-num text-[11px] text-muted-foreground truncate">
                {strVal(config.cpu)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <MemoryStick className="h-3 w-3" />
              内存配额
            </div>
            <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
              {config.memory ? `${Number(config.memory)} MiB` : '—'}
            </div>
            <div className="mt-0.5 font-mono-num text-[11px] text-muted-foreground">
              {guestType === 'lxc'
                ? `Swap ${strVal(config.swap ?? 0)} MiB`
                : config.balloon !== undefined
                  ? `Balloon ${strVal(config.balloon)} MiB`
                  : '固定分配'}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">
              {guestType === 'qemu' ? '机型 / BIOS' : '容器类型'}
            </div>
            <div className="mt-1 font-mono-num text-sm font-semibold text-foreground truncate">
              {guestType === 'qemu'
                ? `${strVal(config.machine || 'i440fx')} · ${strVal(config.bios || 'seabios')}`
                : Number(config.unprivileged) === 1
                  ? '非特权 (Unprivileged)'
                  : '特权 (Privileged)'}
            </div>
            {Boolean(config.ostype) && (
              <div className="mt-0.5 font-mono-num text-[11px] text-muted-foreground">
                OS: {strVal(config.ostype)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">开机自启</div>
            <div className="mt-1.5">
              {Number(config.onboot) === 1 ? (
                <Badge variant="success">已启用</Badge>
              ) : (
                <Badge variant="muted">关闭</Badge>
              )}
            </div>
            {Boolean(config.startup) && (
              <div className="mt-1 font-mono-num text-[11px] text-muted-foreground truncate">
                {strVal(config.startup)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground flex items-center gap-1">
              <Shield className="h-3 w-3" />
              防误删保护
            </div>
            <div className="mt-1.5">
              {Number(config.protection) === 1 ? (
                <Badge variant="warning">保护中</Badge>
              ) : (
                <Badge variant="muted">未锁定</Badge>
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-background/60 p-3">
            <div className="text-xs text-muted-foreground">
              {guestType === 'qemu' ? '引导顺序 / 特性' : 'Features 特性'}
            </div>
            <div className="mt-1 font-mono-num text-xs font-medium text-foreground break-all line-clamp-2">
              {guestType === 'qemu'
                ? strVal(config.boot || '默认')
                : strVal(config.features || '标准')}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* 3. Virtual Disks & Mount Points (with Online Resize) */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3.5">
          <CardTitle className="flex items-center gap-2">
            <HardDrive className="h-4.5 w-4.5 text-accent" />
            <span>{guestType === 'lxc' ? '存储卷与挂载点' : '虚拟磁盘与光驱'}</span>
            <span className="font-mono-num text-xs font-normal text-muted-foreground">
              {disks.length} 项
            </span>
          </CardTitle>
        </CardHeader>
        <div className="divide-y divide-border/70">
          {disks.length === 0 ? (
            <div className="p-5 text-sm text-muted-foreground">未检测到挂载磁盘配置。</div>
          ) : (
            disks.map((d) => {
              const canResize = !d.isCdrom && !d.isCloudInit && !d.isPassthrough && !d.isSystem
              return (
                <div
                  key={d.key}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {d.isCdrom ? (
                        <Disc className="h-4 w-4 text-info shrink-0" />
                      ) : (
                        <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="font-mono-num text-sm font-semibold text-foreground">
                        {d.key}
                      </span>
                      {d.size && (
                        <Badge variant="default" className="font-mono-num">
                          {d.size}
                        </Badge>
                      )}
                      {d.mountPoint && (
                        <Badge variant="info" className="font-mono-num">
                          挂载点 {d.mountPoint}
                        </Badge>
                      )}
                      {d.isPassthrough && <Badge variant="warning">物理盘直通</Badge>}
                      {d.isCloudInit && <Badge variant="accent">Cloud-Init 驱动器</Badge>}
                      {d.isCdrom && !d.isCloudInit && <Badge variant="muted">CD/ISO</Badge>}
                      {d.extras.map((ex) => (
                        <Badge key={ex} variant="muted" className="text-[11px]">
                          {ex}
                        </Badge>
                      ))}
                    </div>
                    <div className="font-mono-num text-xs text-muted-foreground break-all">
                      {d.volume}
                    </div>
                  </div>

                  {canResize && (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={readOnly}
                      title={readOnly ? '写保护已开启' : '在线扩容虚拟磁盘'}
                      onClick={() => setResizeTarget(d)}
                    >
                      <Expand className="h-3.5 w-3.5" />
                      扩容
                    </Button>
                  )}
                </div>
              )
            })
          )}
        </div>
      </Card>

      {/* 4. Network Interfaces + Hardware Passthrough */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Network className="h-4.5 w-4.5 text-info" />
              <span>虚拟网络接口</span>
              <span className="font-mono-num text-xs font-normal text-muted-foreground">
                {nics.length} 张
              </span>
            </CardTitle>
          </CardHeader>
          <div className="divide-y divide-border/70">
            {nics.length === 0 ? (
              <div className="p-5 text-sm text-muted-foreground">未配置虚拟网卡。</div>
            ) : (
              nics.map((n) => (
                <div key={n.key} className="px-5 py-3.5 space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono-num text-sm font-semibold text-foreground">
                        {n.key}
                      </span>
                      <Badge variant="default" className="font-mono-num">
                        {n.modelOrName}
                      </Badge>
                      {n.bridge && (
                        <Badge variant="accent" className="font-mono-num">
                          {n.bridge}
                        </Badge>
                      )}
                      {n.tag && (
                        <Badge variant="info" className="font-mono-num">
                          VLAN {n.tag}
                        </Badge>
                      )}
                      {n.firewall && <Badge variant="success">防火墙</Badge>}
                    </div>
                    {n.rate && (
                      <span className="font-mono-num text-xs text-muted-foreground">
                        限速 {n.rate} MB/s
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 font-mono-num text-xs text-muted-foreground">
                    {n.mac && <span>MAC: {n.mac}</span>}
                    {n.ip && <span>静态 IP: {n.ip}</span>}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Usb className="h-4.5 w-4.5 text-warning" />
              <span>硬件直通与设备映射</span>
              <span className="font-mono-num text-xs font-normal text-muted-foreground">
                {passthroughs.length} 项
              </span>
            </CardTitle>
          </CardHeader>
          <div className="divide-y divide-border/70">
            {passthroughs.length === 0 ? (
              <div className="p-5 text-sm text-muted-foreground">
                未配置 PCI / USB 直通或容器设备节点映射。
              </div>
            ) : (
              passthroughs.map((pt, idx) => (
                <div key={`${pt.key}-${idx}`} className="px-5 py-3.5 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono-num text-sm font-semibold text-foreground">
                      {pt.key}
                    </span>
                    <Badge
                      variant={
                        pt.kind === 'pci' ? 'warning' : pt.kind === 'usb' ? 'info' : 'accent'
                      }
                    >
                      {pt.kind === 'pci'
                        ? 'PCIe 直通'
                        : pt.kind === 'usb'
                          ? 'USB 直通'
                          : '容器设备映射'}
                    </Badge>
                  </div>
                  <div className="font-mono-num text-xs text-muted-foreground break-all">
                    {pt.raw}
                  </div>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      {/* 5. QEMU Cloud-Init Center */}
      {guestType === 'qemu' && (
        <Card>
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Cloud className="h-4.5 w-4.5 text-accent" />
              <span>Cloud-Init 自动化初始化配置</span>
              {hasCloudInitDrive ? (
                <Badge variant="success">已挂载 Cloud-Init 驱动器</Badge>
              ) : (
                <Badge variant="muted">未挂载 Cloud-Init 驱动器</Badge>
              )}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={readOnly}
                title={readOnly ? '写保护已开启' : '编辑 Cloud-Init 参数'}
                onClick={() => setCiOpen(true)}
              >
                <Edit3 className="h-3.5 w-3.5" />
                编辑参数
              </Button>
              {hasCloudInitDrive && (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={readOnly || ciRegenBusy}
                  onClick={handleRegenCloudInit}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', ciRegenBusy && 'animate-spin')} />
                  重新生成镜像
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {!hasCloudInitConfig ? (
              <p className="text-sm text-muted-foreground">
                当前虚拟机尚未配置 Cloud-Init 参数（适用于基于云镜像模板部署的 Linux VM；可点击右上角「编辑参数」预设用户名、SSH 公钥与静态 IP）。
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">默认用户 (ciuser)</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {cloudInitValues.ciuser || '（镜像默认）'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">网络配置 (ipconfig0)</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground truncate">
                    {cloudInitValues.ipconfig0 || '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">DNS / 搜索域</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground truncate">
                    {cloudInitValues.nameserver || '继承宿主机'}
                    {cloudInitValues.searchdomain ? ` · ${cloudInitValues.searchdomain}` : ''}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-muted-foreground">SSH 公钥 / 密码</div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <Badge variant={cloudInitValues.sshkeys ? 'success' : 'muted'}>
                      {cloudInitValues.sshkeys ? '已配置公钥' : '无公钥'}
                    </Badge>
                    <Badge variant={cloudInitValues.hasPassword ? 'info' : 'muted'}>
                      {cloudInitValues.hasPassword ? '已设密码' : '无密码'}
                    </Badge>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 6. QEMU Guest Agent OS & Filesystem Telemetry */}
      {guestType === 'qemu' && isRunning && (
        <Card>
          <CardHeader className="py-3.5">
            <CardTitle className="flex items-center gap-2">
              <Info className="h-4.5 w-4.5 text-info" />
              <span>QEMU Guest Agent 系统与文件系统状态</span>
              {agentInfo?.available ? (
                <Badge variant="success">Agent 在线</Badge>
              ) : (
                <Badge variant="muted">未连接</Badge>
              )}
            </CardTitle>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => refetchAgent()}
              disabled={agentLoading}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', agentLoading && 'animate-spin')} />
              探测
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            {!agentInfo?.available ? (
              <p className="text-sm text-muted-foreground">
                无法与 QEMU Guest Agent 通信（请在虚拟机内安装并启动{' '}
                <code className="font-mono-num text-foreground">qemu-guest-agent</code>
                ，且在选项中开启 Guest Agent）。
              </p>
            ) : (
              <>
                {osInfo && (
                  <div className="flex flex-wrap items-center gap-3 text-sm">
                    <Badge variant="default" className="font-mono-num">
                      {strVal(osInfo['pretty-name'] || osInfo.name || 'Guest OS')}
                    </Badge>
                    {Boolean(osInfo['kernel-release']) && (
                      <span className="font-mono-num text-xs text-muted-foreground">
                        内核 {strVal(osInfo['kernel-release'])}
                      </span>
                    )}
                    {Boolean(osInfo.machine) && (
                      <span className="font-mono-num text-xs text-muted-foreground">
                        架构 {strVal(osInfo.machine)}
                      </span>
                    )}
                  </div>
                )}

                {fsList.length > 0 && (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {fsList.map((fs, i) => {
                      const total = Number(fs['total-bytes'] ?? 0)
                      const used = Number(fs['used-bytes'] ?? 0)
                      const pct = total > 0 ? (used / total) * 100 : 0
                      return (
                        <div
                          key={`${strVal(fs.mountpoint)}-${i}`}
                          className="rounded-lg border border-border bg-background/60 p-3 space-y-2"
                        >
                          <div className="flex items-center justify-between gap-2 text-xs">
                            <span className="font-mono-num font-semibold text-foreground truncate">
                              {strVal(fs.mountpoint)}
                            </span>
                            <span className="font-mono-num text-muted-foreground uppercase">
                              {strVal(fs.type)}
                            </span>
                          </div>
                          <ResourceBar
                            size="xs"
                            percent={pct}
                            label={`${pct.toFixed(1)}%`}
                            sublabel={`${formatBytes(used, 1)} / ${formatBytes(total, 1)}`}
                          />
                        </div>
                      )
                    })}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* 7. Raw Key-Value Config Inspector (Collapsible, with Admin RBAC Guard on Privileged Keys) */}
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
          <button
            type="button"
            onClick={() => setRawOpen((v) => !v)}
            className="flex flex-1 items-center gap-2 text-left text-sm font-semibold text-foreground"
          >
            {rawOpen ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            )}
            <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
            <span>原始 PVE 配置键值 ({configEntries.length} 项)</span>
            <span className="text-xs font-normal text-muted-foreground ml-1">
              {rawOpen ? '收起' : '展开查看全部底层参数'}
            </span>
          </button>

          {rawOpen && (
            <Button
              variant="outline"
              size="xs"
              disabled={readOnly}
              title={readOnly ? '写保护已开启' : '新增或设置自定义键值'}
              onClick={() => setRawKvModal({ key: '', value: '' })}
            >
              <Plus className="h-3.5 w-3.5" />
              设置底层参数
            </Button>
          )}
        </div>

        {rawOpen && (
          <CardContent className="p-0 border-t border-border/80">
            <div className="divide-y divide-border/60">
              {configEntries.map(([key, value]) => {
                const pendingItem = pendingChanges.find((p) => p.key === key)
                const rawStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
                const isPriv = isPrivilegedGuestConfigKey(key, value)
                const canEditKey =
                  !readOnly && typeof value !== 'object' && (isAdmin || !isPriv)
                return (
                  <div
                    key={key}
                    className="grid grid-cols-1 sm:grid-cols-12 gap-1 sm:gap-4 px-5 py-2.5 text-xs hover:bg-muted/35 items-center"
                  >
                    <div className="sm:col-span-3 font-mono-num font-medium text-muted-foreground flex flex-wrap items-center gap-1.5">
                      <span>{key}</span>
                      {pendingItem && (
                        <Badge variant="warning" className="text-[10px]">
                          Pending
                        </Badge>
                      )}
                      {isPriv && (
                        <Badge variant="muted" className="text-[10px]">
                          宿主机特权
                        </Badge>
                      )}
                    </div>
                    <div className="sm:col-span-8 font-mono-num text-foreground break-all">
                      {rawStr}
                    </div>
                    <div className="sm:col-span-1 flex justify-end">
                      {typeof value !== 'object' && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          disabled={!canEditKey}
                          title={
                            !isAdmin && isPriv
                              ? ADMIN_PRIVILEGED_KV_TITLE
                              : readOnly
                                ? '写保护已开启'
                                : `编辑 ${key}`
                          }
                          onClick={() => setRawKvModal({ key, value: rawStr })}
                        >
                          <Edit3 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </CardContent>
        )}
      </Card>

      {editOpen && (
        <GuestResourcesDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          instanceId={instanceId}
          node={node}
          guestType={guestType}
          vmid={vmid}
          config={config}
          onUpdated={onUpdated}
        />
      )}

      {resizeTarget && (
        <GuestDiskResizeDialog
          target={resizeTarget}
          onClose={() => setResizeTarget(null)}
          instanceId={instanceId}
          node={node}
          guestType={guestType}
          vmid={vmid}
          onUpdated={onUpdated}
        />
      )}

      {ciOpen && (
        <GuestCloudInitDialog
          open={ciOpen}
          onOpenChange={setCiOpen}
          instanceId={instanceId}
          node={node}
          vmid={vmid}
          cloudInitValues={cloudInitValues}
          onUpdated={onUpdated}
        />
      )}

      {rawKvModal && (
        <GuestRawKvDialog
          open={Boolean(rawKvModal)}
          onOpenChange={(open) => !open && setRawKvModal(null)}
          instanceId={instanceId}
          node={node}
          guestType={guestType}
          vmid={vmid}
          isAdmin={isAdmin}
          initialKey={rawKvModal.key}
          initialValue={rawKvModal.value}
          onUpdated={onUpdated}
        />
      )}
    </div>
  )
}
