# Phase 2 — Backend APIs

## Goal

Every REST route is implemented, registered, and manually verified with curl. The backend handles the full request lifecycle: create endpoint → receive webhook → list requests → get detail → replay → delete. No WebSocket yet — that is Phase 3.

## Prerequisites

Phase 1 complete. `GET /health` returns ok. PostgreSQL running with schema applied.

---

## What gets built

```
backend/
├── cmd/server/main.go          ← updated: all routes registered
├── internal/
│   ├── db/
│   │   ├── db.go               ← unchanged
│   │   └── schema.sql          ← unchanged
│   ├── models/
│   │   └── models.go           ← Endpoint and Request structs
│   └── handler/
│       ├── endpoint.go         ← POST, GET, DELETE /api/endpoints
│       ├── receiver.go         ← * /r/:id (any HTTP method)
│       ├── request.go          ← GET, DELETE /api/requests, POST /api/requests/:id/replay
│       └── cors.go             ← CORS middleware (needed for frontend later)
├── go.mod                      ← add github.com/google/uuid
```

---

## Implementation

### `backend/go.mod` — updated

```go
module github.com/tarunbtw/webhook-inspector/backend

go 1.26

require (
    github.com/google/uuid v1.6.0
    github.com/jackc/pgx/v5 v5.7.2
)
```

Run `go mod tidy`.

---

### `backend/internal/models/models.go`

These are the canonical structs shared across handlers. JSON tags match the API contract in `main.md` exactly.

```go
package models

import "time"

type Endpoint struct {
    ID          string     `json:"id"`
    CreatedAt   time.Time  `json:"created_at"`
    LastUsedAt  *time.Time `json:"last_used_at"`
    RequestCount int64     `json:"request_count,omitempty"`
}

// InspectURL is constructed at handler level from the request host — not stored in DB.

type Request struct {
    ID          string            `json:"id"`
    EndpointID  string            `json:"endpoint_id"`
    Method      string            `json:"method"`
    Headers     map[string]string `json:"headers"`
    Body        string            `json:"body"`
    QueryParams map[string]string `json:"query_params"`
    ContentType string            `json:"content_type"`
    IP          string            `json:"ip"`
    Size        int               `json:"size"`
    ReceivedAt  time.Time         `json:"received_at"`
}
```

---

### `backend/internal/handler/cors.go`

Needs to exist now so the frontend (Phase 4) works without touching backend code.

```go
package handler

import "net/http"

// CORS wraps a handler to allow cross-origin requests from the frontend.
// In production, replace "*" with your actual frontend origin.
func CORS(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

---

### `backend/internal/handler/endpoint.go`

```go
package handler

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/tarunbtw/webhook-inspector/backend/internal/models"
)

type EndpointHandler struct {
    db *pgxpool.Pool
}

func NewEndpointHandler(db *pgxpool.Pool) *EndpointHandler {
    return &EndpointHandler{db: db}
}

// Create — POST /api/endpoints
func (h *EndpointHandler) Create(w http.ResponseWriter, r *http.Request) {
    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    var ep models.Endpoint
    err := h.db.QueryRow(ctx,
        `INSERT INTO endpoints DEFAULT VALUES
         RETURNING id, created_at, last_used_at`,
    ).Scan(&ep.ID, &ep.CreatedAt, &ep.LastUsedAt)
    if err != nil {
        slog.Error("create endpoint", "err", err)
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }

    scheme := "http"
    if r.TLS != nil {
        scheme = "https"
    }
    if r.Header.Get("X-Forwarded-Proto") == "https" {
        scheme = "https"
    }

    resp := map[string]any{
        "id":          ep.ID,
        "created_at":  ep.CreatedAt,
        "inspect_url": scheme + "://" + r.Host + "/r/" + ep.ID,
    }

    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(http.StatusCreated)
    json.NewEncoder(w).Encode(resp)
}

