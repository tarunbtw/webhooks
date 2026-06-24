import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Badge, Button, Text } from '@tremor/react'
import { api } from '../api/client'
import { useWebSocket } from '../hooks/useWebSocket'
import { RequestList } from '../components/RequestList'
import { RequestDetail } from '../components/RequestDetail'
import { CopyButton } from '../components/CopyButton'
import type { Request, WSMessage } from '../types'

export function EndpointPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [requests, setRequests] = useState<Request[]>([])
  const [selected, setSelected] = useState<Request | null>(null)
  const [loading, setLoading] = useState(true)

  const inspectUrl = `${window.location.origin}/r/${id}`

  // load existing requests on mount
  useEffect(() => {
    if (!id) return
    api.listRequests(id)
      .then(setRequests)
      .catch(() => navigate('/'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  // handle incoming real-time messages
  const onMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'request.received') {
      setRequests(prev => [msg.data, ...prev].slice(0, 100))
    }
  }, [])

  useWebSocket({ endpointId: id!, onMessage })

  const handleDelete = (reqId: string) => {
    setRequests(prev => prev.filter(r => r.id !== reqId))
    if (selected?.id === reqId) setSelected(null)
  }

  const handleDeleteEndpoint = async () => {
    if (!confirm('Delete this endpoint and all its requests?')) return
    await api.deleteEndpoint(id!)
    navigate('/')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Text>Loading...</Text>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top bar */}
      <div className="bg-white border-b px-4 py-3 flex items-center gap-3 flex-wrap">
        <span
          className="font-semibold text-gray-800 cursor-pointer hover:underline"
          onClick={() => navigate('/')}
        >
          webhook inspector
        </span>
        <span className="text-gray-300">/</span>
        <code className="text-sm bg-gray-100 px-2 py-1 rounded font-mono text-gray-700 truncate max-w-sm">
          {inspectUrl}
        </code>
        <CopyButton text={inspectUrl} label="Copy URL" />
        <Badge color="green" className="ml-auto">
          {requests.length} requests
        </Badge>
        <Button size="xs" variant="secondary" color="red" onClick={handleDeleteEndpoint}>
          Delete endpoint
        </Button>
      </div>

      {/* Split view */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — request list */}
        <div className="w-64 flex-shrink-0 border-r bg-white overflow-hidden flex flex-col">
          <div className="px-4 py-2 border-b">
            <Text className="text-xs text-gray-400 uppercase tracking-wide font-medium">
              Requests
            </Text>
          </div>
          <RequestList
            requests={requests}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        </div>

        {/* Right — request detail */}
        <div className="flex-1 overflow-hidden bg-white">
          {selected ? (
            <RequestDetail request={selected} onDelete={handleDelete} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <Text className="text-gray-400">Select a request to inspect it</Text>
                <Text className="text-gray-300 text-xs mt-2">
                  Or send one to:{' '}
                  <code className="font-mono">{inspectUrl}</code>
                </Text>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
