# Project Context — webhook-inspector

## Project Structure
```
webhooks/
├── .env.example
├── .gitignore
├── docker-compose.yml
├── .github/
│   └── workflows/
│       └── ci.yml
├── backend/
│   ├── Dockerfile
│   ├── go.mod
│   ├── cmd/
│   │   └── server/
│   │       └── main.go
│   └── internal/
│       ├── cleanup/
│       │   └── cleanup.go
│       ├── db/
│       │   ├── db.go
│       │   └── schema.sql
│       ├── handler/
│       │   ├── cors.go
│       │   ├── endpoint.go
│       │   ├── receiver.go
│       │   └── request.go
│       ├── models/
│       │   └── models.go
│       └── ws/
│           └── hub.go
└── frontend/
    ├── Dockerfile
    ├── index.html
    ├── nginx.conf
    ├── package.json
    ├── postcss.config.js
    ├── tailwind.config.js
    ├── tsconfig.json
    ├── tsconfig.node.json
    ├── vite.config.ts
    └── src/
        ├── App.tsx
        ├── index.css
        ├── main.tsx
        ├── api/
        │   └── client.ts
        ├── components/
        │   ├── CopyButton.tsx
        │   ├── RequestDetail.tsx
        │   └── RequestList.tsx
        ├── hooks/
        │   └── useWebSocket.ts
        ├── pages/
        │   ├── EndpointPage.tsx
        │   └── HomePage.tsx
        └── types/
            └── index.ts
```

---

## File Contents

### `.env.example`
```
# Copy to .env for local development outside Docker
DATABASE_URL=postgres://inspector:inspector@localhost:5432/inspector?sslmode=disable
ADDR=:8080
```

### `.gitignore`
```
agents
```

### `docker-compose.yml`
```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: inspector
      POSTGRES_PASSWORD: inspector
      POSTGRES_DB: inspector
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U inspector -d inspector"]
      interval: 5s
      timeout: 3s
      retries: 10

  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile
    environment:
      - DATABASE_URL=postgres://inspector:inspector@postgres:5432/inspector?sslmode=disable
      - ADDR=:8080
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

  frontend:
    build:
      context: ./frontend
      dockerfile: Dockerfile
    ports:
      - "80:80"
    depends_on:
      - backend
    restart: unless-stopped

volumes:
  pgdata:
```

### `.github/workflows/ci.yml`
```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  backend:
    name: Backend
    runs-on: ubuntu-latest

    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: inspector
          POSTGRES_PASSWORD: inspector
          POSTGRES_DB: inspector
        ports:
          - 5432:5432
        options: >-
          --health-cmd "pg_isready -U inspector -d inspector"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10

    steps:
      - uses: actions/checkout@v4

      - name: Set up Go
        uses: actions/setup-go@v5
        with:
          go-version: "1.22"
          cache: true

      - name: Download dependencies
        working-directory: backend
        run: go mod download

      - name: Verify dependencies
        working-directory: backend
        run: go mod verify

      - name: Build
        working-directory: backend
        run: go build ./...

      - name: Vet
        working-directory: backend
        run: go vet ./...

  frontend:
    name: Frontend
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: "npm"
          cache-dependency-path: frontend/package-lock.json

      - name: Install dependencies
        working-directory: frontend
        run: npm install

      - name: Type check
        working-directory: frontend
        run: npx tsc --noEmit

      - name: Build
        working-directory: frontend
        run: npm run build

  docker:
    name: Docker build
    runs-on: ubuntu-latest
    needs: [backend, frontend]

    steps:
      - uses: actions/checkout@v4

      - name: Build backend image
        run: docker build ./backend

      - name: Build frontend image
        run: docker build ./frontend
```

---

### `backend/Dockerfile`
```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o server ./cmd/server

FROM alpine:latest
WORKDIR /app
COPY --from=builder /app/server .
EXPOSE 8080
CMD ["./server"]
```

