# Phase 4 — Frontend

## Goal

Full working UI. Create an endpoint from the browser, receive the URL, send a webhook via `curl`, watch it appear in the browser in real time. Click a request to see full detail. Replay it to a target URL. Delete it.

## Prerequisites

Phase 3 complete. Backend WebSocket tested and working with `wscat`.

---

## What gets built

```
frontend/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts              ← proxies /api and /ws to backend in dev
├── tailwind.config.js
├── postcss.config.js
└── src/
    ├── main.tsx
    ├── App.tsx
    ├── types/
    │   └── index.ts            ← Endpoint, Request types
    ├── api/
    │   └── client.ts           ← typed fetch wrapper
    ├── hooks/
    │   └── useWebSocket.ts     ← WS connection, auto-reconnect
    ├── pages/
    │   ├── HomePage.tsx        ← landing, create endpoint button
    │   └── EndpointPage.tsx    ← request list + detail panel
    └── components/
        ├── RequestList.tsx     ← left panel: list of captured requests
        ├── RequestDetail.tsx   ← right panel: full detail, replay
        └── CopyButton.tsx      ← copy URL to clipboard, shows checkmark on copy
```

---

## Implementation

### `frontend/package.json`

```json
{
  "name": "webhook-inspector-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tremor/react": "^3.18.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.9"
  }
}
```

Run `npm install` in the `frontend/` directory.

---

### `frontend/vite.config.ts`

The proxy is the key piece — it lets the React dev server forward `/api/*`, `/r/*`, and `/ws/*` to the Go backend without CORS issues in development.

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/r': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
```

---

### `frontend/tailwind.config.js`

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
}
```

---

### `frontend/postcss.config.js`

```js
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

---

### `frontend/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

---

### `frontend/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>webhook inspector</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

---

### `frontend/src/main.tsx`

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
```

Create `frontend/src/index.css` with just:

```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

---

### `frontend/src/types/index.ts`

```ts
export interface Endpoint {
  id: string
  created_at: string
  last_used_at: string | null
  request_count?: number
  inspect_url?: string
}

export interface Request {
  id: string
  endpoint_id: string
  method: string
  headers: Record<string, string>
  body: string
  query_params: Record<string, string>
  content_type: string
  ip: string
  size: number
  received_at: string
}

export interface WSMessage {
  type: 'request.received'
  data: Request
}
```

---

### `frontend/src/api/client.ts`

```ts
import type { Endpoint, Request } from '../types'

const BASE = '/api'

async function req<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export const api = {
  createEndpoint: () =>
    req<Endpoint & { inspect_url: string }>('/endpoints', { method: 'POST' }),

  getEndpoint: (id: string) =>
    req<Endpoint>(`/endpoints/${id}`),

  listRequests: (endpointId: string) =>
    req<{ requests: Request[] }>(`/endpoints/${endpointId}/requests`).then(r => r.requests),

  getRequest: (id: string) =>
    req<Request>(`/requests/${id}`),

  deleteRequest: (id: string) =>
    req<void>(`/requests/${id}`, { method: 'DELETE' }),

  deleteEndpoint: (id: string) =>
    req<void>(`/endpoints/${id}`, { method: 'DELETE' }),

  replay: (requestId: string, url: string) =>
    req<{ status: number; headers: Record<string, string>; body: string }>(
      `/requests/${requestId}/replay`,
      { method: 'POST', body: JSON.stringify({ url }) }
    ),
}
```

---

### `frontend/src/hooks/useWebSocket.ts`

```ts
import { useEffect, useRef, useCallback } from 'react'
import type { WSMessage } from '../types'

interface Options {
  endpointId: string
  onMessage: (msg: WSMessage) => void
}

export function useWebSocket({ endpointId, onMessage }: Options) {
  const ws = useRef<WebSocket | null>(null)
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  const connect = useCallback(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = `${protocol}//${window.location.host}/ws/${endpointId}`

    const socket = new WebSocket(url)
    ws.current = socket

    socket.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WSMessage
        onMessageRef.current(msg)
      } catch {
        // ignore parse errors (ping frames, etc.)
      }
    }

    socket.onclose = () => {
      // auto-reconnect after 2 seconds if connection drops
      setTimeout(connect, 2000)
    }

    socket.onerror = () => {
      socket.close()
    }
  }, [endpointId])

  useEffect(() => {
    connect()
    return () => {
      ws.current?.close()
    }
  }, [connect])
}
```

---

### `frontend/src/components/CopyButton.tsx`

```tsx
import { useState } from 'react'
import { Button } from '@tremor/react'

