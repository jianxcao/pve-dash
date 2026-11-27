import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Code2,
  Copy,
  Download,
  Fingerprint,
  Info,
  KeyRound,
  Loader2,
  Palette,
  Save,
  Send,
  Sliders,
  Type,
  Users,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { GlobalOverview } from '@/lib/api/types'
import { copyToClipboard } from '@/lib/format'
import { setStoredAccessToken } from '@/lib/platform'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import {
  useAppStore,
  type DensityMode,
  type FontScale,
  type SidebarMode,
} from '@/stores/appStore'
import { ThemePicker } from '@/components/layout/ThemePicker'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AccountSecurityPanel } from './AccountSecurityPanel'
import { UserManagementPanel } from './UserManagementPanel'
import { ConfigBackupPanel } from './ConfigBackupPanel'

const RAW_PRESETS = [
  '/version',
  '/cluster/status',
  '/cluster/resources',
  '/nodes',
  '/storage',
  '/cluster/ha/status/current',
]

const FONT_SCALE_OPTIONS: Array<{
  value: FontScale
  label: string
  badge: string
  desc: string
}> = [
  {
    value: 'sm',
    label: '紧凑 (13px)',
    badge: '13px',
    desc: '适合高分多窗并排与高信息密度巡检',
  },
  {
    value: 'md',
    label: '标准推荐 (14px)',
    badge: '14px 默认',
    desc: '均衡的正文阅读清晰度与控制台排版密度',
  },
  {
    value: 'lg',
    label: '舒展大字 (15px)',
    badge: '15px',
    desc: '适合高清大屏远距查看或更舒展的大字阅读',
  },
]

const selectInstanceOptions = (d: GlobalOverview) =>
  (d.instances ?? []).map((i) => ({ id: i.id, name: i.name }))

