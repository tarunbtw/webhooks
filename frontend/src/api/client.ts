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
