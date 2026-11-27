import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'primary' | 'destructive' | 'warning'
  loading?: boolean
  onConfirm: () => void | Promise<void>
}

/**
 * Reusable confirmation modal for standard two-step actions (delete rule/channel/job,
 * rollback snapshot, revoke session, etc.) without requiring typed target input.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = '确认',
  cancelLabel = '取消',
  variant = 'destructive',
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setError(null)
      setSubmitting(false)
    }
  }, [open])

  const busy = submitting || loading

  const handleConfirm = async () => {
    if (busy) return
    setSubmitting(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作执行失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle
            className={cn(
              'flex items-center gap-2',
              variant === 'destructive' && 'text-destructive',
              variant === 'warning' && 'text-warning',
            )}
          >
            {(variant === 'destructive' || variant === 'warning') && (
              <AlertTriangle className="h-4 w-4 shrink-0" />
            )}
            <span>{title}</span>
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {children && <div className="space-y-3 text-xs text-foreground">{children}</div>}

        {error && (
          <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={() => void handleConfirm()} disabled={busy}>
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
