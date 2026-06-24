import { Text } from '@tremor/react'
import type { Request } from '../types'

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-purple-100 text-purple-700',
  DELETE: 'bg-red-100 text-red-700',
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
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Text className="text-gray-400 text-sm">No requests yet</Text>
        <Text className="text-gray-300 text-xs mt-1">
          Send an HTTP request to your endpoint URL to see it here
        </Text>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full divide-y divide-gray-100">
      {requests.map((req) => (
        <button
          key={req.id}
          onClick={() => onSelect(req)}
          className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${
            selectedId === req.id ? 'bg-blue-50 border-l-2 border-blue-500' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded ${
                METHOD_COLORS[req.method] ?? 'bg-gray-100 text-gray-600'
              }`}
            >
              {req.method}
            </span>
            <Text className="text-xs text-gray-500">{formatTime(req.received_at)}</Text>
            <Text className="text-xs text-gray-400 ml-auto">{req.size}B</Text>
          </div>
          {req.content_type && (
            <Text className="text-xs text-gray-400 mt-1 truncate">{req.content_type}</Text>
          )}
        </button>
      ))}
    </div>
  )
}
