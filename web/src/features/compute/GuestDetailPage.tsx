import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowRightLeft,
  Box,
  ChevronDown,
  Clock,
  Copy,
  Cpu,
  Download,
  GitBranch,
  Monitor,
  Network,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  Shield,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react'
import { useConsoleLauncher } from '@/hooks/useConsoleLauncher'
import { api } from '@/lib/api/client'
import type { GuestType } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import {
  copyToClipboard,
  downloadSpiceVV,
  formatBytes,
  formatPercent,
  formatTaskType,
  formatTimestamp,
  formatUptime,
} from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { RrdMetricPanel } from '@/components/charts/RrdMetricPanel'
import { FirewallPanel } from '@/components/firewall/FirewallPanel'
import { GuestHardwarePanel } from './GuestHardwarePanel'
import { GuestBackupPanel } from './GuestBackupPanel'
import { GuestSnapshotsTab } from './GuestSnapshotsTab'
import { GuestMigrateDialog } from './GuestMigrateDialog'
import { cn } from '@/lib/utils'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

const VALID_GUEST_TABS = new Set([
  'overview',
  'config',
  'snapshots',
  'backups',
  'firewall',
  'tasks',
])

export function GuestDetailPage() {
  const { instanceId = '', node = '', type = 'qemu', vmid: vmidParam = '0' } = useParams()
  const guestType: GuestType = type === 'lxc' ? 'lxc' : 'qemu'
  const vmid = Number(vmidParam) || 0
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const rawTab = searchParams.get('tab') || 'overview'
  const activeTab = VALID_GUEST_TABS.has(rawTab) ? rawTab : 'overview'

  const { data: overview } = useOverviewQuery()
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const livePaused = useAppStore((s) => s.livePaused)
  const { serverReadOnly, launchGuestConsole } = useConsoleLauncher()

  const [actionBusy, setActionBusy] = useState(false)
  const [powerConfirm, setPowerConfirm] = useState<'stop' | 'reset' | null>(null)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroyPurge, setDestroyPurge] = useState(true)
  const [destroyUnref, setDestroyUnref] = useState(true)
  const [migrateOpen, setMigrateOpen] = useState(false)

  useEffect(() => {
    setPowerConfirm(null)
    setDestroyOpen(false)
    setMigrateOpen(false)
  }, [instanceId, node, guestType, vmid])

  // Auto-follow live/offline migration to the new node once overview reflects the new node
  const matchedOverviewGuest = useMemo(
    () =>
      (overview?.guests ?? []).find(
        (g) => g.instanceId === instanceId && g.type === guestType && g.vmid === vmid,
      ),
    [overview?.guests, instanceId, guestType, vmid],
  )

  useEffect(() => {
    if (!matchedOverviewGuest || !node || matchedOverviewGuest.node === node) return
    const tabParam = searchParams.get('tab')
    const qs = tabParam ? `?tab=${encodeURIComponent(tabParam)}` : ''
    toast.info('实例已完成跨节点迁移，已自动切换至新节点视图')
    navigate(
      `/instances/${encodeURIComponent(instanceId)}/nodes/${encodeURIComponent(matchedOverviewGuest.node)}/${guestType}/${vmid}${qs}`,
      { replace: true },
    )
  }, [matchedOverviewGuest, node, instanceId, guestType, vmid, navigate, searchParams])

  const peerNodes = useMemo(
    () =>
      (overview?.nodes ?? []).filter(
        (n) => n.instanceId === instanceId && n.node !== node && n.status === 'online',
      ),
    [overview?.nodes, instanceId, node],
  )

  const instanceSnap = overview?.instances.find((i) => i.id === instanceId)
  const instanceName = instanceSnap?.name || instanceId
  const instanceColor = instanceSnap?.color || '#22C55E'

  const { data: detail, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['guest-detail', instanceId, node, guestType, vmid],
    queryFn: () => api.getGuestDetail(instanceId, node, guestType, vmid),
    refetchInterval: livePaused ? false : 5000,
    enabled: Boolean(instanceId && node && vmid > 0),
  })

  const guestTasks = useMemo(
    () =>
      (overview?.tasks ?? []).filter(
        (t) => t.instanceId === instanceId && t.node === node && t.id === String(vmid),
      ),
    [overview?.tasks, instanceId, node, vmid],
  )

  const current = detail?.current ?? {}
  const config = detail?.config ?? {}
  const status = str(current.status) || 'unknown'
  const qmpStatus = str(current.qmpstatus)
  const isPaused = guestType === 'qemu' && (status === 'paused' || qmpStatus === 'paused')
  const isRunning = status === 'running' && !isPaused
  const isActiveGuest = isRunning || isPaused
  const isTemplate = num(current.template) === 1 || num(config.template) === 1
  const guestName =
    str(current.name) || str(config.name) || str(config.hostname) || `${guestType}-${vmid}`

  const cpuRatio = num(current.cpu)
  const maxCpu = num(current.cpus) || num(config.cores) || 1
  const memUsed = num(current.mem)
  const memMax = num(current.maxmem)
  const swapUsed = num(current.swap)
  const swapMax = num(current.maxswap)
  const diskUsed = num(current.disk)
  const diskMax = num(current.maxdisk)
  const uptime = num(current.uptime)

  const primaryIP = useMemo(() => {
    for (const iface of detail?.ips ?? []) {
      const ip4 = iface.ipv4?.find((ip) => !ip.startsWith('127.'))
      if (ip4) return ip4.split('/')[0]
    }
    return ''
  }, [detail?.ips])

  const pendingChanges = useMemo(
    () => (detail?.pending ?? []).filter((p) => p.pending !== undefined || Boolean(p.delete)),
    [detail?.pending],
  )

  const openConsole = (protocol: 'vnc' | 'xterm') => {
    launchGuestConsole(
      {
        instanceId,
        instanceName,
        instanceColor,
        node,
        type: guestType,
        vmid,
        name: guestName,
        status: isRunning ? 'running' : status,
        template: isTemplate,
      },
      protocol,
    )
  }

  const handleSpice = async () => {
    try {
      const data = await api.requestSpice(instanceId, node, guestType, vmid)
      downloadSpiceVV(data, `${node}-${guestType}-${vmid}.vv`)
      toast.success('已生成并下载 SPICE .vv 连接文件')
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : '获取 SPICE 票据失败（请确认虚拟机已配置 SPICE 显卡）',
      )
    }
  }

  const handlePower = async (
    action: 'start' | 'shutdown' | 'stop' | 'reboot' | 'suspend' | 'resume' | 'reset',
  ) => {
    setActionBusy(true)
    try {
      const res = await api.guestPower(instanceId, node, guestType, vmid, action)
      toast.success(`已发送 ${action} 指令`, {
        action: res.upid
          ? {
              label: '追踪日志',
              onClick: () =>
                openTaskLog({
                  instanceId,
                  instanceName,
                  node,
                  upid: res.upid,
                  type: `${guestType === 'lxc' ? 'vz' : 'qm'}${action}`,
                  id: String(vmid),
                }),
            }
          : undefined,
      })
      void refetch()
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '电源指令执行失败')
    } finally {
      setActionBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      {/* Sticky Resource Action Header */}
      <div className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <Button
              variant="outline"
              size="icon"
              onClick={() => navigate('/compute')}
              aria-label="返回列表"
            >
              <ArrowLeft className="h-4.5 w-4.5" />
            </Button>
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-center gap-2.5">
                {guestType === 'lxc' ? (
                  <Badge variant="success" className="font-mono-num">
                    <Box className="h-3.5 w-3.5" />
                    LXC 容器
                  </Badge>
                ) : (
                  <Badge variant="accent" className="font-mono-num">
                    <Monitor className="h-3.5 w-3.5" />
                    QEMU 虚拟机
                  </Badge>
                )}
                <span className="font-mono-num text-xl font-bold text-muted-foreground">
                  #{vmid}
                </span>
                <h1 className="text-xl sm:text-2xl font-semibold text-foreground truncate">
                  {guestName}
                </h1>
                <StatusBadge status={isPaused ? 'paused' : status} template={isTemplate} />
                {pendingChanges.length > 0 && (
                  <Badge variant="warning">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    {pendingChanges.length} 项待重启生效
                  </Badge>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: instanceColor }} />
                  {instanceName} /{' '}
                  <button
                    type="button"
                    onClick={() => navigate(`/instances/${instanceId}/nodes/${node}`)}
                    className="font-mono-num text-foreground hover:text-accent underline-offset-2 hover:underline"
                  >
                    {node}
                  </button>
                </span>
                {isRunning && (
                  <span className="inline-flex items-center gap-1 font-mono-num">
                    <Clock className="h-3 w-3" />
                    运行 {formatUptime(uptime)}
                  </span>
                )}
                {primaryIP && (
                  <button
                    type="button"
                    onClick={async () => {
                      await copyToClipboard(primaryIP)
                      toast.success(`已复制 IP: ${primaryIP}`)
                    }}
                    className="inline-flex items-center gap-1 rounded bg-muted px-2 py-0.5 font-mono-num text-xs text-foreground hover:bg-muted/70"
                  >
                    <span>{primaryIP}</span>
                    <Copy className="h-3 w-3 text-muted-foreground" />
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Primary Actions: Console + Power + More */}
          <div className="flex flex-wrap items-center gap-1.5">
            {!isTemplate && (
              <div className="inline-flex rounded-md">
                <Button
                  variant="default"
                  size="sm"
                  className="rounded-r-none"
                  disabled={!isRunning || serverReadOnly}
                  title={
                    serverReadOnly
                      ? '服务端强制只读模式已禁用交互式控制台'
                      : !isRunning
                        ? '仅运行中的实例可打开控制台'
                        : undefined
                  }
                  onClick={() => openConsole(guestType === 'lxc' ? 'xterm' : 'vnc')}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  <span>{guestType === 'lxc' ? 'xterm 终端' : 'noVNC 控制台'}</span>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="default"
                      size="sm"
                      disabled={!isRunning || serverReadOnly}
                      className="rounded-l-none border-l border-on-btn-primary/25 px-1.5"
                      aria-label="选择控制台协议"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => openConsole('xterm')}>
                      <Terminal className="h-3.5 w-3.5 text-accent" />
                      <span>xterm.js {guestType === 'qemu' ? '串口终端' : '容器 Shell'}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => openConsole('vnc')}>
                      <Monitor className="h-3.5 w-3.5 text-info" />
                      <span>noVNC 图形控制台</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleSpice}>
                      <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>下载 SPICE (.vv)</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}

            {!isTemplate && !isRunning && !isPaused && (
              <Button
                variant="primary"
                size="sm"
                disabled={actionBusy || readOnly}
                title={readOnly ? '写保护已开启，请先在顶栏解锁' : undefined}
                onClick={() => handlePower('start')}
              >
                <Play className="h-3.5 w-3.5" />
                启动
              </Button>
            )}

            {!isTemplate && guestType === 'qemu' && isPaused && (
              <Button
                variant="primary"
                size="sm"
                disabled={actionBusy || readOnly}
                title={readOnly ? '写保护已开启，请先在顶栏解锁' : undefined}
                onClick={() => handlePower('resume')}
              >
                <Play className="h-3.5 w-3.5" />
                恢复
              </Button>
            )}

            {!isTemplate && isRunning && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionBusy || readOnly}
                  title={readOnly ? '写保护已开启，请先在顶栏解锁' : undefined}
                  onClick={() => handlePower('shutdown')}
                >
                  <Power className="h-3.5 w-3.5 text-warning" />
                  关机
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionBusy || readOnly}
                  title={readOnly ? '写保护已开启，请先在顶栏解锁' : undefined}
                  onClick={() => handlePower('reboot')}
                >
                  <RotateCcw className="h-3.5 w-3.5 text-info" />
                  重启
                </Button>
              </>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={actionBusy || readOnly}
                  title={readOnly ? '写保护已开启，请先在顶栏解锁' : undefined}
                >
                  <span>更多</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {!isTemplate && isActiveGuest && (
                  <>
                    {guestType === 'qemu' && isRunning && (
                      <DropdownMenuItem onClick={() => handlePower('suspend')}>
                        <Pause className="h-3.5 w-3.5 text-warning" />
                        <span>暂停 / 挂起 (Suspend)</span>
                      </DropdownMenuItem>
                    )}
                    {guestType === 'qemu' && (
                      <DropdownMenuItem onClick={() => setPowerConfirm('reset')}>
                        <RotateCcw className="h-3.5 w-3.5 text-warning" />
                        <span>硬复位 (Reset)...</span>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem destructive onClick={() => setPowerConfirm('stop')}>
                      <Square className="h-3.5 w-3.5" />
                      <span>强制断电 (Force Stop)...</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                {!isTemplate && (
                  <>
                    <DropdownMenuItem onClick={() => setMigrateOpen(true)}>
                      <ArrowRightLeft className="h-3.5 w-3.5 text-accent" />
                      <span>迁移至其他节点...</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem destructive onClick={() => setDestroyOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>销毁实例 (Destroy)...</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => refetch()}
              disabled={isFetching}
              title="刷新"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/15 px-4 py-3 text-xs text-destructive">
          加载实例详情失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading && !detail ? (
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}
        >
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="overview">
              <Cpu className="h-3.5 w-3.5" />
              概览与 RRD 监控
            </TabsTrigger>
            <TabsTrigger value="config">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              硬件与配置
              {pendingChanges.length > 0 && (
                <Badge variant="warning" className="ml-1 text-badge">
                  {pendingChanges.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="snapshots">
              <GitBranch className="h-3.5 w-3.5" />
              快照 ({(detail?.snapshots ?? []).filter((s) => s.name !== 'current').length})
            </TabsTrigger>
            <TabsTrigger value="backups">
              <Archive className="h-3.5 w-3.5" />
              备份与恢复
            </TabsTrigger>
            <TabsTrigger value="firewall">
              <Shield className="h-3.5 w-3.5" />
              防火墙
            </TabsTrigger>
            <TabsTrigger value="tasks">
              <Clock className="h-3.5 w-3.5" />
              任务历史 ({guestTasks.length})
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: Overview & RRD */}
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <Card>
                <CardContent className="p-4 space-y-2">
                  <span className="text-xs text-muted-foreground">CPU 使用率</span>
                  <div className="font-mono-num text-xl font-bold">{formatPercent(cpuRatio)}</div>
                  <ResourceBar percent={cpuRatio * 100} sublabel={`${maxCpu} vCPU`} />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="p-4 space-y-2">
                  <span className="text-xs text-muted-foreground">内存占用</span>
                  <div className="font-mono-num text-xl font-bold">{formatBytes(memUsed)}</div>
                  <ResourceBar
                    percent={memMax > 0 ? Math.min(100, (memUsed / memMax) * 100) : 0}
                    sublabel={`配额 ${formatBytes(memMax)}`}
                    colorMode="info"
                  />
                </CardContent>
              </Card>

              {guestType === 'lxc' ? (
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <span className="text-xs text-muted-foreground">根卷 / Swap 占用</span>
                    <div className="font-mono-num text-xl font-bold">{formatBytes(diskUsed)}</div>
                    <ResourceBar
                      percent={diskMax > 0 ? Math.min(100, (diskUsed / diskMax) * 100) : 0}
                      sublabel={`${formatBytes(diskMax, 0)} · Swap ${formatBytes(swapUsed, 0)}/${formatBytes(swapMax, 0)}`}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <span className="text-xs text-muted-foreground">引导盘配额</span>
                    <div className="font-mono-num text-xl font-bold">{formatBytes(diskMax)}</div>
                    <div className="font-mono-num text-xs text-muted-foreground">
                      累计读 {formatBytes(num(current.diskread))} · 写{' '}
                      {formatBytes(num(current.diskwrite))}
                    </div>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="p-4 space-y-2">
                  <span className="text-xs text-muted-foreground">累计网络流量</span>
                  <div className="font-mono-num text-sm font-semibold text-foreground space-y-0.5">
                    <div>入站: {formatBytes(num(current.netin))}</div>
                    <div>出站: {formatBytes(num(current.netout))}</div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Live Network Interfaces & IPs */}
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Network className="h-4 w-4 text-info" />
                  <span>
                    实时网络接口与 IP 地址（
                    {guestType === 'lxc' ? 'LXC /interfaces' : 'QEMU Guest Agent'}）
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3.5">
                {(detail?.ips ?? []).length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {isRunning
                      ? guestType === 'qemu'
                        ? '未获取到 IP（可能未安装或未启用 QEMU Guest Agent）。'
                        : '暂无活跃非回环网卡信息。'
                      : '实例未运行，无法采集实时网卡 IP。'}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                    {(detail?.ips ?? []).map((iface) => (
                      <div
                        key={iface.interface + (iface.mac || '')}
                        className="rounded-lg border border-border bg-background/60 p-3 text-sm space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono-num font-semibold text-foreground">
                            {iface.interface}
                          </span>
                          {iface.mac && (
                            <span className="font-mono-num text-xs text-muted-foreground">
                              {iface.mac}
                            </span>
                          )}
                        </div>
                        {(iface.ipv4 ?? []).map((ip) => (
                          <div
                            key={ip}
                            className="flex items-center justify-between gap-1 font-mono-num text-sm"
                          >
                            <span className="text-accent">{ip}</span>
                            <button
                              type="button"
                              onClick={async () => {
                                await copyToClipboard(ip.split('/')[0])
                                toast.success(`已复制 ${ip.split('/')[0]}`)
                              }}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ))}
                        {(iface.ipv6 ?? []).slice(0, 2).map((ip) => (
                          <div
                            key={ip}
                            className="font-mono-num text-xs text-muted-foreground truncate"
                          >
                            {ip}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <RrdMetricPanel
              mode="guest"
              instanceId={instanceId}
              node={node}
              guestType={guestType}
              vmid={vmid}
            />
          </TabsContent>

          {/* Tab 2: Structured Hardware, Disks, Network, Cloud-Init, Agent & Pending Diff */}
          <TabsContent value="config" className="space-y-4">
            <GuestHardwarePanel
              instanceId={instanceId}
              node={node}
              guestType={guestType}
              vmid={vmid}
              isRunning={isRunning}
              config={config}
              pendingChanges={pendingChanges}
              onUpdated={() => {
                void refetch()
                void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
              }}
            />
          </TabsContent>

          {/* Tab 3: Snapshots */}
          <TabsContent value="snapshots" className="space-y-4">
            <GuestSnapshotsTab
              instanceId={instanceId}
              instanceName={instanceName}
              node={node}
              guestType={guestType}
              vmid={vmid}
              guestName={guestName}
              snapshots={detail?.snapshots ?? []}
              readOnly={readOnly}
              onChanged={() => void refetch()}
            />
          </TabsContent>

          {/* Tab 4: Backup & Restore */}
          <TabsContent value="backups" className="space-y-4">
            <GuestBackupPanel
              instanceId={instanceId}
              instanceName={instanceName}
              node={node}
              guestType={guestType}
              vmid={vmid}
            />
          </TabsContent>

          {/* Tab 5: Guest Firewall */}
          <TabsContent value="firewall" className="space-y-4">
            <FirewallPanel
              scope="guest"
              instanceId={instanceId}
              node={node}
              guestType={guestType}
              vmid={vmid}
            />
          </TabsContent>

          {/* Tab 6: Tasks */}
          <TabsContent value="tasks">
            <Card className="overflow-hidden">
              {guestTasks.length === 0 ? (
                <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                  近期无此实例的任务记录
                </div>
              ) : (
                <div className="divide-y divide-border/60 text-sm">
                  {guestTasks.map((t) => (
                    <button
                      key={t.upid}
                      type="button"
                      onClick={() =>
                        openTaskLog({
                          instanceId: t.instanceId,
                          instanceName: t.instanceName,
                          node: t.node,
                          upid: t.upid,
                          type: t.type,
                          id: t.id,
                        })
                      }
                      className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted/50"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">{formatTaskType(t.type)}</div>
                        <div className="font-mono-num text-xs text-muted-foreground truncate">
                          {t.user} · {formatTimestamp(t.starttime)}
                        </div>
                      </div>
                      <StatusBadge status={t.running ? 'in_progress' : t.status || 'unknown'} />
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      )}

      {/* Force Stop / Hard Reset Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(powerConfirm)}
        onOpenChange={(open) => {
          if (!open) setPowerConfirm(null)
        }}
        title={
          powerConfirm === 'stop'
            ? `确认强制断电 · #${vmid} (${guestName})`
            : `确认硬复位 · #${vmid} (${guestName})`
        }
        description={
          powerConfirm === 'stop'
            ? '强制断电（Force Stop）相当于直接拔掉电源，未落盘数据可能丢失。建议优先使用优雅关机。'
            : '硬复位（Hard Reset）会立即重启虚拟机内核，未落盘数据可能损坏。确认继续？'
        }
        confirmLabel={powerConfirm === 'stop' ? '确认强制断电' : '确认硬复位'}
        variant="destructive"
        loading={actionBusy}
        onConfirm={async () => {
          if (powerConfirm) await handlePower(powerConfirm)
        }}
      />

      {migrateOpen && (
        <GuestMigrateDialog
          open={migrateOpen}
          onOpenChange={setMigrateOpen}
          instanceId={instanceId}
          instanceName={instanceName}
          node={node}
          guestType={guestType}
          vmid={vmid}
          guestName={guestName}
          isActiveGuest={isActiveGuest}
          peerNodes={peerNodes}
          readOnly={readOnly}
        />
      )}

      {/* Destroy Guest Confirmation (X-Confirm-Target: <vmid>) */}
      <DangerConfirmDialog
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        title={`永久销毁 ${guestType.toUpperCase()} #${vmid} (${guestName})`}
        description="销毁操作将彻底删除该实例及其关联磁盘数据，且不可撤销！实例需处于已停止状态。"
        confirmTarget={String(vmid)}
        confirmLabel="确认永久销毁"
        extraOptions={
          <div className="space-y-2 rounded-lg border border-border bg-background/60 p-3 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={destroyPurge}
                onChange={(e) => setDestroyPurge(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-destructive)]"
              />
              <span>同时从备份/HA/复制任务中移除引用 (purge)</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={destroyUnref}
                onChange={(e) => setDestroyUnref(e.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--color-destructive)]"
              />
              <span>清理未挂载磁盘 (destroy-unreferenced-disks)</span>
            </label>
          </div>
        }
        onConfirm={async () => {
          const res = await api.deleteGuest(instanceId, node, guestType, vmid, {
            purge: destroyPurge,
            destroyUnreferencedDisks: destroyUnref,
          })
          toast.success(`已提交销毁任务 #${vmid}`)
          if (res.upid) {
            openTaskLog({
              instanceId,
              instanceName,
              node,
              upid: res.upid,
              type: guestType === 'lxc' ? 'vzdestroy' : 'qmdestroy',
              id: String(vmid),
            })
          }
          void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
          navigate('/compute')
        }}
      />
    </div>
  )
}