// Get — GET /api/endpoints/:id
func (h *EndpointHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    var ep models.Endpoint
    err := h.db.QueryRow(ctx,
        `SELECT e.id, e.created_at, e.last_used_at,
                COUNT(req.id) AS request_count
         FROM endpoints e
         LEFT JOIN requests req ON req.endpoint_id = e.id
         WHERE e.id = $1
         GROUP BY e.id`,
        id,
    ).Scan(&ep.ID, &ep.CreatedAt, &ep.LastUsedAt, &ep.RequestCount)
    if err != nil {
        http.Error(w, "endpoint not found", http.StatusNotFound)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(ep)
}

// ListRequests — GET /api/endpoints/:id/requests
func (h *EndpointHandler) ListRequests(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    // confirm endpoint exists first
    var exists bool
    h.db.QueryRow(ctx, `SELECT true FROM endpoints WHERE id = $1`, id).Scan(&exists)
    if !exists {
        http.Error(w, "endpoint not found", http.StatusNotFound)
        return
    }

    rows, err := h.db.Query(ctx,
        `SELECT id, endpoint_id, method, headers, body,
                query_params, content_type, ip, size, received_at
         FROM requests
         WHERE endpoint_id = $1
         ORDER BY received_at DESC
         LIMIT 100`,
        id,
    )
    if err != nil {
        slog.Error("list requests", "err", err)
        http.Error(w, "internal error", http.StatusInternalServerError)
        return
    }
    defer rows.Close()

    requests := make([]models.Request, 0)
    for rows.Next() {
        var req models.Request
        var body *string
        var contentType *string
        var ip *string

        if err := rows.Scan(
            &req.ID, &req.EndpointID, &req.Method,
            &req.Headers, &body,
            &req.QueryParams, &contentType, &ip,
            &req.Size, &req.ReceivedAt,
        ); err != nil {
            slog.Error("scan request row", "err", err)
            continue
        }

        if body != nil {
            req.Body = *body
        }
        if contentType != nil {
            req.ContentType = *contentType
        }
        if ip != nil {
            req.IP = *ip
        }

        requests = append(requests, req)
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{"requests": requests})
}

// Delete — DELETE /api/endpoints/:id
func (h *EndpointHandler) Delete(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    result, err := h.db.Exec(ctx, `DELETE FROM endpoints WHERE id = $1`, id)
    if err != nil || result.RowsAffected() == 0 {
        http.Error(w, "endpoint not found", http.StatusNotFound)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}
```

---

### `backend/internal/handler/receiver.go`

This is the most critical handler. It accepts **any** HTTP method and stores everything.

```go
package handler

import (
    "context"
    "encoding/json"
    "io"
    "log/slog"
    "net/http"
    "strings"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/tarunbtw/webhook-inspector/backend/internal/models"
)

// hop-by-hop headers must not be forwarded or stored
var hopByHopHeaders = map[string]bool{
    "connection":          true,
    "keep-alive":          true,
    "proxy-authenticate":  true,
    "proxy-authorization": true,
    "te":                  true,
    "trailers":            true,
    "transfer-encoding":   true,
    "upgrade":             true,
}

type ReceiverHandler struct {
    db *pgxpool.Pool
    // Hub will be injected in Phase 3. Nil here means no broadcast.
    Broadcast func(endpointID string, req *models.Request)
}

func NewReceiverHandler(db *pgxpool.Pool) *ReceiverHandler {
    return &ReceiverHandler{db: db}
}

// Receive handles any HTTP method sent to /r/:id
func (h *ReceiverHandler) Receive(w http.ResponseWriter, r *http.Request) {
    endpointID := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
    defer cancel()

    // check endpoint exists
    var exists bool
    h.db.QueryRow(ctx, `SELECT true FROM endpoints WHERE id = $1`, endpointID).Scan(&exists)
    if !exists {
        http.Error(w, "endpoint not found", http.StatusNotFound)
        return
    }

    // read body — cap at 1MB to prevent abuse
    bodyBytes, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
    if err != nil {
        slog.Error("read body", "err", err)
    }
    body := string(bodyBytes)
    size := len(bodyBytes)

    // collect headers, excluding hop-by-hop
    headers := make(map[string]string)
    for k, vs := range r.Header {
        if !hopByHopHeaders[strings.ToLower(k)] {
            headers[k] = vs[0] // take first value per header name
        }
    }

    // collect query params
    queryParams := make(map[string]string)
    for k, vs := range r.URL.Query() {
        queryParams[k] = vs[0]
    }

    contentType := r.Header.Get("Content-Type")
    ip := clientIP(r)

    headersJSON, _ := json.Marshal(headers)
    queryJSON, _ := json.Marshal(queryParams)

    var req models.Request
    err = h.db.QueryRow(ctx,
        `INSERT INTO requests
            (endpoint_id, method, headers, body, query_params, content_type, ip, size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, endpoint_id, method, headers, body,
                   query_params, content_type, ip, size, received_at`,
        endpointID, r.Method, headersJSON, body, queryJSON, contentType, ip, size,
    ).Scan(
        &req.ID, &req.EndpointID, &req.Method, &req.Headers, &req.Body,
        &req.QueryParams, &req.ContentType, &req.IP, &req.Size, &req.ReceivedAt,
    )
    if err != nil {
        slog.Error("insert request", "err", err)
        // return 200 anyway — sender should not retry because of our storage error
        w.Header().Set("Content-Type", "application/json")
        json.NewEncoder(w).Encode(map[string]bool{"ok": true})
        return
    }

    // update last_used_at on the endpoint (best-effort, non-blocking)
    go func() {
        h.db.Exec(context.Background(),
            `UPDATE endpoints SET last_used_at = NOW() WHERE id = $1`, endpointID)
    }()

    // broadcast to WebSocket hub if wired up (Phase 3)
    if h.Broadcast != nil {
        h.Broadcast(endpointID, &req)
    }

    slog.Info("request received",
        "endpoint_id", endpointID,
        "method", r.Method,
        "size", size,
        "content_type", contentType,
    )

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]bool{"ok": true})
}

