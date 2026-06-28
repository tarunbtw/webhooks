import { useState } from 'react'
import { Trash2, Send, ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Separator } from './ui/separator'
import { ConfirmDialog } from './ui/dialog'
import { api } from '../api/client'
import type { Request } from '../types'

interface Props {
  request: Request
  onDelete: (id: string) => void
}

type Tab = 'headers' | 'query' | 'body' | 'replay'

function tryPrettyJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

/** Key-value table with zebra rows */
function KVTable({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data)
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground italic">No entries</p>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-border overflow-hidden">
      {entries.map(([k, v], i) => (
        <div
          key={k}
          className={cn(
            'grid grid-cols-[200px_1fr] gap-0 text-xs font-mono',
            i % 2 === 0 ? 'bg-card' : 'bg-muted/30',
            i !== entries.length - 1 && 'border-b border-border'
          )}
        >
          <div className="px-3 py-2 text-muted-foreground border-r border-border truncate font-medium">
            {k}
          </div>
          <div className="px-3 py-2 text-foreground break-all">
            {v}
          </div>
        </div>
      ))}
    </div>
  )
}

export function RequestDetail({ request, onDelete }: Props) {
  const [tab, setTab] = useState<Tab>('headers')
  const [replayUrl, setReplayUrl] = useState('')
  const [replayResult, setReplayResult] = useState<{ status: number; body: string } | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const handleReplay = async () => {
    if (!replayUrl) return
    setReplaying(true)
    setReplayResult(null)
    try {
      const result = await api.replay(request.id, replayUrl)
      setReplayResult({ status: result.status, body: result.body })
    } catch (e) {
      setReplayResult({ status: 0, body: String(e) })
    } finally {
      setReplaying(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      await api.deleteRequest(request.id)
      onDelete(request.id)
    } finally {
      setDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'headers', label: 'Headers' },
    { id: 'query',   label: 'Query' },
    { id: 'body',    label: 'Body' },
    { id: 'replay',  label: 'Replay' },
  ]

  const methodVariant = request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'default'

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Request meta bar ── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card flex-shrink-0">
        <Badge variant={methodVariant}>{request.method}</Badge>

        <div className="flex items-center gap-3 min-w-0 flex-1 text-xs text-muted-foreground">
          <span className="tabular-nums shrink-0">
            {new Date(request.received_at).toLocaleString()}
          </span>
          <span className="hidden sm:inline shrink-0 tabular-nums">
            {request.size} bytes
          </span>
          {request.ip && (
            <span className="hidden md:inline font-mono truncate text-muted-foreground/60">
              {request.ip}
            </span>
          )}
        </div>

        <Button
          variant="default"
          size="sm"
          onClick={() => setDeleteDialogOpen(true)}
          aria-label="Delete request"
          className="h-7 px-2.5 text-xs gap-1.5 shrink-0"
        >
          <Trash2 className="h-3 w-3" />
          <span className="hidden sm:inline">Delete</span>
        </Button>
      </div>

      {/* Delete request confirmation dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete this request?"
        description="The captured request data will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={handleDelete}
        loading={deleting}
        icon={<Trash2 className="h-4 w-4 text-muted-foreground" />}
      />

      {/* ── Tabs ── */}
      <div className="flex border-b border-border bg-muted/30 flex-shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1 px-4 py-2.5 text-xs font-medium transition-colors relative',
              'hover:text-foreground focus-visible:outline-none',
              tab === t.id
                ? 'text-foreground bg-background border-b-2 border-b-foreground -mb-px'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            {t.label}
            {t.id === 'query' && Object.keys(request.query_params).length > 0 && (
              <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                {Object.keys(request.query_params).length}
              </span>
            )}
            {t.id === 'headers' && (
              <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                {Object.keys(request.headers).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0 space-y-3">
        {tab === 'headers' && <KVTable data={request.headers} />}

        {tab === 'query' && <KVTable data={request.query_params} />}

        {tab === 'body' && (
          request.body ? (
            <pre className={cn(
              'text-xs font-mono rounded-md border border-border',
              'bg-card p-4 overflow-x-auto whitespace-pre-wrap break-all',
              'text-foreground leading-relaxed'
            )}>
              {tryPrettyJSON(request.body)}
            </pre>
          ) : (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground italic">Empty body</p>
            </div>
          )
        )}

        {tab === 'replay' && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-card p-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-foreground mb-0.5">Target URL</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Re-sends this {request.method} request with the original headers and body.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://your-server.com/webhook"
                    value={replayUrl}
                    onChange={(e) => setReplayUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleReplay()}
                    className="flex-1"
                  />
                  <Button
                    onClick={handleReplay}
                    loading={replaying}
                    disabled={!replayUrl}
                    size="sm"
                    className="shrink-0 gap-1.5"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Send
                  </Button>
                </div>
              </div>
            </div>

            {replayResult && (
              <div className="rounded-md border border-border bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
                  <span className="text-xs font-medium text-muted-foreground">Response</span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
                  <Badge
                    variant={replayResult.status >= 200 && replayResult.status < 300 ? 'default' : 'destructive'}
                  >
                    {replayResult.status || 'Error'}
                  </Badge>
                </div>
                {replayResult.body ? (
                  <pre className="text-xs font-mono p-4 overflow-x-auto whitespace-pre-wrap break-all text-foreground leading-relaxed">
                    {tryPrettyJSON(replayResult.body)}
                  </pre>
                ) : (
                  <div className="px-4 py-3">
                    <p className="text-xs text-muted-foreground italic">Empty response body</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Request ID footer ── */}
      <Separator />
      <div className="px-4 py-1.5 bg-muted/20 flex-shrink-0">
        <p className="text-[10px] font-mono text-muted-foreground/50 truncate">
          id: {request.id}
        </p>
      </div>
    </div>
  )
}
