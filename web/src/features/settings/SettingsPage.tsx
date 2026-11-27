import { useState } from 'react'
import { toast } from 'sonner'
import { Code2, Loader2, Palette, Save, Send, Sliders } from 'lucide-react'
import { api } from '@/lib/api/client'
import { useOverviewQuery } from '@/lib/sse/useOverviewStream'
import { useAppStore, type DensityMode, type SidebarMode } from '@/stores/appStore'
import { ThemePicker } from '@/components/layout/ThemePicker'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, NativeSelect } from '@/components/ui/input'

export function SettingsPage() {
  const theme = useAppStore((s) => s.theme)
  const density = useAppStore((s) => s.density)
  const setDensity = useAppStore((s) => s.setDensity)
  const refreshSec = useAppStore((s) => s.refreshSec)
  const setRefreshSec = useAppStore((s) => s.setRefreshSec)
  const sidebarMode = useAppStore((s) => s.sidebarMode)
  const setSidebarMode = useAppStore((s) => s.setSidebarMode)

  const [saving, setSaving] = useState(false)

  // Admin Raw API Escape Hatch Inspector
  const { data: overview } = useOverviewQuery()
  const instances = overview?.instances ?? []
  const [rawInstanceId, setRawInstanceId] = useState('')
  const [rawPath, setRawPath] = useState('/version')
  const [rawOutput, setRawOutput] = useState('')
  const [rawBusy, setRawBusy] = useState(false)

  const effectiveInstId = rawInstanceId || instances[0]?.id || ''

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

  const handleRunRaw = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!effectiveInstId || !rawPath.trim()) return
    setRawBusy(true)
    try {
      const res = await api.rawGet(effectiveInstId, rawPath.trim())
      setRawOutput(JSON.stringify(res, null, 2))
    } catch (err) {
      setRawOutput(`Error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRawBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-[1240px] px-5 py-6 sm:px-8 sm:py-7 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl sm:text-[28px] font-semibold tracking-tight">系统设置与主题工坊</h1>
        <p className="text-sm text-muted-foreground">
          自由切换多套精选暗黑与浅色视觉主题、调整侧栏视图，并使用管理员 Raw PVE API 探测器
        </p>
      </div>

      {/* Multi-Theme Visual Gallery */}
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

      {/* Workspace & Telemetry Preferences */}
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

      {/* Admin Raw API Inspector */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code2 className="h-4.5 w-4.5 text-info" />
            <span>Raw PVE API 只读透传探测器（管理员逃生舱）</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            通过后端受控代理直接查询指定 PVE 实例的任意 <code className="font-mono-num">/api2/json/*</code> 路径，便于排查版本差异与深度硬件参数。
          </p>
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
            <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-console-bg p-3.5 font-mono-num text-xs text-slate-200 leading-relaxed">
              {rawOutput}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
