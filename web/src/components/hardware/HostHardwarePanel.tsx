import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Cpu,
  Gauge,
  HardDrive,
  Info,
  Package,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Thermometer,
  Zap,
  Eye,
  EyeOff,
  FileText,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { DiskHardwareItem, GPUHardwareItem } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useConsoleStore } from '@/stores/consoleStore'
import { copyToClipboard, formatBytes } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { cn } from '@/lib/utils'

interface HostHardwarePanelProps {
  instanceId: string
  node: string
  compact?: boolean
}

function fmtNum(v: number | undefined, suffix = '', digits = 1): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—'
  return `${v.toFixed(digits)}${suffix}`
}

function healthGradeMeta(grade?: string, pct?: number) {
  switch (grade) {
    case 'excellent':
      return {
        label: '优秀',
        badge: 'success' as const,
        barColor: 'bg-success',
        textColor: 'text-success',
      }
    case 'good':
      return {
        label: '良好',
        badge: 'info' as const,
        barColor: 'bg-info',
        textColor: 'text-info',
      }
    case 'warning':
      return {
        label: '需关注',
        badge: 'warning' as const,
        barColor: 'bg-warning',
        textColor: 'text-warning',
      }
    case 'critical':
      return {
        label: '高风险',
        badge: 'destructive' as const,
        barColor: 'bg-destructive',
        textColor: 'text-destructive',
      }
    default:
      return {
        label: pct !== undefined ? '正常' : '未采集',
        badge: 'muted' as const,
        barColor: 'bg-stopped',
        textColor: 'text-muted-foreground',
      }
  }
}