function clampRefreshSec(raw: string, fallback: number): number {
  const trimmed = raw.trim()
  if (!trimmed) return fallback
  const parsed = Math.round(Number(trimmed))
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(2, Math.min(60, parsed))
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const currentUser = useAppStore((s) => s.currentUser)
  const envReadOnly = useAppStore((s) => s.envReadOnly)
  const isAdmin = currentUser?.role === 'admin'

  const theme = useAppStore((s) => s.theme)
  const density = useAppStore((s) => s.density)
  const setDensity = useAppStore((s) => s.setDensity)
  const fontScale = useAppStore((s) => s.fontScale)
  const setFontScale = useAppStore((s) => s.setFontScale)
  const refreshSec = useAppStore((s) => s.refreshSec)
  const setRefreshSec = useAppStore((s) => s.setRefreshSec)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const setSidebarMode = useAppStore((s) => s.setSidebarMode)

  const [refreshSecInput, setRefreshSecInput] = useState(() => String(refreshSec))
  useEffect(() => {
    setRefreshSecInput(String(refreshSec))
  }, [refreshSec])

  const rawTab = searchParams.get('tab') || 'appearance'
  const validTabs = isAdmin
    ? new Set(['appearance', 'security', 'users', 'backup', 'explorer'])
    : new Set(['appearance', 'security'])
  const activeTab = validTabs.has(rawTab) ? rawTab : 'appearance'

  const [saving, setSaving] = useState(false)

  // Self password change
  const [curPassword, setCurPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  // System build & version info
  const { data: sysInfo } = useQuery({
    queryKey: ['system-info'],
    queryFn: api.systemInfo,
    staleTime: 300_000,
  })

  // Admin Raw API Escape Hatch Inspector
  const { data: instances = [] } = useOverviewQuery(selectInstanceOptions)
  const [rawInstanceId, setRawInstanceId] = useState('')
  const [rawPath, setRawPath] = useState('/version')
  const [rawOutput, setRawOutput] = useState('')
  const [rawBusy, setRawBusy] = useState(false)

  const effectiveInstId = instances.some((i) => i.id === rawInstanceId)
    ? rawInstanceId
    : instances[0]?.id || ''

  const commitRefreshSec = (): number => {
    const next = clampRefreshSec(refreshSecInput, refreshSec)
    setRefreshSec(next)
    setRefreshSecInput(String(next))
    return next
  }

  const handleSelectFontScale = (nextScale: FontScale) => {
    setFontScale(nextScale)
    if (currentUser && !envReadOnly) {
      const nextRefreshSec = commitRefreshSec()
      void api
        .savePreferences({
          theme,
          density,
          fontScale: nextScale,
          refreshSec: nextRefreshSec,
          locale: 'zh-CN',
          sidebarMode,
        })
        .catch(() => {
          // Silent fallback: local store already updated, user can also click Save Preferences
        })
    }
  }

  const handleSavePrefs = async () => {
    const nextRefreshSec = commitRefreshSec()
    setSaving(true)
    try {
      await api.savePreferences({
        theme,
        density,
        fontScale,
        refreshSec: nextRefreshSec,
        locale: 'zh-CN',
        sidebarMode,
      })
      toast.success('偏好设置已同步至服务端')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存设置失败')
    } finally {
      setSaving(false)
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPassword.length < 8) {
      toast.error('新密码至少需要 8 个字符')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致')
      return
    }
    setPwBusy(true)
    try {
      const res = await api.changePassword(curPassword, newPassword)
      if (res.accessToken) {
        setStoredAccessToken(res.accessToken)
      }
      void queryClient.invalidateQueries({ queryKey: ['auth-me'] })
      void queryClient.invalidateQueries({ queryKey: ['users'] })
      toast.success('登录密码已更新，其它设备的历史会话已自动注销')
      setCurPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '修改密码失败')
    } finally {
      setPwBusy(false)
    }
  }

  const runRawQuery = async (targetPath: string) => {
    if (!effectiveInstId || !targetPath.trim()) return
    setRawBusy(true)
    try {
      const res = await api.rawGet(effectiveInstId, targetPath.trim())
      setRawOutput(JSON.stringify(res, null, 2))
    } catch (err) {
      setRawOutput(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRawBusy(false)
    }
  }

  const handleRunRaw = async (e: React.FormEvent) => {
    e.preventDefault()
    await runRawQuery(rawPath)
  }

  return (
    <div className="mx-auto max-w-[1280px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">系统设置与安全中心</h1>
          <p className="text-sm text-muted-foreground">
            个性化视觉主题、通行密钥 / 动态口令双重验证 (2FA) 与账号密码设置
            {isAdmin ? '，以及多用户 RBAC 权限、加密配置迁移与 Raw PVE API 探测器' : ''}
          </p>
        </div>
        {sysInfo && (
          <Badge variant="muted" className="font-mono-num">
            PVE Dash {sysInfo.version}
            {sysInfo.commit && sysInfo.commit !== 'none' ? ` (${sysInfo.commit.slice(0, 7)})` : ''}
          </Badge>
        )}
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams({ tab: v }, { replace: true })}
      >
        <TabsList className="flex-wrap h-auto">
          <TabsTrigger value="appearance">
            <Palette className="h-4 w-4" />
            外观偏好与密码
          </TabsTrigger>
          <TabsTrigger value="security">
            <Fingerprint className="h-4 w-4" />
            双重验证 (2FA)
          </TabsTrigger>
          {isAdmin && (
            <>
              <TabsTrigger value="users">
                <Users className="h-4 w-4" />
                用户与权限 (RBAC)
              </TabsTrigger>
              <TabsTrigger value="backup">
                <Download className="h-4 w-4" />
                配置加密备份与迁移
              </TabsTrigger>
              <TabsTrigger value="explorer">
                <Code2 className="h-4 w-4" />
                Raw API 逃生舱
              </TabsTrigger>
            </>
          )}
        </TabsList>

        {/* Tab 1: Appearance, Preferences, Self Password & System Version */}
        <TabsContent value="appearance" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-4.5 w-4.5 text-accent" />
                <span>视觉主题工坊（即时切换并自动同步）</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ThemePicker variant="grid" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sliders className="h-4.5 w-4.5 text-accent" />
                <span>全局字号、布局与遥测偏好</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <Type className="h-4 w-4 text-accent" />
                    <span>全局字号大小</span>
                  </label>
                  <span className="text-xs text-muted-foreground">
                    统一集中控制全站主体字号、表格与标签比例（最低不小于 12px，切换即时生效）
                  </span>
                </div>
                <div
                  role="radiogroup"
                  aria-label="全局字号大小"
                  className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                >
                  {FONT_SCALE_OPTIONS.map((opt) => {
                    const active = fontScale === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => handleSelectFontScale(opt.value)}
                        className={
                          active
                            ? 'flex flex-col items-start gap-1 rounded-xl border-2 border-accent bg-accent/10 px-4 py-3 text-left transition-colors'
                            : 'flex flex-col items-start gap-1 rounded-xl border border-border bg-background/60 px-4 py-3 text-left hover:border-border-strong hover:bg-muted/40 transition-colors'
                        }
                      >
                        <div className="flex w-full items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-foreground whitespace-nowrap">
                            {opt.label}
                          </span>
                          <Badge
                            variant={active ? 'accent' : 'muted'}
                            className="text-badge font-mono-num"
                          >
                            {opt.badge}
                          </Badge>
                        </div>
                        <span className="text-xs text-muted-foreground leading-relaxed">
                          {opt.desc}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="block text-sm font-medium">左侧导航默认视图</label>
                  <NativeSelect
                    value={sidebarMode}
                    onChange={(e) => setSidebarMode(e.target.value as SidebarMode)}
                    className="w-full"
                  >
                    <option value="functional">功能视角（现代扁平导航）</option>
                    <option value="tree">经典资源树（Instance → Node → VM/LXC）</option>
                  </NativeSelect>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-medium">表格与卡片密度</label>
                  <NativeSelect
                    value={density}
                    onChange={(e) => setDensity(e.target.value as DensityMode)}
                    className="w-full"
                  >
                    <option value="comfortable">舒展标准（默认推荐）</option>
                    <option value="compact">高密度紧凑 (Dashboard)</option>
                  </NativeSelect>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-sm font-medium">SSE 遥测刷新周期（2–60 秒）</label>
                  <Input
                    type="number"
                    min={2}
                    max={60}
                    value={refreshSecInput}
                    onChange={(e) => setRefreshSecInput(e.target.value)}
                    onBlur={commitRefreshSec}
                    className="font-mono-num"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {envReadOnly
                    ? '服务端已开启 PVE_DASH_READ_ONLY 强制只读模式，偏好仅在当前浏览器生效。'
                    : '偏好设置会自动保存在当前浏览器，也可同步至服务端账户配置。'}
                </span>
                <Button
                  variant="default"
                  size="sm"
                  onClick={handleSavePrefs}
                  disabled={saving || envReadOnly}
                  title={envReadOnly ? '服务端强制只读模式下不可写入服务端偏好' : undefined}
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  保存到账户配置
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-4.5 w-4.5 text-warning" />
                <span>修改当前账号密码</span>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleChangePassword} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium">当前密码</label>
                    <Input
                      type="password"
                      value={curPassword}
                      onChange={(e) => setCurPassword(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium">新密码（至少 8 位）</label>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-sm font-medium">确认新密码</label>
                    <Input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-xs text-muted-foreground">
                    {envReadOnly
                      ? '服务端已开启 PVE_DASH_READ_ONLY 强制只读模式，当前禁止修改登录密码。'
                      : '修改密码后将自动吊销其它浏览器与移动端的历史登录会话，当前页面保持登录状态。'}
                  </span>
                  <Button type="submit" variant="outline" size="sm" disabled={pwBusy || envReadOnly}>
                    {pwBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    更新密码
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {sysInfo && (
            <Card>
              <CardHeader className="py-4">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Info className="h-4 w-4 text-info" />
                  <span>系统版本与运行环境</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-0.5">
                    <div className="text-xs text-muted-foreground">发行版本</div>
                    <div className="font-mono-num font-semibold text-foreground">
                      {sysInfo.version || 'dev'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-0.5">
                    <div className="text-xs text-muted-foreground">构建 Commit</div>
                    <div className="font-mono-num font-semibold text-foreground truncate">
                      {sysInfo.commit || 'none'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-0.5">
                    <div className="text-xs text-muted-foreground">构建时间</div>
                    <div className="font-mono-num font-semibold text-foreground truncate">
                      {sysInfo.buildTime || 'unknown'}
                    </div>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 space-y-0.5">
                    <div className="text-xs text-muted-foreground">Go 运行时 / 模式</div>
                    <div className="font-mono-num font-semibold text-foreground truncate">
                      {sysInfo.goVersion || 'go'} · {sysInfo.readOnly ? '只读' : '读写'}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Tab 2: Self-Service Account Security (Passkey / TOTP / Recovery Codes) */}
        <TabsContent value="security">
          <AccountSecurityPanel />
        </TabsContent>

        {/* Tab 3: Multi-User RBAC (Admin Only) */}
        {isAdmin && (
          <TabsContent value="users">
            <UserManagementPanel />
          </TabsContent>
        )}

        {/* Tab 4: Encrypted Config Backup & Restore (Admin Only) */}
        {isAdmin && (
          <TabsContent value="backup">
            <ConfigBackupPanel />
          </TabsContent>
        )}

        {/* Tab 5: Admin Raw API Explorer (Admin Only) */}
        {isAdmin && (
          <TabsContent value="explorer">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Code2 className="h-4.5 w-4.5 text-info" />
                  <span>Raw PVE API 只读透传探测器（管理员逃生舱）</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  通过后端受控代理直接查询指定 PVE 实例的任意{' '}
                  <code className="font-mono-num">/api2/json/*</code> 路径，便于排查版本差异与深度硬件参数。
                </p>

                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-muted-foreground mr-1">常用路径：</span>
                  {RAW_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      disabled={rawBusy || !effectiveInstId}
                      onClick={() => {
                        setRawPath(p)
                        void runRawQuery(p)
                      }}
                      className="rounded-md border border-border bg-background/70 px-2.5 py-1 font-mono-num text-xs text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>

                <form onSubmit={handleRunRaw} className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    value={effectiveInstId}
                    onChange={(e) => setRawInstanceId(e.target.value)}
                    className="h-10 text-sm min-w-[160px]"
                  >
                    {instances.length === 0 && <option value="">无可用实例</option>}
                    {instances.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </NativeSelect>
                  <Input
                    value={rawPath}
                    onChange={(e) => setRawPath(e.target.value)}
                    placeholder="/cluster/status"
                    className="font-mono-num flex-1 min-w-[200px] text-sm"
                  />
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    disabled={rawBusy || !effectiveInstId}
                  >
                    {rawBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                    GET 查询
                  </Button>
                </form>

                {rawOutput && (
                  <div className="space-y-2">
                    <div className="flex justify-end">
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={async () => {
                          await copyToClipboard(rawOutput)
                          toast.success('已复制 JSON 响应')
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        复制 JSON
                      </Button>
                    </div>
                    <pre className="max-h-[460px] overflow-auto rounded-lg border border-border bg-console-bg p-3.5 font-mono-num text-xs text-slate-200 leading-relaxed">
                      {rawOutput}
                    </pre>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  )
}