### `backend/go.mod`
```go
module github.com/tarunbtw/webhook-inspector/backend

go 1.22

require (
	github.com/gorilla/websocket v1.5.3
	github.com/jackc/pgx/v5 v5.7.2
)

require (
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	golang.org/x/crypto v0.31.0 // indirect
	golang.org/x/sync v0.10.0 // indirect
	golang.org/x/text v0.21.0 // indirect
)
```

### `backend/cmd/server/main.go`
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

	// any HTTP method — no method prefix
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

### `backend/internal/db/db.go`
```go
package db

import (
	"context"
	_ "embed"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

// Connect opens a connection pool and pings PostgreSQL.
// Returns an error immediately if the database is unreachable.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("invalid DSN: %w", err)
	}

	cfg.MaxConns = 10
	cfg.MinConns = 2
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}

	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}

	return pool, nil
}

// Migrate runs the embedded schema SQL against the pool.
// Uses IF NOT EXISTS throughout — safe to run on every startup.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	if _, err := pool.Exec(ctx, schema); err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	return nil
}

// Ping checks database connectivity. Used by the health handler.
func Ping(ctx context.Context, pool *pgxpool.Pool) error {
	return pool.Ping(ctx)
}
```

### `backend/internal/db/schema.sql`
```sql
CREATE TABLE IF NOT EXISTS endpoints (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS requests (
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

CREATE INDEX IF NOT EXISTS idx_requests_endpoint_received
    ON requests (endpoint_id, received_at DESC);
```

### `backend/internal/handler/cors.go`
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

// Get — GET /api/endpoints/{id}
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

// ListRequests — GET /api/endpoints/{id}/requests
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

// Delete — DELETE /api/endpoints/{id}
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

### `backend/internal/handler/receiver.go`
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

// Receive handles any HTTP method sent to /r/{id}
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

