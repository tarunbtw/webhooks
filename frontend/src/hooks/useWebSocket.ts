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
    // Derive the WS host from VITE_API_BASE so it points at the backend
    // (Render) even when the frontend is served from a different origin (Vercel).
    // Falls back to same-origin, which is correct for local dev / docker-compose.
    const apiBase = import.meta.env.VITE_API_BASE as string | undefined
    let wsOrigin = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

    if (apiBase) {
      const backendUrl = new URL(apiBase, window.location.origin)
      const wsProtocol = backendUrl.protocol === 'https:' ? 'wss:' : 'ws:'
      wsOrigin = `${wsProtocol}//${backendUrl.host}`
    }

    const url = `${wsOrigin}/ws/${endpointId}`

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
