import { cn } from '@/lib/utils'

interface ResourceBarProps {
  percent: number // 0..100
  label?: string
  sublabel?: string
  size?: 'xs' | 'sm' | 'md'
  colorMode?: 'auto' | 'accent' | 'info' | 'success'
  className?: string
}

export function ResourceBar({
  percent,
  label,
  sublabel,
  size = 'sm',
  colorMode = 'auto',
  className,
}: ResourceBarProps) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))
  const barColor =
    colorMode === 'accent' || colorMode === 'info'
      ? 'bg-accent'
      : colorMode === 'success'
        ? 'bg-success'
        : clamped >= 90
          ? 'bg-destructive'
          : clamped >= 75
            ? 'bg-warning'
            : 'bg-accent'

  const hClass = size === 'xs' ? 'h-1.5' : size === 'md' ? 'h-2.5' : 'h-2'

  return (
    <div className={cn('w-full space-y-1.5', className)}>
      {(label || sublabel) && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="font-mono-num text-foreground font-medium whitespace-nowrap shrink-0">
            {label}
          </span>
          {sublabel && (
            <span className="font-mono-num text-muted-foreground truncate text-right">{sublabel}</span>
          )}
        </div>
      )}
      <div
        className={cn('w-full overflow-hidden rounded-full bg-muted', hClass)}
        role="progressbar"
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-200', barColor)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