// Get — GET /api/requests/{id}
func (h *RequestHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	row := h.db.QueryRow(ctx,
		`SELECT id, endpoint_id, method, headers, body,
                query_params, content_type, ip, size, received_at
         FROM requests WHERE id = $1`, id)

	req, err := h.scanRequest(row)
	if err != nil {
		http.Error(w, "request not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(req)
}

// Replay — POST /api/requests/{id}/replay
func (h *RequestHandler) Replay(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()

	row := h.db.QueryRow(ctx,
		`SELECT id, endpoint_id, method, headers, body,
                query_params, content_type, ip, size, received_at
         FROM requests WHERE id = $1`, id)
	req, err := h.scanRequest(row)
	if err != nil {
		http.Error(w, "request not found", http.StatusNotFound)
		return
	}

	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.URL == "" {
		http.Error(w, `body must be {"url": "https://..."}`, http.StatusBadRequest)
		return
	}

	outReq, err := http.NewRequestWithContext(ctx, req.Method, body.URL, strings.NewReader(req.Body))
	if err != nil {
		http.Error(w, "invalid replay URL", http.StatusBadRequest)
		return
	}
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

// Delete — DELETE /api/requests/{id}
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

### `backend/internal/models/models.go`
```go
package models

import "time"

type Endpoint struct {
	ID           string     `json:"id"`
	CreatedAt    time.Time  `json:"created_at"`
	LastUsedAt   *time.Time `json:"last_used_at"`
	RequestCount int64      `json:"request_count,omitempty"`
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

### `backend/internal/ws/hub.go`
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
		return true // allow all origins in dev; restrict in prod via nginx
	},
}

type client struct {
	send chan []byte
}

// Hub manages WebSocket connections grouped by endpoint ID.
// One room per endpoint — clients only receive events for their endpoint.
type Hub struct {
	mu    sync.RWMutex
	rooms map[string]map[*client]struct{}
}

func NewHub() *Hub {
	return &Hub{
		rooms: make(map[string]map[*client]struct{}),
	}
}

// Broadcast sends a request event to all clients subscribed to the given endpoint.
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
		select {
		case c.send <- msg:
		default:
			slog.Warn("ws client buffer full, dropping message", "endpoint_id", endpointID)
		}
	}
}

// ServeWS upgrades the HTTP connection to WebSocket and subscribes
// the client to the given endpoint's room.
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
	slog.Debug("ws client subscribed", "endpoint_id", endpointID, "clients", len(h.rooms[endpointID]))
}

func (h *Hub) unsubscribe(endpointID string, c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if room := h.rooms[endpointID]; room != nil {
		delete(room, c)
		if len(room) == 0 {
			delete(h.rooms, endpointID)
		}
	}
	slog.Debug("ws client unsubscribed", "endpoint_id", endpointID)
}
```

---

### `frontend/Dockerfile`
```dockerfile
# Stage 1 — build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npm run build

# Stage 2 — serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

### `frontend/nginx.conf`
```nginx
server {
    listen 80;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;

    # serve static assets with long cache (vite hashes filenames)
    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files $uri =404;
    }

    # proxy API requests to backend
    location /api/ {
        proxy_pass         http://backend:8080;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # proxy webhook receiver (any method)
    location /r/ {
        proxy_pass         http://backend:8080;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    # proxy WebSocket connections
    location /ws/ {
        proxy_pass         http://backend:8080;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # proxy health check
    location /health {
        proxy_pass         http://backend:8080;
    }

    # SPA fallback — all other paths serve index.html
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### `frontend/index.html`
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>webhook inspector</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### `frontend/package.json`
```json
{
  "name": "webhook-inspector-frontend",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@tremor/react": "^3.18.3",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.47",
    "tailwindcss": "^3.4.14",
    "typescript": "^5.6.3",
    "vite": "^5.4.9"
  }
}
```

### `frontend/postcss.config.js`
```javascript
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
```

### `frontend/tailwind.config.js`
```javascript
/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@tremor/**/*.{js,ts,jsx,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
}
```

### `frontend/tsconfig.json`
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

### `frontend/tsconfig.node.json`
```json
{
  "compilerOptions": {
    "composite": true,
    "skipLibCheck": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": false
  },
  "include": ["vite.config.ts"]
}
```

### `frontend/vite.config.ts`
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/r': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8080',
        ws: true,
        changeOrigin: true,
      },
    },
  },
})
```

---

### `frontend/src/App.tsx`
```tsx
import { Routes, Route } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { EndpointPage } from './pages/EndpointPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/e/:id" element={<EndpointPage />} />
    </Routes>
  )
}
```

### `frontend/src/index.css`
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

### `frontend/src/main.tsx`
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
)
```

### `frontend/src/api/client.ts`
```typescript
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
```

### `frontend/src/components/CopyButton.tsx`
```tsx
import { useState } from 'react'
import { Button } from '@tremor/react'

interface Props {
  text: string
  label?: string
}

export function CopyButton({ text, label = 'Copy' }: Props) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button size="xs" variant="secondary" onClick={copy}>
      {copied ? '✓ Copied' : label}
    </Button>
  )
}
```

