import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Edit3,
  HeartPulse,
  Info,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GlobalOverview, HAResource } from '@/lib/api/types'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
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

interface HaPanelProps {
  instanceId: string
}

function haStateVariant(state?: string): 'success' | 'warning' | 'destructive' | 'muted' {
  switch ((state || '').toLowerCase()) {
    case 'started':
    case 'enabled':
      return 'success'
    case 'stopped':
    case 'disabled':
      return 'muted'
    case 'ignored':
      return 'warning'
    case 'error':
      return 'destructive'
    default:
      return 'muted'
  }
}

const selectHaGuests = (d: GlobalOverview) =>
  (d.guests ?? []).map((g) => ({
    instanceId: g.instanceId,
    node: g.node,
    type: g.type,
    vmid: g.vmid,
    name: g.name,
    template: g.template,
  }))

export function HaPanel({ instanceId }: HaPanelProps) {
  const { data: overviewGuests } = useOverviewQuery(selectHaGuests)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['ha', instanceId],
    queryFn: () => api.getHA(instanceId),
    enabled: Boolean(instanceId),
  })

  const instanceGuests = useMemo(
    () =>
      (overviewGuests ?? [])
        .filter((g) => g.instanceId === instanceId && !g.template)
        .sort((a, b) => a.vmid - b.vmid),
    [overviewGuests, instanceId],
  )

  const guestMap = useMemo(() => {
    const m = new Map<string, (typeof instanceGuests)[number]>()
    for (const g of instanceGuests) {
      const sid = `${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`
      m.set(sid, g)
    }
    return m
  }, [instanceGuests])

  const resources = data?.resources ?? []
  const groups = data?.groups ?? []
  const rules = data?.rules ?? []
  const statusItems = data?.status ?? []
  const haMode = data?.haMode ?? 'groups'

  const managedSids = useMemo(() => new Set(resources.map((r) => r.sid)), [resources])
  const availableGuests = useMemo(
    () =>
      instanceGuests.filter((g) => !managedSids.has(`${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`)),
    [instanceGuests, managedSids],
  )

  const quorumItem = statusItems.find((s) => s.type === 'quorum')
  const masterItem = statusItems.find((s) => s.type === 'master')
  const lrmItems = statusItems.filter((s) => s.type === 'lrm')

  // Create / Edit Modal
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<HAResource | null>(null)
  const [fSid, setFSid] = useState('')
  const [fState, setFState] = useState('started')
  const [fGroup, setFGroup] = useState('')
  const [fMaxRestart, setFMaxRestart] = useState('1')
  const [fMaxRelocate, setFMaxRelocate] = useState('1')
  const [fComment, setFComment] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<HAResource | null>(null)

  useEffect(() => {
    setModalOpen(false)
    setEditing(null)
    setDeleteTarget(null)
  }, [instanceId])

  useEffect(() => {
    if (modalOpen && !editing && !fSid && availableGuests.length > 0) {
      const first = availableGuests[0]
      setFSid(`${first.type === 'lxc' ? 'ct' : 'vm'}:${first.vmid}`)
    }
  }, [modalOpen, editing, fSid, availableGuests])

  const openCreate = () => {
    setEditing(null)
    const first = availableGuests[0]
    setFSid(first ? `${first.type === 'lxc' ? 'ct' : 'vm'}:${first.vmid}` : '')
    setFState('started')
    setFGroup('')
    setFMaxRestart('1')
    setFMaxRelocate('1')
    setFComment('')
    setModalOpen(true)
  }

  const openEdit = (res: HAResource) => {
    setEditing(res)
    setFSid(res.sid)
    setFState(res.state === 'enabled' ? 'started' : res.state || 'started')
    setFGroup(res.group || '')
    setFMaxRestart(String(res.max_restart ?? 1))
    setFMaxRelocate(String(res.max_relocate ?? 1))
    setFComment(res.comment || '')
    setModalOpen(true)
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !instanceId) return
    const targetInstId = instanceId
    const mr = Number(fMaxRestart)
    const mrel = Number(fMaxRelocate)
    if (!Number.isInteger(mr) || mr < 0 || mr > 10 || !Number.isInteger(mrel) || mrel < 0 || mrel > 10) {
      toast.error('最大重启次数与最大迁移次数必须在 0–10 之间')
      return
    }
    setSaving(true)
    try {
      if (editing) {
        const del: string[] = []
        if (haMode === 'groups' && editing.group && !fGroup.trim()) del.push('group')
        if (editing.comment && !fComment.trim()) del.push('comment')
        await api.updateHAResource(targetInstId, editing.sid, {
          state: fState,
          group: haMode === 'groups' ? fGroup.trim() || undefined : undefined,
          maxRestart: mr,
          maxRelocate: mrel,
          comment: fComment.trim() || undefined,
          digest: editing.digest,
          delete: del.length > 0 ? del : undefined,
        })
        toast.success(`HA 资源 ${editing.sid} 已更新`)
      } else {
        if (!fSid.trim()) {
          toast.error('请选择要纳管 HA 的虚拟机或容器')
          setSaving(false)
          return
        }
        await api.createHAResource(targetInstId, {
          sid: fSid.trim(),
          state: fState,
          group: haMode === 'groups' ? fGroup.trim() || undefined : undefined,
          maxRestart: mr,
          maxRelocate: mrel,
          comment: fComment.trim() || undefined,
        })
        toast.success(`已将 ${fSid.trim()} 纳入 HA 高可用保护`)
      }
      setModalOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['ha', targetInstId] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存 HA 资源失败')
    } finally {
      setSaving(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载 HA 高可用状态失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !data) {
    return <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
  }

  return (
    <div className="space-y-5">
      {data && !data.isCluster && (
        <div className="rounded-xl border border-info/35 bg-info/10 px-4 py-3.5 text-xs text-foreground flex items-start gap-2.5">
          <Info className="h-4 w-4 text-info shrink-0 mt-0.5" />
          <div>
            当前实例为单节点模式（未加入多节点 Corosync 集群）。HA 自动故障转移通常需要 3 个及以上集群节点维持仲裁（Quorum）；单节点下仍可查看或预编排 HA 策略。
          </div>
        </div>
      )}

      {data?.warnings && Object.keys(data.warnings).length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            部分 HA 状态采集受限（{Object.keys(data.warnings).join('、')}）：
            {Object.values(data.warnings).join('；')}
          </div>
        </div>
      )}

      {/* Quorum & CRM/LRM Status Summary */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="p-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>仲裁状态 (Quorum)</span>
              <HeartPulse className="h-4 w-4 text-accent" />
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  quorumItem?.quorate === true
                    ? 'success'
                    : quorumItem?.quorate === false
                      ? 'destructive'
                      : 'muted'
                }
              >
                {quorumItem?.quorate === true
                  ? 'OK · 已达成仲裁'
                  : quorumItem?.quorate === false
                    ? '失去仲裁'
                    : '单节点 / 未启用'}
              </Badge>
            </div>
            <div className="font-mono-num text-xs text-muted-foreground truncate">
              {quorumItem?.status || '—'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>CRM 主控节点 (Master)</span>
              <Server className="h-4 w-4 text-info" />
            </div>
            <div className="font-mono-num text-base font-semibold text-foreground">
              {masterItem?.node || '—'}
            </div>
            <div className="font-mono-num text-xs text-muted-foreground truncate">
              {masterItem?.status || '无活跃 CRM Master'}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>本地资源管理器 (LRM) & 策略模式</span>
              <Activity className="h-4 w-4 text-success" />
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="accent" className="font-mono-num">
                {haMode === 'rules' ? 'PVE 9+ HA Rules' : 'HA Groups'}
              </Badge>
              <Badge variant="muted" className="font-mono-num">
                LRM {lrmItems.length} 节点
              </Badge>
            </div>
            <div className="font-mono-num text-xs text-muted-foreground truncate">
              {lrmItems.length > 0
                ? lrmItems.map((l) => `${l.node}: ${l.status || 'active'}`).join(' · ')
                : '暂无 LRM 心跳'}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* HA Managed Resources Table */}
      <Card className="overflow-hidden">
        <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CheckCircle2 className="h-4 w-4 text-accent" />
            <span>受管 HA 资源 ({resources.length})</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={readOnly || !instanceId}
              title={readOnly ? '写保护已开启' : '将 VM 或 LXC 纳入 HA 保护'}
              onClick={openCreate}
            >
              <Plus className="h-4 w-4" />
              纳管 HA 资源
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="刷新 HA 状态"
            >
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {resources.length === 0 ? (
            <EmptyState
              icon={HeartPulse}
              title="暂无 HA 受管虚拟机或容器"
              description="纳管后当宿主机宕机时，Proxmox HA 管理器可按最大重启/迁移策略自动在集群健康节点拉起实例。"
              action={
                !readOnly && availableGuests.length > 0 ? (
                  <Button variant="outline" size="sm" onClick={openCreate}>
                    <Plus className="h-4 w-4" />
                    添加首个 HA 资源
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-muted/60 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">资源 SID</th>
                    <th className="px-4 py-2.5 font-medium">目标状态</th>
                    {haMode === 'groups' && <th className="px-4 py-2.5 font-medium">HA 分组</th>}
                    <th className="px-4 py-2.5 font-medium">最大重启 / 迁移</th>
                    <th className="px-4 py-2.5 font-medium">备注</th>
                    <th className="px-4 py-2.5 font-medium text-right">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {resources.map((res) => {
                    const g = guestMap.get(res.sid)
                    return (
                      <tr key={res.sid} className="hover:bg-muted/35">
                        <td className="px-4 py-3 whitespace-nowrap">
                          {g ? (
                            <button
                              type="button"
                              onClick={() =>
                                navigate(`/instances/${g.instanceId}/nodes/${g.node}/${g.type}/${g.vmid}`)
                              }
                              className="inline-flex items-center gap-2 font-mono-num font-semibold text-foreground hover:text-accent"
                            >
                              <span>{res.sid}</span>
                              <span className="font-sans text-xs font-normal text-muted-foreground">
                                {g.name} ({g.node})
                              </span>
                            </button>
                          ) : (
                            <span className="font-mono-num font-semibold text-foreground">
                              {res.sid}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          <Badge variant={haStateVariant(res.state)} className="font-mono-num">
                            {res.state || 'started'}
                          </Badge>
                        </td>
                        {haMode === 'groups' && (
                          <td className="px-4 py-3 font-mono-num text-sm text-muted-foreground">
                            {res.group || '默认'}
                          </td>
                        )}
                        <td className="px-4 py-3 font-mono-num text-sm text-foreground">
                          重启 {res.max_restart ?? 1} / 迁移 {res.max_relocate ?? 1}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground max-w-[240px] truncate">
                          {res.comment || '—'}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly}
                              title={readOnly ? '写保护已开启' : `编辑 ${res.sid}`}
                              onClick={() => openEdit(res)}
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              disabled={readOnly}
                              title={readOnly ? '写保护已开启' : `移出 HA ${res.sid}`}
                              onClick={() => setDeleteTarget(res)}
                            >
                              <Trash2 className="h-3.5 w-3.5 text-destructive" />
                            </Button>
                          </div>
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

      {/* HA Groups (PVE 7/8) or HA Rules (PVE 9+) */}
      <Card>
        <CardHeader className="py-3.5 border-b border-border/70">
          <CardTitle className="flex items-center gap-2 text-base">
            <Layers className="h-4 w-4 text-info" />
            <span>
              {haMode === 'rules'
                ? `HA 亲和与节点规则 (PVE 9+ Rules · ${rules.length})`
                : `HA 节点分组 (Groups · ${groups.length})`}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          {haMode === 'rules' ? (
            rules.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                当前集群尚未配置 PVE 9 HA 亲和性或节点限制规则。
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {rules.map((r) => (
                  <div
                    key={r.rule}
                    className="min-w-0 rounded-lg border border-border bg-background/50 p-3.5 text-sm space-y-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono-num font-semibold text-foreground truncate">{r.rule}</span>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Badge variant="accent" className="font-mono-num">
                          {r.type}
                        </Badge>
                        {r.disable && <Badge variant="warning">已禁用</Badge>}
                      </div>
                    </div>
                    {r.nodes && (
                      <div className="font-mono-num text-xs text-muted-foreground break-all">节点: {r.nodes}</div>
                    )}
                    {r.resources && (
                      <div className="font-mono-num text-xs text-muted-foreground break-all">资源: {r.resources}</div>
                    )}
                    {r.comment && <div className="text-xs text-muted-foreground break-words">{r.comment}</div>}
                  </div>
                ))}
              </div>
            )
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">当前集群尚未配置 HA 节点分组。</p>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {groups.map((grp) => (
                <div
                  key={grp.group}
                  className="min-w-0 rounded-lg border border-border bg-background/50 p-3.5 text-sm space-y-1.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono-num font-semibold text-foreground truncate">{grp.group}</span>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {grp.restricted && <Badge variant="warning">Restricted</Badge>}
                      {grp.nofailback && <Badge variant="muted">NoFailback</Badge>}
                    </div>
                  </div>
                  <div className="font-mono-num text-xs text-muted-foreground break-all">节点优先级: {grp.nodes}</div>
                  {grp.comment && <div className="text-xs text-muted-foreground break-words">{grp.comment}</div>}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit HA Resource Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 HA 资源 · ${editing.sid}` : '纳管 HA 高可用资源'}</DialogTitle>
            <DialogDescription>
              配置实例的期望运行状态、最大自动重启次数与故障迁移次数。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-3.5">
            {!editing && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">选择虚拟机 / LXC 容器</label>
                {availableGuests.length > 0 ? (
                  <NativeSelect
                    value={fSid}
                    onChange={(e) => setFSid(e.target.value)}
                    className="w-full"
                    required
                  >
                    {availableGuests.map((g) => {
                      const sid = `${g.type === 'lxc' ? 'ct' : 'vm'}:${g.vmid}`
                      return (
                        <option key={sid} value={sid}>
                          {sid} · {g.name} ({g.node})
                        </option>
                      )
                    })}
                  </NativeSelect>
                ) : (
                  <Input
                    value={fSid}
                    onChange={(e) => setFSid(e.target.value)}
                    placeholder="如 vm:100 或 ct:101"
                    className="font-mono-num"
                    required
                  />
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <label className="block text-sm font-medium">期望运行状态 (Request State)</label>
              <NativeSelect
                value={fState}
                onChange={(e) => setFState(e.target.value)}
                className="w-full"
              >
                <option value="started">started（保持运行）</option>
                <option value="stopped">stopped（保持停止）</option>
                <option value="disabled">disabled（禁用 HA 控制）</option>
                <option value="ignored">ignored（暂时忽略）</option>
              </NativeSelect>
            </div>

            {haMode === 'groups' && (
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">HA 节点分组（可选）</label>
                <NativeSelect
                  value={fGroup}
                  onChange={(e) => setFGroup(e.target.value)}
                  className="w-full"
                >
                  <option value="">不限定分组</option>
                  {fGroup && !groups.some((g) => g.group === fGroup) && (
                    <option value={fGroup}>{fGroup}</option>
                  )}
                  {groups.map((grp) => (
                    <option key={grp.group} value={grp.group}>
                      {grp.group} ({grp.nodes})
                    </option>
                  ))}
                </NativeSelect>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">最大重启次数 (0–10)</label>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={fMaxRestart}
                  onChange={(e) => setFMaxRestart(e.target.value)}
                  className="font-mono-num"
                />
              </div>
              <div className="space-y-1.5">
                <label className="block text-sm font-medium">最大迁移次数 (0–10)</label>
                <Input
                  type="number"
                  min={0}
                  max={10}
                  value={fMaxRelocate}
                  onChange={(e) => setFMaxRelocate(e.target.value)}
                  className="font-mono-num"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-sm font-medium">备注说明（可选）</label>
              <Input
                value={fComment}
                onChange={(e) => setFComment(e.target.value)}
                placeholder="如 核心网关 / 数据库"
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" variant="primary" disabled={saving || readOnly}>
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editing ? '保存变更' : '加入 HA'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete HA Resource Confirm */}
      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`移出 HA 保护 · ${deleteTarget?.sid ?? ''}`}
        description="确认将该实例从 Proxmox HA 资源管理中移除？（仅解除高可用托管，不会停止或删除虚拟机本体）"
        confirmTarget={deleteTarget?.sid ?? ''}
        confirmLabel="确认移出 HA"
        onConfirm={async () => {
          if (!deleteTarget || !instanceId) return
          const targetInstId = instanceId
          await api.deleteHAResource(targetInstId, deleteTarget.sid)
          toast.success(`已将 ${deleteTarget.sid} 移出 HA 管理`)
          void queryClient.invalidateQueries({ queryKey: ['ha', targetInstId] })
        }}
      />
    </div>
  )
}
