import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Loader2,
  Pencil,
  Plug,
  Plus,
  Radio,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { InstancePayload, InstanceResponse, ProbeResult } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY, useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { CAPABILITY_ITEMS } from '@/lib/capabilities'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { StatusBadge } from '@/components/shared/StatusBadge'
import { EmptyState } from '@/components/shared/EmptyState'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { cn } from '@/lib/utils'

const PRESET_COLORS = ['#38BDF8', '#34D399', '#FBBF24', '#60A5FA', '#22D3EE', '#FB7185', '#F97316']

function emptyPayload(): InstancePayload {
  return {
    name: '',
    groupName: 'default',
    color: '#38BDF8',
    authMode: 'token',
    tokenId: '',
    tokenSecret: '',
    ticketUsername: '',
    ticketPassword: '',
    tlsMode: 'tofu',
    caCertPem: '',
    sshHost: '',
    enabled: true,
    endpoints: [{ nodeName: '', url: 'https://', priority: 10, certFingerprint: '' }],
  }
}

function toEditPayload(inst: InstanceResponse): InstancePayload {
  return {
    name: inst.name,
    groupName: inst.groupName || 'default',
    color: inst.color || '#38BDF8',
    authMode: (inst.authMode as InstancePayload['authMode']) || 'token',
    tokenId: inst.tokenId || '',
    tokenSecret: '',
    ticketUsername: inst.ticketUsername || '',
    ticketPassword: '',
    tlsMode: (inst.tlsMode as InstancePayload['tlsMode']) || 'tofu',
    caCertPem: inst.caCertPem || '',
    sshHost: inst.sshHost || '',
    enabled: inst.enabled,
    endpoints:
      inst.endpoints && inst.endpoints.length > 0
        ? inst.endpoints.map((ep) => ({
            id: ep.id,
            nodeName: ep.nodeName || '',
            url: ep.url,
            priority: ep.priority,
            certFingerprint: ep.certFingerprint || '',
          }))
        : [{ nodeName: '', url: 'https://', priority: 10, certFingerprint: '' }],
  }
}

