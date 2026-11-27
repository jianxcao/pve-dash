import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Edit3,
  Layers,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  UploadCloud,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { NodeNetworkIface } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { EmptyState } from '@/components/shared/EmptyState'
import { NodeNetworkDialog } from './NodeNetworkDialog'
import { cn } from '@/lib/utils'

interface NodeNetworkPanelProps {
  instanceId: string
  instanceName: string
  node: string
}

const TYPE_PRIORITY: Record<string, number> = {
  bridge: 1,
  OVSBridge: 2,
  bond: 3,
  OVSBond: 4,
  vlan: 5,
  OVSIntPort: 6,
  eth: 7,
  loopback: 9,
}

const ADMIN_HOST_ONLY_TITLE = '仅管理员 (admin) 可执行宿主机级高危操作'

function ifaceTypeMeta(type: string) {
  switch (type) {
    case 'bridge':
      return { label: 'Linux Bridge', variant: 'accent' as const }
    case 'OVSBridge':
      return { label: 'OVS Bridge', variant: 'accent' as const }
    case 'bond':
    case 'OVSBond':
      return { label: 'Bond 聚合', variant: 'info' as const }
    case 'vlan':
      return { label: 'Linux VLAN', variant: 'warning' as const }
    case 'OVSIntPort':
      return { label: 'OVS IntPort', variant: 'warning' as const }
    case 'eth':
      return { label: '物理网卡', variant: 'muted' as const }
    case 'loopback':
      return { label: 'Loopback', variant: 'muted' as const }
    default:
      return { label: type || '未知', variant: 'muted' as const }
  }
}

