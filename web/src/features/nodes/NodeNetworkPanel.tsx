import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
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
import type { NodeNetworkIface, NodeNetworkPayload } from '@/lib/api/types'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
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

const BOND_MODES = [
  'balance-rr',
  'active-backup',
  'balance-xor',
  'broadcast',
  '802.3ad',
  'balance-tlb',
  'balance-alb',
]

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
  const openTaskLog = useAppStore((s) => s.openTaskLog)

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

  const stats = useMemo(() => {
    let active = 0
    let bridges = 0
    let physical = 0
    let pendingCount = 0
    for (const i of sortedIfaces) {
      if (i.active) active++
      if (i.type === 'bridge' || i.type === 'OVSBridge') bridges++
      if (i.type === 'eth') physical++
      if ((i.pending && i.pending.trim()) || i.exists === false) pendingCount++
    }
    return { total: sortedIfaces.length, active, bridges, physical, pendingCount }
  }, [sortedIfaces])

  const hasPending = stats.pendingCount > 0

  // Create / Edit Modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<NodeNetworkIface | null>(null)
  const [fIface, setFIface] = useState('vmbr1')
  const [fType, setFType] = useState('bridge')
  const [fCidr, setFCidr] = useState('')
  const [fGateway, setFGateway] = useState('')
  const [fCidr6, setFCidr6] = useState('')
  const [fGateway6, setFGateway6] = useState('')
  const [fBridgePorts, setFBridgePorts] = useState('')
  const [fVlanAware, setFVlanAware] = useState(true)
  const [fSlaves, setFSlaves] = useState('')
  const [fBondMode, setFBondMode] = useState('active-backup')
  const [fVlanRaw, setFVlanRaw] = useState('')
  const [fVlanId, setFVlanId] = useState('')
  const [fMtu, setFMtu] = useState('')
  const [fAutostart, setFAutostart] = useState(true)
  const [fComments, setFComments] = useState('')
  const [saving, setSaving] = useState(false)

  // Confirmations
  const [applyOpen, setApplyOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<NodeNetworkIface | null>(null)
  const [revertBusy, setRevertBusy] = useState(false)

  const openCreateModal = () => {
    const existingNums = sortedIfaces
      .map((i) => /^vmbr(\d+)$/.exec(i.iface)?.[1])
      .filter(Boolean)
      .map(Number)
    const nextVmbr = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1
    setEditing(null)
    setFType('bridge')
    setFIface(`vmbr${nextVmbr}`)
    setFCidr('')
    setFGateway('')
    setFCidr6('')
    setFGateway6('')
    setFBridgePorts('')
    setFVlanAware(true)
    setFSlaves('')
    setFBondMode('active-backup')
    setFVlanRaw('')
    setFVlanId('')
    setFMtu('')
    setFAutostart(true)
    setFComments('')
    setModalOpen(true)
  }

  const openEditModal = (iface: NodeNetworkIface) => {
    setEditing(iface)
    setFType(iface.type || 'bridge')
    setFIface(iface.iface)
    setFCidr(iface.cidr || iface.address || '')
    setFGateway(iface.gateway || '')
    setFCidr6(iface.cidr6 || '')
    setFGateway6(iface.gateway6 || '')
    setFBridgePorts(iface.bridge_ports || '')
    setFVlanAware(Boolean(iface.bridge_vlan_aware))
    setFSlaves(iface.slaves || '')
    setFBondMode(iface.bond_mode || 'active-backup')
    setFVlanRaw(iface['vlan-raw-device'] || '')
    setFVlanId(iface['vlan-id'] ? String(iface['vlan-id']) : '')
    setFMtu(iface.mtu ? String(iface.mtu) : '')
    setFAutostart(Boolean(iface.autostart))
    setFComments((iface.comments || '').trim())
    setModalOpen(true)
  }

  const handleSaveInterface = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const payload: NodeNetworkPayload = {
        iface: editing ? undefined : fIface.trim(),
        type: fType,
        cidr: fCidr.trim() || undefined,
        gateway: fGateway.trim() || undefined,
        cidr6: fCidr6.trim() || undefined,
        gateway6: fGateway6.trim() || undefined,
        autostart: fAutostart,
        bridgePorts: fType === 'bridge' ? fBridgePorts.trim() || undefined : undefined,
        bridgeVlanAware: fType === 'bridge' ? fVlanAware : undefined,
        slaves: fType === 'bond' ? fSlaves.trim() || undefined : undefined,
        bondMode: fType === 'bond' ? fBondMode : undefined,
        vlanRawDevice: fType === 'vlan' ? fVlanRaw.trim() || undefined : undefined,
        vlanId: fType === 'vlan' && fVlanId.trim() ? Number(fVlanId) : undefined,
        mtu: fMtu.trim() ? Number(fMtu) : undefined,
        comments: fComments.trim() || undefined,
      }

      if (editing) {
        const del: string[] = []
        if ((editing.cidr || editing.address) && !payload.cidr) del.push('cidr')
        if (editing.gateway && !payload.gateway) del.push('gateway')
        if (editing.cidr6 && !payload.cidr6) del.push('cidr6')
        if (editing.gateway6 && !payload.gateway6) del.push('gateway6')
        if (editing.bridge_ports && !payload.bridgePorts) del.push('bridge_ports')
        if (editing.comments?.trim() && !payload.comments) del.push('comments')
        if (editing.mtu && !payload.mtu) del.push('mtu')
        if (del.length > 0) payload.delete = del

        await api.updateNodeNetwork(instanceId, node, editing.iface, payload)
        toast.success(`接口 ${editing.iface} 改动已暂存，请点击“应用配置”生效`)
      } else {
        await api.createNodeNetwork(instanceId, node, payload)
        toast.success(`接口 ${fIface.trim()} 已暂存创建，请点击“应用配置”生效`)
      }
      setModalOpen(false)
      void refetch()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存网络配置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleRevert = async () => {
    setRevertBusy(true)
    try {
      await api.revertNodeNetwork(instanceId, node)
      toast.success('已撤销所有未应用的网络配置变更')
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
        <div className="rounded-xl border border-warning/45 bg-warning/10 p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-warning shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              <div className="text-sm font-semibold text-foreground">
                检测到 {stats.pendingCount} 项待应用的网络配置变更
              </div>
              <p className="text-xs text-muted-foreground">
                当前改动仅暂存在 /etc/network/interfaces.new，点击“应用配置”将调用 ifreload2 热重载网络栈。
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={readOnly || revertBusy}
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
              disabled={readOnly}
              onClick={() => setApplyOpen(true)}
            >
              <UploadCloud className="h-4 w-4" />
              应用配置 (ifreload)
            </Button>
          </div>
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
            disabled={readOnly}
            title={readOnly ? '写保护已开启' : '创建 Linux Bridge / Bond / VLAN'}
            onClick={openCreateModal}
          >
            <Plus className="h-4 w-4" />
            新建网络接口
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={readOnly}
            title={readOnly ? '写保护已开启' : '热重载当前节点的网络配置'}
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
          <CardTitle className="flex items-center gap-2 text-sm">
            <Network className="h-4 w-4 text-accent" />
            <span>宿主机网络接口 ({sortedIfaces.length})</span>
          </CardTitle>
          <span className="text-xs text-muted-foreground hidden sm:inline">
            支持 Linux Bridge / Bond / VLAN 编排与 VLAN 感知配置
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
                              <Badge variant="muted" className="text-[11px]">
                                自启
                              </Badge>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 font-mono-num text-xs whitespace-nowrap">
                          <div className="space-y-0.5">
                            {iface.cidr || iface.address ? (
                              <div className="text-foreground">{iface.cidr || iface.address}</div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                            {iface.gateway && (
                              <div className="text-[11px] text-muted-foreground">
                                GW {iface.gateway}
                              </div>
                            )}
                            {iface.cidr6 && (
                              <div className="text-[11px] text-info">{iface.cidr6}</div>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {iface.bridge_ports && (
                              <span className="font-mono-num text-foreground">
                                {iface.bridge_ports}
                              </span>
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
                              <Badge variant="info" className="text-[11px]">
                                <Layers className="h-3 w-3" />
                                VLAN 感知
                              </Badge>
                            )}
                            {!iface.bridge_ports &&
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
                              <div className="font-mono-num text-foreground">MTU {iface.mtu}</div>
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
                                disabled={readOnly}
                                title={readOnly ? '写保护已开启' : `编辑 ${iface.iface}`}
                                onClick={() => openEditModal(iface)}
                              >
                                <Edit3 className="h-3.5 w-3.5" />
                              </Button>
                              {iface.type !== 'eth' && (
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  disabled={readOnly}
                                  title={readOnly ? '写保护已开启' : `删除 ${iface.iface}`}
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

      {/* Create / Edit Interface Dialog */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {editing ? `编辑网络接口 · ${editing.iface}` : `新建网络接口 · ${node}`}
            </DialogTitle>
            <DialogDescription>
              支持创建与调整 Linux Bridge、Bond 聚合口及 VLAN 子接口；保存后需点击“应用配置”使变更生效。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSaveInterface} className="space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">接口类型</label>
                <NativeSelect
                  value={fType}
                  disabled={Boolean(editing)}
                  onChange={(e) => {
                    const nextType = e.target.value
                    setFType(nextType)
                    if (!editing) {
                      if (nextType === 'bridge') setFIface('vmbr1')
                      else if (nextType === 'bond') setFIface('bond0')
                      else if (nextType === 'vlan') setFIface('vmbr0.100')
                    }
                  }}
                  className="w-full"
                >
                  <option value="bridge">Linux Bridge (vmbr)</option>
                  <option value="bond">Linux Bond (链路聚合)</option>
                  <option value="vlan">Linux VLAN (802.1Q)</option>
                  {editing?.type === 'eth' && <option value="eth">物理网卡 (eth)</option>}
                  <option value="OVSBridge">OVS Bridge</option>
                </NativeSelect>
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">接口名称</label>
                <Input
                  value={fIface}
                  disabled={Boolean(editing)}
                  onChange={(e) => setFIface(e.target.value)}
                  placeholder="如 vmbr1 / bond0 / enp3s0.100"
                  className="font-mono-num"
                  required
                />
              </div>
            </div>

            {fType === 'bridge' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">桥接物理端口 (bridge_ports)</label>
                  <Input
                    value={fBridgePorts}
                    onChange={(e) => setFBridgePorts(e.target.value)}
                    placeholder="如 enp3s0（纯内网桥可留空）"
                    className="font-mono-num"
                  />
                </div>
                <label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs h-10">
                  <input
                    type="checkbox"
                    checked={fVlanAware}
                    onChange={(e) => setFVlanAware(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>启用 VLAN 感知 (VLAN aware)</span>
                </label>
              </div>
            )}

            {fType === 'bond' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">聚合从属网卡 (slaves)</label>
                  <Input
                    value={fSlaves}
                    onChange={(e) => setFSlaves(e.target.value)}
                    placeholder="空格分隔，如 enp2s0 enp3s0"
                    className="font-mono-num"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">聚合模式 (bond_mode)</label>
                  <NativeSelect
                    value={fBondMode}
                    onChange={(e) => setFBondMode(e.target.value)}
                    className="w-full"
                  >
                    {BOND_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </NativeSelect>
                </div>
              </div>
            )}

            {fType === 'vlan' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">底层设备 (vlan-raw-device)</label>
                  <Input
                    value={fVlanRaw}
                    onChange={(e) => setFVlanRaw(e.target.value)}
                    placeholder="如 enp3s0 或 vmbr0"
                    className="font-mono-num"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">VLAN ID (1-4094)</label>
                  <Input
                    type="number"
                    min={1}
                    max={4094}
                    value={fVlanId}
                    onChange={(e) => setFVlanId(e.target.value)}
                    placeholder="100"
                    className="font-mono-num"
                  />
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">IPv4 / CIDR（可选）</label>
                <Input
                  value={fCidr}
                  onChange={(e) => setFCidr(e.target.value)}
                  placeholder="如 192.168.10.2/24"
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">IPv4 网关（可选）</label>
                <Input
                  value={fGateway}
                  onChange={(e) => setFGateway(e.target.value)}
                  placeholder="如 192.168.10.1"
                  className="font-mono-num"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">IPv6 / CIDR（可选）</label>
                <Input
                  value={fCidr6}
                  onChange={(e) => setFCidr6(e.target.value)}
                  placeholder="fe80::1/64"
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-xs font-medium">MTU（可选）</label>
                <Input
                  type="number"
                  min={576}
                  max={65520}
                  value={fMtu}
                  onChange={(e) => setFMtu(e.target.value)}
                  placeholder="1500 / 9000"
                  className="font-mono-num"
                />
              </div>
              <div className="flex items-end">
                <label className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs h-10">
                  <input
                    type="checkbox"
                    checked={fAutostart}
                    onChange={(e) => setFAutostart(e.target.checked)}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span>开机自启 (Autostart)</span>
                </label>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">备注说明（可选）</label>
              <Input
                value={fComments}
                onChange={(e) => setFComments(e.target.value)}
                placeholder="如 业务网桥 / 仅内部隔离通信"
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={saving}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? '暂存修改' : '暂存创建'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
              type: 'srvreload',
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
