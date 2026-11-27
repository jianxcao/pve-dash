import { Copy } from 'lucide-react'
import type { DiskHardwareItem } from '@/lib/api/types'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function healthGradeMeta(grade?: string, pct?: number) {
  switch (grade) {
    case 'excellent':
      return {
        label: '优秀',
        badge: 'success' as const,
        barColor: 'bg-success',
        textColor: 'text-success',
      }
    case 'good':
      return {
        label: '良好',
        badge: 'info' as const,
        barColor: 'bg-info',
        textColor: 'text-info',
      }
    case 'warning':
      return {
        label: '需关注',
        badge: 'warning' as const,
        barColor: 'bg-warning',
        textColor: 'text-warning',
      }
    case 'critical':
      return {
        label: '高风险',
        badge: 'destructive' as const,
        barColor: 'bg-destructive',
        textColor: 'text-destructive',
      }
    default:
      return {
        label: pct !== undefined ? '正常' : '未采集',
        badge: 'muted' as const,
        barColor: 'bg-stopped',
        textColor: 'text-muted-foreground',
      }
  }
}

interface SmartReportDialogProps {
  disk: DiskHardwareItem | null
  onClose: () => void
  onCopy: (text: string) => void
}

export function SmartReportDialog({ disk, onClose, onCopy }: SmartReportDialogProps) {
  if (!disk) return null

  const gm = healthGradeMeta(disk.healthGrade, disk.healthPct)
  const errCount =
    (disk.mediaErrors ?? 0) + (disk.reallocatedSectors ?? 0) + (disk.pendingSectors ?? 0)

  return (
    <Dialog open={Boolean(disk)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="w-[min(95vw,760px)]">
        <DialogHeader>
          <DialogTitle className="font-mono-num">
            SMART 健康报告 · {disk.devpath} ({disk.model})
          </DialogTitle>
          <DialogDescription>
            序列号: {disk.serial || '—'} · 协议类型: {(disk.type || 'disk').toUpperCase()} · SMART
            状态: {disk.health || '—'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {disk.healthPct !== undefined && (
            <div className="rounded-lg border border-border bg-muted/35 p-4 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="text-sm font-medium text-muted-foreground">综合健康评分</span>
                  <span className={cn('font-mono-num text-2xl font-bold', gm.textColor)}>
                    {disk.healthPct}%
                  </span>
                  <Badge variant={gm.badge}>{gm.label}</Badge>
                </div>
                {disk.wearoutPct !== undefined && (
                  <span className="font-mono-num text-xs text-muted-foreground">
                    剩余寿命 {disk.wearoutPct}% · 已损耗{' '}
                    {disk.usedLifePct ?? 100 - disk.wearoutPct}%
                  </span>
                )}
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-background/80">
                <div
                  className={cn('h-full rounded-full', gm.barColor)}
                  style={{ width: `${Math.max(4, disk.healthPct)}%` }}
                />
              </div>
              {(disk.healthReasons?.length ?? 0) > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-0.5">
                  {disk.healthReasons!.map((r) => (
                    <span
                      key={r}
                      className="rounded border border-border bg-background/70 px-2 py-0.5 text-xs text-muted-foreground"
                    >
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">可用备用块 / 阈值</div>
              <div className="mt-1 font-mono-num text-base font-semibold text-foreground">
                {disk.availableSparePct !== undefined
                  ? `${disk.availableSparePct}%${disk.availableSpareThresholdPct !== undefined ? ` / ${disk.availableSpareThresholdPct}%` : ''}`
                  : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">当前温度</div>
              <div className="mt-1 font-mono-num text-base font-semibold text-foreground">
                {disk.tempC !== undefined ? `${disk.tempC.toFixed(0)}°C` : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">累计通电 / 开关机</div>
              <div className="mt-1 font-mono-num text-base font-semibold text-foreground">
                {disk.powerOnHours !== undefined ? `${disk.powerOnHours.toLocaleString()} h` : '—'}
                {disk.powerCycles !== undefined ? ` · ${disk.powerCycles}次` : ''}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">异常断电 (Unsafe)</div>
              <div className="mt-1 font-mono-num text-base font-semibold text-foreground">
                {disk.unsafeShutdowns !== undefined ? `${disk.unsafeShutdowns} 次` : '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">累计主机写入</div>
              <div className="mt-1 font-mono-num text-base font-semibold text-foreground">
                {disk.dataWritten || '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">累计主机读取</div>
              <div className="mt-1 font-mono-num text-base font-semibold text-foreground">
                {disk.dataRead || '—'}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">介质 / 坏道错误</div>
              <div
                className={cn(
                  'mt-1 font-mono-num text-base font-semibold',
                  errCount > 0 ? 'text-destructive' : 'text-success',
                )}
              >
                {errCount}
              </div>
            </div>
            <div className="rounded-lg border border-border bg-background/60 p-3">
              <div className="text-xs text-muted-foreground">关键告警标志</div>
              <div
                className={cn(
                  'mt-1 font-mono-num text-base font-semibold',
                  disk.criticalWarning ? 'text-destructive' : 'text-success',
                )}
              >
                {disk.criticalWarning !== undefined
                  ? disk.criticalWarning === 0
                    ? '0x00 (正常)'
                    : `0x${disk.criticalWarning.toString(16)}`
                  : '—'}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>原始 SMART 诊断输出</span>
              {disk.smartText && (
                <Button variant="ghost" size="xs" onClick={() => onCopy(disk.smartText!)}>
                  <Copy className="h-3.5 w-3.5" />
                  复制原始报告
                </Button>
              )}
            </div>
            <pre className="max-h-[38vh] overflow-auto rounded-lg border border-border bg-console-bg p-3.5 font-mono-num text-xs text-slate-200 leading-relaxed whitespace-pre-wrap">
              {disk.smartText || '无原始 SMART 输出'}
            </pre>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
