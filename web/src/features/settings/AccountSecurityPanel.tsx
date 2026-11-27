import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Fingerprint,
  KeyRound,
  LifeBuoy,
  Loader2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Trash2,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { PasskeyCredentialSummary, TotpSetupResponse } from '@/lib/api/types'
import { copyToClipboard, formatISOTime } from '@/lib/format'
import { getWebAuthnSupportInfo, runWebAuthnRegistration } from '@/lib/webauthn'
import { useAppStore } from '@/stores/appStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import {
  RecoveryCodesRevealDialog,
  RegenerateRecoveryCodesDialog,
} from './RecoveryCodesDialog'

export function AccountSecurityPanel() {
  const queryClient = useQueryClient()
  const currentUser = useAppStore((s) => s.currentUser)
  const envReadOnly = useAppStore((s) => s.envReadOnly)
  const webauthnSupport = useMemo(() => getWebAuthnSupportInfo(), [])

  const { data: status, isLoading, error } = useQuery({
    queryKey: ['auth-security'],
    queryFn: api.getSecurityStatus,
  })

  // Passkey registration dialog
  const [passkeyOpen, setPasskeyOpen] = useState(false)
  const [passkeyName, setPasskeyName] = useState('Mac 指纹 / Bitwarden 通行密钥')
  const [passkeyPwd, setPasskeyPwd] = useState('')
  const [passkeyBusy, setPasskeyBusy] = useState(false)

  // Delete Passkey confirmation
  const [deletingPasskey, setDeletingPasskey] = useState<PasskeyCredentialSummary | null>(null)
  const [deletePasskeyPwd, setDeletePasskeyPwd] = useState('')

  // TOTP setup wizard & disable confirmation
  const [totpPwd, setTotpPwd] = useState('')
  const [totpSetup, setTotpSetup] = useState<TotpSetupResponse | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [totpBusy, setTotpBusy] = useState(false)
  const [disableTotpOpen, setDisableTotpOpen] = useState(false)
  const [disableTotpPwd, setDisableTotpPwd] = useState('')

  // Recovery codes reveal & regenerate
  const [revealedCodes, setRevealedCodes] = useState<string[] | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)

  const invalidateSecurity = () => {
    void queryClient.invalidateQueries({ queryKey: ['auth-security'] })
    void queryClient.invalidateQueries({ queryKey: ['users'] })
  }

  const handleRegisterPasskey = async (e: React.FormEvent) => {
    e.preventDefault()
    if (envReadOnly || !passkeyPwd || !passkeyName.trim()) return
    setPasskeyBusy(true)
    try {
      const begin = await api.beginPasskeyRegister(passkeyPwd, passkeyName.trim())
      const credential = await runWebAuthnRegistration(begin.options)
      const res = await api.finishPasskeyRegister(
        begin.challengeToken,
        passkeyName.trim(),
        credential,
      )
      toast.success(`已成功绑定通行密钥「${passkeyName.trim()}」`)
      setPasskeyOpen(false)
      setPasskeyPwd('')
      invalidateSecurity()
      if (res.recoveryCodes && res.recoveryCodes.length > 0) {
        setRevealedCodes(res.recoveryCodes)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '绑定通行密钥失败')
    } finally {
      setPasskeyBusy(false)
    }
  }

  const handleStartTotpSetup = async (e: React.FormEvent) => {
    e.preventDefault()
    if (envReadOnly || !totpPwd) return
    setTotpBusy(true)
    try {
      const setup = await api.setupTotp(totpPwd)
      setTotpSetup(setup)
      setTotpCode('')
      setTotpPwd('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '初始化动态口令失败')
    } finally {
      setTotpBusy(false)
    }
  }

  const handleEnableTotp = async (e: React.FormEvent) => {
    e.preventDefault()
    const clean = totpCode.replace(/\s+/g, '')
    if (envReadOnly || !/^\d{6}$/.test(clean)) {
      toast.error('请输入 6 位数字验证码')
      return
    }
    setTotpBusy(true)
    try {
      const res = await api.enableTotp(clean)
      toast.success('已成功启用动态口令 (TOTP) 双重验证')
      setTotpSetup(null)
      setTotpCode('')
      invalidateSecurity()
      if (res.recoveryCodes && res.recoveryCodes.length > 0) {
        setRevealedCodes(res.recoveryCodes)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '动态口令校验失败')
    } finally {
      setTotpBusy(false)
    }
  }

  if (error) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/12 px-5 py-4 text-sm text-destructive">
        加载账号安全状态失败：{error instanceof Error ? error.message : '未知错误'}
      </div>
    )
  }

  if (isLoading && !status) {
    return <div className="h-64 animate-pulse rounded-xl border border-border bg-card" />
  }

  const passkeys = status?.passkeys ?? []
  const mfaEnabled = Boolean(status?.mfaEnabled)
  const totpEnabled = Boolean(status?.totpEnabled)
  const remainingCodes = status?.recoveryCodesRemaining ?? 0

  return (
    <div className="space-y-6">
      {/* Top 2FA Status & WebAuthn Origin Banner */}
      <Card>
        <CardContent className="p-5 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-accent/30 bg-accent/12 text-accent">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-base font-semibold text-foreground">
                    双重身份验证 (2FA)
                  </span>
                  {mfaEnabled ? (
                    <Badge variant="success" className="gap-1">
                      <CheckCircle2 className="h-3 w-3" />
                      已启用保护
                    </Badge>
                  ) : (
                    <Badge variant="warning">尚未开启</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  可同时绑定硬件指纹 / Bitwarden 通行密钥 (Passkey) 与 6 位动态口令 (TOTP)，互为备份。
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Badge variant="muted" className="font-mono-num">
                Passkey: {passkeys.length}
              </Badge>
              <Badge variant={totpEnabled ? 'accent' : 'muted'}>
                TOTP: {totpEnabled ? '已开启' : '未开启'}
              </Badge>
              {mfaEnabled && (
                <Badge variant={remainingCodes <= 2 ? 'warning' : 'muted'} className="font-mono-num">
                  恢复码剩余: {remainingCodes}
                </Badge>
              )}
            </div>
          </div>

          {webauthnSupport.supported ? (
            <div className="rounded-lg border border-success/30 bg-success/[0.06] px-3.5 py-2 text-xs text-muted-foreground flex flex-wrap items-center justify-between gap-2">
              <span>
                当前访问源 <code className="font-mono-num text-foreground">{webauthnSupport.origin}</code>{' '}
                满足安全上下文要求，可直接绑定并使用 Touch ID / Windows Hello / Bitwarden 通行密钥。
              </span>
              {status?.currentRpId && (
                <Badge variant="muted" className="font-mono-num">
                  RP ID: {status.currentRpId}
                </Badge>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-warning/40 bg-warning/10 px-3.5 py-2.5 text-xs text-foreground flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
              <div className="leading-relaxed">{webauthnSupport.reason}</div>
            </div>
          )}

          {status?.hasOtherHostPasskeys && !status?.webauthnAvailableForHost && (
            <div className="rounded-lg border border-info/35 bg-info/10 px-3.5 py-2 text-xs text-foreground">
              提示：检测到您已在其它域名下绑定过通行密钥。WebAuthn 凭据按域名 (RP ID) 隔离，您也可以为当前域名单独再绑定一枚通行密钥，或同时开启下方 TOTP 动态口令以支持任意地址登录。
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 1: Passkeys (WebAuthn / FIDO2) */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="h-4.5 w-4.5 text-accent" />
            <span>通行密钥 Passkey（Mac 指纹 / Windows Hello / Bitwarden）</span>
          </CardTitle>
          <Button
            type="button"
            variant="primary"
            size="sm"
            disabled={envReadOnly || !webauthnSupport.supported}
            title={
              envReadOnly
                ? '服务端强制只读模式下不可修改安全凭据'
                : !webauthnSupport.supported
                  ? webauthnSupport.reason
                  : undefined
            }
            onClick={() => {
              setPasskeyName('Mac 指纹 / Bitwarden 通行密钥')
              setPasskeyPwd('')
              setPasskeyOpen(true)
            }}
          >
            <Plus className="h-4 w-4" />
            绑定通行密钥
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {passkeys.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">
              尚未绑定任何通行密钥。点击右上角「绑定通行密钥」可使用本机指纹或 Bitwarden 浏览器插件免输验证码一键登录。
            </div>
          ) : (
            <div className="divide-y divide-border/70 rounded-xl border border-border">
              {passkeys.map((pk) => {
                const sameRp = !status?.currentRpId || pk.rpId === status.currentRpId
                return (
                  <div
                    key={pk.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-xs"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{pk.name}</span>
                        <Badge variant={sameRp ? 'accent' : 'warning'} className="font-mono-num">
                          RP: {pk.rpId}
                        </Badge>
                        {pk.backupState && <Badge variant="muted">已云同步 (Passkey)</Badge>}
                      </div>
                      <div className="font-mono-num text-[11px] text-muted-foreground">
                        创建于 {formatISOTime(pk.createdAt)}
                        {pk.lastUsedAt ? ` · 最近使用 ${formatISOTime(pk.lastUsedAt)}` : ''}
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={envReadOnly}
                      className="text-destructive hover:bg-destructive/15"
                      onClick={() => {
                        setDeletePasskeyPwd('')
                        setDeletingPasskey(pk)
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      移除
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Card 2: Authenticator TOTP */}
      <Card>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-4.5 w-4.5 text-info" />
            <span>动态口令验证器 (TOTP · Bitwarden / Google / Microsoft Authenticator)</span>
          </CardTitle>
          {totpEnabled && (
            <Badge variant="success" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              已绑定启用
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          {totpEnabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs">
              <span className="text-muted-foreground">
                基于 RFC 6238 的 6 位动态口令已开启，即使通过内网 IP 访问面板亦可正常完成二次验证。
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={envReadOnly}
                className="text-destructive"
                onClick={() => {
                  setDisableTotpPwd('')
                  setDisableTotpOpen(true)
                }}
              >
                停用动态口令
              </Button>
            </div>
          ) : totpSetup ? (
            <div className="rounded-xl border border-accent/35 bg-accent/[0.04] p-4 space-y-4">
              <div className="grid grid-cols-1 gap-5 md:grid-cols-[192px_1fr] items-center">
                <div className="flex justify-center">
                  <img
                    src={`data:image/svg+xml;utf8,${encodeURIComponent(totpSetup.qrSvg)}`}
                    alt="TOTP 绑定二维码"
                    className="h-44 w-44 rounded-xl border border-border bg-white p-2 shadow-xs"
                  />
                </div>
                <div className="space-y-3 text-xs">
                  <p className="text-foreground font-medium">
                    使用手机身份验证器或 Bitwarden 扫描左侧二维码，或手动输入下方密钥：
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 rounded-lg border border-border bg-card px-3 py-2 font-mono-num text-xs text-foreground break-all">
                      {totpSetup.secret}
                    </code>
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      onClick={async () => {
                        await copyToClipboard(totpSetup.secret)
                        toast.success('已复制 TOTP 密钥')
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                      复制密钥
                    </Button>
                  </div>

                  <form onSubmit={handleEnableTotp} className="flex flex-wrap items-end gap-2 pt-1">
                    <div className="space-y-1 flex-1 min-w-[180px]">
                      <label className="block text-xs font-medium text-foreground">
                        输入生成的 6 位验证码完成绑定
                      </label>
                      <Input
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]*"
                        maxLength={6}
                        value={totpCode}
                        onChange={(e) => setTotpCode(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                        placeholder="000000"
                        className="font-mono-num tracking-[0.25em]"
                        required
                      />
                    </div>
                    <Button
                      type="submit"
                      variant="primary"
                      size="md"
                      disabled={totpBusy || totpCode.length !== 6 || envReadOnly}
                    >
                      {totpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                      验证并启用
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="md"
                      disabled={totpBusy}
                      onClick={() => setTotpSetup(null)}
                    >
                      取消
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          ) : (
            <form onSubmit={handleStartTotpSetup} className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5 flex-1 min-w-[220px] max-w-sm">
                <label className="block text-xs font-medium">输入当前账号密码以生成绑定二维码</label>
                <Input
                  type="password"
                  value={totpPwd}
                  onChange={(e) => setTotpPwd(e.target.value)}
                  placeholder="验证当前登录密码"
                  autoComplete="current-password"
                  disabled={envReadOnly}
                  required
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                size="md"
                disabled={totpBusy || !totpPwd || envReadOnly}
              >
                {totpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
                开始配置动态口令
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Card 3: Recovery Codes */}
      {mfaEnabled && (
        <Card>
          <CardHeader className="flex-row flex-wrap items-center justify-between gap-3">
            <CardTitle className="flex items-center gap-2">
              <LifeBuoy className="h-4.5 w-4.5 text-warning" />
              <span>一次性应急恢复码 (Recovery Codes)</span>
            </CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={envReadOnly}
              onClick={() => setRegenOpen(true)}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              重新生成恢复码
            </Button>
          </CardHeader>
          <CardContent className="text-xs text-muted-foreground">
            当前剩余可用恢复码：{' '}
            <strong className="font-mono-num text-foreground">{remainingCodes}</strong> 个。
            {remainingCodes <= 2 && (
              <span className="ml-2 text-warning font-medium">
                剩余恢复码较少，建议尽快点击右上角重新生成一套新恢复码。
              </span>
            )}
          </CardContent>
        </Card>
      )}

      {/* Register Passkey Dialog */}
      <Dialog open={passkeyOpen} onOpenChange={(o) => !passkeyBusy && setPasskeyOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Fingerprint className="h-5 w-5 text-accent" />
              <span>绑定新通行密钥 (Passkey)</span>
            </DialogTitle>
            <DialogDescription>
              验证当前密码后将唤起浏览器或 Bitwarden 通行密钥提示框，完成指纹或安全密钥注册。
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleRegisterPasskey} className="space-y-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">通行密钥备注名称</label>
              <Input
                value={passkeyName}
                onChange={(e) => setPasskeyName(e.target.value)}
                placeholder="例如：MacBook Pro 指纹 / Bitwarden"
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">当前登录密码</label>
              <Input
                type="password"
                value={passkeyPwd}
                onChange={(e) => setPasskeyPwd(e.target.value)}
                placeholder="输入当前账号密码以确认"
                autoComplete="current-password"
                required
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setPasskeyOpen(false)}
                disabled={passkeyBusy}
              >
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={passkeyBusy || !passkeyPwd || !passkeyName.trim()}
              >
                {passkeyBusy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Fingerprint className="h-4 w-4" />
                )}
                继续并唤起系统验证
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Passkey Confirm Dialog */}
      <ConfirmDialog
        open={Boolean(deletingPasskey)}
        onOpenChange={(open) => !open && setDeletingPasskey(null)}
        title={`移除通行密钥 · ${deletingPasskey?.name ?? ''}`}
        description="移除后将无法再使用该设备或密码管理器中的此枚通行密钥登录；若这是最后一个 2FA 凭据，账号双重验证将随之关闭。"
        confirmLabel="确认移除通行密钥"
        variant="destructive"
        onConfirm={async () => {
          if (!deletingPasskey) return
          if (!deletePasskeyPwd) {
            throw new Error('请输入当前账号密码以确认移除')
          }
          await api.deletePasskey(deletingPasskey.id, deletePasskeyPwd)
          toast.success(`已移除通行密钥「${deletingPasskey.name}」`)
          invalidateSecurity()
        }}
      >
        <div className="space-y-1.5 pt-1">
          <label className="block text-xs font-medium">验证当前登录密码</label>
          <Input
            type="password"
            value={deletePasskeyPwd}
            onChange={(e) => setDeletePasskeyPwd(e.target.value)}
            placeholder="输入当前账号密码"
            autoComplete="current-password"
          />
        </div>
      </ConfirmDialog>

      {/* Disable TOTP Confirm Dialog */}
      <ConfirmDialog
        open={disableTotpOpen}
        onOpenChange={setDisableTotpOpen}
        title="停用动态口令 (TOTP)"
        description="停用后旧身份验证器中的 6 位验证码将立即失效；若账号未绑定任何通行密钥，双重验证将同步关闭。"
        confirmLabel="确认停用 TOTP"
        variant="destructive"
        onConfirm={async () => {
          if (!disableTotpPwd) {
            throw new Error('请输入当前账号密码以确认停用')
          }
          await api.disableTotp(disableTotpPwd)
          toast.success('已停用动态口令 (TOTP)')
          invalidateSecurity()
        }}
      >
        <div className="space-y-1.5 pt-1">
          <label className="block text-xs font-medium">验证当前登录密码</label>
          <Input
            type="password"
            value={disableTotpPwd}
            onChange={(e) => setDisableTotpPwd(e.target.value)}
            placeholder="输入当前账号密码"
            autoComplete="current-password"
          />
        </div>
      </ConfirmDialog>

      <RegenerateRecoveryCodesDialog
        open={regenOpen}
        onOpenChange={setRegenOpen}
        onGenerated={(codes) => {
          setRevealedCodes(codes)
          invalidateSecurity()
        }}
      />

      <RecoveryCodesRevealDialog
        codes={revealedCodes}
        username={currentUser?.username || 'user'}
        onClose={() => setRevealedCodes(null)}
      />
    </div>
  )
}
