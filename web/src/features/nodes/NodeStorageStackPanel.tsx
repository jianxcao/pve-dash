import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Database,
  FolderOpen,
  HardDrive,
  Layers,
  RefreshCw,
  Server,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { ZFSVDevNode } from '@/lib/api/types'
import { formatBytes } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ResourceBar } from '@/components/shared/ResourceBar'
import { cn } from '@/lib/utils'

interface NodeStorageStackPanelProps {
  instanceId: string
  node: string
}

function zfsHealthVariant(health: string): 'success' | 'warning' | 'destructive' | 'muted' {
  switch ((health || '').toUpperCase()) {
    case 'ONLINE':
      return 'success'
    case 'DEGRADED':
      return 'warning'
    case 'FAULTED':
    case 'UNAVAIL':
    case 'OFFLINE':
      return 'destructive'
    default:
      return 'muted'
  }
}

function cephHealthVariant(health?: string): 'success' | 'warning' | 'destructive' | 'muted' {
  switch ((health || '').toUpperCase()) {
    case 'HEALTH_OK':
      return 'success'
    case 'HEALTH_WARN':
      return 'warning'
    case 'HEALTH_ERR':
      return 'destructive'
    default:
      return 'muted'
  }
}

function ZFSVDevTree({ nodes, depth = 0 }: { nodes: ZFSVDevNode[]; depth?: number }) {
  if (!nodes || nodes.length === 0) return null
  return (
    <div className={cn('space-y-1', depth > 0 && 'ml-4 border-l border-border/70 pl-3')}>
      {nodes.map((n, idx) => {
        const hasErrors = Boolean((n.read ?? 0) > 0 || (n.write ?? 0) > 0 || (n.cksum ?? 0) > 0)
        return (
          <div key={`${n.name}-${idx}`} className="space-y-1">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-background/60 px-2.5 py-1.5 text-sm">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono-num font-medium text-foreground truncate">{n.name}</span>
                {n.state && (
                  <Badge variant={zfsHealthVariant(n.state)} className="text-badge">
                    {n.state}
                  </Badge>
                )}
              </div>
              <div
                className={cn(
                  'font-mono-num text-xs',
                  hasErrors ? 'text-destructive font-semibold' : 'text-muted-foreground',
                )}
              >
                R:{n.read ?? 0} W:{n.write ?? 0} C:{n.cksum ?? 0}
              </div>
            </div>
            {n.msg && <p className="pl-2 text-xs text-warning">{n.msg}</p>}
            {n.children && n.children.length > 0 && (
              <ZFSVDevTree nodes={n.children} depth={depth + 1} />
            )}
          </div>
        )
      })}
    </div>
  )
}

