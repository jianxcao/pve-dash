import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-badge font-medium border whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'bg-muted text-foreground border-border',
        accent: 'bg-accent/12 text-accent border-accent/30',
        success: 'bg-success/12 text-success border-success/30',
        info: 'bg-info/12 text-info border-info/30',
        warning: 'bg-warning/14 text-warning border-warning/35',
        destructive: 'bg-destructive/14 text-destructive border-destructive/35',
        muted: 'bg-muted/80 text-muted-foreground border-border/80',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
