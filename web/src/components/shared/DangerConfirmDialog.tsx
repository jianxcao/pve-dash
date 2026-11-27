import { useState, useEffect } from 'react'
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
import { Input } from '@/components/ui/input'

interface DangerConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmTarget: string
  confirmLabel?: string
  extraOptions?: React.ReactNode
  onConfirm: () => Promise<void>
}

/**
 * High-risk action guard: requires typing exact target ID/name (sent as X-Confirm-Target).
 * Preserves input on failure so user can see error clearly.
 */
export function DangerConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmTarget,
  confirmLabel = '确认执行',
  extraOptions,
  onConfirm,
}: DangerConfirmDialogProps) {
  const [typed, setTyped] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTyped('')
      setError(null)
      setSubmitting(false)
    }
  }, [open, confirmTarget])

  const matched = typed.trim() === confirmTarget

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!matched || submitting) return
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{title}</span>
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-3.5">
          {extraOptions}

          <div className="space-y-1.5">
            <label htmlFor="danger-confirm-input" className="block text-sm text-muted-foreground">
              请输入{' '}
              <code className="font-mono-num rounded bg-muted px-1.5 py-0.5 text-foreground font-semibold">
                {confirmTarget}
              </code>{' '}
              以二次确认：
            </label>
            <Input
              id="danger-confirm-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={confirmTarget}
              autoComplete="off"
              className="font-mono-num"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/15 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" variant="destructive" disabled={!matched || submitting}>
              {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