export function NodeStorageStackPanel({ instanceId, node }: NodeStorageStackPanelProps) {
  const [expandedZfs, setExpandedZfs] = useState<Record<string, boolean>>({})

  useEffect(() => {
    setExpandedZfs({})
  }, [instanceId, node])

  const {
    data: disks,
    isLoading: disksLoading,
    isFetching: disksFetching,
    refetch: refetchDisks,
    error: disksError,
  } = useQuery({
    queryKey: ['node-disks-overview', instanceId, node],
    queryFn: () => api.getNodeDisksOverview(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  const {
    data: ceph,
    isLoading: cephLoading,
    isFetching: cephFetching,
    refetch: refetchCeph,
    error: cephError,
  } = useQuery({
    queryKey: ['node-ceph', instanceId, node],
    queryFn: () => api.getNodeCeph(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  const zfsPools = disks?.zfs ?? []
  const lvmVGs = disks?.lvm ?? []
  const lvmThins = disks?.lvmthin ?? []
  const directories = disks?.directories ?? []

  const refreshAll = () => {
    void refetchDisks()
    void refetchCeph()
  }

  return (
    <div className="space-y-5">
      {/* Top Summary Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="muted" className="font-mono-num">
            ZFS 池 {zfsPools.length}
          </Badge>
          <Badge variant="muted" className="font-mono-num">
            LVM 卷组 {lvmVGs.length}
          </Badge>
          <Badge variant="muted" className="font-mono-num">
            LVM-Thin {lvmThins.length}
          </Badge>
          <Badge variant="muted" className="font-mono-num">
            目录挂载 {directories.length}
          </Badge>
          {ceph && (
            <Badge variant={ceph.installed ? cephHealthVariant(ceph.health) : 'muted'}>
              Ceph: {ceph.installed ? ceph.health || '已部署' : '未部署'}
            </Badge>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          disabled={disksFetching || cephFetching}
        >
          <RefreshCw
            className={cn('h-4 w-4', (disksFetching || cephFetching) && 'animate-spin')}
          />
          刷新磁盘栈
        </Button>
      </div>

      {disks?.warnings && Object.keys(disks.warnings).length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            部分磁盘子系统采集受限（{Object.keys(disks.warnings).join('、')}）：
            {Object.values(disks.warnings).join('；')}
          </div>
        </div>
      )}

      {disksError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
          加载宿主机磁盘栈失败：{disksError instanceof Error ? disksError.message : '未知错误'}
        </div>
      ) : disksLoading && !disks ? (
        <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
      ) : (
        <>
          {/* ZFS Pools */}
          <Card>
            <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-base">
                <Database className="h-4 w-4 text-accent" />
                <span>ZFS 存储池 ({zfsPools.length})</span>
              </CardTitle>
              <span className="text-xs text-muted-foreground hidden sm:inline">
                实时采集 zpool 健康状态、碎片率、去重比与 VDEV 拓扑
              </span>
            </CardHeader>
            <CardContent className="p-4">
              {zfsPools.length === 0 ? (
                <p className="text-sm text-muted-foreground py-3">
                  当前宿主机节点未配置 ZFS 存储池。
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {zfsPools.map((pool) => {
                    const pct = pool.size > 0 ? (pool.alloc / pool.size) * 100 : 0
                    const isOpen = Boolean(expandedZfs[pool.name])
                    const hasVdevs = Boolean(pool.children && pool.children.length > 0)
                    return (
                      <div
                        key={pool.name}
                        className="rounded-xl border border-border bg-background/50 p-4 space-y-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className="font-mono-num text-base font-semibold text-foreground">
                              {pool.name}
                            </span>
                            <Badge variant={zfsHealthVariant(pool.health)}>{pool.health}</Badge>
                          </div>
                          <div className="flex items-center gap-2 font-mono-num text-xs text-muted-foreground">
                            <span>碎片 {pool.frag}%</span>
                            <span>·</span>
                            <span>去重 {Number(pool.dedup || 1).toFixed(2)}x</span>
                          </div>
                        </div>

                        <ResourceBar
                          percent={pct}
                          label={`${pct.toFixed(1)}%`}
                          sublabel={`${formatBytes(pool.alloc)} / ${formatBytes(pool.size)}（剩余 ${formatBytes(pool.free)}）`}
                        />

                        {pool.scan && (
                          <p className="text-xs text-muted-foreground leading-relaxed">
                            Scrub / Scan: {pool.scan}
                          </p>
                        )}
                        {pool.errors && !pool.errors.toLowerCase().includes('no known data errors') && (
                          <p className="text-xs text-destructive">{pool.errors}</p>
                        )}

                        {hasVdevs && (
                          <div className="pt-1">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedZfs((prev) => ({
                                  ...prev,
                                  [pool.name]: !prev[pool.name],
                                }))
                              }
                              className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                              {isOpen ? '收起 VDEV 拓扑' : '展开 VDEV 拓扑与校验错误计数'}
                            </button>
                            {isOpen && (
                              <div className="mt-2.5">
                                <ZFSVDevTree nodes={pool.children!} />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          {/* LVM & LVM-Thin Grid */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {/* LVM VGs */}
            <Card>
              <CardHeader className="py-3.5 border-b border-border/70">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers className="h-4 w-4 text-info" />
                  <span>LVM 卷组 ({lvmVGs.length})</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {lvmVGs.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-3">当前节点无 LVM 卷组。</p>
                ) : (
                  <div className="space-y-3">
                    {lvmVGs.map((vg) => {
                      const used = Math.max(0, vg.size - vg.free)
                      const pct = vg.size > 0 ? (used / vg.size) * 100 : 0
                      return (
                        <div
                          key={vg.name}
                          className="rounded-xl border border-border bg-background/50 p-3.5 space-y-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono-num font-semibold text-foreground">
                              {vg.name}
                            </span>
                            <Badge variant="muted" className="font-mono-num">
                              {vg.lvcount} LV
                            </Badge>
                          </div>
                          <ResourceBar
                            percent={pct}
                            label={`${pct.toFixed(1)}%`}
                            sublabel={`${formatBytes(used)} / ${formatBytes(vg.size)}（剩余 ${formatBytes(vg.free)}）`}
                          />
                          {vg.children && vg.children.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 pt-0.5">
                              {vg.children.map((pv) => (
                                <Badge key={pv.name} variant="muted" className="font-mono-num text-badge">
                                  {pv.name} · {formatBytes(pv.size)}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* LVM-Thin Pools */}
            <Card>
              <CardHeader className="py-3.5 border-b border-border/70">
                <CardTitle className="flex items-center gap-2 text-base">
                  <HardDrive className="h-4 w-4 text-warning" />
                  <span>LVM-Thin 精简池 ({lvmThins.length})</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4">
                {lvmThins.length === 0 ? (
                  <p className="text-sm text-muted-foreground py-3">当前节点无 LVM-Thin 精简池。</p>
                ) : (
                  <div className="space-y-3">
                    {lvmThins.map((tp) => {
                      const dataPct = tp.lv_size > 0 ? (tp.used / tp.lv_size) * 100 : 0
                      const metaPct =
                        tp.metadata_size > 0 ? (tp.metadata_used / tp.metadata_size) * 100 : 0
                      return (
                        <div
                          key={`${tp.vg}/${tp.lv}`}
                          className="rounded-xl border border-border bg-background/50 p-3.5 space-y-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono-num font-semibold text-foreground">
                              {tp.vg} / {tp.lv}
                            </span>
                            {tp.lv_state && (
                              <Badge variant="muted" className="font-mono-num text-badge">
                                {tp.lv_state}
                              </Badge>
                            )}
                          </div>
                          <ResourceBar
                            percent={dataPct}
                            label={`数据 ${dataPct.toFixed(1)}%`}
                            sublabel={`${formatBytes(tp.used)} / ${formatBytes(tp.lv_size)}`}
                          />
                          {tp.metadata_size > 0 && (
                            <ResourceBar
                              size="xs"
                              percent={metaPct}
                              label={`元数据 ${metaPct.toFixed(1)}%`}
                              sublabel={`${formatBytes(tp.metadata_used)} / ${formatBytes(tp.metadata_size)}`}
                              colorMode={metaPct >= 75 ? 'auto' : 'info'}
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Directory Mounts */}
          <Card className="overflow-hidden">
            <CardHeader className="py-3.5 border-b border-border/70">
              <CardTitle className="flex items-center gap-2 text-base">
                <FolderOpen className="h-4 w-4 text-success" />
                <span>本地目录挂载 (Directory Mounts · {directories.length})</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {directories.length === 0 ? (
                <p className="px-5 py-6 text-sm text-muted-foreground">
                  当前节点未通过 Proxmox Directory 磁盘工具创建额外本地挂载目录。
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2.5 font-medium">挂载路径</th>
                        <th className="px-4 py-2.5 font-medium">块设备</th>
                        <th className="px-4 py-2.5 font-medium">文件系统</th>
                        <th className="px-4 py-2.5 font-medium">挂载选项</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70">
                      {directories.map((d) => (
                        <tr key={d.path} className="hover:bg-muted/35">
                          <td className="px-4 py-2.5 font-mono-num font-semibold text-foreground">
                            {d.path}
                          </td>
                          <td className="px-4 py-2.5 font-mono-num text-muted-foreground">
                            {d.device}
                          </td>
                          <td className="px-4 py-2.5">
                            <Badge variant="muted" className="font-mono-num">
                              {d.type}
                            </Badge>
                          </td>
                          <td className="px-4 py-2.5 font-mono-num text-muted-foreground max-w-[320px] truncate">
                            {d.options || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Ceph Cluster Monitoring Card */}
      <Card>
        <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Server className="h-4 w-4 text-accent" />
            <span>Ceph 分布式存储集群</span>
          </CardTitle>
          {ceph?.installed && (
            <Badge variant={cephHealthVariant(ceph.health)} className="font-mono-num">
              {ceph.health || 'UNKNOWN'}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="p-4">
          {cephError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/12 px-4 py-3 text-xs text-destructive">
              采集 Ceph 状态失败：{cephError instanceof Error ? cephError.message : '未知错误'}
            </div>
          ) : cephLoading && !ceph ? (
            <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
          ) : !ceph?.installed ? (
            <div className="flex items-center gap-3 rounded-lg border border-border/80 bg-muted/30 px-4 py-3.5 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>
                {ceph?.reason || '当前节点未安装或未初始化 Ceph 集群'}（若为单机或非 Ceph 环境，可忽略此面板）。
              </span>
            </div>
          ) : (
            <div className="space-y-4">
              {ceph.healthMessages.length > 0 && (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 space-y-1 text-xs">
                  {ceph.healthMessages.map((msg, i) => (
                    <div key={i} className="font-mono-num text-foreground">
                      {msg}
                    </div>
                  ))}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <div className="rounded-lg border border-border bg-background/50 p-3 space-y-1">
                  <div className="text-xs text-muted-foreground">MON 仲裁 / MGR</div>
                  <div className="font-mono-num text-lg font-bold">
                    {ceph.quorumCount} / {ceph.monCount}
                  </div>
                  <div className="text-xs text-muted-foreground truncate">
                    Active MGR: {ceph.mgrActive || '—'}
                  </div>
                </div>
                <div className="rounded-lg border border-border bg-background/50 p-3 space-y-1">
                  <div className="text-xs text-muted-foreground">OSD 状态 (Up / In / Total)</div>
                  <div className="font-mono-num text-lg font-bold">
                    {ceph.osdUp} / {ceph.osdIn} / {ceph.osdTotal}
                  </div>
                  <div className="text-xs text-muted-foreground">PG 总数 {ceph.pgTotal}</div>
                </div>
                <div className="rounded-lg border border-border bg-background/50 p-3 space-y-1.5">
                  <div className="text-xs text-muted-foreground">集群总容量</div>
                  <ResourceBar
                    size="xs"
                    percent={ceph.bytesTotal > 0 ? (ceph.bytesUsed / ceph.bytesTotal) * 100 : 0}
                    label={formatBytes(ceph.bytesUsed)}
                    sublabel={`/ ${formatBytes(ceph.bytesTotal)}`}
                  />
                </div>
                <div className="rounded-lg border border-border bg-background/50 p-3 space-y-1">
                  <div className="text-xs text-muted-foreground">实时吞吐与 IOPS</div>
                  <div className="font-mono-num text-sm text-foreground">
                    读 {formatBytes(ceph.readBps)}/s · {ceph.readOps} IOPS
                  </div>
                  <div className="font-mono-num text-sm text-foreground">
                    写 {formatBytes(ceph.writeBps)}/s · {ceph.writeOps} IOPS
                  </div>
                </div>
              </div>

              {ceph.monitors.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Monitors:</span>
                  {ceph.monitors.map((m) => (
                    <Badge
                      key={m.name}
                      variant={m.quorum ? 'success' : 'warning'}
                      className="font-mono-num"
                    >
                      {m.name} {m.quorum ? '(Quorum)' : '(Out)'}
                    </Badge>
                  ))}
                </div>
              )}

              {ceph.pools.length > 0 && (
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-left text-sm">
                    <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                      <tr>
                        <th className="px-3.5 py-2 font-medium">Ceph Pool</th>
                        <th className="px-3.5 py-2 font-medium">副本数 (Size/Min)</th>
                        <th className="px-3.5 py-2 font-medium">PGs</th>
                        <th className="px-3.5 py-2 font-medium">已用容量</th>
                        <th className="px-3.5 py-2 font-medium">使用率</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/70 font-mono-num">
                      {ceph.pools.map((p) => (
                        <tr key={p.pool_name}>
                          <td className="px-3.5 py-2 font-semibold text-foreground">{p.pool_name}</td>
                          <td className="px-3.5 py-2">
                            {p.size} / {p.min_size}
                          </td>
                          <td className="px-3.5 py-2">{p.pg_num}</td>
                          <td className="px-3.5 py-2">{formatBytes(p.bytes_used)}</td>
                          <td className="px-3.5 py-2">{(Number(p.percent_used) * 100).toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
