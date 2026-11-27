import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Box,
  Cpu,
  Edit3,
  FolderKanban,
  HardDrive,
  HeartPulse,
  Loader2,
  Monitor,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { PoolSummary } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { FirewallPanel } from '@/components/firewall/FirewallPanel'
import { HaPanel } from './HaPanel'
import { ResourceMappingsPanel } from './ResourceMappingsPanel'
import { cn } from '@/lib/utils'

const VALID_GOV_TABS = new Set(['pools', 'firewall', 'ha', 'mappings'])

export function GovernancePage() {
  const { data: overview } = useOverviewQuery()
  const queryClient = useQueryClient()
  const globalInstanceId = useAppStore((s) => s.selectedInstanceId)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const rawTab = searchParams.get('tab') || 'pools'
  const activeTab = VALID_GOV_TABS.has(rawTab) ? rawTab : 'pools'

  const onlineInstances = useMemo(
    () => (overview?.instances ?? []).filter((i) => i.state === 'online'),
    [overview?.instances],
  )
  const onlineIdsKey = onlineInstances.map((i) => i.id).join(',')
  const [instanceId, setInstanceId] = useState('')
  const prevGlobalRef = useRef<string>(globalInstanceId)

  // Only sync from TopBar globalInstanceId when it actually changes; preserve local dropdown pick across SSE ticks
  useEffect(() => {
    const ids = onlineIdsKey ? onlineIdsKey.split(',') : []
    if (ids.length === 0) {
      setInstanceId('')
      return
    }
    const globalChanged = prevGlobalRef.current !== globalInstanceId
    prevGlobalRef.current = globalInstanceId

    if (globalChanged && globalInstanceId !== 'all' && ids.includes(globalInstanceId)) {
      setInstanceId(globalInstanceId)
      return
    }
    setInstanceId((prev) => {
      if (prev && ids.includes(prev)) return prev
      if (globalInstanceId !== 'all' && ids.includes(globalInstanceId)) return globalInstanceId
      return ids[0]
    })
  }, [onlineIdsKey, globalInstanceId])

  const instanceGuests = useMemo(
    () =>
      (overview?.guests ?? [])
        .filter((g) => g.instanceId === instanceId)
        .sort((a, b) => a.vmid - b.vmid),
    [overview?.guests, instanceId],
  )

  const instanceStorages = useMemo(() => {
    const set = new Set<string>()
    for (const s of overview?.storages ?? []) {
      if (s.instanceId === instanceId && s.storage) set.add(s.storage)
    }
    return Array.from(set).sort()
  }, [overview?.storages, instanceId])

  const {
    data: poolsResp,
    isLoading: poolsLoading,
    isFetching: poolsFetching,
    refetch: refetchPools,
    error: poolsError,
  } = useQuery({
    queryKey: ['pools', instanceId],
    queryFn: () => api.listPools(instanceId),
    enabled: Boolean(instanceId),
  })

  const pools = poolsResp?.items ?? []
  const poolWarnings = poolsResp?.warnings

  // Create Pool Modal
  const [createOpen, setCreateOpen] = useState(false)
  const [newPoolId, setNewPoolId] = useState('')
  const [newComment, setNewComment] = useState('')
  const [createBusy, setCreateBusy] = useState(false)

  // Manage Pool Modal (Edit Comment & Add VM / Storage Members)
  const [managePool, setManagePool] = useState<PoolSummary | null>(null)
  const [editComment, setEditComment] = useState('')
  const [selectedAddVmids, setSelectedAddVmids] = useState<Record<number, boolean>>({})
  const [selectedAddStorages, setSelectedAddStorages] = useState<Record<string, boolean>>({})
  const [manageBusy, setManageBusy] = useState(false)

  // Delete Pool / Remove Member Confirm
  const [deletePool, setDeletePool] = useState<PoolSummary | null>(null)
  const [removeMemberTarget, setRemoveMemberTarget] = useState<{
    poolId: string
    label: string
    vmid?: number
    storage?: string
  } | null>(null)
  const [removingBusy, setRemovingBusy] = useState(false)

  // Close dialogs cleanly when cluster changes
  useEffect(() => {
    setCreateOpen(false)
    setManagePool(null)
    setDeletePool(null)
    setRemoveMemberTarget(null)
  }, [instanceId])

  const handleCreatePool = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !instanceId) return
    const clean = newPoolId.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})*$/.test(clean) || clean.includes('..')) {
      toast.error('资源池名称仅支持字母、数字、点、下划线、连字符（PVE 8.1+ 嵌套池支持单斜杠分段）')
      return
    }
    setCreateBusy(true)
    try {
      await api.createPool(instanceId, { poolid: clean, comment: newComment.trim() })
      toast.success(`资源池 "${clean}" 创建成功`)
      setCreateOpen(false)
      setNewPoolId('')
      setNewComment('')
      void refetchPools()
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建资源池失败')
    } finally {
      setCreateBusy(false)
    }
  }

  const openManagePool = (pool: PoolSummary) => {
    setManagePool(pool)
    setEditComment(pool.comment || '')
    setSelectedAddVmids({})
    setSelectedAddStorages({})
  }

  const handleSaveManagePool = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!managePool || readOnly || !instanceId) return
    setManageBusy(true)
    try {
      const addVmids = Object.entries(selectedAddVmids)
        .filter(([, checked]) => checked)
        .map(([vmid]) => vmid)
      const addStorages = Object.entries(selectedAddStorages)
        .filter(([, checked]) => checked)
        .map(([st]) => st)
      await api.updatePool(instanceId, managePool.poolid, {
        comment: editComment.trim(),
        vms: addVmids.length > 0 ? addVmids.join(',') : undefined,
        storage: addStorages.length > 0 ? addStorages.join(',') : undefined,
        allowMove: addVmids.length > 0,
      })
      toast.success(`资源池 "${managePool.poolid}" 已更新`)
      setManagePool(null)
      void refetchPools()
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新资源池失败')
    } finally {
      setManageBusy(false)
    }
  }

  const handleConfirmRemoveMember = async () => {
    if (!removeMemberTarget || readOnly || !instanceId) return
    setRemovingBusy(true)
    try {
      await api.updatePool(instanceId, removeMemberTarget.poolId, {
        vms: removeMemberTarget.vmid ? String(removeMemberTarget.vmid) : undefined,
        storage: removeMemberTarget.storage || undefined,
        delete: true,
      })
      toast.success(`已从资源池 "${removeMemberTarget.poolId}" 移除 ${removeMemberTarget.label}`)
      setRemoveMemberTarget(null)
      void refetchPools()
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '移除成员失败')
    } finally {
      setRemovingBusy(false)
    }
  }

  const manageExistingVmids = useMemo(() => {
    const set = new Set<number>()
    for (const m of managePool?.members ?? []) {
      if (m.vmid) set.add(m.vmid)
    }
    return set
  }, [managePool])

  const manageExistingStorages = useMemo(() => {
    const set = new Set<string>()
    for (const m of managePool?.members ?? []) {
      if (m.type === 'storage' && m.storage) set.add(m.storage)
    }
    return set
  }, [managePool])

  const totalMembers = useMemo(
    () => pools.reduce((acc, p) => acc + (p.members?.length ?? 0), 0),
    [pools],
  )

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      {/* Page Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">
            集群治理与安全
          </h1>
          <p className="text-sm text-muted-foreground">
            统一管理业务资源池、数据中心防火墙策略、HA 高可用故障转移与集群 PCI/USB/目录硬件映射。
          </p>
        </div>

        {onlineInstances.length > 0 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">目标集群：</span>
            <NativeSelect
              aria-label="选择 PVE 实例"
              value={instanceId}
              onChange={(e) => setInstanceId(e.target.value)}
              className="h-9 text-sm min-w-[160px]"
            >
              {onlineInstances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} {inst.pveVersion ? `(v${inst.pveVersion})` : ''}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
      </div>

      {onlineInstances.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="暂无在线 Proxmox VE 实例"
          description="请先前往实例连接管理接入至少一个在线的 PVE 节点或集群。"
          action={
            <Button variant="primary" size="sm" onClick={() => navigate('/instances')}>
              前往实例管理
            </Button>
          }
        />
      ) : (
        <Tabs
          value={activeTab}
          onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}
        >
          <TabsList className="flex-wrap h-auto">
            <TabsTrigger value="pools">
              <FolderKanban className="h-4 w-4" />
              资源池管理 ({pools.length})
            </TabsTrigger>
            <TabsTrigger value="firewall">
              <Shield className="h-4 w-4" />
              集群防火墙 (Datacenter)
            </TabsTrigger>
            <TabsTrigger value="ha">
              <HeartPulse className="h-4 w-4" />
              HA 高可用
            </TabsTrigger>
            <TabsTrigger value="mappings">
              <Cpu className="h-4 w-4" />
              硬件资源映射
            </TabsTrigger>
          </TabsList>

          {/* Tab 1: Resource Pools */}
          <TabsContent value="pools" className="space-y-5">
            {poolWarnings && Object.keys(poolWarnings).length > 0 && (
              <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div>
                  部分资源池成员明细加载失败（{Object.keys(poolWarnings).join('、')}）：
                  {Object.values(poolWarnings).join('；')}
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="muted" className="font-mono-num">
                  资源池 {pools.length}
                </Badge>
                <Badge variant="accent" className="font-mono-num">
                  已纳管成员 {totalMembers}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={readOnly || !instanceId}
                  title={readOnly ? '写保护已开启' : '创建新资源池'}
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  新建资源池
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => refetchPools()}
                  disabled={poolsFetching}
                  aria-label="刷新资源池"
                >
                  <RefreshCw className={cn('h-4 w-4', poolsFetching && 'animate-spin')} />
                </Button>
              </div>
            </div>

            {poolsError ? (
              <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
                加载资源池失败：{poolsError instanceof Error ? poolsError.message : '未知错误'}
              </div>
            ) : poolsLoading && !poolsResp ? (
              <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
            ) : pools.length === 0 ? (
              <EmptyState
                icon={FolderKanban}
                title="当前集群尚未创建资源池"
                description="可通过资源池将生产业务、测试环境、媒体服务等虚拟机与存储池按逻辑分组，也支持在计算列表页批量勾选加入。"
                action={
                  !readOnly && instanceId ? (
                    <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus className="h-4 w-4" />
                      创建首个资源池
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {pools.map((pool) => {
                  const members = pool.members ?? []
                  return (
                    <Card key={pool.poolid} className="flex flex-col">
                      <CardHeader className="py-4 border-b border-border/70 flex-row items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <FolderKanban className="h-4.5 w-4.5 text-accent shrink-0" />
                            <CardTitle className="font-mono-num text-base truncate">
                              {pool.poolid}
                            </CardTitle>
                            <Badge variant="muted" className="font-mono-num">
                              {members.length} 成员
                            </Badge>
                          </div>
                          {pool.comment && (
                            <p className="text-xs text-muted-foreground">{pool.comment}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <Button
                            variant="outline"
                            size="xs"
                            disabled={readOnly}
                            title={readOnly ? '写保护已开启' : '编辑备注与添加成员'}
                            onClick={() => openManagePool(pool)}
                          >
                            <Edit3 className="h-3 w-3" />
                            管理成员
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled={readOnly}
                            title={readOnly ? '写保护已开启' : '删除资源池'}
                            onClick={() => setDeletePool(pool)}
                          >
                            <Trash2 className="h-3.5 w-3.5 text-destructive" />
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="p-4 flex-1">
                        {members.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">
                            该资源池暂无成员，点击右上角“管理成员”添加 VM / LXC 或存储
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {members.map((m) => {
                              const isStorage = m.type === 'storage'
                              const chipLabel = isStorage
                                ? `存储 ${m.storage}`
                                : `#${m.vmid}${m.name ? ` (${m.name})` : ''}`
                              return (
                                <div
                                  key={m.id}
                                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/60 px-2.5 py-1.5 text-xs"
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (isStorage && m.node && m.storage) {
                                        navigate(
                                          `/storage?instanceId=${encodeURIComponent(instanceId)}&node=${encodeURIComponent(m.node)}&storage=${encodeURIComponent(m.storage)}`,
                                        )
                                      } else if (m.node && m.vmid) {
                                        navigate(
                                          `/instances/${instanceId}/nodes/${m.node}/${m.type === 'lxc' ? 'lxc' : 'qemu'}/${m.vmid}`,
                                        )
                                      }
                                    }}
                                    className="inline-flex items-center gap-1.5 hover:text-accent"
                                  >
                                    {isStorage ? (
                                      <HardDrive className="h-3.5 w-3.5 text-warning" />
                                    ) : m.type === 'lxc' ? (
                                      <Box className="h-3.5 w-3.5 text-success" />
                                    ) : (
                                      <Monitor className="h-3.5 w-3.5 text-accent" />
                                    )}
                                    <span className="font-mono-num font-semibold">
                                      {isStorage ? m.storage : `#${m.vmid}`}
                                    </span>
                                    {!isStorage && m.name && (
                                      <span className="max-w-[120px] truncate text-muted-foreground">
                                        {m.name}
                                      </span>
                                    )}
                                  </button>
                                  {!readOnly && (
                                    <button
                                      type="button"
                                      title="从资源池移除"
                                      onClick={() =>
                                        setRemoveMemberTarget({
                                          poolId: pool.poolid,
                                          label: chipLabel,
                                          vmid: isStorage ? undefined : m.vmid,
                                          storage: isStorage ? m.storage : undefined,
                                        })
                                      }
                                      className="ml-0.5 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  )}
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
            )}
          </TabsContent>

          {/* Tab 2: Cluster Firewall */}
          <TabsContent value="firewall">
            <FirewallPanel scope="cluster" instanceId={instanceId} />
          </TabsContent>

          {/* Tab 3: HA High Availability */}
          <TabsContent value="ha">
            <HaPanel instanceId={instanceId} />
          </TabsContent>

          {/* Tab 4: Cluster Hardware Resource Mappings */}
          <TabsContent value="mappings">
            <ResourceMappingsPanel instanceId={instanceId} />
          </TabsContent>
        </Tabs>
      )}

      {/* Create Pool Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建资源池 (Resource Pool)</DialogTitle>
            <DialogDescription>
              创建用于逻辑分组的 Proxmox 资源池（例如 prod、homelab、media；PVE 8.1+ 支持 parent/child 嵌套池）。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreatePool} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">资源池名称 (Pool ID)</label>
              <Input
                value={newPoolId}
                onChange={(e) => setNewPoolId(e.target.value)}
                placeholder="如 homelab-prod"
                className="font-mono-num"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">备注说明（可选）</label>
              <Input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="如 核心生产虚拟机与数据库"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={createBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={createBusy || readOnly}>
                {createBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                创建资源池
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Manage Pool Members & Comment Dialog */}
      <Dialog
        open={Boolean(managePool)}
        onOpenChange={(open) => {
          if (!open) setManagePool(null)
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>管理资源池 · {managePool?.poolid}</DialogTitle>
            <DialogDescription>
              更新备注说明，或勾选当前集群的虚拟机/容器与存储池加入此资源池（支持跨池自动迁入）。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveManagePool} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">备注说明</label>
              <Input
                value={editComment}
                onChange={(e) => setEditComment(e.target.value)}
                placeholder="资源池用途说明"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">添加虚拟机 / LXC 容器</label>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
                {instanceGuests.filter((g) => !manageExistingVmids.has(g.vmid)).length === 0 ? (
                  <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                    所有计算实例均已在此资源池中
                  </div>
                ) : (
                  instanceGuests
                    .filter((g) => !manageExistingVmids.has(g.vmid))
                    .map((g) => (
                      <label
                        key={g.urn}
                        className="flex items-center justify-between gap-2 px-3 py-2 text-xs hover:bg-muted/40 cursor-pointer"
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <input
                            type="checkbox"
                            checked={Boolean(selectedAddVmids[g.vmid])}
                            onChange={(e) =>
                              setSelectedAddVmids((prev) => ({
                                ...prev,
                                [g.vmid]: e.target.checked,
                              }))
                            }
                            className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                          />
                          <span className="font-mono-num font-semibold text-muted-foreground">
                            #{g.vmid}
                          </span>
                          <span className="truncate font-medium text-foreground">{g.name}</span>
                          <Badge variant={g.type === 'lxc' ? 'success' : 'accent'}>
                            {g.type.toUpperCase()}
                          </Badge>
                        </span>
                        {g.pool && (
                          <span className="text-[11px] text-muted-foreground shrink-0">
                            原属: {g.pool}
                          </span>
                        )}
                      </label>
                    ))
                )}
              </div>
            </div>

            {instanceStorages.filter((st) => !manageExistingStorages.has(st)).length > 0 && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">添加存储池成员</label>
                <div className="max-h-32 overflow-y-auto rounded-lg border border-border divide-y divide-border/60">
                  {instanceStorages
                    .filter((st) => !manageExistingStorages.has(st))
                    .map((st) => (
                      <label
                        key={st}
                        className="flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={Boolean(selectedAddStorages[st])}
                          onChange={(e) =>
                            setSelectedAddStorages((prev) => ({
                              ...prev,
                              [st]: e.target.checked,
                            }))
                          }
                          className="h-3.5 w-3.5 accent-[var(--color-accent)]"
                        />
                        <HardDrive className="h-3.5 w-3.5 text-warning" />
                        <span className="font-mono-num font-medium text-foreground">{st}</span>
                      </label>
                    ))}
                </div>
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setManagePool(null)} disabled={manageBusy}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={manageBusy || readOnly}>
                {manageBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                保存变更
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove Pool Member Confirm Dialog */}
      <Dialog
        open={Boolean(removeMemberTarget)}
        onOpenChange={(open) => {
          if (!open) setRemoveMemberTarget(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>从资源池移除成员</DialogTitle>
            <DialogDescription>
              确认将 <span className="font-mono-num font-semibold text-foreground">{removeMemberTarget?.label}</span>{' '}
              从资源池 <span className="font-mono-num font-semibold text-foreground">{removeMemberTarget?.poolId}</span>{' '}
              中移出？（不会影响虚拟机、容器或存储的正常运行）
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveMemberTarget(null)}
              disabled={removingBusy}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmRemoveMember}
              disabled={removingBusy || readOnly}
            >
              {removingBusy && <Loader2 className="h-4 w-4 animate-spin" />}
              确认移出
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Pool Confirmation */}
      <DangerConfirmDialog
        open={Boolean(deletePool)}
        onOpenChange={(open) => {
          if (!open) setDeletePool(null)
        }}
        title={`删除资源池 · ${deletePool?.poolid ?? ''}`}
        description="确认删除此资源池？注意：Proxmox 要求资源池内无成员时才能删除，请先移除池中成员（删除池不会影响虚拟机本体运行）。"
        confirmTarget={deletePool?.poolid ?? ''}
        confirmLabel="确认删除资源池"
        onConfirm={async () => {
          if (!deletePool) return
          await api.deletePool(instanceId, deletePool.poolid)
          toast.success(`资源池 "${deletePool.poolid}" 已删除`)
          void refetchPools()
          void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
        }}
      />
    </div>
  )
}
