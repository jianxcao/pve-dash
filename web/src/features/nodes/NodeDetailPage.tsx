import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Activity,
  ArrowLeft,
  Box,
  Cog,
  Cpu,
  FileTerminal,
  Gauge,
  HardDrive,
  Monitor,
  Package,
  Power,
  RefreshCw,
  RotateCcw,
  Server,
  Terminal,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { useConsoleStore } from '@/stores/consoleStore'
import { formatBytes, formatPercent, formatUptime } from '@/lib/format'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { RrdMetricPanel } from '@/components/charts/RrdMetricPanel'
import { HostHardwarePanel } from '@/components/hardware/HostHardwarePanel'
import { NodeAPTTab, NodeServicesTab, NodeSyslogTab } from './NodeOpsPanel'
import { cn } from '@/lib/utils'

export function NodeDetailPage() {
  const { instanceId = '', node = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const { data: overview } = useOverviewQuery()
  const openTab = useConsoleStore((s) => s.openTab)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const [powerDialog, setPowerDialog] = useState<'reboot' | 'shutdown' | null>(null)

  const activeTab = searchParams.get('tab') || 'hardware'

  const instanceSnap = overview?.instances.find((i) => i.id === instanceId)
  const instanceName = instanceSnap?.name || instanceId
  const instanceColor = instanceSnap?.color || '#38BDF8'

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['node-status', instanceId, node],
    queryFn: () => api.getNodeStatus(instanceId, node),
    refetchInterval: 5000,
    enabled: Boolean(instanceId && node),
  })

  const nodeGuests = useMemo(
    () => (overview?.guests ?? []).filter((g) => g.instanceId === instanceId && g.node === node),
    [overview?.guests, instanceId, node],
  )

  const nodeStorages = useMemo(
    () => (overview?.storages ?? []).filter((s) => s.instanceId === instanceId && s.node === node),
    [overview?.storages, instanceId, node],
  )

  const st = data?.status
  const memPct = st && st.memory.total > 0 ? (st.memory.used / st.memory.total) * 100 : 0
  const swapPct = st && st.swap.total > 0 ? (st.swap.used / st.swap.total) * 100 : 0
  const rootPct = st && st.rootfs.total > 0 ? (st.rootfs.used / st.rootfs.total) * 100 : 0

  const openNodeConsole = (protocol: 'xterm' | 'vnc') => {
    openTab({
      instanceId,
      instanceName,
      instanceColor,
      node,
      targetType: 'node',
      title: `${node} (${protocol === 'xterm' ? 'Shell' : 'VNC'})`,
      protocol,
    })
    navigate('/console')
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      {/* Node Header */}
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <Button variant="outline" size="icon" onClick={() => navigate('/nodes')} aria-label="返回节点列表">
              <ArrowLeft className="h-4.5 w-4.5" />
            </Button>
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <Server className="h-5 w-5 text-accent" />
                <h1 className="font-mono-num text-2xl font-bold tracking-tight">{node}</h1>
                <StatusBadge status={st ? 'online' : 'unknown'} />
                {st?.pveversion && (
                  <Badge variant="muted" className="font-mono-num">
                    {st.pveversion.split('/')[0]} {st.pveversion.split('/')[1] || ''}
                  </Badge>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: instanceColor }} />
                  {instanceName}
                </span>
                {st && (
                  <>
                    <span className="font-mono-num">运行 {formatUptime(st.uptime)}</span>
                    <span className="font-mono-num">
                      LoadAvg: {st.loadavg?.join(' / ') || '—'}
                    </span>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="default" size="sm" onClick={() => openNodeConsole('xterm')}>
              <Terminal className="h-4 w-4" />
              宿主机 Shell
            </Button>
            <Button variant="outline" size="sm" onClick={() => openNodeConsole('vnc')}>
              <Monitor className="h-4 w-4" />
              VNC Shell
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              title={readOnly ? '写保护已开启，请先解锁' : undefined}
              onClick={() => setPowerDialog('reboot')}
            >
              <RotateCcw className="h-4 w-4 text-warning" />
              重启节点
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly}
              title={readOnly ? '写保护已开启，请先解锁' : undefined}
              onClick={() => setPowerDialog('shutdown')}
            >
              <Power className="h-4 w-4 text-destructive" />
              关闭节点
            </Button>
            <Button variant="ghost" size="icon" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </Button>
          </div>
        </div>
      </Card>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
          获取节点状态失败：{error instanceof Error ? error.message : '未知错误'}
        </div>
      ) : isLoading && !st ? (
        <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
      ) : st ? (
        <>
          {/* Core CPU / RAM / RootFS / Kernel KPIs */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>CPU 使用率</span>
                  <Cpu className="h-4.5 w-4.5 text-accent" />
                </div>
                <div className="font-mono-num text-3xl font-bold tracking-tight">
                  {formatPercent(st.cpu)}
                </div>
                <ResourceBar
                  percent={st.cpu * 100}
                  sublabel={`${st.cpuinfo.cpus} 线程 (${st.cpuinfo.sockets}×${st.cpuinfo.cores}C) · Wait ${formatPercent(st.wait)}`}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>物理内存</span>
                  <Activity className="h-4.5 w-4.5 text-success" />
                </div>
                <div className="font-mono-num text-3xl font-bold tracking-tight">
                  {formatBytes(st.memory.used)}
                </div>
                <ResourceBar
                  percent={memPct}
                  sublabel={`共 ${formatBytes(st.memory.total)} (${memPct.toFixed(1)}%)`}
                  colorMode={memPct >= 85 ? 'auto' : 'success'}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-3">
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>系统根分区 (RootFS)</span>
                  <HardDrive className="h-4.5 w-4.5 text-warning" />
                </div>
                <div className="font-mono-num text-3xl font-bold tracking-tight">
                  {formatBytes(st.rootfs.used)}
                </div>
                <ResourceBar
                  percent={rootPct}
                  sublabel={`共 ${formatBytes(st.rootfs.total)} · Swap ${swapPct.toFixed(0)}%`}
                />
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-5 space-y-2 text-sm">
                <span className="text-muted-foreground">处理器与内核</span>
                <div className="font-semibold text-foreground leading-snug" title={st.cpuinfo.model}>
                  {st.cpuinfo.model || 'Unknown CPU'}
                </div>
                <div className="font-mono-num text-xs text-muted-foreground truncate" title={st.kversion}>
                  Kernel {st['current-kernel']?.release || st.kversion}
                </div>
              </CardContent>
            </Card>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}
          >
            <TabsList>
              <TabsTrigger value="hardware">
                <Gauge className="h-4 w-4" />
                未直通硬件 (GPU / 硬盘 / 传感器)
              </TabsTrigger>
              <TabsTrigger value="rrd">
                <Activity className="h-4 w-4" />
                RRD 历史性能
              </TabsTrigger>
              <TabsTrigger value="guests">
                <Cpu className="h-4 w-4" />
                计算实例 ({nodeGuests.length})
              </TabsTrigger>
              <TabsTrigger value="storages">
                <HardDrive className="h-4 w-4" />
                存储池 ({nodeStorages.length})
              </TabsTrigger>
              <TabsTrigger value="services">
                <Cog className="h-4 w-4" />
                系统服务
              </TabsTrigger>
              <TabsTrigger value="syslog">
                <FileTerminal className="h-4 w-4" />
                系统日志
              </TabsTrigger>
              <TabsTrigger value="apt">
                <Package className="h-4 w-4" />
                APT 更新与源
              </TabsTrigger>
            </TabsList>

            <TabsContent value="hardware">
              <HostHardwarePanel instanceId={instanceId} node={node} />
            </TabsContent>

            <TabsContent value="rrd">
              <RrdMetricPanel mode="node" instanceId={instanceId} node={node} />
            </TabsContent>

            <TabsContent value="guests">
              <Card className="overflow-hidden">
                {nodeGuests.length === 0 ? (
                  <div className="px-5 py-12 text-center text-sm text-muted-foreground">
                    当前节点暂无 VM 或 LXC 容器
                  </div>
                ) : (
                  <div className="divide-y divide-border/70 text-sm">
                    {nodeGuests.map((g) => (
                      <div
                        key={g.urn}
                        className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 hover:bg-muted/40"
                      >
                        <button
                          type="button"
                          onClick={() =>
                            navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                          }
                          className="flex items-center gap-2.5 text-left min-w-0"
                        >
                          {g.type === 'lxc' ? (
                            <Box className="h-4.5 w-4.5 text-success shrink-0" />
                          ) : (
                            <Monitor className="h-4.5 w-4.5 text-accent shrink-0" />
                          )}
                          <span className="font-mono-num font-semibold text-muted-foreground">
                            #{g.vmid}
                          </span>
                          <span className="font-medium text-foreground truncate">{g.name}</span>
                          <Badge variant={g.type === 'lxc' ? 'success' : 'accent'}>
                            {g.type.toUpperCase()}
                          </Badge>
                        </button>
                        <div className="flex items-center gap-4">
                          <span className="font-mono-num text-xs text-muted-foreground">
                            CPU {formatPercent(g.cpu)} · RAM {formatBytes(g.mem, 1)}
                          </span>
                          <StatusBadge status={g.status} template={g.template} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </TabsContent>

            <TabsContent value="storages">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {nodeStorages.map((s) => {
                  const pct = s.maxdisk > 0 ? (s.disk / s.maxdisk) * 100 : 0
                  return (
                    <Card
                      key={s.urn}
                      className="cursor-pointer transition-colors hover:border-border-strong"
                      onClick={() =>
                        navigate(
                          `/storage?instanceId=${encodeURIComponent(s.instanceId)}&node=${encodeURIComponent(s.node)}&storage=${encodeURIComponent(s.storage)}`,
                        )
                      }
                    >
                      <CardContent className="p-5 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono-num text-base font-semibold">{s.storage}</span>
                          <Badge variant="muted" className="font-mono-num">
                            {s.pluginType}
                          </Badge>
                        </div>
                        <ResourceBar
                          percent={pct}
                          label={`${pct.toFixed(1)}%`}
                          sublabel={`${formatBytes(s.disk)} / ${formatBytes(s.maxdisk)}`}
                        />
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {s.content.slice(0, 4).map((c) => (
                            <Badge key={c} variant="muted">
                              {c}
                            </Badge>
                          ))}
                          {s.content.length > 4 && (
                            <Badge variant="muted">+{s.content.length - 4}</Badge>
                          )}
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </TabsContent>

            <TabsContent value="services">
              <NodeServicesTab
                instanceId={instanceId}
                instanceName={instanceName}
                instanceColor={instanceColor}
                node={node}
              />
            </TabsContent>

            <TabsContent value="syslog">
              <NodeSyslogTab
                instanceId={instanceId}
                instanceName={instanceName}
                instanceColor={instanceColor}
                node={node}
              />
            </TabsContent>

            <TabsContent value="apt">
              <NodeAPTTab
                instanceId={instanceId}
                instanceName={instanceName}
                instanceColor={instanceColor}
                node={node}
              />
            </TabsContent>
          </Tabs>
        </>
      ) : null}

      <DangerConfirmDialog
        open={Boolean(powerDialog)}
        onOpenChange={(open) => {
          if (!open) setPowerDialog(null)
        }}
        title={powerDialog === 'reboot' ? `重启宿主机节点 ${node}` : `关闭宿主机节点 ${node}`}
        description="警告：此操作将直接影响该宿主机节点上运行的全部虚拟机与 LXC 容器！请务必谨慎确认。"
        confirmTarget={node}
        confirmLabel={powerDialog === 'reboot' ? '确认重启节点' : '确认关闭节点'}
        onConfirm={async () => {
          if (!powerDialog) return
          await api.nodePower(instanceId, node, powerDialog)
          toast.success(`已向节点 ${node} 发送 ${powerDialog} 指令`)
        }}
      />
    </div>
  )
}
