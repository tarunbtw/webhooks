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
