# webhook-inspector

A self-hostable HTTP request inspector. Point any service at your unique endpoint URL, watch every request arrive in real time — headers, body, query params, IP, timing. Like webhook.site, but yours.

---

## What it does

You open the app. You get a unique URL. You paste that URL into Stripe, GitHub, Shopify, or `curl` and fire a request. It appears in your browser within a second. You see everything — method, headers, raw body, query params. You can replay it to a real destination URL. Requests persist across page refreshes. Nothing gets wiped on server restart.

That's it. No accounts. No setup. No config. Open the URL, start receiving.

---

## Monorepo — yes, and here's why

Both frontend and backend live in the same repository.

```
webhook-inspector/
├── backend/          Go API server
├── frontend/         React + TypeScript + Tremor UI
├── docker-compose.yml
├── .env.example
├── main.md           this file
└── phases/           build specs, one per phase
```

The alternative is two repos. The problem with two repos for a solo project or small team:

- A single product change (change API response shape + update TS types) becomes two commits across two repos. Git history lies — it looks like two separate things, not one change.
- Two CI pipelines to configure and maintain.
- Two repos to clone when onboarding.
- No atomic deploys — backend and frontend can get out of sync.

A monorepo at this scale does not need tooling (Nx, Turborepo, Bazel). A flat `backend/` and `frontend/` directory is the entire setup. The two sides have completely independent dependency management — `backend/go.mod` and `frontend/package.json` never touch each other. Docker compose coordinates them at runtime. That's the full story.

---

## Architecture

```
                    ┌─────────────────────────────────────┐
                    │           browser                   │
                    │                                     │
                    │  React + Tremor UI                  │
                    │    │                │               │
                    │    │ REST /api/*    │ WS /ws/:id    │
                    └────┼────────────────┼───────────────┘
                         │                │
                         ▼                ▼
                    ┌──────────────────────────┐
                    │     Go backend :8080      │
                    │                          │
                    │  ┌──────────────────┐    │
                    │  │   HTTP router    │    │
                    │  │  /api/*          │    │
                    │  │  /r/:id  ◄───────┼────┼──── any external service
                    │  │  /ws/:id         │    │     (Stripe, GitHub, curl)
                    │  │  /health         │    │
                    │  └────────┬─────────┘    │
                    │           │              │
                    │  ┌────────▼─────────┐    │
                    │  │   WebSocket hub  │    │
                    │  │  room per        │    │
                    │  │  endpoint ID     │    │
                    │  └──────────────────┘    │
                    │           │              │
                    └───────────┼──────────────┘
                                │
                         ┌──────▼──────┐
                         │ PostgreSQL  │
                         │  endpoints  │
                         │  requests   │
                         └─────────────┘
```

### Request flow (the hot path)

When any HTTP request hits `/r/:endpoint_id`:

1. Look up endpoint in PostgreSQL — return 404 if not found
2. Read full request: method, all headers, raw body, query params, client IP
3. Write to `requests` table, update `last_used_at` on endpoint
4. Publish the stored request to the WebSocket hub for this endpoint ID
5. Return `200 {"ok": true}` to the sender

The hub fans the message to every browser tab currently subscribed to that endpoint ID. The browser receives it over WebSocket and adds it to the list without a page refresh or poll.

---

## Data model

```sql
CREATE TABLE endpoints (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE requests (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id  UUID        NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
    method       TEXT        NOT NULL,
    headers      JSONB       NOT NULL DEFAULT '{}',
    body         TEXT,
    query_params JSONB       NOT NULL DEFAULT '{}',
    content_type TEXT,
    ip           TEXT,
    size         INT         NOT NULL DEFAULT 0,
    received_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_requests_endpoint_received
    ON requests (endpoint_id, received_at DESC);
```

### Design decisions in the schema

**JSONB for headers and query_params.** Headers are key-value pairs. Query params are key-value pairs. JSONB stores them natively, queries them efficiently, and returns them as structured objects — no parsing needed in application code.

**`content_type` column.** Technically in `headers`, but extracted as a top-level column because the UI needs it constantly for syntax highlighting. One column vs parsing JSONB on every render.

**`ON DELETE CASCADE` on endpoint_id.** Delete an endpoint, every request under it is gone. No orphan rows, no cleanup job needed for this relationship.

**`size INT`.** Body length in bytes, stored at write time. Avoids `len(body)` in the UI on every render. Cheap to store, useful to display.

**Index on `(endpoint_id, received_at DESC)`.** The one hot query is "give me the last 100 requests for endpoint X." This index makes it a single index scan with no sort needed.

**48-hour TTL.** A background goroutine runs every hour and executes `DELETE FROM requests WHERE received_at < NOW() - INTERVAL '48 hours'`. Simple, correct, no framework needed. Keeps the table lean.

**100 request cap in the API.** The list endpoint returns `LIMIT 100`. This is not a database constraint — the data is still there until the background job deletes it. The cap is a UX decision: a webhook inspector that shows 10,000 requests is unusable.

---

## API contract

### Endpoints

```
POST   /api/endpoints
       → 201 { id, inspect_url, created_at }

GET    /api/endpoints/:id
       → 200 { id, created_at, last_used_at, request_count }
       → 404 if not found

GET    /api/endpoints/:id/requests
       → 200 { requests: [ ...request objects, ordered by received_at DESC, max 100 ] }

DELETE /api/endpoints/:id
       → 204 (cascades to all requests)
```

### Receiver

