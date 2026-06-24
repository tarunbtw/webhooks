import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-mono font-semibold uppercase tracking-wide transition-colors',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-primary/10 text-foreground',
        outline:     'border-border text-muted-foreground',
        destructive: 'border-transparent bg-destructive/15 text-destructive',
        GET:         'border-transparent bg-muted text-foreground',
        POST:        'border-transparent bg-muted text-foreground',
        PUT:         'border-transparent bg-muted text-foreground',
        PATCH:       'border-transparent bg-muted text-foreground',
        DELETE:      'border-transparent bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
