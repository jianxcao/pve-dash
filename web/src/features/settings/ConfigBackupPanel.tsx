import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CheckCircle2,
  Download,
  FileJson,
  Lock,
  Loader2,
  ShieldCheck,
  Upload,
} from 'lucide-react'
import { api } from '@/lib/api/client'
import type { ConfigImportPreview, EncryptedBackupBundle } from '@/lib/api/types'
import { OVERVIEW_QUERY_KEY } from '@/lib/sse/useOverviewStream'
import { useAppStore } from '@/stores/appStore'
import { formatISOTime } from '@/lib/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'

export function ConfigBackupPanel() {
  const queryClient = useQueryClient()
  const readOnly = useAppStore((s) => s.readOnly || s.serverReadOnly)

  // Export state
  const [expPass, setExpPass] = useState('')
  const [expPassConfirm, setExpPassConfirm] = useState('')
  const [expBusy, setExpBusy] = useState(false)

  // Import state
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [bundleFileName, setBundleFileName] = useState('')
  const [parsedBundle, setParsedBundle] = useState<EncryptedBackupBundle | null>(null)
  const [impPass, setImpPass] = useState('')
  const [preview, setPreview] = useState<ConfigImportPreview | null>(null)
  const [impBusy, setImpBusy] = useState(false)

  const handleExport = async (e: React.FormEvent) => {
    e.preventDefault()
    if (expPass.length < 8) {
      toast.error('加密口令至少需要 8 个字符')
      return
    }
    if (expPass !== expPassConfirm) {
      toast.error('两次输入的加密口令不一致')
      return
    }
    setExpBusy(true)
    try {
      const res = await api.exportConfig(expPass)
      const blob = new Blob([JSON.stringify(res.bundle, null, 2) + '\n'], {
        type: 'application/json',
      })
      const url = URL.createObjectURL(blob)
      const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
      const a = document.createElement('a')
      a.href = url
      a.download = `pve-dash-backup-${stamp}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
      const subsCount = res.summary.subscriptions ?? res.summary.subscriptionsTotal ?? 0
      toast.success(
        `已导出加密配置（${res.summary.instances} 个实例 · ${res.summary.channels} 个通道 · ${res.summary.alertRules} 条规则 · ${subsCount} 项事件订阅）`,
      )
      setExpPass('')
      setExpPassConfirm('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导出配置失败')
    } finally {
      setExpBusy(false)
    }
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const text = await file.text()
      const obj = JSON.parse(text) as EncryptedBackupBundle
      if (obj.format !== 'pve-dash-backup' || !obj.ciphertext || !obj.salt || !obj.nonce) {
        toast.error('所选文件不是有效的 PVE Dash 加密备份文件')
        return
      }
      setParsedBundle(obj)
      setBundleFileName(file.name)
      setPreview(null)
    } catch {
      toast.error('无法解析 JSON 备份文件')
    }
  }

  const handleDryRun = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!parsedBundle) {
      toast.error('请先选择加密备份 JSON 文件')
      return
    }
    if (!impPass) {
      toast.error('请输入备份文件的解密口令')
      return
    }
    setImpBusy(true)
    try {
      const res = await api.importConfig(parsedBundle, impPass, true)
      setPreview(res)
      toast.success('备份解密与校验通过，请确认增量导入预览')
    } catch (err) {
      setPreview(null)
      toast.error(err instanceof Error ? err.message : '解密预检失败')
    } finally {
      setImpBusy(false)
    }
  }

  const handleApplyImport = async () => {
    if (!parsedBundle || !preview || readOnly) return
    setImpBusy(true)
    try {
      const res = await api.importConfig(parsedBundle, impPass, false)
      const subsAdded = res.subscriptionsAdded ?? res.subscriptionsAdd ?? 0
      toast.success(
        `导入完成：新增 ${res.instancesAdd.length} 个实例、${res.channelsAdd.length} 个通道、${res.rulesAdd.length} 条告警规则、${subsAdded} 项事件订阅`,
      )
      setPreview(null)
      setParsedBundle(null)
      setBundleFileName('')
      setImpPass('')
      if (fileInputRef.current) fileInputRef.current.value = ''
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_QUERY_KEY })
      void queryClient.invalidateQueries({ queryKey: ['instances'] })
      void queryClient.invalidateQueries({ queryKey: ['alerts-channels'] })
      void queryClient.invalidateQueries({ queryKey: ['alerts-rules'] })
      void queryClient.invalidateQueries({ queryKey: ['alerts-subscriptions'] })
      void queryClient.invalidateQueries({ queryKey: ['alerts-summary'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '应用导入失败')
    } finally {
      setImpBusy(false)
    }
  }

  const subsAddCount = preview ? (preview.subscriptionsAdd ?? 0) : 0
  const subsSkipCount = preview ? (preview.subscriptionsSkip ?? 0) : 0
  const totalToAdd = preview
    ? preview.instancesAdd.length +
      preview.channelsAdd.length +
      preview.rulesAdd.length +
      subsAddCount
    : 0

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
      {/* Export Card */}
      <Card>
        <CardHeader className="border-b border-border/70">
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="h-4.5 w-4.5 text-accent" />
            <span>口令加密导出配置</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          <div className="rounded-lg border border-border bg-muted/40 p-3.5 text-xs text-muted-foreground space-y-1.5 leading-relaxed">
            <div className="flex items-center gap-1.5 font-medium text-foreground">
              <Lock className="h-3.5 w-3.5 text-success" />
              <span>端到端 Argon2id + AES-256-GCM 便携加密</span>
            </div>
            <p>
              导出内容包含全部 PVE 实例连接与凭据、告警通知通道密钥、阈值告警规则以及事件通知订阅策略。导出文件使用你指定的独立口令重新加密，绝不依赖本机 Master Key，可安全迁移到任意新部署的 PVE Dash 服务器。
            </p>
          </div>

          <form onSubmit={handleExport} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">备份加密口令（至少 8 位）</label>
              <Input
                type="password"
                value={expPass}
                onChange={(e) => setExpPass(e.target.value)}
                placeholder="请输入高强度口令"
                minLength={8}
                required
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">确认加密口令</label>
              <Input
                type="password"
                value={expPassConfirm}
                onChange={(e) => setExpPassConfirm(e.target.value)}
                placeholder="再次输入口令确认"
                minLength={8}
                required
              />
            </div>
            <Button type="submit" variant="primary" size="sm" disabled={expBusy}>
              {expBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              加密并下载备份 JSON
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Import Card */}
      <Card>
        <CardHeader className="border-b border-border/70">
          <CardTitle className="flex items-center gap-2 text-base">
            <Upload className="h-4.5 w-4.5 text-success" />
            <span>解密导入配置（增量无损合入）</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            采用「先解密预检（Dry-Run），后确认合入」两段式流程。同名 PVE 实例、告警通道、规则及已自定义的事件订阅会自动跳过，绝不覆盖现有线上配置；新增凭据会自动使用当前服务器的 Master Key 重新加密落盘。
          </p>

          <form onSubmit={handleDryRun} className="space-y-3.5">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium">选择加密备份文件 (.json)</label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  onChange={handleFileChange}
                  className="hidden"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <FileJson className="h-4 w-4" />
                  {bundleFileName ? '更换备份文件' : '选择备份文件'}
                </Button>
                {bundleFileName && (
                  <Badge variant="accent" className="font-mono-num">
                    {bundleFileName}
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium">备份解密口令</label>
              <Input
                type="password"
                value={impPass}
                onChange={(e) => {
                  setImpPass(e.target.value)
                  setPreview(null)
                }}
                placeholder="输入导出时设置的口令"
                required
              />
            </div>

            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={impBusy || !parsedBundle || !impPass}
            >
              {impBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              解密并预检差异 (Dry-Run)
            </Button>
          </form>

          {preview && (
            <div className="rounded-xl border border-success/40 bg-success/[0.07] p-4 space-y-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1.5 font-semibold text-foreground">
                  <CheckCircle2 className="h-4 w-4 text-success" />
                  预检通过 · 备份时间 {formatISOTime(preview.exportedAt)}
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 font-mono-num">
                {[
                  {
                    label: 'PVE 实例',
                    addCount: preview.instancesAdd.length,
                    addNames: preview.instancesAdd,
                    skipCount: preview.instancesSkip.length,
                    skipNames: preview.instancesSkip,
                  },
                  {
                    label: '告警通道',
                    addCount: preview.channelsAdd.length,
                    addNames: preview.channelsAdd,
                    skipCount: preview.channelsSkip.length,
                    skipNames: preview.channelsSkip,
                  },
                  {
                    label: '告警规则',
                    addCount: preview.rulesAdd.length,
                    addNames: preview.rulesAdd,
                    skipCount: preview.rulesSkip.length,
                    skipNames: preview.rulesSkip,
                  },
                  {
                    label: '事件订阅',
                    addCount: subsAddCount,
                    addNames: preview.subscriptionsAddCategories ?? [],
                    skipCount: subsSkipCount,
                    skipNames: preview.subscriptionsSkipCategories ?? [],
                  },
                ].map((sec) => (
                  <div key={sec.label} className="rounded-lg border border-border bg-background/70 p-2.5 space-y-1">
                    <div className="text-muted-foreground font-sans">{sec.label}</div>
                    <div className="font-semibold text-success">+{sec.addCount} 新增</div>
                    {sec.addNames.length > 0 && (
                      <div className="text-[11px] text-foreground break-all">
                        {sec.addNames.join('、')}
                      </div>
                    )}
                    <div className="text-muted-foreground">{sec.skipCount} 跳过</div>
                    {sec.skipNames.length > 0 && (
                      <div className="text-[11px] text-muted-foreground/80 break-all">
                        {sec.skipNames.join('、')}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  disabled={impBusy || readOnly || totalToAdd === 0}
                  title={
                    readOnly
                      ? '写保护已开启'
                      : totalToAdd === 0
                        ? '备份中的所有配置均已存在，无需重复导入'
                        : '将新增项安全合入当前服务器'
                  }
                  onClick={handleApplyImport}
                >
                  {impBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                  {totalToAdd === 0 ? '无新增变更' : `确认合入 ${totalToAdd} 项配置`}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