func clientIP(r *http.Request) string {
    if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
        return strings.TrimSpace(strings.SplitN(xff, ",", 2)[0])
    }
    if xri := r.Header.Get("X-Real-IP"); xri != "" {
        return xri
    }
    ip := r.RemoteAddr
    if i := strings.LastIndex(ip, ":"); i != -1 {
        return ip[:i]
    }
    return ip
}
```

---

### `backend/internal/handler/request.go`

```go
package handler

import (
    "context"
    "encoding/json"
    "io"
    "log/slog"
    "net/http"
    "strings"
    "time"

    "github.com/jackc/pgx/v5/pgxpool"
    "github.com/tarunbtw/webhook-inspector/backend/internal/models"
)

type RequestHandler struct {
    db *pgxpool.Pool
}

func NewRequestHandler(db *pgxpool.Pool) *RequestHandler {
    return &RequestHandler{db: db}
}

func (h *RequestHandler) scanRequest(row interface {
    Scan(...any) error
}) (*models.Request, error) {
    var req models.Request
    var body, contentType, ip *string

    err := row.Scan(
        &req.ID, &req.EndpointID, &req.Method, &req.Headers,
        &body, &req.QueryParams, &contentType, &ip, &req.Size, &req.ReceivedAt,
    )
    if err != nil {
        return nil, err
    }
    if body != nil {
        req.Body = *body
    }
    if contentType != nil {
        req.ContentType = *contentType
    }
    if ip != nil {
        req.IP = *ip
    }
    return &req, nil
}

// Get — GET /api/requests/:id
func (h *RequestHandler) Get(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    row := h.db.QueryRow(ctx,
        `SELECT id, endpoint_id, method, headers, body,
                query_params, content_type, ip, size, received_at
         FROM requests WHERE id = $1`,
        id,
    )

    req, err := h.scanRequest(row)
    if err != nil {
        http.Error(w, "request not found", http.StatusNotFound)
        return
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(req)
}

// Replay — POST /api/requests/:id/replay
func (h *RequestHandler) Replay(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
    defer cancel()

    row := h.db.QueryRow(ctx,
        `SELECT id, endpoint_id, method, headers, body,
                query_params, content_type, ip, size, received_at
         FROM requests WHERE id = $1`,
        id,
    )
    req, err := h.scanRequest(row)
    if err != nil {
        http.Error(w, "request not found", http.StatusNotFound)
        return
    }

    var body struct {
        URL string `json:"url"`
    }
    if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
        http.Error(w, "body must be {\"url\": \"https://...\"}", http.StatusBadRequest)
        return
    }

    outReq, err := http.NewRequestWithContext(ctx, req.Method, body.URL, strings.NewReader(req.Body))
    if err != nil {
        http.Error(w, "invalid replay URL", http.StatusBadRequest)
        return
    }

    // forward original headers
    for k, v := range req.Headers {
        outReq.Header.Set(k, v)
    }

    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Do(outReq)
    if err != nil {
        slog.Error("replay failed", "url", body.URL, "err", err)
        http.Error(w, "replay failed: "+err.Error(), http.StatusBadGateway)
        return
    }
    defer resp.Body.Close()

    respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
    respHeaders := make(map[string]string)
    for k, vs := range resp.Header {
        respHeaders[k] = vs[0]
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]any{
        "status":  resp.StatusCode,
        "headers": respHeaders,
        "body":    string(respBody),
    })
}

// Delete — DELETE /api/requests/:id
func (h *RequestHandler) Delete(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")

    ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
    defer cancel()

    result, err := h.db.Exec(ctx, `DELETE FROM requests WHERE id = $1`, id)
    if err != nil || result.RowsAffected() == 0 {
        http.Error(w, "request not found", http.StatusNotFound)
        return
    }

    w.WriteHeader(http.StatusNoContent)
}
```

---

### `backend/cmd/server/main.go` — updated with all routes

```go
package main

