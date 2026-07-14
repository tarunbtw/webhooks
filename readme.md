# webhooks ( site )

Inspect HTTP requests in real time. Get a unique URL, point any webhook at it, watch requests arrive live — headers, body, query params, all of it.

**[Live demo →](https://your-demo-url.com)**

---

## What it does

- Any HTTP method — GET, POST, PUT, PATCH, DELETE
- Real-time delivery via WebSocket, zero polling
- Full request detail: headers, body, query params, source IP, size
- Replay any captured request to a target URL
- Requests auto-purge after 48 hours

---

## Run locally (Docker)

Requires Docker and Docker Compose.

```bash
git clone https://github.com/tarunbtw/webhooks.git
cd webhooks
docker-compose up --build
```

Open `http://localhost`.

---


## Stack

| | |
|---|---|
| Backend | Go 1.22, stdlib HTTP, no framework |
| Database | PostgreSQL 16 |
| Real-time | WebSocket (`gorilla/websocket`) |
| Frontend | React 18 + TypeScript |
| UI | Tailwind CSS + Radix UI |
| Production | nginx (reverse proxy + static files) |

---

## API

```
POST   /api/endpoints               → { id, inspect_url, created_at }
GET    /api/endpoints/:id           → endpoint info + request count
GET    /api/endpoints/:id/requests  → last 100 requests, newest first
DELETE /api/endpoints/:id           → delete endpoint + all requests

*      /r/:id                       receive any HTTP request (always 200)

GET    /api/requests/:id            → full request detail
POST   /api/requests/:id/replay     body: { url } → { status, headers, body }
DELETE /api/requests/:id            → 204

WS     /ws/:id                      real-time stream, server → client only
GET    /health                      → { status, db }
```

---

## Project structure

```
webhooks/
├── backend/            Go API server
│   ├── cmd/server/     entry point
│   └── internal/
│       ├── db/         postgres pool + migrations
│       ├── handler/    HTTP handlers
│       ├── models/     shared types
│       ├── ws/         WebSocket hub
│       └── cleanup/    48h TTL background job
├── frontend/           React + TypeScript
│   ├── src/
│   │   ├── api/        typed fetch client
│   │   ├── components/ UI components
│   │   ├── hooks/      useWebSocket
│   │   └── pages/      HomePage, EndpointPage
│   └── vercel.json     SPA route fallback
├── render.yaml         Render Blueprint (backend service config)
└── docker-compose.yml
```

---

Built with Go.