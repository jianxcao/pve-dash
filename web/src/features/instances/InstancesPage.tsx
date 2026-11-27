import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Fingerprint,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Radio,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GlobalOverview, InstanceResponse } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { CAPABILITY_ITEMS } from '@/lib/capabilities'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { EmptyState } from '@/components/shared/EmptyState'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { InstanceFormDialog } from './InstanceFormDialog'

const selectInstanceLiveStates = (d: GlobalOverview) =>
  (d.instances ?? []).map((i) => ({
    id: i.id,
    state: i.state,
    error: i.error,
  }))

export function InstancesPage() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: liveInstances } = useOverviewQuery(selectInstanceLiveStates)
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const canManage = isAdmin && !readOnly
  const manageDisabledTitle = !isAdmin
    ? '仅管理员 (admin) 可管理实例连接'
    : readOnly
      ? '写保护已开启'
      : undefined
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId)
  const setSelectedInstanceId = useAppStore((s) => s.setSelectedInstanceId)

  const { data: listResp, isLoading } = useQuery({
    queryKey: ['instances'],
    queryFn: () => api.listInstances(),
  })

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<InstanceResponse | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InstanceResponse | null>(null)

  const instances = listResp?.items ?? []

  const openCreateModal = () => {
    setEditing(null)
    setDialogOpen(true)
  }

  const openEditModal = (inst: InstanceResponse) => {
    setEditing(inst)
    setDialogOpen(true)
  }

  useEffect(() => {
    if (searchParams.get('add') === '1') {
      if (canManage) {
        openCreateModal()
      }
      setSearchParams({})
    }
  }, [canManage, searchParams, setSearchParams])

  const refreshInstancesAndOverview = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['instances'] }),
      queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY }),
    ])
  }

  const handleProbeExisting = async (inst: InstanceResponse) => {
    setProbingId(inst.id)
    try {
      const res = await api.probeInstance(inst.id)
      if (res.ok) {
        toast.success(
          `${inst.name} 连接正常 · PVE ${res.version?.version || ''} (${res.nodes?.join(', ') || 'online'})`,
        )
      } else if (res.certMismatch) {
        toast.error(`证书指纹不匹配：请编辑 "${inst.name}" 核对并更新 TOFU 指纹`)
      } else {
        toast.error(`${inst.name} 探测失败：${res.error}`)
      }
      await refreshInstancesAndOverview()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '探测失败')
    } finally {
      setProbingId(null)
    }
  }

  return (
    <div className="mx-auto max-w-[1480px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">
            多 PVE 实例连接管理
          </h1>
          <p className="text-sm text-muted-foreground">
            支持接入多套单机 PVE 或多节点集群 · 内置多 Endpoint Failover、AES-256-GCM 凭据加密、TLS TOFU 指纹锁定与可选 SSH 宿主机硬件遥测
          </p>
        </div>
        <Button
          variant="default"
          size="md"
          disabled={!canManage}
          title={manageDisabledTitle}
          onClick={openCreateModal}
        >
          <Plus className="h-4 w-4" />
          添加 PVE 实例
        </Button>
      </div>

      {isLoading ? (
        <div className="h-48 animate-pulse rounded-xl border border-border bg-card" />
      ) : instances.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="尚未配置 Proxmox VE 实例"
          description="点击下方按钮添加你的第一台 Proxmox VE 主机，推荐使用 API Token + TOFU 指纹锁定模式。"
          action={
            <Button
              variant="default"
              size="md"
              disabled={!canManage}
              title={manageDisabledTitle}
              onClick={openCreateModal}
            >
              <Plus className="h-4 w-4" />
              添加第一个实例
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {instances.map((inst) => {
            const liveSnap = liveInstances?.find((i) => i.id === inst.id)
            const state = liveSnap?.state || (inst.enabled ? 'unknown' : 'disabled')
            const enabledFeatures = inst.capabilities
              ? CAPABILITY_ITEMS.filter((c) => inst.capabilities?.features[c.key])
              : []

            return (
              <Card key={inst.id} className="overflow-hidden">
                <div className="h-1 w-full" style={{ backgroundColor: inst.color }} />
                <CardContent className="p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-foreground">{inst.name}</h3>
                        <StatusBadge status={state} />
                        {inst.detectedVersion && (
                          <Badge variant="info" className="font-mono-num">
                            PVE {inst.detectedVersion}
                          </Badge>
                        )}
                        <Badge variant="muted">{inst.groupName}</Badge>
                        {inst.sshHost && (
                          <Badge variant="success" className="font-mono-num">
                            SSH 遥测: {inst.sshHost}
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="font-mono-num">
                          鉴权:{' '}
                          {inst.authMode === 'token'
                            ? `Token (${inst.tokenId || '—'})`
                            : inst.authMode === 'hybrid'
                              ? `混合 (${inst.tokenId} + Ticket)`
                              : `Ticket (${inst.ticketUsername || '—'})`}
                        </span>
                        <span>·</span>
                        <span className="inline-flex items-center gap-1">
                          {inst.tlsMode === 'tofu' ? (
                            <Fingerprint className="h-3 w-3 text-accent" />
                          ) : inst.tlsMode === 'strict' ? (
                            <ShieldCheck className="h-3 w-3 text-info" />
                          ) : (
                            <ShieldAlert className="h-3 w-3 text-warning" />
                          )}
                          TLS:{' '}
                          {inst.tlsMode === 'tofu'
                            ? 'TOFU 指纹锁定'
                            : inst.tlsMode === 'strict'
                              ? '严格 CA 校验'
                              : '跳过校验 (不安全)'}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={!isAdmin || probingId === inst.id}
                        title={!isAdmin ? '仅管理员 (admin) 可执行连接探测' : undefined}
                        onClick={() => handleProbeExisting(inst)}
                      >
                        {probingId === inst.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Radio className="h-3 w-3 text-accent" />
                        )}
                        探测
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        disabled={!canManage}
                        title={manageDisabledTitle}
                        onClick={() => openEditModal(inst)}
                      >
                        <Pencil className="h-3 w-3" />
                        编辑
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={!canManage}
                        title={manageDisabledTitle || `删除 ${inst.name}`}
                        aria-label={`删除 ${inst.name}`}
                        onClick={() => setDeleteTarget(inst)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </div>
                  </div>

                  {/* Endpoints list */}
                  <div className="space-y-1.5 rounded-lg border border-border/80 bg-background/60 p-2.5 text-xs">
                    <div className="text-[11px] font-medium text-muted-foreground">
                      接入端点 ({inst.endpoints.length} · 按优先级 Failover)
                    </div>
                    {inst.endpoints.map((ep) => (
                      <div key={ep.id || ep.url} className="space-y-0.5">
                        <div className="flex items-center justify-between gap-2 font-mono-num">
                          <span className="truncate text-foreground">{ep.url}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">
                            P{ep.priority}
                          </span>
                        </div>
                        {ep.certFingerprint && (
                          <div className="flex items-center gap-1 font-mono-num text-[10px] text-accent truncate">
                            <Fingerprint className="h-3 w-3 shrink-0" />
                            <span className="truncate">SHA256: {ep.certFingerprint}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  {liveSnap?.error && (
                    <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive break-all">
                      {liveSnap.error}
                    </div>
                  )}

                  {enabledFeatures.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1">
                      {enabledFeatures.map((cap) => (
                        <Badge key={cap.key} variant="muted" className="text-[10px]">
                          {cap.label}
                        </Badge>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {dialogOpen && (
        <InstanceFormDialog
          key={editing?.id || 'create'}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          editing={editing}
          readOnly={readOnly}
          onSaved={refreshInstancesAndOverview}
        />
      )}

      <DangerConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title={`移除 PVE 实例 "${deleteTarget?.name ?? ''}"`}
        description="仅从 PVE Dash 控制平面解除纳管并删除本地加密凭据，不会影响底层 Proxmox VE 服务器和虚拟机运行。"
        confirmTarget={deleteTarget?.name ?? ''}
        confirmLabel="确认移除实例"
        onConfirm={async () => {
          if (!deleteTarget) return
          const removedId = deleteTarget.id
          await api.deleteInstance(removedId)
          if (selectedInstanceId === removedId) {
            setSelectedInstanceId('all')
          }
          toast.success(`已移除实例 "${deleteTarget.name}"`)
          await refreshInstancesAndOverview()
        }}
      />
    </div>
  )
}