export function NodeNetworkPanel({ instanceId, instanceName, node }: NodeNetworkPanelProps) {
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const openTaskLog = useAppStore((s) => s.openTaskLog)

  const canMutate = isAdmin && !readOnly
  const mutateDisabledTitle = !isAdmin
    ? ADMIN_HOST_ONLY_TITLE
    : readOnly
      ? '写保护已开启'
      : undefined

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['node-networks', instanceId, node],
    queryFn: () => api.getNodeNetworks(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  const sortedIfaces = useMemo(() => {
    const raw = [...(data?.items ?? [])]
    raw.sort((a, b) => {
      const pa = TYPE_PRIORITY[a.type] ?? 8
      const pb = TYPE_PRIORITY[b.type] ?? 8
      if (pa !== pb) return pa - pb
      return a.iface.localeCompare(b.iface)
    })
    return raw
  }, [data?.items])

  const nextVmbrName = useMemo(() => {
    const existingNums = sortedIfaces
      .map((i) => /^vmbr(\d+)$/.exec(i.iface)?.[1])
      .filter(Boolean)
      .map(Number)
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1
    return `vmbr${nextNum}`
  }, [sortedIfaces])

  const stagedChanges = (data?.changes || '').trim()

  const stats = useMemo(() => {
    let active = 0
    let bridges = 0
    let physical = 0
    let pendingIfaces = 0
    for (const i of sortedIfaces) {
      if (i.active) active++
      if (i.type === 'bridge' || i.type === 'OVSBridge') bridges++
      if (i.type === 'eth') physical++
      if ((i.pending && i.pending.trim()) || i.exists === false) pendingIfaces++
    }
    return { total: sortedIfaces.length, active, bridges, physical, pendingIfaces }
  }, [sortedIfaces])

  const hasPending = Boolean(data?.hasPending || stagedChanges) || stats.pendingIfaces > 0

  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<NodeNetworkIface | null>(null)
  const [showDiff, setShowDiff] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<NodeNetworkIface | null>(null)
  const [revertBusy, setRevertBusy] = useState(false)

  useEffect(() => {
    setModalOpen(false)
    setEditing(null)
    setApplyOpen(false)
    setDeleteTarget(null)
    setShowDiff(false)
  }, [instanceId, node])

  const openCreateModal = () => {
    setEditing(null)
    setModalOpen(true)
  }

  const openEditModal = (iface: NodeNetworkIface) => {
    setEditing(iface)
    setModalOpen(true)
  }

  const handleRevert = async () => {
    if (!canMutate) return
    setRevertBusy(true)
    try {
      await api.revertNodeNetwork(instanceId, node)
      toast.success('已撤销所有未应用的网络配置变更')
      setShowDiff(false)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '撤销变更失败')
    } finally {
      setRevertBusy(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载节点网络配置失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !data) {
    return <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
  }

  return (
    <div className="space-y-5">
      {/* Pending Staged Changes Alert */}
      {hasPending && (
        <div className="rounded-xl border border-warning/45 bg-warning/10 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <div className="text-sm font-semibold text-foreground">
                  检测到未应用的网络配置暂存变更
                </div>
                <p className="text-xs text-muted-foreground">
                  当前改动仅暂存在 /etc/network/interfaces.new，点击“应用配置”将调用 ifreload2 热重载网络栈。
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {stagedChanges && (
                <Button variant="ghost" size="sm" onClick={() => setShowDiff((v) => !v)}>
                  {showDiff ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  {showDiff ? '收起 Diff' : '查看 Diff'}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                disabled={!canMutate || revertBusy}
                title={mutateDisabledTitle}
                onClick={handleRevert}
              >
                {revertBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RotateCcw className="h-4 w-4" />
                )}
                撤销暂存
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!canMutate}
                title={mutateDisabledTitle}
                onClick={() => setApplyOpen(true)}
              >
                <UploadCloud className="h-4 w-4" />
                应用配置 (ifreload)
              </Button>
            </div>
          </div>

          {showDiff && stagedChanges && (
            <pre className="max-h-60 overflow-auto rounded-lg border border-border bg-background/80 p-3 font-mono-num text-xs text-foreground whitespace-pre-wrap">
              {stagedChanges}
            </pre>
          )}
        </div>
      )}

      {/* Summary & Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="muted" className="font-mono-num">
            总接口 {stats.total}
          </Badge>
          <Badge variant="success" className="font-mono-num">
            活跃 {stats.active}
          </Badge>
          <Badge variant="accent" className="font-mono-num">
            网桥 {stats.bridges}
          </Badge>
          <Badge variant="muted" className="font-mono-num">
            物理口 {stats.physical}
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            disabled={!canMutate}
            title={mutateDisabledTitle || '创建 Linux Bridge / Bond / VLAN'}
            onClick={openCreateModal}
          >
            <Plus className="h-4 w-4" />
            新建网络接口
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!canMutate}
            title={mutateDisabledTitle || '热重载当前节点的网络配置'}
            onClick={() => setApplyOpen(true)}
          >
            <UploadCloud className="h-4 w-4 text-accent" />
            应用配置
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="刷新网络接口"
          >
            <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Interfaces Table */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Network className="h-4 w-4 text-accent" />
            <span>宿主机网络接口 ({sortedIfaces.length})</span>
          </CardTitle>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            支持 Linux Bridge / OVSBridge / Bond / VLAN 编排与 VLAN 感知配置
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {sortedIfaces.length === 0 ? (
            <EmptyState
              icon={Cable}
              title="未检测到网络接口"
              description="当前节点未能返回网络接口信息。"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">接口名</th>
                    <th className="px-4 py-2.5 font-medium">类型</th>
                    <th className="px-4 py-2.5 font-medium">状态</th>
                    <th className="px-4 py-2.5 font-medium">IP / 网关</th>
                    <th className="px-4 py-2.5 font-medium">桥接端口 / 绑定关系</th>
                    <th className="px-4 py-2.5 font-medium">MTU & 备注</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {sortedIfaces.map((iface) => {
                    const meta = ifaceTypeMeta(iface.type)
                    const isLoopback = iface.type === 'loopback' || iface.iface === 'lo'
                    const hasIfacePending = Boolean(iface.pending?.trim()) || iface.exists === false
                    const portsText = iface.bridge_ports || iface.ovs_ports
                    return (
                      <tr key={iface.iface} className="transition-colors hover:bg-muted/35">
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span className="font-mono-num font-semibold text-foreground">
                              {iface.iface}
                            </span>
                            {hasIfacePending && <Badge variant="warning">待生效</Badge>}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={iface.active ? 'success' : 'muted'}>
                              {iface.active ? (
                                <>
                                  <CheckCircle2 className="h-3 w-3" />
                                  活跃
                                </>
                              ) : (
                                '未激活'
                              )}
                            </Badge>
                            {iface.autostart && (
                              <Badge variant="muted" className="text-badge">
                                自启
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono-num text-sm whitespace-nowrap">
                          <div className="space-y-0.5">
                            {iface.cidr || iface.address ? (
                              <div className="text-foreground">{iface.cidr || iface.address}</div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            {iface.gateway && (
                              <div className="text-xs text-muted-foreground">
                                GW {iface.gateway}
                              </div>
                            )}
                            {iface.cidr6 && (
                              <div className="text-xs text-info">
                                {iface.cidr6}
                                {iface.gateway6 ? ` (GW ${iface.gateway6})` : ''}
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {portsText && (
                              <span className="font-mono-num text-foreground">{portsText}</span>
                            )}
                            {iface.slaves && (
                              <span className="font-mono-num text-foreground">
                                {iface.slaves}
                                {iface.bond_mode ? ` (${iface.bond_mode})` : ''}
                              </span>
                            )}
                            {iface['vlan-raw-device'] && (
                              <span className="font-mono-num text-foreground">
                                {iface['vlan-raw-device']}
                                {iface['vlan-id'] ? ` · VLAN ${iface['vlan-id']}` : ''}
                              </span>
                            )}
                            {iface.bridge_vlan_aware && (
                              <Badge variant="info" className="text-badge">
                                <Layers className="h-3 w-3" />
                                VLAN 感知
                              </Badge>
                            )}
                            {!portsText &&
                              !iface.slaves &&
                              !iface['vlan-raw-device'] &&
                              !iface.bridge_vlan_aware && (
                                <span className="text-muted-foreground">—</span>
                              )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs text-muted-foreground">
                          <div className="space-y-0.5">
                            {iface.mtu ? (
                              <div className="font-mono-num text-sm text-foreground">MTU {iface.mtu}</div>
                            ) : null}
                            <div className="max-w-[200px] truncate">
                              {iface.comments?.trim() || (!iface.mtu ? '—' : '')}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {!isLoopback && (
                            <div className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={!canMutate}
                                title={mutateDisabledTitle || `编辑 ${iface.iface}`}
                                onClick={() => openEditModal(iface)}
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </Button>
                              {iface.type !== 'eth' && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={!canMutate}
                                  title={mutateDisabledTitle || `删除 ${iface.iface}`}
                                  onClick={() => setDeleteTarget(iface)}
                                >
                                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                                </Button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {modalOpen && (
        <NodeNetworkDialog
          key={editing?.iface || 'create'}
          open={modalOpen}
          onOpenChange={setModalOpen}
          instanceId={instanceId}
          node={node}
          editing={editing}
          nextVmbrName={nextVmbrName}
          canMutate={canMutate}
          onSaved={() => void refetch()}
        />
      )}

      {/* Apply Network Changes Confirmation */}
      <DangerConfirmDialog
        open={applyOpen}
        onOpenChange={setApplyOpen}
        title={`应用宿主机网络配置 · ${node}`}
        description="警告：此操作将调用 Proxmox ifreload2 重载宿主机网络栈。若管理网桥（如 vmbr0）IP、网关或物理端口配置有误，可能导致 SSH 与 PVE Web 界面失联！"
        confirmTarget={node}
        confirmLabel="确认应用网络变更"
        onConfirm={async () => {
          const res = await api.applyNodeNetwork(instanceId, node)
          toast.success(`已向节点 ${node} 提交网络配置重载任务`)
          if (res.upid) {
            openTaskLog({
              instanceId,
              instanceName,
              node,
              upid: res.upid,
              type: 'networkreload',
              id: 'networking',
            })
          }
          setTimeout(() => void refetch(), 1500)
        }}
      />

      {/* Delete Interface Confirmation */}
      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`删除网络接口 · ${deleteTarget?.iface ?? ''}`}
        description="确认从节点暂存网络配置中删除此接口？请确保没有正在运行的虚拟机或管理流量依赖该网桥。"
        confirmTarget={deleteTarget?.iface ?? ''}
        confirmLabel="确认删除接口"
        onConfirm={async () => {
          if (!deleteTarget) return
          await api.deleteNodeNetwork(instanceId, node, deleteTarget.iface)
          toast.success(`接口 ${deleteTarget.iface} 已标记删除，应用配置后生效`)
          void refetch()
        }}
      />
    </div>
  )
}