import (
    "context"
    "encoding/json"
    "log/slog"
    "net/http"
    "os"
    "time"

    "github.com/tarunbtw/webhook-inspector/backend/internal/db"
    "github.com/tarunbtw/webhook-inspector/backend/internal/handler"
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

    epHandler := handler.NewEndpointHandler(pool)
    rxHandler := handler.NewReceiverHandler(pool)
    reqHandler := handler.NewRequestHandler(pool)

    mux := http.NewServeMux()

    // endpoint management
    mux.HandleFunc("POST /api/endpoints", epHandler.Create)
    mux.HandleFunc("GET /api/endpoints/{id}", epHandler.Get)
    mux.HandleFunc("GET /api/endpoints/{id}/requests", epHandler.ListRequests)
    mux.HandleFunc("DELETE /api/endpoints/{id}", epHandler.Delete)

    // webhook receiver — any method, catch-all via Handle (not HandleFunc)
    // Go 1.22 stdlib router: use {id} for path params
    mux.Handle("/r/{id}", http.HandlerFunc(rxHandler.Receive))

    // individual request operations
    mux.HandleFunc("GET /api/requests/{id}", reqHandler.Get)
    mux.HandleFunc("POST /api/requests/{id}/replay", reqHandler.Replay)
    mux.HandleFunc("DELETE /api/requests/{id}", reqHandler.Delete)

    // health
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

Note `mux.Handle("/r/{id}", ...)` without a method prefix — this is intentional. It must accept GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS — any method the sender chooses.

---

## Verification — definition of done

```bash
# Rebuild after code changes
docker-compose up --build -d

# --- Endpoints ---

# Create an endpoint
EP=$(curl -s -X POST http://localhost:8080/api/endpoints | jq -r '.id')
echo "Endpoint ID: $EP"
# Expected: a UUID like 550e8400-e29b-41d4-a716-446655440000

# Get endpoint info
curl -s http://localhost:8080/api/endpoints/$EP | jq .
# Expected: { id, created_at, last_used_at: null, request_count: 0 }

# --- Receiver (any HTTP method) ---

# Send a POST webhook
curl -s -X POST http://localhost:8080/r/$EP \
  -H "Content-Type: application/json" \
  -d '{"event": "order.created", "amount": 9900}' | jq .
# Expected: { "ok": true }

# Send a GET with query params
curl -s "http://localhost:8080/r/$EP?source=stripe&type=charge" | jq .
# Expected: { "ok": true }

# Send a DELETE
curl -s -X DELETE http://localhost:8080/r/$EP | jq .
# Expected: { "ok": true }

# --- List requests ---
curl -s http://localhost:8080/api/endpoints/$EP/requests | jq .
# Expected: { "requests": [ ...3 items, newest first ] }

# Get single request detail
REQ_ID=$(curl -s http://localhost:8080/api/endpoints/$EP/requests \
  | jq -r '.requests[0].id')
curl -s http://localhost:8080/api/requests/$REQ_ID | jq .
# Expected: full request object with headers, body, query_params

# Check last_used_at is now populated
curl -s http://localhost:8080/api/endpoints/$EP | jq .last_used_at
# Expected: a timestamp (not null)

# --- Replay ---
curl -s -X POST http://localhost:8080/api/requests/$REQ_ID/replay \
  -H "Content-Type: application/json" \
  -d '{"url": "https://httpbin.org/post"}' | jq .status
# Expected: 200

# --- Delete single request ---
curl -s -X DELETE http://localhost:8080/api/requests/$REQ_ID
# Expected: HTTP 204, empty body

# Confirm it's gone
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/api/requests/$REQ_ID
# Expected: 404

# --- Delete endpoint ---
curl -s -X DELETE http://localhost:8080/api/endpoints/$EP
# Expected: HTTP 204

# Confirm cascade — all requests gone
curl -s http://localhost:8080/api/endpoints/$EP
# Expected: 404
```

## Checklist

- [ ] `POST /api/endpoints` returns 201 with `id` and `inspect_url`
- [ ] `GET /api/endpoints/:id` returns endpoint with `request_count`
- [ ] Receiver accepts POST, GET, DELETE — all return `{"ok":true}`
- [ ] Headers, body, query_params stored correctly for each method
- [ ] `last_used_at` is populated after first webhook received
- [ ] `GET /api/endpoints/:id/requests` returns newest request first
- [ ] `GET /api/requests/:id` returns full detail
- [ ] `POST /api/requests/:id/replay` makes a real outgoing HTTP request
- [ ] `DELETE /api/requests/:id` removes the row, returns 204
- [ ] `DELETE /api/endpoints/:id` cascades to requests, returns 204
- [ ] Unknown endpoint ID on `/r/:id` returns 404
- [ ] `GET /health` still returns ok