```
*      /r/:id          (any HTTP method — GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS)
       → 200 { ok: true }
       → 404 if endpoint ID doesn't exist
```

The receiver returns 200 even if body storage encounters a non-fatal error. The sender must not be punished for the inspector's internal issues. Exception: 404 on unknown endpoint ID, 405 is never returned.

### Requests

```
GET    /api/requests/:id
       → 200 { id, endpoint_id, method, headers, body, query_params,
               content_type, ip, size, received_at }
       → 404 if not found

POST   /api/requests/:id/replay
       body: { url: "https://your-server.com/webhook" }
       → 200 { status: 200, headers: {...}, body: "..." }
       → This makes a real outgoing HTTP request to `url` with the same method/headers/body

DELETE /api/requests/:id
       → 204
```

### WebSocket

```
WS     /ws/:endpoint_id
```

Server pushes messages to client. Client never sends messages. Connection drops silently if endpoint doesn't exist (close with 4004).

Message format:

```json
{
  "type": "request.received",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "endpoint_id": "550e8400-e29b-41d4-a716-446655440001",
    "method": "POST",
    "headers": {
      "Content-Type": "application/json",
      "X-Github-Event": "push"
    },
    "body": "{\"ref\": \"refs/heads/main\"}",
    "query_params": {},
    "content_type": "application/json",
    "ip": "192.30.252.1",
    "size": 28,
    "received_at": "2026-06-20T10:30:00Z"
  }
}
```

### Health

```
GET    /health
       → 200 { status: "ok", db: "ok" }
       → 503 { status: "ok", db: "error: ..." } if PostgreSQL ping fails
```

---

## Stack

| Layer      | Choice                   | Why                                                                 |
|------------|--------------------------|---------------------------------------------------------------------|
| Backend    | Go 1.26, stdlib HTTP     | Single binary, zero framework overhead, correct for this scope      |
| DB driver  | `jackc/pgx/v5`           | Native PostgreSQL driver. Better perf and ergonomics than `database/sql` |
| WebSocket  | `gorilla/websocket`      | Battle-tested, explicit, well-understood                            |
| Database   | PostgreSQL 16            | Persistent, JSONB, `gen_random_uuid()` built-in, not SQLite         |
| Frontend   | React 18 + TypeScript    | Standard                                                            |
| UI         | Tremor + Tailwind CSS    | Data-heavy dashboard components, exactly right for this UI          |
| Bundler    | Vite                     | Fast dev server, standard in 2026                                   |
| Routing    | react-router-dom v6      | Standard                                                            |

### Backend dependency list (`backend/go.mod`)

```
github.com/google/uuid v1.6.0          — UUID generation (also available from PG, belt+suspenders)
github.com/gorilla/websocket v1.5.3    — WebSocket
github.com/jackc/pgx/v5 v5.7.2        — PostgreSQL driver + connection pool
```

No web framework. No ORM. Go's stdlib HTTP router handles everything at this scale cleanly, especially with Go 1.22+ method+path routing (`mux.HandleFunc("POST /api/endpoints", ...)`).

### Frontend dependency list (`frontend/package.json`)

```
react 18 + react-dom
react-router-dom v6
@tremor/react
tailwindcss + autoprefixer + postcss
typescript
vite + @vitejs/plugin-react
```

---

## Principles

**No auth by design.**
The UUID endpoint ID is the access token. A 128-bit UUID has ~5.3 × 10³⁸ possible values. Brute-forcing it is not a realistic attack vector. This keeps the product zero-friction — no signup, no email confirmation, no password reset flow. A developer tool that requires creating an account to inspect a webhook is a developer tool nobody uses.

**PostgreSQL, not SQLite.**
SQLite on a free-tier cloud deploy gets wiped on restart (ephemeral filesystem). The previous webhook-delivery-service in this portfolio made this mistake. PostgreSQL on Supabase, Railway, or Neon gives you a persistent, durable store on a free tier.

**WebSocket, not polling.**
Polling on 1-second intervals is architecturally lazy. It means N clients × 1 req/sec constant load on the server regardless of activity, and the UX is still up to 1 second stale. A single persistent WebSocket connection is cheaper, faster, and correct.

**Raw body, no transformation.**
The `body` field is stored verbatim and returned verbatim. If the sender sends malformed JSON, you see malformed JSON. If they send a form-encoded payload, you see URL-encoded text. The inspector's job is to show you exactly what was sent. The frontend decides how to display it.

**Receiver always returns 200.**
If the endpoint exists and the request was received, the response is 200 even if the background write to PostgreSQL fails. Returning 500 would cause retry logic in the sending service to flood the inspector. The sender's obligation ends at delivery.

**Fail fast on startup.**
If PostgreSQL is unreachable when the server starts, `os.Exit(1)`. No retry loops, no silent degradation. Misconfigured environment = immediate crash with a clear error message.

**Background cleanup over database triggers.**
A goroutine running every hour with a simple `DELETE WHERE received_at < NOW() - INTERVAL '48 hours'` is more transparent and debuggable than a PostgreSQL trigger or cron job. It lives in the application code where you can read it, test it, and log it.

---

## What is intentionally not in v1

The following features are real and worth building eventually. They are not in v1 because scope control is a skill.

- User accounts / auth
- Custom response templates (respond to sender with configurable status/body)
- Request search and filtering
- Retention beyond 48 hours
- Rate limiting on the receiver endpoint
- Custom domains
- Request size limits (add a 1MB body cap in v2)
- Team sharing / collaborative endpoints
