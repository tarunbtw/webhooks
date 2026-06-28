# webhook-inspector

Inspect HTTP requests in real time. Get a unique URL, point any webhook at it, watch requests arrive live — headers, body, query params, all of it.

**[Live demo →](https://your-demo-url.com)**

---

## What it does

- Any HTTP method — GET, POST, PUT, PATCH, DELETE
- Real-time delivery via WebSocket, zero polling
- Full request detail: headers, body, query params, source IP, size
- Replay any captured request to a target URL
- Requests auto-purge after 48 hours
- Dark mode

No account required. The UUID endpoint ID is your access token.

---

## Run locally (Docker)

Requires Docker and Docker Compose.

```bash
git clone https://github.com/tarunbtw/webhook-inspector.git
cd webhook-inspector
docker-compose up --build
```

Open `http://localhost`.

---

## Run locally (dev mode)

Requires Go 1.22+, Node 22+, Docker.

```bash
# 1. Start postgres
docker-compose up postgres -d

# 2. Backend — terminal 1
cd backend
cp ../.env.example .env   # edit DATABASE_URL if needed
go run ./cmd/server

# 3. Frontend — terminal 2
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

The Vite dev server proxies `/api`, `/r`, and `/ws` to the Go backend on `:8080`.

---

## Self-hosting (free)

Recommended stack — all free tiers:

| Service | What runs there |
|---|---|
| [Neon](https://neon.tech) or [Supabase](https://supabase.com) | PostgreSQL |
| [Railway](https://railway.app) or [Render](https://render.com) | Go backend |
| [Vercel](https://vercel.com) or [Netlify](https://netlify.com) | React frontend |

### Backend env var

```
DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=require
```

The backend runs schema migrations on startup. Nothing else to configure.

### Frontend on separate origin

If your frontend and backend are on different domains, update `frontend/src/api/client.ts`:

```ts
// change this
const BASE = '/api'

// to this
const BASE = import.meta.env.VITE_API_BASE ?? '/api'
```

Then set `VITE_API_BASE=https://your-backend.railway.app/api` in your frontend deployment.

### VPS / single server

```bash
git clone https://github.com/tarunbtw/webhook-inspector.git
cd webhook-inspector
docker-compose up -d --build
```

Put Caddy or nginx in front for HTTPS. App runs on port 80.

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
webhook-inspector/
├── backend/            Go API server
│   ├── cmd/server/     entry point
│   └── internal/
│       ├── db/         postgres pool + migrations
│       ├── handler/    HTTP handlers
│       ├── models/     shared types
│       ├── ws/         WebSocket hub
│       └── cleanup/    48h TTL background job
├── frontend/           React + TypeScript
│   └── src/
│       ├── api/        typed fetch client
│       ├── components/ UI components
│       ├── hooks/      useWebSocket
│       └── pages/      HomePage, EndpointPage
└── docker-compose.yml
```

---

Built with Go.