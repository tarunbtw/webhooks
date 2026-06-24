import { Inbox } from 'lucide-react'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import type { Request } from '../types'

const METHOD_VARIANT: Record<string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'default'> = {
  GET:    'GET',
  POST:   'POST',
  PUT:    'PUT',
  PATCH:  'PATCH',
  DELETE: 'DELETE',
}

interface Props {
  requests: Request[]
  selectedId: string | null
  onSelect: (req: Request) => void
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function RequestList({ requests, selectedId, onSelect }: Props) {
  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-8 text-center">
        <Inbox className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No requests yet</p>
        <p className="text-xs text-muted-foreground/60">
          Send an HTTP request to your endpoint URL
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full">
      {requests.map((req) => {
        const isSelected = selectedId === req.id
        return (
          <button
            key={req.id}
            onClick={() => onSelect(req)}
            className={cn(
              'w-full text-left px-3 py-2.5 border-b border-border',
              'hover:bg-accent transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isSelected && 'bg-accent border-l-2 border-l-foreground'
            )}
          >
            <div className="flex items-center gap-2">
              <Badge variant={METHOD_VARIANT[req.method] ?? 'default'}>
                {req.method}
              </Badge>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatTime(req.received_at)}
              </span>
              <span className="ml-auto text-xs text-muted-foreground/60 tabular-nums">
                {req.size}B
              </span>
            </div>
            {req.content_type && (
              <p className="text-xs text-muted-foreground/60 mt-1 truncate">
                {req.content_type}
              </p>
            )}
          </button>
        )
      })}
    </div>
  )
}
