import { useState } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Loader2,
  Plus,
  Radio,
  Shield,
  ShieldAlert,
  X,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { InstancePayload, InstanceResponse, ProbeResult } from '@/lib/api/types'
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

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

function normalizeFp(fp: string): string {
  return fp.trim().toUpperCase()
}

interface InstanceFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: InstanceResponse | null
  readOnly: boolean
  onSaved: () => Promise<void>
}

export function InstanceFormDialog({
  open,
  onOpenChange,
  editing,
  readOnly,
  onSaved,
}: InstanceFormDialogProps) {
  const [form, setForm] = useState<InstancePayload>(() =>
    editing ? toEditPayload(editing) : emptyPayload(),
  )
  const [probing, setProbing] = useState(false)
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)
  const [tofuConfirmed, setTofuConfirmed] = useState(() => {
    if (!editing) return false
    if (editing.tlsMode !== 'tofu') return true
    return (
      editing.endpoints.length > 0 &&
      editing.endpoints.every((ep) => Boolean(ep.certFingerprint?.trim()))
    )
  })
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const savedFpMap = new Map(
    (editing?.endpoints ?? [])
      .filter((ep) => ep.certFingerprint?.trim())
      .map((ep) => [normalizeUrl(ep.url), normalizeFp(ep.certFingerprint)]),
  )

  const updateEndpoint = (idx: number, patch: Partial<InstancePayload['endpoints'][number]>) => {
    setForm((prev) => {
      const nextEndpoints = prev.endpoints.map((ep, i) => (i === idx ? { ...ep, ...patch } : ep))
      if (patch.certFingerprint !== undefined || patch.url !== undefined) {
        const allStillMatchSaved = nextEndpoints
          .filter((ep) => ep.url.trim() && ep.url.trim() !== 'https://')
          .every((ep) => {
            const saved = savedFpMap.get(normalizeUrl(ep.url))
            return Boolean(saved && ep.certFingerprint && normalizeFp(ep.certFingerprint) === saved)
          })
        if (!allStillMatchSaved) {
          setTofuConfirmed(false)
        }
      }
      return { ...prev, endpoints: nextEndpoints }
    })
  }

  const addEndpoint = () => {
    setTofuConfirmed(false)
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
        const observedEntries = Object.entries(res.fingerprints)
        const allMatchSavedOrConfirmed =
          observedEntries.length > 0 &&
          observedEntries.every(([url, fp]) => {
            const clean = normalizeUrl(url)
            const normObs = normalizeFp(fp)
            const saved = savedFpMap.get(clean)
            if (saved && saved === normObs) return true
            const curEp = form.endpoints.find((e) => normalizeUrl(e.url) === clean)
            if (
              tofuConfirmed &&
              curEp?.certFingerprint &&
              normalizeFp(curEp.certFingerprint) === normObs
            ) {
              return true
            }
            return false
          })

        setForm((prev) => ({
          ...prev,
          endpoints: prev.endpoints.map((ep) => {
            const cleanUrl = normalizeUrl(ep.url)
            const observed = res.fingerprints?.[cleanUrl]
            if (observed && !ep.certFingerprint) {
              return { ...ep, certFingerprint: observed }
            }
            return ep
          }),
        }))
        setTofuConfirmed(allMatchSavedOrConfirmed)
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
    const clean = normalizeUrl(endpoint)
    setForm((prev) => ({
      ...prev,
      endpoints: prev.endpoints.map((ep) => {
        const epUrl = normalizeUrl(ep.url)
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
    const validEndpoints = form.endpoints.filter(
      (ep) => ep.url.trim() && ep.url.trim() !== 'https://',
    )
    if (validEndpoints.length === 0) {
      setFormError('请至少填写一个有效的 PVE 节点 HTTPS 地址（如 https://198.51.100.10:8006）')
      return
    }
    if (form.tlsMode === 'tofu') {
      const hasBlankFp = validEndpoints.some((ep) => !ep.certFingerprint.trim())
      if (hasBlankFp) {
        setFormError('TOFU 模式下请先点击「测试连接、探测版本能力并获取 TLS 指纹」以锁定证书指纹')
        return
      }
      if (!tofuConfirmed) {
        setFormError('请先勾选确认锁定 TLS TOFU 证书指纹')
        return
      }
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
      onOpenChange(false)
      await onSaved()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : '保存实例失败')
    } finally {
      setSaving(false)
    }
  }

  const hasAnyPinnedFp = form.endpoints.some((ep) => Boolean(ep.certFingerprint.trim()))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(95vw,680px)]">
        <DialogHeader>
          <DialogTitle>
            {editing ? `编辑 PVE 实例 · ${editing.name}` : '接入新的 Proxmox VE 实例'}
          </DialogTitle>
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
              <Button type="button" variant="outline" size="xs" onClick={addEndpoint}>
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
                      placeholder="https://198.51.100.10:8006"
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
                      onChange={(e) =>
                        updateEndpoint(idx, { priority: Number(e.target.value) || 10 })
                      }
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
                    placeholder={
                      editing?.hasTokenSecret
                        ? '••••••••-••••-••••-••••'
                        : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
                    }
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
              placeholder="例如：pve1 或 root@198.51.100.10（留空仅使用 PVE REST API）"
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
              </div>
            )}

            {form.tlsMode === 'tofu' && (probeResult?.ok || hasAnyPinnedFp) && (
              <label className="flex items-start gap-2 rounded-lg border border-border bg-background/60 p-2.5 text-xs font-medium text-foreground">
                <input
                  type="checkbox"
                  checked={tofuConfirmed}
                  onChange={(e) => setTofuConfirmed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>我已核对上述主机叶证书 SHA-256 指纹，确认采用 TOFU 模式永久锁定。</span>
              </label>
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
                <Button
                  type="button"
                  variant="warning"
                  size="xs"
                  onClick={acceptObservedFingerprint}
                >
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
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
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
  )
}
