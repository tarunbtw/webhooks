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
