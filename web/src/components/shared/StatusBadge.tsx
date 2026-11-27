import {
  AlertTriangle,
  CheckCircle2,
  CircleOff,
  Loader2,
  PauseCircle,
  Square,
  XCircle,
  Copy,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface StatusBadgeProps {
  status: string
  template?: boolean
  className?: string
  compact?: boolean
}

/**
 * Accessible status indicator: never relies on color alone (always icon + text).
 */
export function StatusBadge({ status, template, className, compact }: StatusBadgeProps) {
  if (template) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-info/12 text-info border-info/30 whitespace-nowrap',
          className,
        )}
      >
        <Copy className="h-3.5 w-3.5 shrink-0" />
        {!compact && <span>模板</span>}
      </span>
    )
  }

  const normalized = (status || 'unknown').toLowerCase()

  if (
    normalized === 'running' ||
    normalized === 'online' ||
    normalized === 'available' ||
    normalized === 'ok' ||
    normalized === 'passed' ||
    normalized === 'success'
  ) {
    const label =
      normalized === 'running'
        ? '运行中'
        : normalized === 'online'
          ? '在线'
          : normalized === 'available'
            ? '可用'
            : normalized === 'passed'
              ? '健康'
              : '正常'
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-success/12 text-success border-success/30 whitespace-nowrap',
          className,
        )}
      >
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        {!compact && <span>{label}</span>}
      </span>
    )
  }

  if (normalized === 'stopped') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-muted text-muted-foreground border-border whitespace-nowrap',
          className,
        )}
      >
        <Square className="h-2.5 w-2.5 fill-current shrink-0" />
        {!compact && <span>已停止</span>}
      </span>
    )
  }

  if (normalized === 'paused' || normalized === 'suspended' || normalized === 'pending') {
    const label = normalized === 'pending' ? '待重启' : '已暂停'
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-warning/14 text-warning border-warning/35 whitespace-nowrap',
          className,
        )}
      >
        <PauseCircle className="h-3.5 w-3.5 shrink-0" />
        {!compact && <span>{label}</span>}
      </span>
    )
  }

  if (normalized === 'disabled') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-muted text-muted-foreground border-border whitespace-nowrap',
          className,
        )}
      >
        <CircleOff className="h-3.5 w-3.5 shrink-0" />
        {!compact && <span>已禁用</span>}
      </span>
    )
  }

  if (normalized === 'in_progress' || normalized === 'connecting') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-info/14 text-info border-info/35 whitespace-nowrap',
          className,
        )}
      >
        <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />
        {!compact && <span>进行中</span>}
      </span>
    )
  }

  if (
    normalized === 'offline' ||
    normalized === 'error' ||
    normalized === 'failed' ||
    normalized === 'unavailable'
  ) {
    const label = normalized === 'offline' ? '离线' : normalized === 'unavailable' ? '不可用' : '异常'
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-destructive/14 text-destructive border-destructive/35 whitespace-nowrap',
          className,
        )}
      >
        <XCircle className="h-3.5 w-3.5 shrink-0" />
        {!compact && <span>{label}</span>}
      </span>
    )
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium border bg-warning/14 text-warning border-warning/35 whitespace-nowrap',
        className,
      )}
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      {!compact && <span>{status}</span>}
    </span>
  )
}