### `frontend/src/components/RequestDetail.tsx`
```tsx
import { useState } from 'react'
import { Button, Card, Badge, Text, Title, TextInput } from '@tremor/react'
import type { Request } from '../types'
import { api } from '../api/client'

interface Props {
  request: Request
  onDelete: (id: string) => void
}

// pretty prints string if valid JSON
function tryPrettyJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

export function RequestDetail({ request, onDelete }: Props) {
  const [replayUrl, setReplayUrl] = useState('')
  const [replayResult, setReplayResult] = useState<{ status: number; body: string } | null>(null)
  const [replaying, setReplaying] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleReplay = async () => {
    if (!replayUrl) return
    setReplaying(true)
    setReplayResult(null)
    try {
      const result = await api.replay(request.id, replayUrl)
      setReplayResult({ status: result.status, body: result.body })
    } catch (e) {
      setReplayResult({ status: 0, body: String(e) })
    } finally {
      setReplaying(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    await api.deleteRequest(request.id)
    onDelete(request.id)
  }

  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge color="blue">{request.method}</Badge>
          <Text className="text-xs text-gray-500">
            {new Date(request.received_at).toLocaleString()}
          </Text>
          <Text className="text-xs text-gray-400">{request.size} bytes</Text>
        </div>
        <Button
          size="xs"
          variant="secondary"
          color="red"
          onClick={handleDelete}
          loading={deleting}
        >
          Delete
        </Button>
      </div>

      {/* Headers */}
      <Card>
        <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Headers
        </Title>
        <div className="space-y-1">
          {Object.entries(request.headers).map(([k, v]) => (
            <div key={k} className="flex gap-2 text-xs font-mono">
              <span className="text-gray-400 min-w-0 flex-shrink-0">{k}:</span>
              <span className="text-gray-700 break-all">{v}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Query Params */}
      {Object.keys(request.query_params).length > 0 && (
        <Card>
          <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
            Query Parameters
          </Title>
          <div className="space-y-1">
            {Object.entries(request.query_params).map(([k, v]) => (
              <div key={k} className="flex gap-2 text-xs font-mono">
                <span className="text-gray-400">{k}:</span>
                <span className="text-gray-700">{v}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Body */}
      <Card>
        <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Body
        </Title>
        {request.body ? (
          <pre className="text-xs font-mono bg-gray-50 p-3 rounded overflow-x-auto text-gray-800 whitespace-pre-wrap break-all">
            {tryPrettyJSON(request.body)}
          </pre>
        ) : (
          <Text className="text-xs text-gray-400">empty body</Text>
        )}
      </Card>

      {/* Replay */}
      <Card>
        <Title className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
          Replay
        </Title>
        <div className="flex gap-2">
          <TextInput
            placeholder="https://your-server.com/webhook"
            value={replayUrl}
            onChange={(e) => setReplayUrl(e.target.value)}
            className="flex-1"
          />
          <Button size="sm" onClick={handleReplay} loading={replaying} disabled={!replayUrl}>
            Send
          </Button>
        </div>
        {replayResult && (
          <div className="mt-3">
            <Badge color={replayResult.status >= 200 && replayResult.status < 300 ? 'green' : 'red'}>
              {replayResult.status || 'Error'}
            </Badge>
            {replayResult.body && (
              <pre className="text-xs font-mono bg-gray-50 p-2 rounded mt-2 overflow-x-auto whitespace-pre-wrap break-all">
                {tryPrettyJSON(replayResult.body)}
              </pre>
            )}
          </div>
        )}
      </Card>

      {/* Meta */}
      <div className="text-xs text-gray-400 space-y-1">
        <div>ID: <span className="font-mono">{request.id}</span></div>
        {request.ip && <div>Source IP: <span className="font-mono">{request.ip}</span></div>}
      </div>
    </div>
  )
}
```

