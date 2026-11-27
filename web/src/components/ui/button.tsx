import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--radius-control)] text-sm font-medium transition-all duration-150 active:translate-y-[0.5px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-btn-primary text-on-btn-primary hover:bg-btn-primary-hover font-semibold shadow-sm',
        primary: 'bg-btn-primary text-on-btn-primary hover:bg-btn-primary-hover font-semibold shadow-sm',
        secondary: 'bg-secondary text-on-secondary hover:bg-muted border border-border',
        outline: 'border border-border bg-transparent text-foreground hover:bg-muted hover:border-border-strong',
        ghost: 'text-foreground hover:bg-muted',
        destructive: 'bg-destructive text-on-destructive hover:bg-destructive/90 font-semibold',
        warning: 'bg-warning text-on-warning hover:bg-warning/90 font-semibold',
      },
      size: {
        xs: 'h-8 px-3 text-xs gap-1.5',
        sm: 'h-9 px-3.5 text-sm gap-1.5',
        md: 'h-10 px-4 text-sm',
        lg: 'h-11 px-5 text-base',
        icon: 'h-9 w-9 p-0',
        'icon-sm': 'h-8 w-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'secondary',
      size: 'sm',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, type = 'button', ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp
        ref={ref}
        type={asChild ? undefined : type}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      />
    )
  },
)
Button.displayName = 'Button'
