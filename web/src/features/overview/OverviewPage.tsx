import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type * as echarts from 'echarts'
import { toast } from 'sonner'
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Box,
  Cpu,
  Gauge,
  HardDrive,
  Monitor,
  Pause,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Server,
  Terminal,
  Thermometer,
  Zap,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { useConsoleLauncher } from '@/hooks/useConsoleLauncher'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { formatBytes, formatClockTime, formatPercent, formatUptime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { EChartBox, useChartThemeColors } from '@/components/charts/EChartBox'
import { cn } from '@/lib/utils'

const ADMIN_HOST_ONLY_TITLE = '仅管理员 (admin) 可执行宿主机级高危操作'

function NodeHardwareMiniStrip({
  instanceId,
  node,
  nodeStatus,
  livePaused,
  onOpenHardware,
}: {
  instanceId: string
  node: string
  nodeStatus: string
  livePaused: boolean
  onOpenHardware: () => void
}) {
  const { data: hw } = useQuery({
    queryKey: ['node-hardware', instanceId, node],
    queryFn: () => api.getNodeHardware(instanceId, node, false),
    enabled: nodeStatus === 'online',
    refetchInterval: livePaused ? false : 30_000,
    staleTime: 15_000,
  })

  if (nodeStatus !== 'online' || !hw) return null

  const hostGPUs = hw.gpus.filter((g) => !g.passthrough)
  const hostDisks = hw.disks.filter((d) => !d.passthrough)
  const maxDiskTemp = hostDisks.reduce<number | null>(
    (acc, d) => (d.tempC !== undefined ? (acc === null ? d.tempC : Math.max(acc, d.tempC)) : acc),
    null,
  )
  const primaryGPU = hostGPUs[0]

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenHardware}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpenHardware()
        }
      }}
      className="flex flex-wrap items-center justify-between gap-2.5 rounded-lg border border-border/80 bg-muted/40 px-3.5 py-2.5 text-sm transition-colors hover:border-border-strong hover:bg-muted/70"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 min-w-0">
        {primaryGPU && (
          <span className="inline-flex items-center gap-1.5 text-foreground min-w-0">
            <Gauge className="h-3.5 w-3.5 text-accent shrink-0" />
            <span className="truncate max-w-[220px] font-medium">{primaryGPU.model}</span>
            {primaryGPU.curFreqMhz !== undefined && (
              <span className="font-mono-num text-muted-foreground">
                {primaryGPU.curFreqMhz.toFixed(0)}MHz
              </span>
            )}
            {primaryGPU.powerW !== undefined && (
              <span className="font-mono-num text-muted-foreground">
                {primaryGPU.powerW.toFixed(1)}W
              </span>
            )}
          </span>
        )}

        <span className="inline-flex items-center gap-1.5 text-foreground font-mono-num">
          <HardDrive className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span>宿主机盘 {hostDisks.length} 块</span>
          {maxDiskTemp !== null && (
            <span className={maxDiskTemp >= 60 ? 'text-warning' : 'text-muted-foreground'}>
              最高 {maxDiskTemp.toFixed(0)}°C
            </span>
          )}
        </span>

        {hw.cpu.packageTempC !== undefined && (
          <span className="inline-flex items-center gap-1 font-mono-num text-foreground">
            <Thermometer className="h-3.5 w-3.5 text-warning shrink-0" />
            <span>CPU {hw.cpu.packageTempC.toFixed(0)}°C</span>
          </span>
        )}

        {hw.cpu.packagePowerW !== undefined && (
          <span className="inline-flex items-center gap-1 font-mono-num text-muted-foreground">
            <Zap className="h-3.5 w-3.5 text-warning shrink-0" />
            <span>{hw.cpu.packagePowerW.toFixed(1)}W</span>
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 shrink-0">
        {hw.missingPackages.length > 0 && (
          <Badge variant="warning">缺少 {hw.missingPackages.length} 个包</Badge>
        )}
        <span className="inline-flex items-center gap-1 text-accent font-medium">
          硬件详情
          <ArrowUpRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  )
}

