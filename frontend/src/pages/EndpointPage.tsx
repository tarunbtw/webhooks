import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Trash2, Webhook, Activity } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Separator } from '../components/ui/separator'
import { Tooltip } from '../components/ui/tooltip'
import { ConfirmDialog } from '../components/ui/dialog'
import { ThemeToggle } from '../components/ThemeToggle'
import { CopyButton } from '../components/CopyButton'
import { RequestList } from '../components/RequestList'
import { RequestDetail } from '../components/RequestDetail'
import { api } from '../api/client'
import { useWebSocket } from '../hooks/useWebSocket'
import type { Request, WSMessage } from '../types'

const STORAGE_KEY = 'wi-last-endpoint'

export function EndpointPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [requests, setRequests] = useState<Request[]>([])
  const [selected, setSelected] = useState<Request | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const inspectUrl = `${window.location.origin}/r/${id}`

  // Persist this endpoint so the landing page can offer "Continue"
  useEffect(() => {
    if (id) localStorage.setItem(STORAGE_KEY, id)
  }, [id])

  // Load existing requests on mount
  useEffect(() => {
    if (!id) return
    api.listRequests(id)
      .then((r) => { setRequests(r); setLoading(false) })
      .catch(() => navigate('/'))
  }, [id, navigate])

  // Real-time WebSocket updates
  const onMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'request.received') {
      setRequests((prev) => [msg.data, ...prev].slice(0, 100))
    }
  }, [])

  useWebSocket({ endpointId: id!, onMessage })

  const handleDeleteRequest = (reqId: string) => {
    setRequests((prev) => prev.filter((r) => r.id !== reqId))
    if (selected?.id === reqId) setSelected(null)
  }

  const handleDeleteEndpoint = async () => {
    setDeleting(true)
    try {
      await api.deleteEndpoint(id!)
      localStorage.removeItem(STORAGE_KEY)  // clear persisted endpoint
      navigate('/')
    } finally {
      setDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Loading…
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* ── Top navbar ── */}
      <header className="flex items-center gap-2 px-3 h-12 border-b border-border bg-card flex-shrink-0">
        {/* Logo */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-2 hover:opacity-70 transition-opacity shrink-0"
        >
          <Webhook className="h-4 w-4 text-foreground" strokeWidth={2} />
          <span className="hidden sm:inline text-sm font-semibold tracking-tight">webhooks</span>
        </button>

        <Separator className="h-4 w-px border-0 bg-border hidden sm:block shrink-0" />

        {/* Endpoint URL + copy */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <code className="text-xs font-mono text-muted-foreground truncate">
            {inspectUrl}
          </code>
          <CopyButton text={inspectUrl} label="Copy endpoint URL" />
        </div>

        {/* Live indicator + request count */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Activity className="h-3 w-3 text-muted-foreground/50 animate-pulse" />
          <Badge variant="outline" className="tabular-nums text-xs">
            {requests.length} {requests.length === 1 ? 'request' : 'requests'}
          </Badge>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <ThemeToggle />
          <Tooltip content="Delete endpoint" side="bottom">
            <Button
              variant="default"
              size="sm"
              onClick={() => setDeleteDialogOpen(true)}
              aria-label="Delete endpoint"
              className="h-7 px-2.5 text-xs gap-1.5"
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </Tooltip>
        </div>

        {/* Delete endpoint confirmation dialog */}
        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="Delete endpoint?"
          description="This will permanently delete the endpoint and all its captured requests. This action cannot be undone."
          confirmLabel="Delete"
          cancelLabel="Cancel"
          onConfirm={handleDeleteEndpoint}
          loading={deleting}
          icon={<Trash2 className="h-4 w-4 text-muted-foreground" />}
        />
      </header>

      {/* ── Split panel ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left — request list */}
        <div className="w-56 sm:w-64 flex-shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/40 flex-shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Incoming Requests
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <RequestList
              requests={requests}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          </div>
        </div>

        {/* Right — request detail */}
        <div className="flex-1 overflow-hidden bg-background flex flex-col">
          {selected ? (
            <RequestDetail request={selected} onDelete={handleDeleteRequest} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-3 max-w-xs px-4">
                <div className="h-10 w-10 rounded-full border border-border flex items-center justify-center mx-auto">
                  <Activity className="h-4 w-4 text-muted-foreground/50" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    Waiting for requests
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Select one from the list, or send a request to:
                  </p>
                  <p className="text-xs font-mono text-muted-foreground/80 bg-muted rounded px-2 py-1 break-all">
                    {inspectUrl}
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