export function InstancesPage() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const { data: overview } = useOverviewQuery()
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
  const [form, setForm] = useState<InstancePayload>(emptyPayload)
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [tofuConfirmed, setTofuConfirmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [probingId, setProbingId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<InstanceResponse | null>(null)

  const instances = listResp?.items ?? []

  useEffect(() => {
    if (searchParams.get('add') === '1') {
      if (canManage) {
        openCreateModal()
      }
      setSearchParams({})
    }
  }, [canManage, searchParams, setSearchParams])

  const openCreateModal = () => {
    setEditing(null)
    setForm(emptyPayload())
    setProbeResult(null)
    setTofuConfirmed(false)
    setFormError(null)
    setDialogOpen(true)
  }

  const openEditModal = (inst: InstanceResponse) => {
    setEditing(inst)
    setForm(toEditPayload(inst))
    setProbeResult(null)
    setTofuConfirmed(true)
    setFormError(null)
    setDialogOpen(true)
  }

  const updateEndpoint = (idx: number, patch: Partial<InstancePayload['endpoints'][number]>) => {
    setForm((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((ep, i) => (i === idx ? { ...ep, ...patch } : ep)),
    }))
  }

  const addEndpoint = () => {
    setForm((prev) => ({
      ...prev,
      endpoints: [
        ...prev.endpoints,
        {
          nodeName: '',
          url: 'https://',
          priority: (prev.endpoints.length + 1) * 10,
          certFingerprint: '',
        },
      ],
    }))
  }

  const removeEndpoint = (idx: number) => {
    setForm((prev) => ({
      ...prev,
      endpoints: prev.endpoints.filter((_, i) => i !== idx),
    }))
  }

  const handleProbeForm = async () => {
    setFormError(null)
    setProbing(true)
    try {
      const res = await api.probeAdhoc({
        ...form,
        instanceId: editing?.id,
      })
      setProbeResult(res)
      if (res.ok && res.fingerprints) {
        // Fill observed fingerprints for endpoints that don't have one pinned yet
        setForm((prev) => ({
          ...prev,
          endpoints: prev.endpoints.map((ep) => {
            const cleanUrl = ep.url.trim().replace(/\/+$/, '')
            const observed = res.fingerprints?.[cleanUrl]
            if (observed && !ep.certFingerprint) {
              return { ...ep, certFingerprint: observed }
            }
            return ep
          }),
        }))
        setTofuConfirmed(false)
        toast.success(`探测成功：Proxmox VE ${res.version?.version || ''}`)
      } else if (res.certMismatch) {
        toast.warning('检测到证书指纹变更，请核对后决定是否信任新指纹')
      } else {
        toast.error(res.error || '探测失败')
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '探测请求失败')
    } finally {
      setProbing(false)
    }
  }

  const acceptObservedFingerprint = () => {
    if (!probeResult?.certMismatch) return
    const { endpoint, observedFingerprint } = probeResult.certMismatch
    const clean = endpoint.replace(/\/+$/, '')
    setForm((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((ep) => {
        const epUrl = ep.url.trim().replace(/\/+$/, '')
        return epUrl === clean || prev.endpoints.length === 1
          ? { ...ep, certFingerprint: observedFingerprint }
          : ep
      }),
    }))
    setProbeResult(null)
    setTofuConfirmed(true)
    toast.success('已填入最新 SHA-256 指纹，请重新点击探测或直接保存')
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)

    if (!form.name.trim()) {
      setFormError('请填写实例名称')
      return
    }
    const validEndpoints = form.endpoints.filter((ep) => ep.url.trim() && ep.url.trim() !== 'https://')
    if (validEndpoints.length === 0) {
      setFormError('请至少填写一个有效的 PVE 节点 HTTPS 地址（如 https://192.168.1.10:8006）')
      return
    }
    if (form.tlsMode === 'tofu' && probeResult?.ok && !tofuConfirmed) {
      setFormError('请先勾选确认锁定探测到的 TLS TOFU 证书指纹')
      return
    }

    setSaving(true)
    try {
      const payload: InstancePayload = { ...form, endpoints: validEndpoints }
      if (editing) {
        await api.updateInstance(editing.id, payload)
        toast.success(`已更新实例 "${payload.name}"`)
      } else {
        await api.createInstance(payload)
        toast.success(`已添加实例 "${payload.name}"`)
      }
      setDialogOpen(false)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['instances'] }),
        queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY }),
      ])
    } catch (err) {
      // Strictly keep all entered values intact on error!
      setFormError(err instanceof Error ? err.message : '保存实例失败')
    } finally {
      setSaving(false)
    }
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
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['instances'] }),
        queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY }),
      ])
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
            const liveSnap = overview?.instances.find((i) => i.id === inst.id)
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

      {/* Add / Edit Instance Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[min(95vw,680px)]">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑 PVE 实例 · ${editing.name}` : '接入新的 Proxmox VE 实例'}</DialogTitle>
            <DialogDescription>
              凭据仅保存于本地后端并经 AES-256-GCM 加密，浏览器端永不暴露明文 Secret。
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSave} className="space-y-4">
            {/* Basic Info */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
              <div className="sm:col-span-5 space-y-1">
                <label className="block text-xs font-medium">实例名称 *</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                  placeholder="例如：Homelab-PVE1"
                  required
                />
              </div>
              <div className="sm:col-span-4 space-y-1">
                <label className="block text-xs font-medium">分组</label>
                <Input
                  value={form.groupName}
                  onChange={(e) => setForm((p) => ({ ...p, groupName: e.target.value }))}
                  placeholder="home / prod"
                />
              </div>
              <div className="sm:col-span-3 space-y-1">
                <label className="block text-xs font-medium">启用状态</label>
                <div className="flex h-9 items-center gap-2">
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(checked) => setForm((p) => ({ ...p, enabled: checked }))}
                  />
                  <span className="text-xs text-muted-foreground">
                    {form.enabled ? '已启用' : '已禁用'}
                  </span>
                </div>
              </div>
            </div>

            {/* Color Swatches */}
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">标识色</label>
              <div className="flex flex-wrap items-center gap-2">
                {PRESET_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, color: c }))}
                    className={cn(
                      'h-6 w-6 rounded-full border-2 transition-transform',
                      form.color === c ? 'border-foreground scale-110' : 'border-transparent',
                    )}
                    style={{ backgroundColor: c }}
                    aria-label={`选择颜色 ${c}`}
                  />
                ))}
              </div>
            </div>

            {/* Endpoints (Failover) */}
            <div className="space-y-2 rounded-lg border border-border bg-background/50 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">节点接入端点 (支持集群多节点 Failover)</span>
                <Button variant="outline" size="xs" onClick={addEndpoint}>
                  <Plus className="h-3 w-3" />
                  添加备用端点
                </Button>
              </div>

              {form.endpoints.map((ep, idx) => (
                <div key={idx} className="space-y-1.5 rounded-md border border-border/70 bg-card p-2.5">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 items-center">
                    <div className="sm:col-span-7">
                      <Input
                        value={ep.url}
                        onChange={(e) => updateEndpoint(idx, { url: e.target.value })}
                        placeholder="https://192.168.1.10:8006"
                        className="font-mono-num h-8 text-xs"
                        required
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <Input
                        value={ep.nodeName}
                        onChange={(e) => updateEndpoint(idx, { nodeName: e.target.value })}
                        placeholder="节点别名 (可选)"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="sm:col-span-2 flex items-center gap-1">
                      <Input
                        type="number"
                        value={ep.priority}
                        onChange={(e) => updateEndpoint(idx, { priority: Number(e.target.value) || 10 })}
                        className="font-mono-num h-8 text-xs"
                        title="优先级（数字越小越优先）"
                      />
                      {form.endpoints.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removeEndpoint(idx)}
                          className="rounded p-1 text-muted-foreground hover:text-destructive"
                          aria-label="移除端点"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                  {ep.certFingerprint && (
                    <div className="flex items-center justify-between gap-2 text-[10px] font-mono-num text-accent">
                      <span className="truncate">已锁定 SHA256: {ep.certFingerprint}</span>
                      <button
                        type="button"
                        onClick={() => updateEndpoint(idx, { certFingerprint: '' })}
                        className="text-muted-foreground hover:text-destructive shrink-0"
                      >
                        清除指纹
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>

            {/* Auth Mode */}
            <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">认证方式</span>
                <div className="inline-flex rounded-md border border-border bg-muted/60 p-0.5">
                  {(
                    [
                      ['token', 'API Token (推荐)'],
                      ['hybrid', 'Token + 账密回退'],
                      ['ticket', '账号密码 (Ticket)'],
                    ] as const
                  ).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setForm((p) => ({ ...p, authMode: mode }))}
                      className={cn(
                        'rounded px-2 py-1 text-[11px] font-medium transition-colors',
                        form.authMode === mode
                          ? 'bg-card text-foreground shadow-xs'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {(form.authMode === 'token' || form.authMode === 'hybrid') && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="block text-[11px] text-muted-foreground">
                      Token ID (user@realm!tokenid)
                    </label>
                    <Input
                      value={form.tokenId}
                      onChange={(e) => setForm((p) => ({ ...p, tokenId: e.target.value }))}
                      placeholder="root@pam!pve-dash"
                      className="font-mono-num text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] text-muted-foreground">
                      Token Secret {editing?.hasTokenSecret ? '(已加密保存，留空保持不变)' : ''}
                    </label>
                    <Input
                      type="password"
                      value={form.tokenSecret}
                      onChange={(e) => setForm((p) => ({ ...p, tokenSecret: e.target.value }))}
                      placeholder={editing?.hasTokenSecret ? '••••••••-••••-••••-••••' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'}
                      className="font-mono-num text-xs"
                    />
                  </div>
                </div>
              )}

              {(form.authMode === 'ticket' || form.authMode === 'hybrid') && (
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="block text-[11px] text-muted-foreground">
                      PVE 用户名 (如 root@pam)
                    </label>
                    <Input
                      value={form.ticketUsername}
                      onChange={(e) => setForm((p) => ({ ...p, ticketUsername: e.target.value }))}
                      placeholder="root@pam"
                      className="font-mono-num text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="block text-[11px] text-muted-foreground">
                      PVE 密码 {editing?.hasTicketPassword ? '(已保存，留空不变)' : ''}
                    </label>
                    <Input
                      type="password"
                      value={form.ticketPassword}
                      onChange={(e) => setForm((p) => ({ ...p, ticketPassword: e.target.value }))}
                      placeholder="••••••••"
                      className="text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* TLS Policy */}
            <div className="space-y-2.5 rounded-lg border border-border bg-background/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-xs font-semibold">
                  <Shield className="h-3.5 w-3.5 text-accent" />
                  TLS 证书校验策略
                </span>
                <NativeSelect
                  value={form.tlsMode}
                  onChange={(e) =>
                    setForm((p) => ({
                      ...p,
                      tlsMode: e.target.value as InstancePayload['tlsMode'],
                    }))
                  }
                  className="h-8 text-xs"
                >
                  <option value="tofu">TOFU 首次信任并锁定 SHA-256 指纹（推荐）</option>
                  <option value="strict">严格校验（系统根证书或自定义 CA）</option>
                  <option value="insecure">跳过证书校验（仅限内网临时测试）</option>
                </NativeSelect>
              </div>

              {form.tlsMode === 'strict' && (
                <div className="space-y-1">
                  <label className="block text-[11px] text-muted-foreground">
                    自定义 CA 证书 PEM（可选，留空使用系统根证书）
                  </label>
                  <Textarea
                    value={form.caCertPem}
                    onChange={(e) => setForm((p) => ({ ...p, caCertPem: e.target.value }))}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    className="font-mono-num text-[11px]"
                    rows={3}
                  />
                </div>
              )}

              {form.tlsMode === 'insecure' && (
                <div className="flex items-center gap-2 rounded border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  <span>跳过 TLS 校验存在中间人攻击风险，建议改用 TOFU 模式锁定自签名证书指纹。</span>
                </div>
              )}
            </div>

            {/* Optional SSH Hardware Telemetry Host */}
            <div className="space-y-2 rounded-lg border border-border bg-background/50 p-3.5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">宿主机 SSH 硬件遥测目标（可选）</span>
                <Badge variant="muted">GPU 实时频率/功耗 + 缺包诊断</Badge>
              </div>
              <Input
                value={form.sshHost || ''}
                onChange={(e) => setForm((p) => ({ ...p, sshHost: e.target.value }))}
                placeholder="例如：pve1 或 root@192.168.1.10（留空仅使用 PVE REST API）"
                className="font-mono-num text-xs"
              />
              <p className="text-xs text-muted-foreground">
                配置免密 SSH 主机后，节点页可实时采集未直通 Intel/NVIDIA/AMD 显卡频率、占用与功耗，并自动检测宿主机是否缺少监测软件包。
              </p>
            </div>

            {/* Connection Probe & TOFU Confirmation Box */}
            <div className="space-y-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full"
                disabled={probing}
                onClick={handleProbeForm}
              >
                {probing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radio className="h-3.5 w-3.5 text-accent" />
                )}
                <span>测试连接、探测版本能力并获取 TLS 指纹</span>
              </Button>

              {probeResult?.ok && (
                <div className="rounded-lg border border-accent/45 bg-accent/10 p-3 space-y-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2 font-medium text-accent">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    <span>
                      探测成功：Proxmox VE {probeResult.version?.version} (
                      {probeResult.capabilities?.isCluster
                        ? `集群 ${probeResult.clusterName || ''}`
                        : '单机'}
                      )
                    </span>
                  </div>
                  {probeResult.nodes && probeResult.nodes.length > 0 && (
                    <div className="text-[11px] text-foreground">
                      发现节点：<span className="font-mono-num">{probeResult.nodes.join(', ')}</span>
                    </div>
                  )}
                  {probeResult.fingerprints &&
                    Object.entries(probeResult.fingerprints).map(([url, fp]) => (
                      <div
                        key={url}
                        className="rounded border border-border bg-background/80 p-2 font-mono-num text-[10px] space-y-0.5"
                      >
                        <div className="text-muted-foreground">{url}</div>
                        <div className="text-accent break-all">SHA-256: {fp}</div>
                      </div>
                    ))}

                  {form.tlsMode === 'tofu' && (
                    <label className="flex items-start gap-2 pt-1 text-xs font-medium text-foreground">
                      <input
                        type="checkbox"
                        checked={tofuConfirmed}
                        onChange={(e) => setTofuConfirmed(e.target.checked)}
                        className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span>我已核对上述主机叶证书 SHA-256 指纹，确认采用 TOFU 模式永久锁定。</span>
                    </label>
                  )}
                </div>
              )}

              {probeResult && !probeResult.ok && probeResult.certMismatch && (
                <div className="rounded-lg border border-warning/60 bg-warning/10 p-3 space-y-2 text-xs">
                  <div className="flex items-center gap-2 font-semibold text-warning">
                    <ShieldAlert className="h-4 w-4 shrink-0" />
                    <span>检测到 TLS 证书指纹变更 ({probeResult.certMismatch.endpoint})</span>
                  </div>
                  <div className="space-y-1 font-mono-num text-[10px]">
                    <div className="text-muted-foreground break-all">
                      预期锁定：{probeResult.certMismatch.expectedFingerprint}
                    </div>
                    <div className="text-warning break-all">
                      本次观测：{probeResult.certMismatch.observedFingerprint}
                    </div>
                  </div>
                  <Button type="button" variant="warning" size="xs" onClick={acceptObservedFingerprint}>
                    <Fingerprint className="h-3.5 w-3.5" />
                    确认并更新为最新指纹
                  </Button>
                </div>
              )}

              {probeResult && !probeResult.ok && !probeResult.certMismatch && (
                <div className="rounded-lg border border-destructive/45 bg-destructive/15 px-3 py-2 text-xs text-destructive break-all">
                  探测失败：{probeResult.error}
                </div>
              )}
            </div>

            {formError && (
              <div className="rounded-lg border border-destructive/45 bg-destructive/15 px-3 py-2 text-xs text-destructive">
                {formError}
              </div>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
                取消
              </Button>
              <Button type="submit" variant="default" disabled={saving || readOnly}>
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                {editing ? '保存变更' : '保存并接入实例'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

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
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['instances'] }),
            queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY }),
          ])
        }}
      />
    </div>
  )
}
