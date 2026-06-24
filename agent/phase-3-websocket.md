# Phase 3 — WebSocket + Cleanup

## Goal

Real-time working end-to-end. A browser (or `wscat`) connects to `/ws/:endpoint_id`. When any HTTP request hits `/r/:endpoint_id`, it broadcasts immediately over WebSocket to all connected clients. A background goroutine deletes requests older than 48 hours, runs every hour.

## Prerequisites

Phase 2 complete. All REST routes work with curl.

---

## What gets built

```
backend/
├── internal/
│   ├── ws/
│   │   └── hub.go              ← WebSocket hub, one room per endpoint ID
│   └── cleanup/
│       └── cleanup.go          ← background TTL job
├── cmd/server/main.go          ← wire hub + cleanup into server startup
```

`receiver.go` is updated to call `hub.Broadcast()`. One line change, already has the hook (`h.Broadcast`).

---

## Implementation

### `backend/go.mod` — add gorilla/websocket

```go
module github.com/tarunbtw/webhook-inspector/backend

go 1.26

require (
    github.com/google/uuid v1.6.0
    github.com/gorilla/websocket v1.5.3
    github.com/jackc/pgx/v5 v5.7.2
)
```

Run `go mod tidy`.

---

### `backend/internal/ws/hub.go`

The hub maintains a map of `endpoint_id → set of connected clients`. Each client is a goroutine-safe channel. When a request comes in, the hub looks up the room and sends to every client in it.

```go
package ws

import (
    "encoding/json"
    "log/slog"
    "net/http"
    "sync"
    "time"

    "github.com/gorilla/websocket"
    "github.com/tarunbtw/webhook-inspector/backend/internal/models"
)

var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        // Allow all origins in development.
        // In production, check r.Header.Get("Origin") against your domain.
        return true
    },
}

type client struct {
    send chan []byte
}

// Hub manages WebSocket connections grouped by endpoint ID.
// One room per endpoint — clients only receive events for their endpoint.
type Hub struct {
    mu    sync.RWMutex
    rooms map[string]map[*client]struct{} // endpoint_id → set of clients
}

func NewHub() *Hub {
    return &Hub{
        rooms: make(map[string]map[*client]struct{}),
    }
}

// Broadcast sends a request event to all clients subscribed to the given endpoint.
// Called from the receiver handler after writing to PostgreSQL.
func (h *Hub) Broadcast(endpointID string, req *models.Request) {
    msg, err := json.Marshal(map[string]any{
        "type": "request.received",
        "data": req,
    })
    if err != nil {
        slog.Error("ws marshal", "err", err)
        return
    }

    h.mu.RLock()
    clients := h.rooms[endpointID]
    h.mu.RUnlock()

    for c := range clients {
        // non-blocking send: if the client's buffer is full, skip it
        select {
        case c.send <- msg:
        default:
            slog.Warn("ws client buffer full, dropping message", "endpoint_id", endpointID)
        }
    }
}

// ServeWS upgrades the HTTP connection to WebSocket and subscribes
// the client to the given endpoint's room.
// Route: GET /ws/:endpoint_id
func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
    endpointID := r.PathValue("id")

    conn, err := upgrader.Upgrade(w, r, nil)
    if err != nil {
        slog.Error("ws upgrade", "err", err)
        return
    }

    c := &client{send: make(chan []byte, 64)}

    h.subscribe(endpointID, c)
    defer h.unsubscribe(endpointID, c)

    // writer goroutine — sends queued messages to the client
    go func() {
        defer conn.Close()
        for msg := range c.send {
            conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := conn.WriteMessage(websocket.TextMessage, msg); err != nil {
                slog.Debug("ws write error", "err", err)
                return
            }
        }
    }()

    // reader loop — keeps connection alive, handles pings, detects close
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    conn.SetPongHandler(func(string) error {
        conn.SetReadDeadline(time.Now().Add(60 * time.Second))
        return nil
    })

    // periodic ping to detect dead connections
    ticker := time.NewTicker(30 * time.Second)
    defer ticker.Stop()

    go func() {
        for range ticker.C {
            conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
        }
    }()

    // block until client disconnects
    for {
        if _, _, err := conn.ReadMessage(); err != nil {
            break
        }
    }

    close(c.send)
}

func (h *Hub) subscribe(endpointID string, c *client) {
    h.mu.Lock()
    defer h.mu.Unlock()
    if h.rooms[endpointID] == nil {
        h.rooms[endpointID] = make(map[*client]struct{})
    }
    h.rooms[endpointID][c] = struct{}{}
    slog.Debug("ws client subscribed", "endpoint_id", endpointID,
        "clients", len(h.rooms[endpointID]))
}

func (h *Hub) unsubscribe(endpointID string, c *client) {
    h.mu.Lock()
    defer h.mu.Unlock()
    if room := h.rooms[endpointID]; room != nil {
        delete(room, c)
        if len(room) == 0 {
            delete(h.rooms, endpointID) // clean up empty rooms
        }
    }
    slog.Debug("ws client unsubscribed", "endpoint_id", endpointID)
}
```

---

### `backend/internal/cleanup/cleanup.go`

```go
package cleanup

import (
    "context"
    "log/slog"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
)

// Start runs a background goroutine that deletes requests older than ttl.
// Runs every interval. Call once at server startup.
func Start(pool *pgxpool.Pool, ttl time.Duration, interval time.Duration) {
    go func() {
        slog.Info("cleanup job started", "ttl", ttl, "interval", interval)
        ticker := time.NewTicker(interval)
        defer ticker.Stop()

        for range ticker.C {
            run(pool, ttl)
        }
    }()
}

func run(pool *pgxpool.Pool, ttl time.Duration) {
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    cutoff := time.Now().Add(-ttl)
    result, err := pool.Exec(ctx,
        `DELETE FROM requests WHERE received_at < $1`, cutoff,
    )
    if err != nil {
        slog.Error("cleanup job failed", "err", err)
        return
    }

    deleted := result.RowsAffected()
    if deleted > 0 {
        slog.Info("cleanup: deleted expired requests", "count", deleted, "cutoff", cutoff)
    }
}
```

