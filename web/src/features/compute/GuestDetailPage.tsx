import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  Box,
  Camera,
  ChevronDown,
  Clock,
  Copy,
  Cpu,
  Download,
  GitBranch,
  Loader2,
  Monitor,
  Network,
  Pause,
  Play,
  Power,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Terminal,
  Trash2,
  Undo2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GuestType, SnapshotItem } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
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
import { Input, Textarea } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { RrdMetricPanel } from '@/components/charts/RrdMetricPanel'
import { GuestHardwarePanel } from './GuestHardwarePanel'
import { GuestBackupPanel } from './GuestBackupPanel'
import { cn } from '@/lib/utils'

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function str(v: unknown): string {
  if (v === undefined || v === null) return ''
  return String(v)
}

export function GuestDetailPage() {
  const { instanceId = '', node = '', type = 'qemu', vmid: vmidParam = '0' } = useParams()
  const guestType: GuestType = type === 'lxc' ? 'lxc' : 'qemu'
  const vmid = Number(vmidParam) || 0
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const { data: overview } = useOverviewQuery()
  const openTaskLog = useAppStore((s) => s.openTaskLog)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const openTab = useConsoleStore((s) => s.openTab)

  const [actionBusy, setActionBusy] = useState(false)
  const [destroyOpen, setDestroyOpen] = useState(false)
  const [destroyPurge, setDestroyPurge] = useState(true)
  const [destroyUnref, setDestroyUnref] = useState(true)

  const [snapModalOpen, setSnapModalOpen] = useState(false)
  const [snapName, setSnapName] = useState('')
  const [snapDesc, setSnapDesc] = useState('')
  const [snapVmState, setSnapVmState] = useState(false)
  const [snapBusy, setSnapBusy] = useState(false)
  const [snapError, setSnapError] = useState<string | null>(null)

  const [confirmSnapAction, setConfirmSnapAction] = useState<{
    mode: 'rollback' | 'delete'
    snap: SnapshotItem
  } | null>(null)

  const instanceSnap = overview?.instances.find((i) => i.id === instanceId)
  const instanceName = instanceSnap?.name || instanceId
  const instanceColor = instanceSnap?.color || '#22C55E'

  const { data: detail, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['guest-detail', instanceId, node, guestType, vmid],
    queryFn: () => api.getGuestDetail(instanceId, node, guestType, vmid),
    refetchInterval: 5000,
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
  const isRunning = status === 'running'
  const isPaused = status === 'paused'
  const isTemplate = num(current.template) === 1 || num(config.template) === 1
  const guestName = str(current.name) || str(config.name) || str(config.hostname) || `${guestType}-${vmid}`

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
    () =>
      (detail?.pending ?? []).filter(
        (p) => p.pending !== undefined || Boolean(p.delete),
      ),
    [detail?.pending],
  )

  const openConsole = (protocol: 'vnc' | 'xterm') => {
    openTab({
      instanceId,
      instanceName,
      instanceColor,
      node,
      targetType: guestType,
      vmid,
      title: `${vmid} · ${guestName}`,
      protocol,
    })
    navigate('/console')
  }

  const handleSpice = async () => {
    try {
      const data = await api.requestSpice(instanceId, node, guestType, vmid)
      downloadSpiceVV(data, `${node}-${guestType}-${vmid}.vv`)
      toast.success('已生成并下载 SPICE .vv 连接文件')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '获取 SPICE 票据失败（请确认虚拟机已配置 SPICE 显卡）')
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

  const handleCreateSnapshot = async (e: React.FormEvent) => {
    e.preventDefault()
    setSnapError(null)
    const clean = snapName.trim()
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(clean)) {
      setSnapError('快照名称需以字母开头，仅含字母、数字、下划线或连字符（最长 40 位）')
      return
    }
    setSnapBusy(true)
    try {
      const res = await api.createSnapshot(instanceId, node, guestType, vmid, {
        snapname: clean,
        description: snapDesc.trim(),
        vmstate: guestType === 'qemu' ? snapVmState : false,
      })
      toast.success(`快照 "${clean}" 创建任务已提交`)
      setSnapModalOpen(false)
      setSnapName('')
      setSnapDesc('')
      setSnapVmState(false)
      if (res.upid) {
        openTaskLog({
          instanceId,
          instanceName,
          node,
          upid: res.upid,
          type: guestType === 'lxc' ? 'vzsnapshot' : 'qmsnapshot',
          id: String(vmid),
        })
      }
      setTimeout(() => void refetch(), 1500)
    } catch (err) {
      setSnapError(err instanceof Error ? err.message : '创建快照失败')
    } finally {
      setSnapBusy(false)
    }
  }

  const handleSnapshotConfirm = async () => {
    if (!confirmSnapAction) return
    const { mode, snap } = confirmSnapAction
    const res =
      mode === 'rollback'
        ? await api.rollbackSnapshot(instanceId, node, guestType, vmid, snap.name)
        : await api.deleteSnapshot(instanceId, node, guestType, vmid, snap.name)
    toast.success(
      mode === 'rollback' ? `已提交回滚快照 "${snap.name}"` : `已提交删除快照 "${snap.name}"`,
    )
    if (res.upid) {
      openTaskLog({
        instanceId,
        instanceName,
        node,
        upid: res.upid,
        type:
          mode === 'rollback'
            ? guestType === 'lxc'
              ? 'vzrollback'
              : 'qmrollback'
            : guestType === 'lxc'
              ? 'vzdelsnapshot'
              : 'qmdelsnapshot',
        id: String(vmid),
      })
    }
    setTimeout(() => void refetch(), 1500)
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      {/* Sticky Resource Action Header */}
      <div className="rounded-xl border border-border bg-card p-5 sm:p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <Button variant="outline" size="icon" onClick={() => navigate('/compute')} aria-label="返回列表">
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
                <span className="font-mono-num text-xl font-bold text-muted-foreground">#{vmid}</span>
                <h1 className="text-xl sm:text-2xl font-semibold text-foreground truncate">{guestName}</h1>
                <StatusBadge status={status} template={isTemplate} />
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
                    className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono-num text-[11px] text-foreground hover:bg-muted/70"
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
                  disabled={!isRunning}
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
                      disabled={!isRunning}
                      className="rounded-l-none border-l border-on-accent/25 px-1.5"
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

            {!isTemplate && isPaused && (
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
                {!isTemplate && isRunning && (
                  <>
                    <DropdownMenuItem onClick={() => handlePower('suspend')}>
                      <Pause className="h-3.5 w-3.5 text-warning" />
                      <span>暂停 / 挂起 (Suspend)</span>
                    </DropdownMenuItem>
                    {guestType === 'qemu' && (
                      <DropdownMenuItem onClick={() => handlePower('reset')}>
                        <RotateCcw className="h-3.5 w-3.5 text-warning" />
                        <span>硬复位 (Reset)</span>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem destructive onClick={() => handlePower('stop')}>
                      <Square className="h-3.5 w-3.5" />
                      <span>强制断电 (Force Stop)</span>
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

            <Button variant="ghost" size="icon-sm" onClick={() => refetch()} disabled={isFetching} title="刷新">
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
        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">
              <Cpu className="h-3.5 w-3.5" />
              概览与 RRD 监控
            </TabsTrigger>
            <TabsTrigger value="config">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              硬件与配置
              {pendingChanges.length > 0 && (
                <Badge variant="warning" className="ml-1 text-[10px]">
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
                    percent={memMax > 0 ? (memUsed / memMax) * 100 : 0}
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
                      percent={diskMax > 0 ? (diskUsed / diskMax) * 100 : 0}
                      sublabel={`${formatBytes(diskMax, 0)} · Swap ${formatBytes(swapUsed, 0)}/${formatBytes(swapMax, 0)}`}
                    />
                  </CardContent>
                </Card>
              ) : (
                <Card>
                  <CardContent className="p-4 space-y-2">
                    <span className="text-xs text-muted-foreground">引导盘配额</span>
                    <div className="font-mono-num text-xl font-bold">{formatBytes(diskMax)}</div>
                    <div className="font-mono-num text-[11px] text-muted-foreground">
                      累计读 {formatBytes(num(current.diskread))} · 写 {formatBytes(num(current.diskwrite))}
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
              <CardHeader className="py-2.5">
                <CardTitle className="flex items-center gap-2 text-xs">
                  <Network className="h-4 w-4 text-info" />
                  <span>
                    实时网络接口与 IP 地址（{guestType === 'lxc' ? 'LXC /interfaces' : 'QEMU Guest Agent'}）
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                {(detail?.ips ?? []).length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {isRunning
                      ? guestType === 'qemu'
                        ? '未获取到 IP（可能未安装或未启用 QEMU Guest Agent）。'
                        : '暂无活跃非回环网卡信息。'
                      : '实例未运行，无法采集实时网卡 IP。'}
                  </p>
                ) : (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                    {(detail?.ips ?? []).map((iface) => (
                      <div
                        key={iface.interface + (iface.mac || '')}
                        className="rounded-lg border border-border bg-background/60 p-2.5 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono-num font-semibold text-foreground">{iface.interface}</span>
                          {iface.mac && (
                            <span className="font-mono-num text-[10px] text-muted-foreground">{iface.mac}</span>
                          )}
                        </div>
                        {(iface.ipv4 ?? []).map((ip) => (
                          <div key={ip} className="flex items-center justify-between gap-1 font-mono-num text-[11px]">
                            <span className="text-accent">{ip}</span>
                            <button
                              type="button"
                              onClick={async () => {
                                await copyToClipboard(ip.split('/')[0])
                                toast.success(`已复制 ${ip.split('/')[0]}`)
                              }}
                              className="text-muted-foreground hover:text-foreground"
                            >
                              <Copy className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                        {(iface.ipv6 ?? []).slice(0, 2).map((ip) => (
                          <div key={ip} className="font-mono-num text-[10px] text-muted-foreground truncate">
                            {ip}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* RRD Historical Charts */}
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
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                支持 QEMU 与 LXC 快照树展示、创建、回滚与删除。
              </p>
              <Button
                variant="default"
                size="sm"
                disabled={readOnly}
                title={readOnly ? '写保护已开启' : undefined}
                onClick={() => setSnapModalOpen(true)}
              >
                <Camera className="h-3.5 w-3.5" />
                创建快照
              </Button>
            </div>

            <Card>
              <CardContent className="p-0">
                {(detail?.snapshots ?? []).length === 0 ? (
                  <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                    暂无快照记录（或当前底层存储不支持快照）。
                  </div>
                ) : (
                  <div className="divide-y divide-border/60">
                    {(detail?.snapshots ?? []).map((snap) => {
                      const isCurrent = snap.name === 'current'
                      return (
                        <div
                          key={snap.name}
                          className={cn(
                            'flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs',
                            isCurrent && 'bg-accent/8',
                          )}
                        >
                          <div className="space-y-0.5 min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <GitBranch
                                className={cn(
                                  'h-3.5 w-3.5 shrink-0',
                                  isCurrent ? 'text-accent' : 'text-info',
                                )}
                              />
                              <span className="font-mono-num font-semibold text-foreground">
                                {isCurrent ? '当前状态 (You are here)' : snap.name}
                              </span>
                              {snap.parent && (
                                <span className="font-mono-num text-[10px] text-muted-foreground">
                                  父节点: {snap.parent}
                                </span>
                              )}
                              {snap.vmstate && <Badge variant="info">含内存状态</Badge>}
                            </div>
                            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground pl-5">
                              {snap.snaptime ? (
                                <span className="font-mono-num">{formatTimestamp(snap.snaptime)}</span>
                              ) : null}
                              {snap.description && <span>{snap.description}</span>}
                            </div>
                          </div>

                          {!isCurrent && (
                            <div className="flex items-center gap-1.5 shrink-0">
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={readOnly}
                                title={readOnly ? '写保护已开启' : undefined}
                                onClick={() => setConfirmSnapAction({ mode: 'rollback', snap })}
                              >
                                <Undo2 className="h-3 w-3 text-warning" />
                                回滚
                              </Button>
                              <Button
                                variant="outline"
                                size="xs"
                                disabled={readOnly}
                                title={readOnly ? '写保护已开启' : undefined}
                                onClick={() => setConfirmSnapAction({ mode: 'delete', snap })}
                              >
                                <Trash2 className="h-3 w-3 text-destructive" />
                                删除
                              </Button>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
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

          {/* Tab 5: Tasks */}
          <TabsContent value="tasks">
            <Card className="overflow-hidden">
              {guestTasks.length === 0 ? (
                <div className="px-4 py-10 text-center text-xs text-muted-foreground">
                  近期无此实例的任务记录
                </div>
              ) : (
                <div className="divide-y divide-border/60 text-xs">
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
                      className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-muted/50"
                    >
                      <div className="min-w-0">
                        <div className="font-medium text-foreground">{formatTaskType(t.type)}</div>
                        <div className="font-mono-num text-[11px] text-muted-foreground truncate">
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

      {/* Create Snapshot Dialog */}
      <Dialog open={snapModalOpen} onOpenChange={setSnapModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>创建快照 · #{vmid} ({guestName})</DialogTitle>
            <DialogDescription>
              为当前 {guestType.toUpperCase()} 实例创建即时快照，便于故障快速回滚。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateSnapshot} className="space-y-3.5">
            <div className="space-y-1.5">
              <label htmlFor="snap-name" className="block text-xs font-medium">
                快照名称
              </label>
              <Input
                id="snap-name"
                value={snapName}
                onChange={(e) => setSnapName(e.target.value)}
                placeholder="before_upgrade"
                className="font-mono-num"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="snap-desc" className="block text-xs font-medium">
                备注说明（可选）
              </label>
              <Textarea
                id="snap-desc"
                value={snapDesc}
                onChange={(e) => setSnapDesc(e.target.value)}
                placeholder="升级内核前备份"
                rows={2}
              />
            </div>
            {guestType === 'qemu' && (
              <label className="flex items-center gap-2 text-xs text-foreground">
                <input
                  type="checkbox"
                  checked={snapVmState}
                  onChange={(e) => setSnapVmState(e.target.checked)}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>同时保存内存运行状态 (Include RAM / vmstate)</span>
              </label>
            )}
            {snapError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive">
                {snapError}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => setSnapModalOpen(false)} disabled={snapBusy}>
                取消
              </Button>
              <Button type="submit" variant="default" disabled={snapBusy}>
                {snapBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                创建快照
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Rollback / Delete Snapshot Confirmation */}
      <DangerConfirmDialog
        open={Boolean(confirmSnapAction)}
        onOpenChange={(open) => {
          if (!open) setConfirmSnapAction(null)
        }}
        title={
          confirmSnapAction?.mode === 'rollback'
            ? `回滚快照 "${confirmSnapAction.snap.name}"`
            : `删除快照 "${confirmSnapAction?.snap.name ?? ''}"`
        }
        description={
          confirmSnapAction?.mode === 'rollback'
            ? '回滚将覆盖自该快照之后的全部磁盘改动，此操作不可逆！'
            : '删除后该快照无法恢复。'
        }
        confirmTarget={confirmSnapAction?.snap.name ?? ''}
        confirmLabel={confirmSnapAction?.mode === 'rollback' ? '确认回滚' : '确认删除'}
        onConfirm={handleSnapshotConfirm}
      />

      {/* Destroy Guest Confirmation (X-Confirm-Target: <vmid>) */}
      <DangerConfirmDialog
        open={destroyOpen}
        onOpenChange={setDestroyOpen}
        title={`永久销毁 ${guestType.toUpperCase()} #${vmid} (${guestName})`}
        description="销毁操作将彻底删除该实例及其关联磁盘数据，且不可撤销！实例需处于已停止状态。"
        confirmTarget={String(vmid)}
        confirmLabel="确认永久销毁"
        extraOptions={
          <div className="space-y-2 rounded-lg border border-border bg-background/60 p-3 text-xs">
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