interface Props {
  text: string
  label?: string
}

export function CopyButton({ text, label = 'Copy' }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button size="xs" variant="secondary" onClick={copy}>
      {copied ? '✓ Copied' : label}
    </Button>
  )
}
```

---

### `frontend/src/components/RequestList.tsx`

```tsx
import { Badge, Card, Text } from '@tremor/react'
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
```

---

### `frontend/src/components/RequestDetail.tsx`

```tsx
import { useState } from 'react'
import { Button, Card, Badge, Text, Title, Divider, TextInput } from '@tremor/react'
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
```

---

### `frontend/src/pages/HomePage.tsx`

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Card, Title, Text } from '@tremor/react'
import { api } from '../api/client'

export function HomePage() {
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  const create = async () => {
    setLoading(true)
    try {
      const ep = await api.createEndpoint()
      navigate(`/e/${ep.id}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <Card className="max-w-md w-full text-center">
        <Title>webhook inspector</Title>
        <Text className="mt-2 text-gray-500">
          Get a unique URL. Send any HTTP request to it. Watch it arrive instantly.
        </Text>
        <div className="mt-6 space-y-2 text-sm text-gray-400 text-left">
          <div>→ Any HTTP method (GET, POST, PUT, DELETE, PATCH...)</div>
          <div>→ Full headers, body, query params</div>
          <div>→ Real-time via WebSocket</div>
          <div>→ Replay to any URL</div>
          <div>→ Persists for 48 hours</div>
        </div>
        <Button className="mt-6 w-full" size="lg" onClick={create} loading={loading}>
          Create endpoint
        </Button>
      </Card>
    </div>
  )
}
```

---

### `frontend/src/pages/EndpointPage.tsx`

```tsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Badge, Button, Card, Text, Title } from '@tremor/react'
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
```

---

### `frontend/src/App.tsx`

```tsx
import { Routes, Route } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { EndpointPage } from './pages/EndpointPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/e/:id" element={<EndpointPage />} />
    </Routes>
  )
}
```

---

## Running in development

Both processes run in parallel in development. Use two terminals:

```bash
# Terminal 1 — backend + postgres
docker-compose up

# Terminal 2 — frontend dev server
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

The Vite proxy forwards `/api/*`, `/r/*`, and `/ws/*` to `localhost:8080`. No CORS issues, no config changes needed.

---

## Verification — definition of done

```bash
# Start everything
docker-compose up -d
cd frontend && npm run dev

# Open http://localhost:3000 in the browser
# 1. Click "Create endpoint"
# 2. You are redirected to /e/:id with your unique URL shown in the top bar
# 3. Copy the URL

# In a terminal — send a POST webhook
curl -X POST http://localhost:3000/r/YOUR_ENDPOINT_ID \
  -H "Content-Type: application/json" \
  -d '{"event": "checkout.completed", "order_id": "ord_123"}'

# In the browser — the request appears in the left panel INSTANTLY
# 4. Click it — right panel shows method, headers, body (pretty-printed)

# Send a GET with query params
curl "http://localhost:3000/r/YOUR_ENDPOINT_ID?source=github&action=push"
# → appears in browser in < 1 second

# 5. Click a request → click "Send" in Replay with https://httpbin.org/post
# → response status and body appear below the input

# 6. Click Delete on a request → it disappears from the left panel
# 7. Refresh the page → requests are still there (PostgreSQL, not in-memory)
# 8. Click "Delete endpoint" → confirm → redirected to home
```

## Checklist

- [ ] Home page renders with no errors
- [ ] "Create endpoint" creates an endpoint and redirects to `/e/:id`
- [ ] Endpoint URL shown in top bar, copy button works
- [ ] WebSocket connects (check browser dev tools → Network → WS tab)
- [ ] Sending `curl` request to the endpoint URL appears in browser instantly
- [ ] Request list shows method badge with correct colour, timestamp, size
- [ ] Clicking a request shows full detail in the right panel
- [ ] Headers displayed correctly
- [ ] JSON body is pretty-printed
- [ ] Query params section appears only when query params are present
- [ ] Replay sends a real request and shows the response status
- [ ] Delete request removes it from the list and clears the detail panel
- [ ] Refreshing the page re-loads the request history from PostgreSQL
- [ ] Delete endpoint redirects to home and removes all data
- [ ] No TypeScript errors (`tsc --noEmit` passes clean)