### `frontend/src/components/RequestList.tsx`
```tsx
import { Text } from '@tremor/react'
import type { Request } from '../types'

const METHOD_COLORS: Record<string, string> = {
  GET: 'bg-emerald-100 text-emerald-700',
  POST: 'bg-blue-100 text-blue-700',
  PUT: 'bg-amber-100 text-amber-700',
  PATCH: 'bg-purple-100 text-purple-700',
  DELETE: 'bg-red-100 text-red-700',
}

interface Props {
  requests: Request[]
  selectedId: string | null
  onSelect: (req: Request) => void
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function RequestList({ requests, selectedId, onSelect }: Props) {
  if (requests.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center p-8">
        <Text className="text-gray-400 text-sm">No requests yet</Text>
        <Text className="text-gray-300 text-xs mt-1">
          Send an HTTP request to your endpoint URL to see it here
        </Text>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full divide-y divide-gray-100">
      {requests.map((req) => (
        <button
          key={req.id}
          onClick={() => onSelect(req)}
          className={`w-full text-left px-4 py-3 hover:bg-gray-50 transition-colors ${
            selectedId === req.id ? 'bg-blue-50 border-l-2 border-blue-500' : ''
          }`}
        >
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-mono font-bold px-1.5 py-0.5 rounded ${
                METHOD_COLORS[req.method] ?? 'bg-gray-100 text-gray-600'
              }`}
            >
              {req.method}
            </span>
            <Text className="text-xs text-gray-500">{formatTime(req.received_at)}</Text>
            <Text className="text-xs text-gray-400 ml-auto">{req.size}B</Text>
          </div>
          {req.content_type && (
            <Text className="text-xs text-gray-400 mt-1 truncate">{req.content_type}</Text>
          )}
        </button>
      ))}
    </div>
  )
}
```

### `frontend/src/hooks/useWebSocket.ts`
```typescript
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
```

### `frontend/src/pages/EndpointPage.tsx`
```tsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Badge, Button, Text } from '@tremor/react'
import { api } from '../api/client'
import { useWebSocket } from '../hooks/useWebSocket'
import { RequestList } from '../components/RequestList'
import { RequestDetail } from '../components/RequestDetail'
import { CopyButton } from '../components/CopyButton'
import type { Request, WSMessage } from '../types'

export function EndpointPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [requests, setRequests] = useState<Request[]>([])
  const [selected, setSelected] = useState<Request | null>(null)
  const [loading, setLoading] = useState(true)

  const inspectUrl = `${window.location.origin}/r/${id}`

  // load existing requests on mount
  useEffect(() => {
    if (!id) return
    api.listRequests(id)
      .then(setRequests)
      .catch(() => navigate('/'))
      .finally(() => setLoading(false))
  }, [id, navigate])

  // handle incoming real-time messages
  const onMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'request.received') {
      setRequests(prev => [msg.data, ...prev].slice(0, 100))
    }
  }, [])

  useWebSocket({ endpointId: id!, onMessage })

  const handleDelete = (reqId: string) => {
    setRequests(prev => prev.filter(r => r.id !== reqId))
    if (selected?.id === reqId) setSelected(null)
  }

  const handleDeleteEndpoint = async () => {
    if (!confirm('Delete this endpoint and all its requests?')) return
    await api.deleteEndpoint(id!)
    navigate('/')
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Text>Loading...</Text>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* Top bar */}
      <div className="bg-white border-b px-4 py-3 flex items-center gap-3 flex-wrap">
        <span
          className="font-semibold text-gray-800 cursor-pointer hover:underline"
          onClick={() => navigate('/')}
        >
          webhook inspector
        </span>
        <span className="text-gray-300">/</span>
        <code className="text-sm bg-gray-100 px-2 py-1 rounded font-mono text-gray-700 truncate max-w-sm">
          {inspectUrl}
        </code>
        <CopyButton text={inspectUrl} label="Copy URL" />
        <Badge color="green" className="ml-auto">
          {requests.length} requests
        </Badge>
        <Button size="xs" variant="secondary" color="red" onClick={handleDeleteEndpoint}>
          Delete endpoint
        </Button>
      </div>

      {/* Split view */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left — request list */}
        <div className="w-64 flex-shrink-0 border-r bg-white overflow-hidden flex flex-col">
          <div className="px-4 py-2 border-b">
            <Text className="text-xs text-gray-400 uppercase tracking-wide font-medium">
              Requests
            </Text>
          </div>
          <RequestList
            requests={requests}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        </div>

        {/* Right — request detail */}
        <div className="flex-1 overflow-hidden bg-white">
          {selected ? (
            <RequestDetail request={selected} onDelete={handleDelete} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center">
                <Text className="text-gray-400">Select a request to inspect it</Text>
                <Text className="text-gray-300 text-xs mt-2">
                  Or send one to:{' '}
                  <code className="font-mono">{inspectUrl}</code>
                </Text>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
```

### `frontend/src/pages/HomePage.tsx`
```tsx
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
```

### `frontend/src/types/index.ts`
```typescript
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
```
