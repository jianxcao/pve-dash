import { useState } from 'react'
import { Loader2, ShieldCheck, Lock, UserPlus, LogIn } from 'lucide-react'
import { api } from '@/lib/api/client'
import type { User } from '@/lib/api/types'
import { setStoredAccessToken } from '@/lib/platform'
import { ThemePicker } from '@/components/layout/ThemePicker'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface AuthPageProps {
  initialized: boolean
  onAuthenticated: (user: User) => void
}

export function AuthPage({ initialized, onAuthenticated }: AuthPageProps) {
  const [username, setUsername] = useState(initialized ? '' : 'admin')
  const [displayName, setDisplayName] = useState(initialized ? '' : 'Administrator')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)

    const trimmedUser = username.trim()
    if (trimmedUser.length < 2) {
      setError('用户名长度至少为 2 个字符')
      return
    }
    if (!initialized && password.length < 6) {
      setError('管理员密码长度至少为 6 个字符')
      return
    }
    if (!initialized && password !== confirmPassword) {
      setError('两次输入的密码不一致')
      return
    }

    setSubmitting(true)
    try {
      const pair = initialized
        ? await api.authLogin({ username: trimmedUser, password })
        : await api.authSetup({
            username: trimmedUser,
            displayName: displayName.trim() || trimmedUser,
            password,
          })
      if (pair.accessToken) {
        setStoredAccessToken(pair.accessToken)
      }
      onAuthenticated(pair.user)
    } catch (err) {
      // Strictly keep entered username/displayName intact on error (never reset form!)
      setError(err instanceof Error ? err.message : initialized ? '登录失败，请检查账号密码' : '初始化失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10 text-foreground">
      <div className="app-bg-mesh" aria-hidden="true" />

      <div className="fixed right-4 top-4 z-20">
        <ThemePicker variant="dropdown" persistToServer={false} />
      </div>

      <div className="surface-card relative z-10 w-full max-w-[450px] border p-8 shadow-[var(--shadow-lg)]">
        <div className="mb-7 flex items-center gap-3.5">
          <svg viewBox="0 0 64 64" className="h-11 w-11 shrink-0" fill="none" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="var(--color-card)" />
            <rect x="3" y="3" width="58" height="58" rx="11" stroke="var(--color-border-strong)" strokeWidth="3" />
            <path d="M18 22L28 32L18 42" stroke="var(--color-accent)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M46 22L36 32L46 42" stroke="var(--color-success)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <div>
            <h1 className="font-mono-num text-xl font-bold tracking-tight">PVE Dash</h1>
            <p className="text-sm text-muted-foreground">
              {initialized
                ? 'Proxmox VE 多集群控制平面'
                : '首次启动 · 创建平台管理员账号'}
            </p>
          </div>
        </div>

        {!initialized && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-accent/35 bg-accent/10 p-3 text-xs text-foreground">
            <ShieldCheck className="h-4 w-4 text-accent shrink-0 mt-0.5" />
            <div className="leading-relaxed">
              欢迎使用 PVE Dash。请先设置本地管理员凭据，之后即可接入一台或多台 Proxmox VE 7.4 / 8.x / 9.x 实例（凭据使用 AES-256-GCM 加密落库）。
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
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
              <label htmlFor="auth-displayname" className="block text-xs font-medium text-foreground">
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
              placeholder={initialized ? '请输入密码' : '至少 6 位字符'}
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

          <Button type="submit" variant="default" size="lg" className="w-full" disabled={submitting}>
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

        <div className="mt-5 flex items-center justify-between border-t border-border/70 pt-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Lock className="h-3 w-3" />
            Argon2id + HttpOnly Session
          </span>
          <span className="font-mono-num">PVE 7.4 · 8.x · 9.x</span>
        </div>
      </div>
    </div>
  )
}