export function HostHardwarePanel({ instanceId, node, compact = false }: HostHardwarePanelProps) {
  const navigate = useNavigate()
  const { data: overview } = useOverviewQuery()
  const openTab = useConsoleStore((s) => s.openTab)

  const [showPassthrough, setShowPassthrough] = useState(false)
  const [smartDisk, setSmartDisk] = useState<DiskHardwareItem | null>(null)
  const [showAllPkgChecks, setShowAllPkgChecks] = useState(false)

  const instanceMeta = overview?.instances.find((i) => i.id === instanceId)

  const { data: hw, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['node-hardware', instanceId, node],
    queryFn: () => api.getNodeHardware(instanceId, node, false),
    refetchInterval: 10_000,
    staleTime: 4_000,
    enabled: Boolean(instanceId && node),
  })

  const gpus = hw?.gpus ?? []
  const disks = hw?.disks ?? []

  const hostGPUs = useMemo(() => gpus.filter((g) => !g.passthrough), [gpus])
  const ptGPUs = useMemo(() => gpus.filter((g) => g.passthrough), [gpus])
  const visibleGPUs = showPassthrough ? gpus : hostGPUs

  const hostDisks = useMemo(() => disks.filter((d) => !d.passthrough), [disks])
  const ptDisks = useMemo(() => disks.filter((d) => d.passthrough), [disks])
  const visibleDisks = showPassthrough ? disks : hostDisks

  const missingPkgs = hw?.missingPackages ?? []
  const unverifiedPkgs = useMemo(
    () => (hw?.packageChecks ?? []).filter((p) => p.status === 'unverified'),
    [hw?.packageChecks],
  )
  const smartPkgMissing = useMemo(
    () =>
      missingPkgs.some((p) => p.package === 'smartmontools') ||
      visibleDisks.some((d) => d.telemetryStatus === 'missing_pkg'),
    [missingPkgs, visibleDisks],
  )

  const handleForceRefresh = async () => {
    try {
      await api.getNodeHardware(instanceId, node, true)
      await refetch()
      toast.success('已刷新宿主机硬件状态')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '刷新失败')
    }
  }

  const handleCopyCmd = async (cmd: string) => {
    await copyToClipboard(cmd)
    toast.success('安装命令已复制到剪贴板')
  }

  const handleInstallInShell = async (cmd: string) => {
    await copyToClipboard(cmd)
    openTab({
      instanceId,
      instanceName: instanceMeta?.name || instanceId,
      instanceColor: instanceMeta?.color || '#3B82F6',
      node,
      targetType: 'node',
      title: `${node} (Shell)`,
      protocol: 'xterm',
    })
    toast.success('已复制安装命令并打开宿主机终端，直接粘贴回车即可安装')
    navigate('/console')
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        采集节点硬件状态失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !hw) {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-xl border border-border bg-card" />
        <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
      </div>
    )
  }

  if (!hw) return null

  const ptCountTotal = ptGPUs.length + ptDisks.length

  return (
    <div className="space-y-6">
      {/* Toolbar: Scope + Passthrough Filter + Refresh */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              宿主机未直通硬件状态
            </h2>
            <Badge variant="default" className="font-mono-num">
              显卡 {hostGPUs.length} · 物理硬盘 {hostDisks.length}
            </Badge>
            {ptCountTotal > 0 && (
              <Badge variant="muted" className="font-mono-num">
                已配置直通 {ptCountTotal} 项
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            聚焦当前由宿主机内核直接持有的 GPU、物理硬盘健康度 (SMART %)、CPU 与内存；已直通给 VM 的设备默认折叠，可随时切换查看。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {ptCountTotal > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPassthrough((v) => !v)}
            >
              {showPassthrough ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              <span>{showPassthrough ? '隐藏已直通设备' : `显示已直通设备 (${ptCountTotal})`}</span>
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={handleForceRefresh} disabled={isFetching}>
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            <span>刷新硬件</span>
          </Button>
        </div>
      </div>

      {/* Package & Telemetry Diagnostics Banner */}
      {missingPkgs.length > 0 ? (
        <Card className="border-warning/45 bg-warning/[0.06]">
          <CardContent className="p-5 space-y-3.5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="text-base font-semibold text-foreground">
                    检测到宿主机缺少 {missingPkgs.length} 个硬件监测软件包（已自动降级展示基础信息）
                  </div>
                  <p className="text-sm text-muted-foreground">
                    缺失软件包不会影响 PVE 正常运行与基础硬件列表展示；安装以下 Debian/PVE 官方轻量工具包后即可解锁完整实时遥测：
                  </p>
                </div>
              </div>
              {hw.installAllCmd && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="warning" size="sm" onClick={() => handleCopyCmd(hw.installAllCmd!)}>
                    <Copy className="h-4 w-4" />
                    复制一键安装命令
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => handleInstallInShell(hw.installAllCmd!)}>
                    <Terminal className="h-4 w-4" />
                    复制并打开宿主机终端
                  </Button>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
              {missingPkgs.map((p) => (
                <div
                  key={p.package}
                  className="flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-background/70 px-3.5 py-2.5"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="flex items-center gap-2">
                      <code className="font-mono-num text-sm font-semibold text-warning">{p.package}</code>
                      <span className="font-mono-num text-xs text-muted-foreground">({p.command})</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{p.reason}</p>
                  </div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="shrink-0"
                    onClick={() => handleCopyCmd(p.installCmd)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    复制
                  </Button>
                </div>
              ))}
            </div>

            {hw.installAllCmd && (
              <div className="rounded-lg border border-border bg-console-bg px-3.5 py-2.5 font-mono-num text-xs text-slate-200 overflow-x-auto">
                $ {hw.installAllCmd}
              </div>
            )}
          </CardContent>
        </Card>
      ) : !hw.sshTelemetryEnabled && unverifiedPkgs.length > 0 ? (
        <Card className="border-info/35 bg-info/[0.05]">
          <CardContent className="p-4 sm:p-5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <Info className="h-5 w-5 text-accent shrink-0 mt-0.5" />
              <div className="space-y-1 text-sm">
                <div className="font-semibold text-foreground">
                  {hw.sshError
                    ? `宿主机 SSH 遥测探针连接失败 (${hw.sshHost}) · 已降级为原生 PVE API 模式`
                    : '当前为原生 PVE API 模式 · 显卡实时负载与软件包检测需配置免密 SSH'}
                </div>
                <p className="text-muted-foreground text-xs sm:text-sm">
                  {hw.sshError
                    ? `错误：${hw.sshError}。基础 PCI 显卡清单与硬盘 SMART 健康度仍可正常展示。`
                    : `当前已通过原生 PVE API 采集 PCI 显卡清单、硬盘容量与 SMART；如需采集 GPU 实时频率/占用/功耗及自动检测 ${unverifiedPkgs.map((p) => p.package).join('、')}，请在「实例连接管理」填写免密 SSH 主机别名。`}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => navigate('/instances')}>
              <Terminal className="h-4 w-4" />
              配置 SSH 遥测
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="surface-card flex flex-wrap items-center justify-between gap-3 border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2.5 text-sm">
            <ShieldCheck className="h-4.5 w-4.5 text-success shrink-0" />
            <span className="font-medium text-foreground">宿主机硬件监测包全部就绪</span>
            {hw.sshHost && (
              <Badge variant="muted" className="font-mono-num">
                SSH 实时探针: {hw.sshHost}
              </Badge>
            )}
          </div>
          <button
            type="button"
            onClick={() => setShowAllPkgChecks((v) => !v)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <Package className="h-3.5 w-3.5" />
            <span>{showAllPkgChecks ? '收起依赖与降级说明' : `查看 ${hw.packageChecks.length} 项工具与降级机制`}</span>
          </button>
        </div>
      )}

      {showAllPkgChecks && hw.packageChecks.length > 0 && (
        <Card>
          <CardContent className="p-4 space-y-3.5">
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
              {hw.packageChecks.map((p) => (
                <div
                  key={p.package}
                  className="flex flex-col justify-between gap-2 rounded-lg border border-border bg-background/60 px-3.5 py-3 text-xs"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-mono-num font-semibold text-foreground truncate">{p.package}</div>
                      <div className="font-mono-num text-[11px] text-muted-foreground truncate">命令: {p.command}</div>
                    </div>
                    {p.status === 'installed' ? (
                      <Badge variant="success">
                        <CheckCircle2 className="h-3 w-3" />
                        已安装
                      </Badge>
                    ) : p.status === 'missing' ? (
                      <Badge variant="warning">缺失</Badge>
                    ) : (
                      <Badge variant="muted">未探测</Badge>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">{p.reason}</p>
                  <div className="flex items-center justify-between gap-1 pt-1 border-t border-border/60">
                    <code className="font-mono-num text-[10px] text-muted-foreground truncate">{p.installCmd}</code>
                    <button
                      type="button"
                      onClick={() => handleCopyCmd(p.installCmd)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground shrink-0"
                      title="复制安装命令"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-lg border border-border/80 bg-muted/35 px-3.5 py-2.5 text-xs text-muted-foreground leading-relaxed">
              <strong className="text-foreground">缺包自动降级保障：</strong>
              若某台新接入的 PVE 宿主机未安装上述软件包，界面不会报错或空白——① 仍通过原生 PVE API 正常展示 PCI 显卡清单、直通归属、硬盘容量与 CPU/内存；② 显卡在无 <code className="font-mono-num text-foreground">intel-gpu-tools</code> 时仍尝试通过 Linux <code className="font-mono-num text-foreground">drm sysfs</code> 读取基础频率；③ 顶部与对应硬件区块会自动标出缺失包并提供一键复制/直达宿主机终端安装。
            </div>
          </CardContent>
        </Card>
      )}

      {/* Section 1: Non-Passthrough GPU Cards */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Gauge className="h-4.5 w-4.5 text-accent" />
            <span>显卡 (GPU)</span>
            <span className="font-mono-num text-sm font-normal text-muted-foreground">
              {visibleGPUs.length} 台
            </span>
          </h3>
        </div>

        {visibleGPUs.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              {gpus.length === 0
                ? '此宿主机节点未检测到 PCI 显卡设备。'
                : '所有检测到的显卡均已配置 PCI 直通（点击右上角「显示已直通设备」查看绑定详情）。'}
            </CardContent>
          </Card>
        ) : (
          <div
            className={cn(
              'grid grid-cols-1 gap-4',
              visibleGPUs.length > 1 && 'xl:grid-cols-2',
            )}
          >
            {visibleGPUs.map((gpu) => (
              <GPUCard
                key={gpu.id}
                gpu={gpu}
                onCopyCmd={handleCopyCmd}
                onInstallInShell={handleInstallInShell}
              />
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Non-Passthrough Physical Disks & Detailed SMART Health % */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <HardDrive className="h-4.5 w-4.5 text-accent" />
            <span>物理硬盘与 SMART 健康度</span>
            <span className="font-mono-num text-sm font-normal text-muted-foreground">
              {visibleDisks.length} 块{ptDisks.length > 0 && !showPassthrough ? `（已隐藏 ${ptDisks.length} 块直通盘）` : ''}
            </span>
          </h3>
          {smartPkgMissing && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => handleInstallInShell('apt update && apt install -y smartmontools nvme-cli')}
            >
              <Terminal className="h-3.5 w-3.5 text-warning" />
              安装 smartmontools 解锁健康度
            </Button>
          )}
        </div>

        {visibleDisks.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">
              暂无宿主机持有的物理硬盘。
            </CardContent>
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">设备 / 型号</th>
                    <th className="px-3 py-3 font-medium">类型 / 容量</th>
                    <th className="px-3 py-3 font-medium">归属与用途</th>
                    <th className="px-3 py-3 font-medium">温度</th>
                    <th className="px-3 py-3 font-medium min-w-[205px]">健康度与寿命 (%)</th>
                    <th className="px-3 py-3 font-medium">通电 / 读写</th>
                    <th className="px-4 py-3 font-medium text-right">SMART</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {visibleDisks.map((d) => {
                    const tempHot = d.tempC !== undefined && d.tempC >= 60
                    const tempCrit = d.tempC !== undefined && d.tempC >= 72
                    const gm = healthGradeMeta(d.healthGrade, d.healthPct)
                    const errCount = (d.mediaErrors ?? 0) + (d.reallocatedSectors ?? 0) + (d.pendingSectors ?? 0)

                    return (
                      <tr key={d.devpath} className="hover:bg-muted/35 transition-colors">
                        <td className="px-4 py-3.5">
                          <div className="font-medium text-foreground">{d.model || d.devpath}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono-num text-xs text-muted-foreground">
                            <span>{d.devpath}</span>
                            {d.serial && <span>SN: {d.serial}</span>}
                          </div>
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap">
                          <div className="font-mono-num font-semibold text-foreground">
                            {formatBytes(d.size, 1)}
                          </div>
                          <div className="mt-0.5 text-xs uppercase font-mono-num text-muted-foreground">
                            {d.type || 'disk'}
                            {d.rpm ? ` · ${d.rpm} RPM` : ''}
                          </div>
                        </td>
                        <td className="px-3 py-3.5">
                          {d.passthrough ? (
                            <div className="space-y-1">
                              <Badge variant={d.passthroughActive ? 'warning' : 'muted'}>
                                {d.passthroughType === 'pci' ? 'PCI 直通' : '磁盘直通'}
                                {d.passthroughActive ? ' (使用中)' : ' (未运行)'}
                              </Badge>
                              <div className="text-xs font-mono-num text-muted-foreground">
                                {d.passthroughGuests
                                  .map((g) => `#${g.vmid} ${g.name}`)
                                  .join(', ')}
                              </div>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge variant="success">宿主机持有</Badge>
                              {d.used && <Badge variant="muted">{d.used}</Badge>}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap font-mono-num">
                          {d.tempC !== undefined ? (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 font-semibold',
                                tempCrit
                                  ? 'text-destructive'
                                  : tempHot
                                    ? 'text-warning'
                                    : 'text-foreground',
                              )}
                            >
                              <Thermometer className="h-3.5 w-3.5 opacity-75" />
                              {d.tempC.toFixed(0)}°C
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3.5 min-w-[205px]">
                          {d.healthPct !== undefined ? (
                            <div className="space-y-1.5">
                              <div className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span className={cn('font-mono-num text-sm font-bold', gm.textColor)}>
                                    {d.healthPct}%
                                  </span>
                                  <Badge variant={gm.badge} className="text-[11px] px-1.5 py-0">
                                    {gm.label}
                                  </Badge>
                                </div>
                                {d.availableSparePct !== undefined && (
                                  <span className="font-mono-num text-[11px] text-muted-foreground">
                                    备用 {d.availableSparePct}%
                                  </span>
                                )}
                              </div>
                              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className={cn('h-full rounded-full transition-all duration-300', gm.barColor)}
                                  style={{ width: `${Math.max(4, Math.min(100, d.healthPct))}%` }}
                                />
                              </div>
                              <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-mono-num text-muted-foreground">
                                {d.usedLifePct !== undefined && <span>已损耗 {d.usedLifePct}%</span>}
                                <span className={errCount > 0 ? 'text-destructive font-medium' : ''}>
                                  错误 {errCount}
                                </span>
                                {d.health && <span>SMART {d.health}</span>}
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <Badge variant={d.telemetryStatus === 'missing_pkg' ? 'warning' : 'muted'}>
                                {d.telemetryStatus === 'missing_pkg' ? '缺 smartmontools' : '无 SMART 数据'}
                              </Badge>
                              {d.telemetryNote && (
                                <div className="text-[11px] text-muted-foreground max-w-[220px] leading-snug">
                                  {d.telemetryNote}
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap font-mono-num text-xs">
                          <div className="text-foreground">
                            {d.powerOnHours !== undefined ? `${d.powerOnHours.toLocaleString()} h` : '—'}
                          </div>
                          {d.dataWritten && (
                            <div className="text-muted-foreground">写 {d.dataWritten}</div>
                          )}
                          {d.dataRead && (
                            <div className="text-[11px] text-muted-foreground/80">读 {d.dataRead}</div>
                          )}
                        </td>
                        <td className="px-4 py-3.5 text-right whitespace-nowrap">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={!d.smartText && d.healthPct === undefined}
                            onClick={() => setSmartDisk(d)}
                          >
                            <FileText className="h-3.5 w-3.5" />
                            详情
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </section>

      {/* Section 3: CPU & Extra Host Sensors (when not compact) */}
      {!compact && (
        <section className="space-y-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-foreground">
            <Cpu className="h-4.5 w-4.5 text-accent" />
            <span>CPU 与主板/NVMe 实时传感器</span>
            {hw.cpu.governor && (
              <Badge variant="muted" className="font-mono-num">
                调速策略: {hw.cpu.governor} · {hw.cpu.curMhz.toFixed(0)} MHz
              </Badge>
            )}
          </h3>

          {hw.sensors.length === 0 ? (
            <Card>
              <CardContent className="p-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
                <div className="flex items-center gap-2.5">
                  <ShieldAlert className="h-4.5 w-4.5 text-warning shrink-0" />
                  <span>
                    未检测到宿主机温度/功耗传感器读数（需在宿主机安装 <code className="font-mono-num text-foreground">lm-sensors</code> 并启用 SSH 探针或传感器扩展）。
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => handleInstallInShell('apt update && apt install -y lm-sensors && sensors-detect --auto')}
                >
                  <Terminal className="h-3.5 w-3.5" />
                  复制并在终端安装 lm-sensors
                </Button>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {hw.sensors.map((s) => {
                const isHot = s.unit === '°C' && s.value >= 75
                return (
                  <Card key={s.label}>
                    <CardContent className="p-4 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-xs text-muted-foreground truncate">{s.label}</div>
                        <div
                          className={cn(
                            'font-mono-num text-xl font-bold mt-1',
                            isHot ? 'text-destructive' : 'text-foreground',
                          )}
                        >
                          {s.value.toFixed(1)}
                          <span className="ml-1 text-sm font-normal text-muted-foreground">{s.unit}</span>
                        </div>
                      </div>
                      {s.unit === 'W' ? (
                        <Zap className="h-5 w-5 text-warning shrink-0" />
                      ) : (
                        <Thermometer
                          className={cn('h-5 w-5 shrink-0', isHot ? 'text-destructive' : 'text-accent')}
                        />
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </section>
      )}

      {/* Structured SMART Health Report Dialog */}
      <Dialog open={Boolean(smartDisk)} onOpenChange={(o) => !o && setSmartDisk(null)}>
        <DialogContent className="w-[min(95vw,760px)]">
          <DialogHeader>
            <DialogTitle className="font-mono-num">
              SMART 健康报告 · {smartDisk?.devpath} ({smartDisk?.model})
            </DialogTitle>
            <DialogDescription>
              序列号: {smartDisk?.serial || '—'} · 协议类型: {(smartDisk?.type || 'disk').toUpperCase()} · SMART 状态: {smartDisk?.health || '—'}
            </DialogDescription>
          </DialogHeader>

          {smartDisk && (
            <div className="space-y-4">
              {/* Top Health Score Banner */}
              {smartDisk.healthPct !== undefined && (() => {
                const gm = healthGradeMeta(smartDisk.healthGrade, smartDisk.healthPct)
                return (
                  <div className="rounded-lg border border-border bg-muted/35 p-4 space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5">
                        <span className="text-xs font-medium text-muted-foreground">综合健康评分</span>
                        <span className={cn('font-mono-num text-2xl font-bold', gm.textColor)}>
                          {smartDisk.healthPct}%
                        </span>
                        <Badge variant={gm.badge}>{gm.label}</Badge>
                      </div>
                      {smartDisk.wearoutPct !== undefined && (
                        <span className="font-mono-num text-xs text-muted-foreground">
                          剩余寿命 {smartDisk.wearoutPct}% · 已损耗 {smartDisk.usedLifePct ?? (100 - smartDisk.wearoutPct)}%
                        </span>
                      )}
                    </div>
                    <div className="h-2 w-full overflow-hidden rounded-full bg-background/80">
                      <div
                        className={cn('h-full rounded-full', gm.barColor)}
                        style={{ width: `${Math.max(4, smartDisk.healthPct)}%` }}
                      />
                    </div>
                    {(smartDisk.healthReasons?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {smartDisk.healthReasons!.map((r) => (
                          <span
                            key={r}
                            className="rounded border border-border bg-background/70 px-2 py-0.5 text-[11px] text-muted-foreground"
                          >
                            {r}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* Key Structured SMART Metrics Grid */}
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">可用备用块 / 阈值</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {smartDisk.availableSparePct !== undefined
                      ? `${smartDisk.availableSparePct}%${smartDisk.availableSpareThresholdPct !== undefined ? ` / ${smartDisk.availableSpareThresholdPct}%` : ''}`
                      : '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">当前温度</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {smartDisk.tempC !== undefined ? `${smartDisk.tempC.toFixed(0)}°C` : '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">累计通电 / 开关机</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {smartDisk.powerOnHours !== undefined ? `${smartDisk.powerOnHours.toLocaleString()} h` : '—'}
                    {smartDisk.powerCycles !== undefined ? ` · ${smartDisk.powerCycles}次` : ''}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">异常断电 (Unsafe)</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {smartDisk.unsafeShutdowns !== undefined ? `${smartDisk.unsafeShutdowns} 次` : '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">累计主机写入</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {smartDisk.dataWritten || '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">累计主机读取</div>
                  <div className="mt-1 font-mono-num text-sm font-semibold text-foreground">
                    {smartDisk.dataRead || '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">介质 / 坏道错误</div>
                  <div
                    className={cn(
                      'mt-1 font-mono-num text-sm font-semibold',
                      ((smartDisk.mediaErrors ?? 0) + (smartDisk.reallocatedSectors ?? 0) + (smartDisk.pendingSectors ?? 0)) > 0
                        ? 'text-destructive'
                        : 'text-success',
                    )}
                  >
                    {(smartDisk.mediaErrors ?? 0) + (smartDisk.reallocatedSectors ?? 0) + (smartDisk.pendingSectors ?? 0)}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-[11px] text-muted-foreground">关键告警标志</div>
                  <div
                    className={cn(
                      'mt-1 font-mono-num text-sm font-semibold',
                      smartDisk.criticalWarning ? 'text-destructive' : 'text-success',
                    )}
                  >
                    {smartDisk.criticalWarning !== undefined
                      ? smartDisk.criticalWarning === 0
                        ? '0x00 (正常)'
                        : `0x${smartDisk.criticalWarning.toString(16)}`
                      : '—'}
                  </div>
                </div>
              </div>

              {/* Raw SMART Output */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>原始 SMART 诊断输出</span>
                  {smartDisk.smartText && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => handleCopyCmd(smartDisk.smartText!)}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制原始报告
                    </Button>
                  )}
                </div>
                <pre className="max-h-[38vh] overflow-auto rounded-lg border border-border bg-console-bg p-3.5 font-mono-num text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
                  {smartDisk.smartText || '无原始 SMART 输出'}
                </pre>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function GPUCard({
  gpu,
  onCopyCmd,
  onInstallInShell,
}: {
  gpu: GPUHardwareItem
  onCopyCmd: (cmd: string) => void
  onInstallInShell: (cmd: string) => void
}) {
  const vendorLabel =
    gpu.vendor === 'intel'
      ? 'Intel'
      : gpu.vendor === 'nvidia'
        ? 'NVIDIA'
        : gpu.vendor === 'amd'
          ? 'AMD'
          : gpu.vendorName

  const freqPct =
    gpu.curFreqMhz !== undefined && gpu.maxFreqMhz && gpu.maxFreqMhz > 0
      ? (gpu.curFreqMhz / gpu.maxFreqMhz) * 100
      : undefined

  return (
    <Card className={cn(gpu.passthroughActive && 'opacity-80')}>
      <CardHeader className="pb-3.5">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="accent" className="font-mono-num">
              {vendorLabel}
            </Badge>
            <CardTitle className="truncate">{gpu.model}</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2.5 font-mono-num text-xs text-muted-foreground">
            <span>PCI {gpu.id}</span>
            <span>· IOMMU Group {gpu.iommuGroup}</span>
            {gpu.driver && <span>· 驱动 {gpu.driver}</span>}
            {gpu.sriovCapable && <span>· SR-IOV/mdev</span>}
          </div>
        </div>

        <div className="flex flex-col items-end gap-1 shrink-0">
          {gpu.passthrough ? (
            <Badge variant={gpu.passthroughActive ? 'warning' : 'muted'}>
              {gpu.passthroughActive ? '直通运行中' : '已绑定直通 (未启动)'}
            </Badge>
          ) : (
            <Badge variant="success">宿主机持有 (未直通)</Badge>
          )}
          {gpu.telemetrySource && (
            <span className="font-mono-num text-xs text-muted-foreground">{gpu.telemetrySource}</span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {gpu.passthroughGuests.length > 0 && (
          <div className="text-xs text-muted-foreground">
            直通绑定 VM：{' '}
            <span className="font-mono-num text-foreground">
              {gpu.passthroughGuests.map((g) => `#${g.vmid} ${g.name}`).join(', ')}
            </span>
          </div>
        )}

        {gpu.sharedLxcGuests.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">LXC 硬件解码共享 (/dev/dri):</span>
            {gpu.sharedLxcGuests.map((g) => (
              <Badge key={g.vmid} variant="default" className="font-mono-num">
                #{g.vmid} {g.name}
              </Badge>
            ))}
          </div>
        )}

        {gpu.telemetryAvailable ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {gpu.curFreqMhz !== undefined && (
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs text-muted-foreground">核心频率</div>
                  <div className="mt-1 font-mono-num text-base font-bold text-foreground">
                    {gpu.curFreqMhz.toFixed(0)}
                    <span className="text-xs font-normal text-muted-foreground">
                      {gpu.maxFreqMhz ? ` / ${gpu.maxFreqMhz.toFixed(0)} MHz` : ' MHz'}
                    </span>
                  </div>
                </div>
              )}

              {gpu.powerW !== undefined && (
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs text-muted-foreground">GPU 功耗</div>
                  <div className="mt-1 font-mono-num text-base font-bold text-foreground">
                    {gpu.powerW.toFixed(2)} <span className="text-xs font-normal text-muted-foreground">W</span>
                  </div>
                </div>
              )}

              {gpu.tempC !== undefined && (
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs text-muted-foreground">核心温度</div>
                  <div className="mt-1 font-mono-num text-base font-bold text-foreground">
                    {gpu.tempC.toFixed(0)} <span className="text-xs font-normal text-muted-foreground">°C</span>
                  </div>
                </div>
              )}

              {gpu.rc6Pct !== undefined && (
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs text-muted-foreground">RC6 节能占比</div>
                  <div className="mt-1 font-mono-num text-base font-bold text-success">
                    {gpu.rc6Pct.toFixed(1)}%
                  </div>
                </div>
              )}

              {gpu.vramTotalMb !== undefined && gpu.vramTotalMb > 0 && (
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs text-muted-foreground">显存使用</div>
                  <div className="mt-1 font-mono-num text-base font-bold text-foreground">
                    {(gpu.vramUsedMb ?? 0).toFixed(0)} / {gpu.vramTotalMb.toFixed(0)} MiB
                  </div>
                </div>
              )}

              {gpu.activeClients !== undefined && gpu.activeClients > 0 && (
                <div className="rounded-lg border border-border bg-background/60 p-3">
                  <div className="text-xs text-muted-foreground">活跃渲染进程</div>
                  <div className="mt-1 font-mono-num text-base font-bold text-foreground">
                    {gpu.activeClients} 个
                  </div>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {gpu.renderBusyPct !== undefined && (
                <ResourceBar
                  percent={gpu.renderBusyPct}
                  label="Render / 3D 负载"
                  sublabel={fmtNum(gpu.renderBusyPct, '%')}
                />
              )}
              {gpu.videoBusyPct !== undefined && (
                <ResourceBar
                  percent={gpu.videoBusyPct}
                  label="Video 编解码负载"
                  sublabel={fmtNum(gpu.videoBusyPct, '%')}
                  colorMode="success"
                />
              )}
              {gpu.blitterBusyPct !== undefined && (
                <ResourceBar
                  percent={gpu.blitterBusyPct}
                  label="Blitter 引擎"
                  sublabel={fmtNum(gpu.blitterBusyPct, '%')}
                />
              )}
              {freqPct !== undefined && (
                <ResourceBar
                  percent={freqPct}
                  label="频率占比"
                  sublabel={`${gpu.curFreqMhz?.toFixed(0)} / ${gpu.maxFreqMhz?.toFixed(0)} MHz`}
                />
              )}
            </div>

            {/* Partial sysfs fallback notice if vendor CLI tool is missing */}
            {gpu.missingPackage && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/35 bg-warning/[0.06] px-3.5 py-2.5 text-xs text-muted-foreground">
                <span>
                  当前通过内核 sysfs 降级展示基础指标；安装{' '}
                  <code className="font-mono-num text-warning font-semibold">{gpu.missingPackage}</code>{' '}
                  后可解锁引擎占用率、功耗与详细负载。
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onCopyCmd(`apt update && apt install -y ${gpu.missingPackage}`)}
                  >
                    <Copy className="h-3 w-3" />
                    复制命令
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => onInstallInShell(`apt update && apt install -y ${gpu.missingPackage}`)}
                  >
                    <Terminal className="h-3 w-3" />
                    打开终端安装
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : !gpu.passthroughActive ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-xs text-muted-foreground">
            <span>
              暂无实时显卡频率/负载数据（需启用 SSH 遥测并在宿主机安装{' '}
              <code className="font-mono-num text-foreground font-medium">
                {gpu.missingPackage || 'gpu-tools'}
              </code>
              ）
            </span>
            {gpu.missingPackage && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onCopyCmd(`apt update && apt install -y ${gpu.missingPackage}`)}
                >
                  <Copy className="h-3 w-3" />
                  复制命令
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  onClick={() => onInstallInShell(`apt update && apt install -y ${gpu.missingPackage}`)}
                >
                  <Terminal className="h-3 w-3" />
                  打开终端安装
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="text-xs text-muted-foreground">
            该显卡正由虚拟机通过 VFIO 独占直通，宿主机侧无法读取其内部运行指标。
          </div>
        )}
      </CardContent>
    </Card>
  )
}
