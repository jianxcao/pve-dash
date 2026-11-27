import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  FileKey2,
  Globe,
  KeyRound,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { useAppStore } from '@/stores/appStore'
import { copyToClipboard, formatDateTime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DangerConfirmDialog } from '@/components/shared/DangerConfirmDialog'
import { cn } from '@/lib/utils'

interface NodeCertificatesPanelProps {
  instanceId: string
  instanceName: string
  node: string
}

function certExpiryBadge(notAfterSec: number) {
  if (!notAfterSec) return { label: '未知到期', variant: 'muted' as const }
  const daysLeft = Math.floor((notAfterSec * 1000 - Date.now()) / (86400 * 1000))
  if (daysLeft < 0) return { label: `已过期 ${Math.abs(daysLeft)} 天`, variant: 'destructive' as const }
  if (daysLeft <= 30) return { label: `剩余 ${daysLeft} 天`, variant: 'warning' as const }
  return { label: `剩余 ${daysLeft} 天`, variant: 'success' as const }
}

const ADMIN_HOST_ONLY_TITLE = '仅管理员 (admin) 可执行宿主机级高危操作'

export function NodeCertificatesPanel({
  instanceId,
  instanceName,
  node,
}: NodeCertificatesPanelProps) {
  const queryClient = useQueryClient()
  const isAdmin = useAppStore((s) => s.currentUser?.role === 'admin')
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)
  const canMutate = isAdmin && !readOnly
  const openTaskLog = useAppStore((s) => s.openTaskLog)

  const [renewOpen, setRenewOpen] = useState(false)
  const [forceRenew, setForceRenew] = useState(false)

  useEffect(() => {
    setRenewOpen(false)
    setForceRenew(false)
  }, [instanceId, node])

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['node-certificates', instanceId, node],
    queryFn: () => api.getNodeCertificates(instanceId, node),
    enabled: Boolean(instanceId && node),
  })

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载节点 SSL 证书与 ACME 信息失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !data) {
    return <div className="h-56 animate-pulse rounded-xl border border-border bg-card" />
  }

  const certs = data?.certificates ?? []
  const acmeAccounts = data?.acmeAccounts ?? []
  const acmeDomains = data?.acmeDomains ?? []
  const hasACMEConfigured = acmeDomains.length > 0 && (acmeAccounts.length > 0 || Boolean(data?.acmeAccountConfigured))
  const hasCustomCert = certs.some((c) => c.filename === 'pveproxy-ssl.pem')
  const acmeActionLabel = hasCustomCert ? '续签 ACME 证书' : '申请 ACME 证书'

  return (
    <div className="space-y-5">
      {data?.warnings && Object.keys(data.warnings).length > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-xs text-foreground flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
          <div>
            部分 ACME 配置读取受限（{Object.keys(data.warnings).join('、')}）：
            {Object.values(data.warnings).join('；')}
          </div>
        </div>
      )}

      {/* ACME Summary Card */}
      <Card>
        <CardContent className="p-5 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3.5 min-w-0">
            <div
              className={cn(
                'flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border',
                hasACMEConfigured
                  ? 'border-success/35 bg-success/12 text-success'
                  : 'border-border bg-muted/60 text-muted-foreground',
              )}
            >
              <Globe className="h-5 w-5" />
            </div>
            <div className="space-y-1.5 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-foreground">
                  ACME 自动证书 (Let&apos;s Encrypt)
                </h3>
                <Badge variant={hasACMEConfigured ? 'success' : 'muted'}>
                  {hasACMEConfigured ? '已配置域名' : '未配置 ACME 域名'}
                </Badge>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>
                  集群 ACME 账号:{' '}
                  <span className="font-mono-num text-foreground">
                    {acmeAccounts.length > 0
                      ? acmeAccounts.map((a) => a.name).join(', ')
                      : '暂无'}
                  </span>
                </span>
                <span>·</span>
                <span>
                  当前节点绑定域名:{' '}
                  <span className="font-mono-num text-foreground">
                    {acmeDomains.length > 0 ? acmeDomains.join(', ') : '未绑定'}
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={!canMutate || !hasACMEConfigured}
              title={
                !isAdmin
                  ? ADMIN_HOST_ONLY_TITLE
                  : !hasACMEConfigured
                    ? '需先在 PVE 配置 ACME 账号与域名后方可续签'
                    : readOnly
                      ? '写保护已开启'
                      : '申请或续签当前节点的 ACME TLS 证书'
              }
              onClick={() => {
                setForceRenew(false)
                setRenewOpen(true)
              }}
            >
              <ShieldCheck className="h-4 w-4" />
              {acmeActionLabel}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="刷新证书列表"
            >
              <RefreshCw className={cn('h-4 w-4', isFetching && 'animate-spin')} />
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* SSL Certificates Grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {certs.map((cert) => {
          const exp = certExpiryBadge(cert.notafter)
          return (
            <Card key={cert.filename}>
              <CardHeader className="py-3.5 border-b border-border/70 flex-row items-center justify-between gap-2">
                <CardTitle className="flex items-center gap-2 font-mono-num text-sm truncate">
                  <FileKey2 className="h-4 w-4 text-accent shrink-0" />
                  <span className="truncate">{cert.filename}</span>
                </CardTitle>
                <Badge variant={exp.variant} className="font-mono-num shrink-0">
                  {exp.label}
                </Badge>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-xs">
                <div className="space-y-1">
                  <div className="text-muted-foreground">主体 (Subject)</div>
                  <div className="font-mono-num text-foreground break-all">{cert.subject || '—'}</div>
                </div>
                <div className="space-y-1">
                  <div className="text-muted-foreground">签发者 (Issuer)</div>
                  <div className="font-mono-num text-foreground break-all">{cert.issuer || '—'}</div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-muted-foreground">生效时间</div>
                    <div className="font-mono-num text-foreground mt-0.5">
                      {cert.notbefore ? formatDateTime(cert.notbefore) : '—'}
                    </div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">到期时间</div>
                    <div className="font-mono-num text-foreground mt-0.5">
                      {cert.notafter ? formatDateTime(cert.notafter) : '—'}
                    </div>
                  </div>
                </div>

                {cert.san && cert.san.length > 0 && (
                  <div className="space-y-1">
                    <div className="text-muted-foreground">Subject Alternative Names (SAN)</div>
                    <div className="flex flex-wrap gap-1.5">
                      {cert.san.map((s) => (
                        <Badge key={s} variant="muted" className="font-mono-num text-[11px]">
                          {s}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-border/70">
                  <span className="inline-flex items-center gap-1.5 font-mono-num text-muted-foreground">
                    <KeyRound className="h-3.5 w-3.5" />
                    {cert['public-key-type'] || 'Key'} {cert['public-key-bits'] ? `${cert['public-key-bits']} bit` : ''}
                  </span>
                  {cert.fingerprint && (
                    <button
                      type="button"
                      onClick={async () => {
                        await copyToClipboard(cert.fingerprint)
                        toast.success(`已复制 ${cert.filename} SHA-256 指纹`)
                      }}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1 font-mono-num text-[11px] text-foreground hover:border-accent hover:text-accent"
                      title={cert.fingerprint}
                    >
                      <CheckCircle2 className="h-3 w-3 text-success" />
                      <span>{cert.fingerprint.slice(0, 23)}…</span>
                      <Copy className="h-3 w-3 text-muted-foreground" />
                    </button>
                  )}
                </div>
              </CardContent>
            </Card>
          )
        })}
      </div>

      {/* Renew / Order ACME Cert Confirmation */}
      <DangerConfirmDialog
        open={renewOpen}
        onOpenChange={setRenewOpen}
        title={`${acmeActionLabel} · ${node}`}
        description={
          hasCustomCert
            ? '将调用 Proxmox ACME 续签流程更新当前节点的 pveproxy-ssl.pem 证书并自动重载 pveproxy 服务（若启用了 TLS TOFU 指纹锁定，证书更新后可能需要重新确认节点证书指纹）。'
            : '当前节点尚无自定义 ACME 证书，将调用 Proxmox ACME 首次申请流程签发 pveproxy-ssl.pem 并自动重载 pveproxy 服务（若启用了 TLS TOFU 指纹锁定，证书更新后可能需要重新确认节点证书指纹）。'
        }
        confirmTarget={node}
        confirmLabel={`确认${acmeActionLabel}`}
        extraOptions={
          <label className="flex items-center gap-2 rounded-lg border border-border bg-background/60 p-3 text-xs">
            <input
              type="checkbox"
              checked={forceRenew}
              onChange={(e) => setForceRenew(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--color-accent)]"
            />
            <span>强制签发（即使证书剩余有效期超过 30 天也强制重新申请）</span>
          </label>
        }
        onConfirm={async () => {
          if (!canMutate) return
          const mode = hasCustomCert ? 'renew' : 'order'
          const res = await api.renewNodeACME(instanceId, node, forceRenew, mode)
          const act = res.action ?? mode
          toast.success(`已提交节点 ${node} ACME 证书${act === 'order' ? '申请' : '续签'}任务`)
          if (res.upid) {
            openTaskLog({
              instanceId,
              instanceName,
              node,
              upid: res.upid,
              type: act === 'order' ? 'acmenewcert' : 'acmerenew',
              id: node,
            })
          }
          setTimeout(
            () => void queryClient.invalidateQueries({ queryKey: ['node-certificates', instanceId, node] }),
            2000,
          )
        }}
      />
    </div>
  )
}
