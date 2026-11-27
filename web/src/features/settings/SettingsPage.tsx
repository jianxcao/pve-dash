import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Code2,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Palette,
  Save,
  Send,
  Sliders,
  Users,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import { copyToClipboard } from '@/lib/format'
import { setStoredAccessToken } from '@/lib/platform'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore, type DensityMode, type SidebarMode } from '@/stores/appStore'
import { ThemePicker } from '@/components/layout/ThemePicker'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
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

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const currentUser = useAppStore((s) => s.currentUser)
  const envReadOnly = useAppStore((s) => s.envReadOnly)
  const isAdmin = currentUser?.role === 'admin'

  const theme = useAppStore((s) => s.theme)
  const density = useAppStore((s) => s.density)
  const setDensity = useAppStore((s) => s.setDensity)
  const refreshSec = useAppStore((s) => s.refreshSec)
  const setRefreshSec = useAppStore((s) => s.setRefreshSec)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const setSidebarMode = useAppStore((s) => s.setSidebarMode)

  const rawTab = searchParams.get('tab') || 'appearance'
  const validTabs = isAdmin
    ? new Set(['appearance', 'users', 'backup', 'explorer'])
    : new Set(['appearance'])
  const activeTab = validTabs.has(rawTab) ? rawTab : 'appearance'

  const [saving, setSaving] = useState(false)

  // Self password change
  const [curPassword, setCurPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwBusy, setPwBusy] = useState(false)

  // Admin Raw API Escape Hatch Inspector
  const { data: overview } = useOverviewQuery()
  const instances = overview?.instances ?? []
  const [rawInstanceId, setRawInstanceId] = useState('')
  const [rawPath, setRawPath] = useState('/version')
  const [rawOutput, setRawOutput] = useState('')
  const [rawBusy, setRawBusy] = useState(false)

  const effectiveInstId = instances.some((i) => i.id === rawInstanceId)
    ? rawInstanceId
    : instances[0]?.id || ''

  const handleSavePrefs = async () => {
    setSaving(true)
    try {
      await api.savePreferences({
        theme,
        density,
        refreshSec,
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
      <div className="space-y-1">
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">系统设置与安全中心</h1>
        <p className="text-sm text-muted-foreground">
          个性化视觉主题与账号密码设置{isAdmin ? '，以及多用户 RBAC 权限、加密配置迁移与 Raw PVE API 探测器' : ''}
        </p>
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

        {/* Tab 1: Appearance, Preferences & Self Password */}
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
                <span>布局与遥测偏好</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">左侧导航默认视图</label>
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
                  <label className="block text-xs font-medium">表格与卡片密度</label>
                  <NativeSelect
                    value={density}
                    onChange={(e) => setDensity(e.target.value as DensityMode)}
                    className="w-full"
                  >
                    <option value="compact">高密度紧凑 (Dashboard)</option>
                    <option value="comfortable">舒展标准</option>
                  </NativeSelect>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium">SSE 遥测刷新周期（秒）</label>
                  <Input
                    type="number"
                    min={2}
                    max={60}
                    value={refreshSec}
                    onChange={(e) => setRefreshSec(Number(e.target.value) || 3)}
                    className="font-mono-num"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <Button variant="default" size="sm" onClick={handleSavePrefs} disabled={saving}>
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
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
                    <label className="block text-xs font-medium">当前密码</label>
                    <Input
                      type="password"
                      value={curPassword}
                      onChange={(e) => setCurPassword(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">新密码（至少 8 位）</label>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium">确认新密码</label>
                    <Input
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      minLength={8}
                      required
                    />
                  </div>
                </div>
                <div className="flex items-center justify-between gap-3">
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
        </TabsContent>

        {/* Tab 2: Multi-User RBAC (Admin Only) */}
        {isAdmin && (
          <TabsContent value="users">
            <UserManagementPanel />
          </TabsContent>
        )}

        {/* Tab 3: Encrypted Config Backup & Restore (Admin Only) */}
        {isAdmin && (
          <TabsContent value="backup">
            <ConfigBackupPanel />
          </TabsContent>
        )}

        {/* Tab 4: Admin Raw API Explorer (Admin Only) */}
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
                      className="rounded-md border border-border bg-background/70 px-2 py-1 font-mono-num text-[11px] text-muted-foreground hover:border-accent hover:text-accent disabled:opacity-50 disabled:pointer-events-none transition-colors"
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
                  <Button type="submit" variant="primary" size="md" disabled={rawBusy || !effectiveInstId}>
                    {rawBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
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