export function OverviewPage() {
  const { data: overview, isLoading, isFetching } = useOverviewQuery()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const colors = useChartThemeColors()

  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const livePaused = useAppStore((s) => s.livePaused)
  const setLivePaused = useAppStore((s) => s.setLivePaused)
  const liveHistory = useAppStore((s) => s.liveHistory)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const { isAdmin, serverReadOnly, launchNodeConsole, launchGuestConsole } = useConsoleLauncher()

  const scoped = useMemo(() => {
    const allInst = overview?.instances ?? []
    const instances =
      selectedInstanceId === 'all' ? allInst : allInst.filter((i) => i.id === selectedInstanceId)
    const nodes = (overview?.nodes ?? []).filter(
      (n) => selectedInstanceId === 'all' || n.instanceId === selectedInstanceId,
    )
    const guests = (overview?.guests ?? []).filter(
      (g) => selectedInstanceId === 'all' || g.instanceId === selectedInstanceId,
    )
    const storages = (overview?.storages ?? []).filter(
      (s) => selectedInstanceId === 'all' || s.instanceId === selectedInstanceId,
    )
    const tasks = (overview?.tasks ?? []).filter(
      (t) => selectedInstanceId === 'all' || t.instanceId === selectedInstanceId,
    )

    let totalCpu = 0
    let usedCpu = 0
    let totalMem = 0
    let usedMem = 0
    let nodesOnline = 0
    for (const n of nodes) {
      if (n.status === 'online') {
        nodesOnline += 1
        totalCpu += n.maxcpu
        usedCpu += n.cpu * n.maxcpu
        totalMem += n.maxmem
        usedMem += n.mem
      }
    }

    let qemuRunning = 0
    let qemuStopped = 0
    let lxcRunning = 0
    let lxcStopped = 0
    let templates = 0
    for (const g of guests) {
      if (g.template) {
        templates += 1
        continue
      }
      if (g.type === 'qemu') {
        if (g.status === 'running') qemuRunning += 1
        else qemuStopped += 1
      } else {
        if (g.status === 'running') lxcRunning += 1
        else lxcStopped += 1
      }
    }

    const seenShared = new Set<string>()
    let totalDisk = 0
    let usedDisk = 0
    for (const st of storages) {
      if (st.status !== 'available') continue
      if (st.shared) {
        const key = `${st.instanceId}:${st.storage}`
        if (seenShared.has(key)) continue
        seenShared.add(key)
      }
      totalDisk += st.maxdisk
      usedDisk += st.disk
    }

    const runningTasks = tasks.filter((t) => t.running).length
    const offlineInstances = instances.filter((i) => i.state === 'offline').length

    const topCpu = [...guests]
      .filter((g) => !g.template && g.status === 'running')
      .sort((a, b) => b.cpu - a.cpu)
      .slice(0, 5)

    return {
      instances,
      nodes,
      guests,
      storages,
      tasks,
      totalCpu,
      usedCpu,
      totalMem,
      usedMem,
      totalDisk,
      usedDisk,
      nodesOnline,
      qemuRunning,
      qemuStopped,
      lxcRunning,
      lxcStopped,
      templates,
      runningTasks,
      offlineInstances,
      topCpu,
    }
  }, [overview, selectedInstanceId])

  const cpuPct = scoped.totalCpu > 0 ? (scoped.usedCpu / scoped.totalCpu) * 100 : 0
  const memPct = scoped.totalMem > 0 ? (scoped.usedMem / scoped.totalMem) * 100 : 0
  const diskPct = scoped.totalDisk > 0 ? (scoped.usedDisk / scoped.totalDisk) * 100 : 0

  const scopePrefix = useMemo(() => {
    if (selectedInstanceId === 'all') return '全局'
    return scoped.instances[0]?.name || '当前实例'
  }, [scoped.instances, selectedInstanceId])

  const liveChartOption = useMemo<echarts.EChartsOption>(() => {
    const scopedSamples =
      selectedInstanceId === 'all'
        ? liveHistory.map((sample) => ({
            time: sample.time,
            cpuPct: sample.cpuPct,
            memPct: sample.memPct,
          }))
        : liveHistory.flatMap((sample) => {
            const perInst = (
              sample as { byInstance?: Record<string, { cpuPct: number; memPct: number }> }
            ).byInstance?.[selectedInstanceId]
            return perInst
              ? [{ time: sample.time, cpuPct: perInst.cpuPct, memPct: perInst.memPct }]
              : []
          })

    const fallbackTime = formatClockTime(overview?.updatedAt)
    const times =
      scopedSamples.length > 0
        ? scopedSamples.map((s) => s.time)
        : [fallbackTime !== '—' ? fallbackTime : '--:--:--']

    return {
      grid: { left: 48, right: 20, top: 32, bottom: 28 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: colors.tooltipBg,
        borderColor: colors.tooltipBorder,
        textStyle: { color: colors.textStrong, fontSize: 12, fontFamily: 'JetBrains Mono, monospace' },
      },
      legend: { top: 0, right: 8, textStyle: { color: colors.text, fontSize: 12 } },
      xAxis: {
        type: 'category',
        data: times,
        boundaryGap: false,
        axisLine: { lineStyle: { color: colors.gridLine } },
        axisLabel: { color: colors.text, fontSize: 12, fontFamily: 'JetBrains Mono, monospace' },
      },
      yAxis: {
        type: 'value',
        min: 0,
        max: 100,
        splitLine: { lineStyle: { color: colors.gridLine, type: 'dashed' } },
        axisLabel: { color: colors.text, fontSize: 12, formatter: '{value}%' },
      },
      series: [
        {
          name: `${scopePrefix} CPU %`,
          type: 'line',
          smooth: 0.25,
          showSymbol: false,
          lineStyle: { width: 2.2, color: colors.accent },
          itemStyle: { color: colors.accent },
          areaStyle: { color: `${colors.accent}20` },
          data:
            scopedSamples.length > 0
              ? scopedSamples.map((s) => s.cpuPct)
              : [Number(cpuPct.toFixed(1))],
        },
        {
          name: `${scopePrefix} 内存 %`,
          type: 'line',
          smooth: 0.25,
          showSymbol: false,
          lineStyle: { width: 2.2, color: colors.info },
          itemStyle: { color: colors.info },
          areaStyle: { color: `${colors.info}1A` },
          data:
            scopedSamples.length > 0
              ? scopedSamples.map((s) => s.memPct)
              : [Number(memPct.toFixed(1))],
        },
      ],
    }
  }, [liveHistory, selectedInstanceId, overview?.updatedAt, colors, scopePrefix, cpuPct, memPct])

  const handleForceRefresh = async () => {
    try {
      const fresh = await api.getOverview(true)
      queryClient.setQueryData(OVERVIEW_QUERY_KEY, fresh)
      toast.success('已同步最新集群状态')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '刷新失败')
    }
  }

  const handleRetryInstance = async (instanceId: string) => {
    try {
      const res = await api.probeInstance(instanceId)
      if (res.ok) {
        toast.success(`探测成功：PVE ${res.version?.version ?? ''}`)
      } else {
        toast.error(res.error || '节点仍无法连接')
      }
      const fresh = await api.getOverview(true)
      queryClient.setQueryData(OVERVIEW_QUERY_KEY, fresh)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '探测失败')
    }
  }

  if (isLoading && !overview) {
    return (
      <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map((k) => (
            <div key={k} className="h-36 animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-7">
      {/* Header Row */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight text-foreground">
            多集群全局总览
          </h1>
          <p className="text-sm text-muted-foreground">
            实时聚合在线 Proxmox VE 节点、计算负载与宿主机硬件状态 · 最近同步{' '}
            <span className="font-mono-num text-foreground">{formatClockTime(overview?.updatedAt)}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Button variant="outline" size="sm" onClick={() => setLivePaused(!livePaused)}>
            {livePaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
            <span>{livePaused ? '恢复推送' : '暂停推送'}</span>
          </Button>
          <Button variant="outline" size="sm" onClick={handleForceRefresh} disabled={isFetching}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            <span>立即刷新</span>
          </Button>
          <Button
            variant="default"
            size="sm"
            disabled={!isAdmin || readOnly}
            title={
              !isAdmin
                ? ADMIN_HOST_ONLY_TITLE
                : readOnly
                  ? '写保护已开启'
                  : undefined
            }
            onClick={() => navigate('/instances?add=1')}
          >
            <Plus className="h-4 w-4" />
            <span>接入 PVE 实例</span>
          </Button>
        </div>
      </div>

      {scoped.instances.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="尚未接入任何 Proxmox VE 实例"
          description="支持同时纳管多套单机 PVE 或多节点集群（PVE 7.4 / 8.x / 9.x），内置多节点 Failover、TLS TOFU 证书指纹锁定与宿主机硬件监控。"
          action={
            <Button
              variant="default"
              size="md"
              disabled={!isAdmin || readOnly}
              title={
                !isAdmin
                  ? ADMIN_HOST_ONLY_TITLE
                  : readOnly
                    ? '写保护已开启'
                    : undefined
              }
              onClick={() => navigate('/instances?add=1')}
            >
              <Plus className="h-4 w-4" />
              立即添加第一个 PVE 实例
            </Button>
          }
        />
      ) : (
        <>
          {/* Top 4 Generous KPI Cards */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="p-5 sm:p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">集群与宿主机节点</span>
                  <Server className="h-5 w-5 text-accent" />
                </div>
                <div className="flex items-baseline justify-between gap-2">
                  <div className="font-mono-num text-3xl font-bold tracking-tight">
                    {scoped.nodesOnline}
                    <span className="text-base font-normal text-muted-foreground">
                      {' '}
                      / {scoped.nodes.length} 在线
                    </span>
                  </div>
                  {scoped.offlineInstances > 0 ? (
                    <Badge variant="destructive">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      {scoped.offlineInstances} 失联
                    </Badge>
                  ) : (
                    <Badge variant="success">运行正常</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  已纳管 <span className="font-mono-num text-foreground">{scoped.instances.length}</span> 套实例 · 活跃任务{' '}
                  <span className="font-mono-num text-foreground">{scoped.runningTasks}</span>
                </p>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-border-strong"
              onClick={() => navigate('/compute')}
            >
              <CardContent className="p-5 sm:p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">计算实例 (VM + LXC)</span>
                  <Cpu className="h-5 w-5 text-accent" />
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono-num text-3xl font-bold tracking-tight text-foreground">
                    {scoped.qemuRunning + scoped.lxcRunning}
                  </span>
                  <span className="text-sm text-muted-foreground">运行中</span>
                  <span className="font-mono-num text-lg font-medium text-muted-foreground ml-1">
                    / {scoped.qemuStopped + scoped.lxcStopped} 已停止
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <span className="inline-flex items-center gap-1.5 font-mono-num text-foreground">
                    <Monitor className="h-3.5 w-3.5 text-accent" />
                    VM {scoped.qemuRunning}/{scoped.qemuRunning + scoped.qemuStopped}
                  </span>
                  <span className="inline-flex items-center gap-1.5 font-mono-num text-foreground">
                    <Box className="h-3.5 w-3.5 text-success" />
                    LXC {scoped.lxcRunning}/{scoped.lxcRunning + scoped.lxcStopped}
                  </span>
                  {scoped.templates > 0 && (
                    <span className="font-mono-num text-muted-foreground">模板 {scoped.templates}</span>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 sm:p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">聚合 CPU / 内存水位</span>
                  <Activity className="h-5 w-5 text-accent" />
                </div>
                <ResourceBar
                  percent={cpuPct}
                  label={`CPU ${cpuPct.toFixed(1)}%`}
                  sublabel={`${scoped.usedCpu.toFixed(1)} / ${scoped.totalCpu} Core`}
                />
                <ResourceBar
                  percent={memPct}
                  label={`RAM ${memPct.toFixed(1)}%`}
                  sublabel={`${formatBytes(scoped.usedMem, 1)} / ${formatBytes(scoped.totalMem, 0)}`}
                  colorMode={memPct >= 85 ? 'auto' : 'success'}
                />
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer transition-colors hover:border-border-strong"
              onClick={() => navigate('/storage')}
            >
              <CardContent className="p-5 sm:p-6 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-muted-foreground">聚合存储池容量</span>
                  <HardDrive className="h-5 w-5 text-warning" />
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="font-mono-num text-3xl font-bold tracking-tight">
                    {diskPct.toFixed(1)}%
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {scoped.storages.length} 个存储池
                  </span>
                </div>
                <ResourceBar
                  percent={diskPct}
                  sublabel={`${formatBytes(scoped.usedDisk)} / ${formatBytes(scoped.totalDisk)}`}
                />
              </CardContent>
            </Card>
          </div>

          {/* Instance & Host Hardware Matrix */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-foreground">
                PVE 实例与宿主机硬件矩阵
              </h2>
              <Button variant="ghost" size="sm" onClick={() => navigate('/instances')}>
                实例管理
                <ArrowUpRight className="h-4 w-4" />
              </Button>
            </div>

            <div
              className={cn(
                'grid grid-cols-1 gap-5',
                scoped.instances.length > 1 && 'xl:grid-cols-2',
              )}
            >
              {scoped.instances.map((inst) => {
                const isOffline = inst.state === 'offline'
                return (
                  <Card
                    key={inst.id}
                    className={cn(
                      'overflow-hidden',
                      isOffline && 'border-destructive/50 opacity-90',
                    )}
                  >
                    <CardContent className="p-5 sm:p-6 space-y-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1.5 min-w-0">
                          <div className="flex flex-wrap items-center gap-2.5">
                            <span
                              className="h-2.5 w-2.5 rounded-full shrink-0"
                              style={{ backgroundColor: inst.color }}
                            />
                            <h3 className="text-base font-semibold text-foreground truncate">
                              {inst.name}
                            </h3>
                            <StatusBadge status={inst.state} />
                            {inst.pveVersion && (
                              <Badge variant="muted" className="font-mono-num">
                                PVE {inst.pveVersion}
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground font-mono-num">
                            <span>分组: {inst.groupName}</span>
                            <span>{inst.isCluster ? `集群 ${inst.clusterName || ''}` : '单机节点'}</span>
                            {inst.latencyMs !== undefined && inst.state === 'online' && (
                              <span>延迟 {inst.latencyMs}ms</span>
                            )}
                            {inst.state === 'online' && (
                              <span>
                                计算实例 {inst.runningCount}/{inst.guestCount} 运行
                              </span>
                            )}
                          </div>
                        </div>

                        {isOffline && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!isAdmin}
                            title={!isAdmin ? ADMIN_HOST_ONLY_TITLE : undefined}
                            onClick={() => handleRetryInstance(inst.id)}
                          >
                            <RefreshCw className="h-4 w-4" />
                            重试探测
                          </Button>
                        )}
                      </div>

                      {isOffline && inst.error && (
                        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive break-all">
                          连接异常：{inst.error}
                        </div>
                      )}

                      {inst.nodes.length > 0 && (
                        <div className="space-y-3">
                          {inst.nodes.map((n) => {
                            const nCpu = n.cpu * 100
                            const nMem = n.maxmem > 0 ? (n.mem / n.maxmem) * 100 : 0
                            const canOpenNodeShell =
                              isAdmin && !serverReadOnly && n.status === 'online'
                            const nodeShellTitle = !isAdmin
                              ? ADMIN_HOST_ONLY_TITLE
                              : serverReadOnly
                                ? '只读模式下不可打开宿主机终端'
                                : n.status !== 'online'
                                  ? '节点当前离线'
                                  : '打开宿主机 Shell'
                            return (
                              <div
                                key={n.urn}
                                className="rounded-xl border border-border bg-background/70 p-4 space-y-3.5"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <button
                                    type="button"
                                    onClick={() => navigate(`/instances/${inst.id}/nodes/${n.node}`)}
                                    className="flex items-center gap-2 text-sm font-mono-num font-semibold text-foreground hover:text-accent"
                                  >
                                    <Server className="h-4 w-4 text-accent" />
                                    <span>{n.node}</span>
                                    {n.ip && (
                                      <span className="font-normal text-muted-foreground">{n.ip}</span>
                                    )}
                                  </button>
                                  <div className="flex items-center gap-2.5">
                                    <span className="font-mono-num text-xs text-muted-foreground">
                                      运行 {formatUptime(n.uptime)}
                                    </span>
                                    <Button
                                      variant="outline"
                                      size="xs"
                                      disabled={!canOpenNodeShell}
                                      title={nodeShellTitle}
                                      onClick={() =>
                                        launchNodeConsole(
                                          {
                                            instanceId: inst.id,
                                            instanceName: inst.name,
                                            instanceColor: inst.color,
                                            node: n.node,
                                            status: n.status,
                                          },
                                          'xterm',
                                        )
                                      }
                                    >
                                      <Terminal className="h-3.5 w-3.5" />
                                      Shell
                                    </Button>
                                  </div>
                                </div>

                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                  <ResourceBar
                                    percent={nCpu}
                                    label={`CPU ${formatPercent(n.cpu)}`}
                                    sublabel={`${n.maxcpu} vCPU`}
                                  />
                                  <ResourceBar
                                    percent={nMem}
                                    label={`RAM ${nMem.toFixed(1)}%`}
                                    sublabel={`${formatBytes(n.mem)} / ${formatBytes(n.maxmem)}`}
                                    colorMode={nMem >= 85 ? 'auto' : 'success'}
                                  />
                                </div>

                                {/* Non-passthrough GPU / Disks / Sensors summary */}
                                <NodeHardwareMiniStrip
                                  instanceId={inst.id}
                                  node={n.node}
                                  nodeStatus={n.status}
                                  livePaused={livePaused}
                                  onOpenHardware={() =>
                                    navigate(`/instances/${inst.id}/nodes/${n.node}?tab=hardware`)
                                  }
                                />
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </section>

          {/* Telemetry Trend + Top 5 Hotspots */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
            <Card className="xl:col-span-7">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-4.5 w-4.5 text-accent" />
                  <span>
                    实时聚合水位趋势 ({selectedInstanceId === 'all' ? 'SSE' : scopePrefix})
                  </span>
                </CardTitle>
                <span className="font-mono-num text-xs text-muted-foreground">
                  CPU {cpuPct.toFixed(1)}% · RAM {memPct.toFixed(1)}%
                </span>
              </CardHeader>
              <CardContent className="pt-4">
                <EChartBox
                  option={liveChartOption}
                  height={250}
                  ariaLabel="全局聚合 CPU 与内存实时趋势图"
                />
              </CardContent>
            </Card>

            <Card className="xl:col-span-5">
              <CardHeader>
                <CardTitle>Top 5 高负载热点 (VM + LXC)</CardTitle>
                <Button variant="ghost" size="xs" onClick={() => navigate('/compute')}>
                  全部计算资源
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                {scoped.topCpu.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                    暂无运行中的虚拟机或容器
                  </div>
                ) : (
                  <div className="divide-y divide-border/70">
                    {scoped.topCpu.map((g) => {
                      const ramPct = g.maxmem > 0 ? Math.min(100, (g.mem / g.maxmem) * 100) : 0
                      const canOpenConsole =
                        !serverReadOnly && !g.template && g.status === 'running'
                      const consoleTitle = serverReadOnly
                        ? '只读模式下不可打开控制台'
                        : g.template
                          ? '模板不支持打开控制台'
                          : g.status !== 'running'
                            ? '仅运行中的实例可打开控制台'
                            : '打开控制台'
                      return (
                        <div
                          key={g.urn}
                          className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted/40 transition-colors"
                        >
                          <button
                            type="button"
                            onClick={() =>
                              navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                            }
                            className="flex items-center gap-2.5 min-w-0 text-left flex-1"
                          >
                            {g.type === 'lxc' ? (
                              <Box className="h-4.5 w-4.5 text-success shrink-0" />
                            ) : (
                              <Monitor className="h-4.5 w-4.5 text-accent shrink-0" />
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                                <span className="font-mono-num text-muted-foreground">#{g.vmid}</span>
                                <span className="truncate">{g.name || `${g.type}-${g.vmid}`}</span>
                              </div>
                              <div className="text-xs text-muted-foreground truncate">
                                {g.instanceName} / {g.node} · {g.type.toUpperCase()}
                              </div>
                            </div>
                          </button>

                          <div className="flex items-center gap-3 shrink-0">
                            <div className="text-right font-mono-num">
                              <div className="text-sm text-foreground font-semibold">
                                CPU {formatPercent(g.cpu)}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                RAM {ramPct.toFixed(0)}% ({formatBytes(g.mem, 0)})
                              </div>
                            </div>
                            <Button
                              variant="outline"
                              size="icon-sm"
                              disabled={!canOpenConsole}
                              title={consoleTitle}
                              onClick={() => launchGuestConsole(g)}
                            >
                              <Terminal className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
