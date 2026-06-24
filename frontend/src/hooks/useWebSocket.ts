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
