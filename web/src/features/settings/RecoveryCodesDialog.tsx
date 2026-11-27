import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Copy, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { api } from '@/lib/api/client'
import { copyToClipboard } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface RecoveryCodesRevealDialogProps {
  codes: string[] | null
  username: string
  onClose: () => void
}

export function RecoveryCodesRevealDialog({
  codes,
  username,
  onClose,
}: RecoveryCodesRevealDialogProps) {
  if (!codes || codes.length === 0) return null

  const formattedText = [
    `PVE Dash 一次性应急恢复码 (${username})`,
    `生成时间: ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    `提示: 每个恢复码仅可使用一次，请妥善保存在密码管理器 (如 Bitwarden) 或离线安全位置。`,
    '',
    ...codes,
  ].join('\n')

  const handleCopyAll = async () => {
    await copyToClipboard(codes.join('\n'))
    toast.success('已复制全部应急恢复码')
  }

  const handleDownloadTxt = () => {
    const blob = new Blob([formattedText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `pve-dash-recovery-codes-${username || 'user'}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    toast.success('已下载应急恢复码 .txt 文件')
  }

  return (
    <Dialog open={Boolean(codes)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-warning" />
            <span>请立即备份一次性应急恢复码</span>
          </DialogTitle>
          <DialogDescription>
            恢复码仅在生成时明文展示此一次（服务端仅存储单向哈希）。当无法使用指纹或手机验证器时，可凭任意未使用的恢复码应急登录。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
            <span>关闭此弹窗后将无法再次查看这些恢复码，建议存入 Bitwarden 备注或下载保存。</span>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-xl border border-border bg-muted/40 p-3.5">
            {codes.map((c) => (
              <div
                key={c}
                className="rounded-md border border-border/70 bg-card px-2.5 py-1.5 text-center font-mono-num text-sm font-semibold tracking-wider text-foreground"
              >
                {c}
              </div>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => void handleCopyAll()}
            >
              <Copy className="h-3.5 w-3.5" />
              一键复制全部
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={handleDownloadTxt}
            >
              <Download className="h-3.5 w-3.5" />
              下载 .txt 文件
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="primary" onClick={onClose}>
            我已安全备份，关闭窗口
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface RegenerateRecoveryCodesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onGenerated: (codes: string[]) => void
}

export function RegenerateRecoveryCodesDialog({
  open,
  onOpenChange,
  onGenerated,
}: RegenerateRecoveryCodesDialogProps) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (open) setPassword('')
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!password) return
    setBusy(true)
    try {
      const res = await api.regenerateRecoveryCodes(password)
      toast.success('已重新生成全新应急恢复码，旧恢复码已全部作废')
      onOpenChange(false)
      onGenerated(res.recoveryCodes || [])
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重新生成恢复码失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-4.5 w-4.5 text-warning" />
            <span>重新生成应急恢复码</span>
          </DialogTitle>
          <DialogDescription>
            重新生成后，之前保存的所有未使用的旧恢复码将立即全部失效。请验证当前账号密码继续。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-sm font-medium">当前登录密码</label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入当前账号密码以确认"
              autoComplete="current-password"
              required
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button type="submit" variant="primary" disabled={busy || !password}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              验证并生成新恢复码
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
