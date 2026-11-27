import { useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowUpRight,
  Gauge,
  HardDrive,
  Server,
  Terminal,
  Thermometer,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { useConsoleLauncher } from '@/hooks/useConsoleLauncher'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { formatBytes, formatPercent, formatUptime } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { EmptyState } from '@/components/shared/EmptyState'
import { cn } from '@/lib/utils'

const ADMIN_HOST_ONLY_TITLE = '仅管理员 (admin) 可执行宿主机级高危操作'

function NodeHardwarePreview({
  instanceId,
  node,
  nodeStatus,
  livePaused,
}: {
  instanceId: string
  node: string
  nodeStatus: string
  livePaused: boolean
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
  const ptDisks = hw.disks.filter((d) => d.passthrough)

  return (
    <div className="rounded-lg border border-border bg-background/60 p-3.5 space-y-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-muted-foreground">未直通宿主机硬件概览</span>
        {hw.missingPackages.length > 0 && (
          <Badge variant="warning">
            <AlertTriangle className="h-3 w-3" />
            缺少 {hw.missingPackages.length} 个监测包
          </Badge>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Gauge className="h-4 w-4 text-accent shrink-0" />
          <span>
            {hostGPUs.length > 0
              ? `${hostGPUs[0].model}${hostGPUs[0].curFreqMhz !== undefined ? ` (${hostGPUs[0].curFreqMhz.toFixed(0)} MHz)` : ''}`
              : '无宿主机 GPU'}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5 font-mono-num text-foreground">
          <HardDrive className="h-4 w-4 text-muted-foreground shrink-0" />
          <span>
            硬盘 {hostDisks.length} 块{ptDisks.length > 0 ? ` (+${ptDisks.length} 直通)` : ''}
          </span>
        </span>
        {hw.cpu.packageTempC !== undefined && (
          <span className="inline-flex items-center gap-1 font-mono-num text-foreground">
            <Thermometer className="h-4 w-4 text-warning shrink-0" />
            <span>CPU {hw.cpu.packageTempC.toFixed(0)}°C</span>
          </span>
        )}
      </div>
    </div>
  )
}

export function NodesPage() {
  const { data: overview, isLoading } = useOverviewQuery()
  const navigate = useNavigate()
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const livePaused = useAppStore((s) => s.livePaused)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const { isAdmin, serverReadOnly, launchNodeConsole } = useConsoleLauncher()

  const nodes = useMemo(() => {
    const raw = overview?.nodes ?? []
    if (selectedInstanceId === 'all') return raw
    return raw.filter((n) => n.instanceId === selectedInstanceId)
  }, [overview?.nodes, selectedInstanceId])

  const guestsByNode = useMemo(() => {
    const map = new Map<string, { total: number; running: number }>()
    for (const g of overview?.guests ?? []) {
      if (g.template) continue
      const key = `${g.instanceId}:${g.node}`
      const existing = map.get(key)
      if (existing) {
        existing.total += 1
        if (g.status === 'running') existing.running += 1
      } else {
        map.set(key, { total: 1, running: g.status === 'running' ? 1 : 0 })
      }
    }
    return map
  }, [overview?.guests])

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">节点与宿主机硬件</h1>
        <p className="text-sm text-muted-foreground">
          共 <span className="font-mono-num text-foreground">{nodes.length}</span> 台宿主机节点 ·
          点击进入查看未直通显卡、物理硬盘 SMART 健康、传感器与 RRD 历史趋势
        </p>
      </div>

      {isLoading && !overview ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[0, 1].map((k) => (
            <div key={k} className="h-56 animate-pulse rounded-xl border border-border bg-card" />
          ))}
        </div>
      ) : nodes.length === 0 ? (
        <EmptyState
          icon={Server}
          title="暂无宿主机节点"
          description="请先在「实例连接管理」中接入 Proxmox VE 实例。"
          action={
            <Button
              variant="default"
              size="md"
              disabled={!isAdmin || readOnly}
              title={!isAdmin ? ADMIN_HOST_ONLY_TITLE : readOnly ? '写保护已开启' : undefined}
              onClick={() => navigate('/instances?add=1')}
            >
              接入 PVE 实例
            </Button>
          }
        />
      ) : (
        <div
          className={cn(
            'grid grid-cols-1 gap-5',
            nodes.length > 1 && 'xl:grid-cols-2',
          )}
        >
          {nodes.map((n) => {
            const memPct = n.maxmem > 0 ? (n.mem / n.maxmem) * 100 : 0
            const diskPct = n.maxdisk > 0 ? (n.disk / n.maxdisk) * 100 : 0
            const counts = guestsByNode.get(`${n.instanceId}:${n.node}`)
            const totalGuests = counts?.total ?? 0
            const runningCount = counts?.running ?? 0
            const canOpenShell = isAdmin && !serverReadOnly && n.status === 'online'
            const shellTitle = !isAdmin
              ? ADMIN_HOST_ONLY_TITLE
              : serverReadOnly
                ? '只读模式下不可打开宿主机终端'
                : n.status !== 'online'
                  ? '节点当前离线'
                  : '打开宿主机 Shell'

            return (
              <Card key={n.urn} className="overflow-hidden">
                <CardContent className="p-5 sm:p-6 space-y-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <span
                          className="h-2.5 w-2.5 rounded-full shrink-0"
                          style={{ backgroundColor: n.instanceColor }}
                        />
                        <button
                          type="button"
                          onClick={() => navigate(`/instances/${n.instanceId}/nodes/${n.node}`)}
                          className="flex items-center gap-2 font-mono-num text-lg font-bold text-foreground hover:text-accent"
                        >
                          <Server className="h-4.5 w-4.5 text-accent" />
                          <span>{n.node}</span>
                        </button>
                        <StatusBadge status={n.status} />
                        {n.cgroupMode ? (
                          <Badge variant="muted" className="font-mono-num">
                            cgroup v{n.cgroupMode}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2.5 text-xs text-muted-foreground font-mono-num">
                        <span>{n.instanceName}</span>
                        {n.ip && <span>· {n.ip}</span>}
                        <span>· 运行 {formatUptime(n.uptime)}</span>
                        <span>
                          · 实例 {runningCount}/{totalGuests}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canOpenShell}
                        title={shellTitle}
                        onClick={() =>
                          launchNodeConsole(
                            {
                              instanceId: n.instanceId,
                              instanceName: n.instanceName,
                              instanceColor: n.instanceColor,
                              node: n.node,
                              status: n.status,
                            },
                            'xterm',
                          )
                        }
                      >
                        <Terminal className="h-4 w-4" />
                        Shell
                      </Button>
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => navigate(`/instances/${n.instanceId}/nodes/${n.node}`)}
                      >
                        硬件与详情
                        <ArrowUpRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="space-y-3 pt-1">
                    <ResourceBar
                      percent={n.cpu * 100}
                      label={`CPU ${formatPercent(n.cpu)}`}
                      sublabel={`${n.maxcpu} Core`}
                    />
                    <ResourceBar
                      percent={memPct}
                      label={`RAM ${memPct.toFixed(1)}%`}
                      sublabel={`${formatBytes(n.mem)} / ${formatBytes(n.maxmem)}`}
                      colorMode={memPct >= 85 ? 'auto' : 'success'}
                    />
                    <ResourceBar
                      percent={diskPct}
                      label={`RootFS ${diskPct.toFixed(1)}%`}
                      sublabel={`${formatBytes(n.disk)} / ${formatBytes(n.maxdisk)}`}
                    />
                  </div>

                  <NodeHardwarePreview
                    instanceId={n.instanceId}
                    node={n.node}
                    nodeStatus={n.status}
                    livePaused={livePaused}
                  />
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
