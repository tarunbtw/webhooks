import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '../../lib/utils'
import { Button } from './button'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  /** Label for the confirm/destructive action */
  confirmLabel?: string
  /** Label for the cancel action */
  cancelLabel?: string
  onConfirm: () => void | Promise<void>
  /** Show spinner on confirm button while async action runs */
  loading?: boolean
  /** Icon shown at the top of the dialog */
  icon?: React.ReactNode
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  loading = false,
  icon,
}: ConfirmDialogProps) {
  // Close on Escape
  React.useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onOpenChange])

  // Prevent body scroll while open
  React.useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-background/30 backdrop-blur-[2px]"
        onClick={() => !loading && onOpenChange(false)}
      />

      {/* Panel */}
      <div
        className={cn(
          'relative z-10 w-full max-w-sm mx-4',
          'rounded-lg border border-border bg-card shadow-lg',
          'animate-in fade-in-0 zoom-in-95 duration-150',
        )}
      >
        {/* Close button */}
        <button
          onClick={() => !loading && onOpenChange(false)}
          disabled={loading}
          aria-label="Close dialog"
          className={cn(
            'absolute top-3 right-3',
            'inline-flex items-center justify-center rounded-md p-1',
            'text-muted-foreground hover:text-foreground hover:bg-accent',
            'transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>

        <div className="p-6">
          {/* Optional icon */}
          {icon && (
            <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted">
              {icon}
            </div>
          )}

          {/* Title */}
          <h2
            id="dialog-title"
            className="text-sm font-semibold text-foreground leading-snug pr-6"
          >
            {title}
          </h2>

          {/* Description */}
          {description && (
            <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">
              {description}
            </p>
          )}

          {/* Actions */}
          <div className="mt-5 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              {cancelLabel}
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={onConfirm}
              loading={loading}
              className="min-w-[72px]"
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
