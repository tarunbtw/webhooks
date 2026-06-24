import { useState } from 'react'
import { Button, Card, Badge, Text, Title, TextInput } from '@tremor/react'
import type { Request } from '../types'
import { api } from '../api/client'

interface Props {
  request: Request
  onDelete: (id: string) => void
}

function tryPrettyJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

export function RequestDetail({ request, onDelete }: Props) {
  const [replayUrl, setReplayUrl] = useState('')
  const [replayResult, setReplayResult] = useState<{ status: number; body: string } | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [deleting, setDeleting] = useState(false)

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
    await api.deleteRequest(request.id)
    onDelete(request.id)
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge color="blue">{request.method}</Badge>
          <Text className="text-xs text-gray-500">
            {new Date(request.received_at).toLocaleString()}
          </Text>
          <Text className="text-xs text-gray-400">{request.size} bytes</Text>
        </div>
        <Button
          size="xs"
          variant="secondary"
          color="red"
          onClick={handleDelete}
          loading={deleting}
        >
          Delete
        </Button>
      </div>

      {/* Headers */}
      <Card>
        <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Headers
        </Title>
        <div className="space-y-1">
          {Object.entries(request.headers).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-xs font-mono">
              <span className="text-gray-400 min-w-0 flex-shrink-0">{k}:</span>
              <span className="text-gray-700 break-all">{v}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Query Params */}
      {Object.keys(request.query_params).length > 0 && (
        <Card>
          <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Query Parameters
          </Title>
          <div className="space-y-1">
            {Object.entries(request.query_params).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-xs font-mono">
                <span className="text-gray-400">{k}:</span>
                <span className="text-gray-700">{v}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Body */}
      <Card>
        <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Body
        </Title>
        {request.body ? (
          <pre className="text-xs font-mono bg-gray-50 p-3 rounded overflow-x-auto text-gray-800 whitespace-pre-wrap break-all">
            {tryPrettyJSON(request.body)}
          </pre>
        ) : (
          <Text className="text-xs text-gray-400">empty body</Text>
        )}
      </Card>

      {/* Replay */}
      <Card>
        <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Replay
        </Title>
        <div className="flex gap-2">
          <TextInput
            placeholder="https://your-server.com/webhook"
            value={replayUrl}
            onChange={(e) => setReplayUrl(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" onClick={handleReplay} loading={replaying} disabled={!replayUrl}>
            Send
          </Button>
        </div>
        {replayResult && (
          <div className="mt-3">
            <Badge color={replayResult.status >= 200 && replayResult.status < 300 ? 'green' : 'red'}>
              {replayResult.status || 'Error'}
            </Badge>
            {replayResult.body && (
              <pre className="text-xs font-mono bg-gray-50 p-2 rounded mt-2 overflow-x-auto whitespace-pre-wrap break-all">
                {tryPrettyJSON(replayResult.body)}
              </pre>
            )}
          </div>
        )}
      </Card>

      {/* Meta */}
      <div className="text-xs text-gray-400 space-y-1">
        <div>ID: <span className="font-mono">{request.id}</span></div>
        {request.ip && <div>Source IP: <span className="font-mono">{request.ip}</span></div>}
      </div>
    </div>
  )
}
