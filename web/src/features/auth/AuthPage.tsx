import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  Fingerprint,
  KeyRound,
  LifeBuoy,
  Loader2,
  Lock,
  LogIn,
  ShieldCheck,
  Smartphone,
  UserPlus,
} from 'lucide-react'
import { ApiError, api } from '@/lib/api/client'
import type { MfaMethod, TokenPair, User } from '@/lib/api/types'
import { setStoredAccessToken } from '@/lib/platform'
import { getWebAuthnSupportInfo, runWebAuthnAssertion } from '@/lib/webauthn'
import { ThemePicker } from '@/components/layout/ThemePicker'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

interface AuthPageProps {
  initialized: boolean
  onAuthenticated: (user: User) => void
}

interface MfaChallengeState {
  mfaToken: string
  methods: MfaMethod[]
  webauthnAvailableForHost: boolean
  hasOtherHostPasskeys: boolean
  username: string
}

export function AuthPage({ initialized, onAuthenticated }: AuthPageProps) {
  const [username, setUsername] = useState(initialized ? '' : 'admin')
  const [displayName, setDisplayName] = useState(initialized ? '' : 'Administrator')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Step 2 MFA Challenge state
  const [mfaState, setMfaState] = useState<MfaChallengeState | null>(null)
  const [mfaMethod, setMfaMethod] = useState<MfaMethod>('totp')
  const [totpCode, setTotpCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')

  const webauthnSupport = useMemo(() => getWebAuthnSupportInfo(), [])

  const finishAuth = (pair: TokenPair) => {
    if (pair.accessToken) {
      setStoredAccessToken(pair.accessToken)
    }
    onAuthenticated(pair.user)
  }

  const handleStep1Submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedUser = username.trim()
    if (trimmedUser.length < 2) {
      setError('用户名长度至少为 2 个字符')
      return
    }
    if (!initialized && password.length < 8) {
      setError('管理员密码长度至少为 8 个字符')
      return
    }
    if (!initialized && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    setSubmitting(true)
    try {
      if (!initialized) {
        const pair = await api.authSetup({
          username: trimmedUser,
          displayName: displayName.trim() || trimmedUser,
          password,
        })
        finishAuth(pair)
        return
      }

      const res = await api.login({ username: trimmedUser, password })
      if (res.mfaRequired && res.mfaToken) {
        const rawMethods = res.methods && res.methods.length > 0 ? res.methods : (['totp'] as MfaMethod[])
        const canUsePasskeyHere =
          rawMethods.includes('webauthn') &&
          res.webauthnAvailableForHost !== false &&
          webauthnSupport.supported
        const preferred: MfaMethod = canUsePasskeyHere
          ? 'webauthn'
          : rawMethods.includes('totp')
            ? 'totp'
            : rawMethods.includes('recovery')
              ? 'recovery'
              : rawMethods[0]

        setMfaState({
          mfaToken: res.mfaToken,
          methods: rawMethods,
          webauthnAvailableForHost: Boolean(res.webauthnAvailableForHost),
          hasOtherHostPasskeys: Boolean(res.hasOtherHostPasskeys),
          username: res.username || trimmedUser,
        })
        setMfaMethod(preferred)
        setTotpCode('')
        setRecoveryCode('')
        setError(null)
        return
      }

      if (res.user) {
        if (res.accessToken) {
          setStoredAccessToken(res.accessToken)
        }
        onAuthenticated(res.user)
        return
      }

      setError('登录响应异常，请重试')
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : initialized
            ? '登录失败，请检查账号密码'
            : '初始化失败',
      )
    } finally {
      setSubmitting(false)
    }
  }

  const handleStep2Error = (err: unknown, fallback: string) => {
    const msg = err instanceof Error ? err.message : fallback
    const errCode =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code || '')
        : ''
    const isExpiredChallenge =
      errCode === 'MFA_TOKEN_EXPIRED' ||
      (err instanceof ApiError &&
        err.status === 401 &&
        (msg.includes('重新输入') || msg.includes('已过期')))
    if (isExpiredChallenge) {
      setMfaState(null)
      setTotpCode('')
      setRecoveryCode('')
      setPassword('')
    }
    setError(msg)
  }

  const handleVerifyPasskey = async () => {
    if (!mfaState) return
    setError(null)
    setSubmitting(true)
    try {
      const begin = await api.beginMfaWebauthn(mfaState.mfaToken)
      const credential = await runWebAuthnAssertion(begin.options)
      const pair = await api.finishMfaWebauthn(
        mfaState.mfaToken,
        begin.challengeToken,
        credential,
      )
      finishAuth(pair)
    } catch (err) {
      handleStep2Error(err, '通行密钥验证失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleVerifyTotp = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!mfaState) return
    const clean = totpCode.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(clean)) {
      setError('请输入 6 位数字动态验证码')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const pair = await api.verifyMfaTotp(mfaState.mfaToken, clean)
      finishAuth(pair)
    } catch (err) {
      handleStep2Error(err, '动态验证码校验失败')
    } finally {
      setSubmitting(false)
    }
  }

  const handleVerifyRecovery = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!mfaState) return
    const clean = recoveryCode.trim()
    if (!clean) {
      setError('请输入一次性应急恢复码')
      return
    }
    setError(null)
    setSubmitting(true)
    try {
      const pair = await api.verifyMfaRecovery(mfaState.mfaToken, clean)
      finishAuth(pair)
    } catch (err) {
      handleStep2Error(err, '应急恢复码无效或已使用')
    } finally {
      setSubmitting(false)
    }
  }

  const resetMfaStep = () => {
    setMfaState(null)
    setTotpCode('')
    setRecoveryCode('')
    setPassword('')
    setError(null)
  }

  const availableMethods = useMemo(() => {
    if (!mfaState) return [] as Array<{ id: MfaMethod; label: string; icon: typeof KeyRound; disabled?: boolean }>
    const tabs: Array<{ id: MfaMethod; label: string; icon: typeof KeyRound; disabled?: boolean }> = []
    if (mfaState.methods.includes('webauthn')) {
      tabs.push({
        id: 'webauthn',
        label: '通行密钥 / 指纹',
        icon: Fingerprint,
        disabled: !webauthnSupport.supported || !mfaState.webauthnAvailableForHost,
      })
    }
    if (mfaState.methods.includes('totp')) {
      tabs.push({ id: 'totp', label: '6 位动态口令', icon: Smartphone })
    }
    if (mfaState.methods.includes('recovery') || mfaState.methods.length > 0) {
      tabs.push({ id: 'recovery', label: '恢复码', icon: LifeBuoy })
    }
    return tabs
  }, [mfaState, webauthnSupport.supported])

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10 text-foreground">
      <div className="app-bg-mesh" aria-hidden="true" />

      <div className="fixed right-4 top-4 z-20">
        <ThemePicker variant="dropdown" persistToServer={false} />
      </div>

      <div className="surface-card relative z-10 w-full max-w-[460px] border p-8 shadow-[var(--shadow-lg)]">
        <div className="mb-6 flex items-center gap-3.5">
          <svg viewBox="0 0 64 64" className="h-11 w-11 shrink-0" fill="none" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="var(--color-card)" />
            <rect
              x="3"
              y="3"
              width="58"
              height="58"
              rx="11"
              stroke="var(--color-border-strong)"
              strokeWidth="3"
            />
            <path
              d="M18 22L28 32L18 42"
              stroke="var(--color-accent)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M46 22L36 32L46 42"
              stroke="var(--color-success)"
              strokeWidth="5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          <div>
            <h1 className="font-mono-num text-xl font-bold tracking-tight">PVE Dash</h1>
            <p className="text-sm text-muted-foreground">
              {mfaState
                ? '安全登录 · 第二步身份验证 (2FA)'
                : initialized
                  ? 'Proxmox VE 多集群控制平面'
                  : '首次启动 · 创建平台管理员账号'}
            </p>
          </div>
        </div>

        {mfaState ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <Badge variant="accent">2FA</Badge>
                <span className="text-muted-foreground truncate">
                  正在验证账号：<strong className="font-mono-num text-foreground">{mfaState.username}</strong>
                </span>
              </div>
              <button
                type="button"
                onClick={resetMfaStep}
                disabled={submitting}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground shrink-0"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                返回密码页
              </button>
            </div>

            {mfaState.hasOtherHostPasskeys && !mfaState.webauthnAvailableForHost && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div className="leading-relaxed">
                  该账号已在其它域名下绑定过通行密钥 (Passkey)。由于浏览器 WebAuthn 按域名隔离凭据，当前地址 (
                  <span className="font-mono-num">{webauthnSupport.hostname || '当前主机'}</span>
                  ) 无法调用该通行密钥；请切换至原绑定 HTTPS 域名 / localhost，或使用下方{' '}
                  <strong>动态口令</strong> 或 <strong>恢复码</strong> 登录。
                </div>
              </div>
            )}

            {!webauthnSupport.supported && mfaState.methods.includes('webauthn') && (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div className="leading-relaxed">{webauthnSupport.reason}</div>
              </div>
            )}

            {availableMethods.length > 1 && (
              <div className="grid grid-cols-3 gap-1.5 rounded-lg border border-border bg-muted/50 p-1">
                {availableMethods.map((tab) => {
                  const Icon = tab.icon
                  const active = mfaMethod === tab.id
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      disabled={tab.disabled || submitting}
                      onClick={() => {
                        setMfaMethod(tab.id)
                        setError(null)
                      }}
                      className={cn(
                        'flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none',
                        active
                          ? 'bg-card text-foreground shadow-xs border border-border-strong'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      <Icon className={cn('h-3.5 w-3.5 shrink-0', active && 'text-accent')} />
                      <span className="truncate">{tab.label}</span>
                    </button>
                  )
                })}
              </div>
            )}

            {mfaMethod === 'webauthn' && (
              <div className="space-y-3 rounded-xl border border-border bg-background/50 p-4 text-center">
                <Fingerprint className="mx-auto h-9 w-9 text-accent" />
                <div className="space-y-1">
                  <div className="text-sm font-medium text-foreground">
                    使用硬件指纹或密码管理器通行密钥
                  </div>
                  <p className="text-xs text-muted-foreground">
                    支持 Mac Touch ID、Windows Hello、iCloud 钥匙串与 Bitwarden 通行密钥弹窗签名。
                  </p>
                </div>
                <Button
                  type="button"
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={
                    submitting ||
                    !webauthnSupport.supported ||
                    !mfaState.webauthnAvailableForHost
                  }
                  onClick={() => void handleVerifyPasskey()}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Fingerprint className="h-4 w-4" />
                  )}
                  <span>唤起通行密钥验证</span>
                </Button>
              </div>
            )}

            {mfaMethod === 'totp' && (
              <form onSubmit={handleVerifyTotp} className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="mfa-totp-code" className="block text-xs font-medium text-foreground">
                    6 位动态口令（Authenticator / Bitwarden TOTP）
                  </label>
                  <Input
                    id="mfa-totp-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]*"
                    maxLength={6}
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="font-mono-num text-center text-lg tracking-[0.35em]"
                    autoFocus
                    required
                  />
                </div>
                <Button
                  type="submit"
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={submitting || totpCode.length !== 6}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  <span>验证动态口令并进入</span>
                </Button>
              </form>
            )}

            {mfaMethod === 'recovery' && (
              <form onSubmit={handleVerifyRecovery} className="space-y-4">
                <div className="space-y-1.5">
                  <label
                    htmlFor="mfa-recovery-code"
                    className="block text-xs font-medium text-foreground"
                  >
                    一次性应急恢复码
                  </label>
                  <Input
                    id="mfa-recovery-code"
                    autoComplete="off"
                    value={recoveryCode}
                    onChange={(e) => setRecoveryCode(e.target.value.toUpperCase())}
                    placeholder="XXXX-XXXX"
                    className="font-mono-num text-center tracking-widest"
                    autoFocus
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">
                    每个恢复码仅可使用一次，验证成功后该恢复码将自动核销作废。
                  </p>
                </div>
                <Button
                  type="submit"
                  variant="default"
                  size="lg"
                  className="w-full"
                  disabled={submitting || !recoveryCode.trim()}
                >
                  {submitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LifeBuoy className="h-4 w-4" />
                  )}
                  <span>使用恢复码登录</span>
                </Button>
              </form>
            )}

            {error && (
              <div
                role="alert"
                className="rounded-lg border border-destructive/45 bg-destructive/15 px-3 py-2 text-xs font-medium text-destructive"
              >
                {error}
              </div>
            )}
          </div>
        ) : (
          <>
            {!initialized && (
              <div className="mb-4 flex items-start gap-2 rounded-lg border border-accent/35 bg-accent/10 p-3 text-xs text-foreground">
                <ShieldCheck className="h-4 w-4 text-accent shrink-0 mt-0.5" />
                <div className="leading-relaxed">
                  欢迎使用 PVE Dash。请先设置本地管理员凭据，之后即可接入一台或多台 Proxmox VE 7.4 / 8.x / 9.x 实例（凭据使用 AES-256-GCM 加密落库）。
                </div>
              </div>
            )}

            <form onSubmit={handleStep1Submit} className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="auth-username" className="block text-xs font-medium text-foreground">
                  用户名
                </label>
                <Input
                  id="auth-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="admin"
                  autoComplete="username"
                  required
                />
              </div>

              {!initialized && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="auth-displayname"
                    className="block text-xs font-medium text-foreground"
                  >
                    显示名称
                  </label>
                  <Input
                    id="auth-displayname"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="Administrator"
                  />
                </div>
              )}

              <div className="space-y-1.5">
                <label htmlFor="auth-password" className="block text-xs font-medium text-foreground">
                  密码
                </label>
                <Input
                  id="auth-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={initialized ? '请输入密码' : '至少 8 位字符'}
                  minLength={initialized ? undefined : 8}
                  autoComplete={initialized ? 'current-password' : 'new-password'}
                  required
                />
              </div>

              {!initialized && (
                <div className="space-y-1.5">
                  <label htmlFor="auth-confirm" className="block text-xs font-medium text-foreground">
                    确认密码
                  </label>
                  <Input
                    id="auth-confirm"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="再次输入密码"
                    autoComplete="new-password"
                    required
                  />
                </div>
              )}

              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-destructive/45 bg-destructive/15 px-3 py-2 text-xs font-medium text-destructive"
                >
                  {error}
                </div>
              )}

              <Button
                type="submit"
                variant="default"
                size="lg"
                className="w-full"
                disabled={submitting}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : initialized ? (
                  <LogIn className="h-4 w-4" />
                ) : (
                  <UserPlus className="h-4 w-4" />
                )}
                <span>{initialized ? '登录控制平面' : '完成初始化并进入控制台'}</span>
              </Button>
            </form>
          </>
        )}

        <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Lock className="h-3 w-3" />
            Argon2id + Passkey / TOTP 2FA
          </span>
          <span className="font-mono-num">PVE 7.4 · 8.x · 9.x</span>
        </div>
      </div>
    </div>
  )
}