---

### `backend/cmd/server/main.go` — wire up hub and cleanup

Replace the existing `main.go` with this version. The only additions are the hub init, cleanup start, WS route, and wiring `hub.Broadcast` into the receiver.

```go
package main

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "os"
    "time"

    "github.com/tarunbtw/webhook-inspector/backend/internal/cleanup"
    "github.com/tarunbtw/webhook-inspector/backend/internal/db"
    "github.com/tarunbtw/webhook-inspector/backend/internal/handler"
    "github.com/tarunbtw/webhook-inspector/backend/internal/ws"
)

func main() {
    slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

    dsn := getEnv("DATABASE_URL", "postgres://inspector:inspector@localhost:5432/inspector?sslmode=disable")

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    pool, err := db.Connect(ctx, dsn)
    if err != nil {
        slog.Error("database connection failed", "err", err)
        os.Exit(1)
    }
    defer pool.Close()

    if err := db.Migrate(context.Background(), pool); err != nil {
        slog.Error("migration failed", "err", err)
        os.Exit(1)
    }
    slog.Info("database ready")

    // start cleanup job: delete requests older than 48h, check every hour
    cleanup.Start(pool, 48*time.Hour, time.Hour)

    // init WebSocket hub
    hub := ws.NewHub()

    epHandler := handler.NewEndpointHandler(pool)

    rxHandler := handler.NewReceiverHandler(pool)
    rxHandler.Broadcast = hub.Broadcast // wire broadcast in

    reqHandler := handler.NewRequestHandler(pool)

    mux := http.NewServeMux()

    mux.HandleFunc("POST /api/endpoints", epHandler.Create)
    mux.HandleFunc("GET /api/endpoints/{id}", epHandler.Get)
    mux.HandleFunc("GET /api/endpoints/{id}/requests", epHandler.ListRequests)
    mux.HandleFunc("DELETE /api/endpoints/{id}", epHandler.Delete)

    mux.Handle("/r/{id}", http.HandlerFunc(rxHandler.Receive))

    mux.HandleFunc("GET /api/requests/{id}", reqHandler.Get)
    mux.HandleFunc("POST /api/requests/{id}/replay", reqHandler.Replay)
    mux.HandleFunc("DELETE /api/requests/{id}", reqHandler.Delete)

    // WebSocket endpoint
    mux.HandleFunc("GET /ws/{id}", hub.ServeWS)

    mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
        resp := map[string]string{"status": "ok", "db": "ok"}
        pingCtx, c := context.WithTimeout(r.Context(), 2*time.Second)
        defer c()
        if err := db.Ping(pingCtx, pool); err != nil {
            resp["db"] = "error: " + err.Error()
            w.WriteHeader(http.StatusServiceUnavailable)
        }
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(resp)
    })

    addr := getEnv("ADDR", ":8080")
    slog.Info("server listening", "addr", addr)
    if err := http.ListenAndServe(addr, handler.CORS(mux)); err != nil {
        slog.Error("server error", "err", err)
        os.Exit(1)
    }
}

func getEnv(key, fallback string) string {
    if v := os.Getenv(key); v != "" {
        return v
    }
    return fallback
}
```

---

## Verification — definition of done

Install `wscat` for WebSocket testing:

```bash
npm install -g wscat
```

Then:

```bash
# Rebuild
docker-compose up --build -d

# Create an endpoint
EP=$(curl -s -X POST http://localhost:8080/api/endpoints | jq -r '.id')
echo "Endpoint: $EP"

# Open a WebSocket connection in terminal 1
wscat -c ws://localhost:8080/ws/$EP
# Expected: Connected (press Ctrl+C to close later)

# In terminal 2 — send a webhook
curl -s -X POST http://localhost:8080/r/$EP \
  -H "Content-Type: application/json" \
  -d '{"event": "payment.succeeded", "amount": 5000}'

# Back in terminal 1 — you should immediately see:
# {
#   "type": "request.received",
#   "data": {
#     "id": "...",
#     "method": "POST",
#     "headers": { "Content-Type": "application/json" },
#     "body": "{\"event\": \"payment.succeeded\", \"amount\": 5000}",
#     ...
#   }
# }

# Open a SECOND wscat in terminal 3
wscat -c ws://localhost:8080/ws/$EP

# Send another webhook from terminal 2
curl -s -X PUT http://localhost:8080/r/$EP -d 'raw text body'

# Both terminal 1 and terminal 3 should receive the broadcast simultaneously

# Verify cleanup goroutine started (check logs)
docker-compose logs backend | grep "cleanup job started"
# Expected: {"level":"INFO","msg":"cleanup job started","ttl":"48h0m0s","interval":"1h0m0s"}
```

## Checklist

- [ ] WebSocket connects to `/ws/:endpoint_id` without error
- [ ] Sending a webhook to `/r/:endpoint_id` immediately delivers a message to all connected WebSocket clients
- [ ] Two simultaneous WS clients both receive the broadcast
- [ ] Closing the WebSocket client (Ctrl+C) does not crash the server
- [ ] Cleanup goroutine start message appears in server logs
- [ ] Server logs show structured JSON (not plain text)
- [ ] All Phase 2 curl tests still pass (regression check)
