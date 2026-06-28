# Project Context

This document contains the directory structure and the full contents of all source, configuration, and setup files in the `webhook-inspector` project.

---

## Directory Structure

```text
.
├── .env.example
├── .gitignore
├── docker-compose.yml
├── backend
│   ├── cmd
│   │   └── server
│   │       └── main.go
│   ├── internal
│   │   ├── cleanup
│   │   │   └── cleanup.go
│   │   ├── db
│   │   │   ├── db.go
│   │   │   └── schema.sql
│   │   ├── handler
│   │   │   ├── cors.go
│   │   │   ├── endpoint.go
│   │   │   ├── receiver.go
│   │   │   └── request.go
│   │   ├── models
│   │   │   └── models.go
│   │   └── ws
│   │       └── hub.go
│   ├── Dockerfile
│   └── go.mod
└── frontend
    ├── src
    │   ├── api
    │   │   └── client.ts
    │   ├── components
    │   │   ├── ui
    │   │   │   ├── badge.tsx
    │   │   │   ├── button.tsx
    │   │   │   ├── input.tsx
    │   │   │   ├── separator.tsx
    │   │   │   └── tooltip.tsx
    │   │   ├── CopyButton.tsx
    │   │   ├── RequestDetail.tsx
    │   │   ├── RequestList.tsx
    │   │   ├── ThemeProvider.tsx
    │   │   └── ThemeToggle.tsx
    │   ├── hooks
    │   │   └── useWebSocket.ts
    │   ├── lib
    │   │   └── utils.ts
    │   ├── pages
    │   │   ├── EndpointPage.tsx
    │   │   └── HomePage.tsx
    │   ├── types
    │   │   └── index.ts
    │   ├── App.tsx
    │   ├── index.css
    │   └── main.tsx
    ├── Dockerfile
    ├── index.html
    ├── nginx.conf
    ├── package.json
    ├── postcss.config.js
    ├── tailwind.config.js
    ├── tsconfig.json
    ├── tsconfig.node.json
    └── vite.config.ts
```

---

## Root Configurations

### `.env.example`
```ini
# Copy to .env for local development outside Docker
DATABASE_URL=postgres://inspector:inspector@localhost:5432/inspector?sslmode=disable
ADDR=:8080
```

### `.gitignore`
```text
# Local
.env
.env.local

# IDEs and OS overhead
.DS_Store
.idea/
.vscode/
*.suo
*.ntvs*
*.njsproj
*.sln
*.swp

# Frontend
node_modules/
frontend/node_modules/
dist/
frontend/dist/
.eslintcache
.vite/

# Backend
backend/server
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out

# Docker
pgdata/

# eh
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

---

## Backend Source Code

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
	golang.org/x/text. v0.21.0 // indirect
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
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
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

	// done is closed when the read loop exits (client disconnects).
	// the ping goroutine selects on it to exit cleanly — no goroutine leak.
	done := make(chan struct{})

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

	// ping goroutine — exits via done channel when client disconnects
	go func() {
		for {
			select {
			case <-ticker.C:
				conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					return
				}
			case <-done:
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

	close(done)    // signal ping goroutine to exit
	close(c.send)  // signal writer goroutine to exit
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

## Frontend Source Code

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

### `frontend/package.json`
```json
{
  "name": "webhook-inspector-frontend",
  "private": true,
  "version": "0.2.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@radix-ui/react-tooltip": "^1.1.6",
    "class-variance-authority": "^0.7.1",
    "clsx": "^2.1.1",
    "lucide-react": "^0.468.0",
    "next-themes": "^0.4.4",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.28.0",
    "tailwind-merge": "^2.6.0"
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
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      colors: {
        background:       'hsl(var(--background))',
        foreground:       'hsl(var(--foreground))',
        muted:            'hsl(var(--muted))',
        'muted-foreground': 'hsl(var(--muted-foreground))',
        border:           'hsl(var(--border))',
        input:            'hsl(var(--input))',
        ring:             'hsl(var(--ring))',
        card: {
          DEFAULT:     'hsl(var(--card))',
          foreground:  'hsl(var(--card-foreground))',
        },
        accent: {
          DEFAULT:     'hsl(var(--accent))',
          foreground:  'hsl(var(--accent-foreground))',
        },
        primary: {
          DEFAULT:     'hsl(var(--primary))',
          foreground:  'hsl(var(--primary-foreground))',
        },
        destructive: {
          DEFAULT:     'hsl(var(--destructive))',
          foreground:  'hsl(var(--destructive-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
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

### `frontend/src/App.tsx`
```tsx
import { Routes, Route } from 'react-router-dom'
import { ThemeProvider } from './components/ThemeProvider'
import { TooltipProvider } from './components/ui/tooltip'
import { HomePage } from './pages/HomePage'
import { EndpointPage } from './pages/EndpointPage'

export default function App() {
  return (
    <ThemeProvider>
      <TooltipProvider>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/e/:id" element={<EndpointPage />} />
        </Routes>
      </TooltipProvider>
    </ThemeProvider>
  )
}
```

### `frontend/src/index.css`
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    /* Zinc-based monochrome — light */
    --background:         0 0% 98%;      /* zinc-50 */
    --foreground:         240 6% 10%;    /* zinc-900 */

    --card:               0 0% 100%;     /* white */
    --card-foreground:    240 6% 10%;

    --muted:              240 5% 96%;    /* zinc-100 */
    --muted-foreground:   240 4% 46%;    /* zinc-500 */

    --border:             240 6% 90%;    /* zinc-200 */
    --input:              240 6% 90%;

    --accent:             240 5% 96%;    /* zinc-100 */
    --accent-foreground:  240 6% 10%;

    --primary:            240 6% 10%;    /* zinc-900 */
    --primary-foreground: 0 0% 98%;      /* zinc-50 */

    --destructive:        0 84% 60%;
    --destructive-foreground: 0 0% 98%;

    --ring:               240 6% 10%;
    --radius:             0.5rem;
  }

  .dark {
    /* Zinc-based monochrome — dark */
    --background:         240 10% 4%;    /* zinc-950 */
    --foreground:         0 0% 98%;      /* zinc-50 */

    --card:               240 6% 10%;    /* zinc-900 */
    --card-foreground:    0 0% 98%;

    --muted:              240 5% 15%;    /* zinc-800/900 blend */
    --muted-foreground:   240 5% 65%;    /* zinc-400 */

    --border:             240 5% 18%;    /* zinc-800 */
    --input:              240 5% 18%;

    --accent:             240 5% 15%;
    --accent-foreground:  0 0% 98%;

    --primary:            0 0% 98%;      /* zinc-50 */
    --primary-foreground: 240 6% 10%;   /* zinc-900 */

    --destructive:        0 72% 51%;
    --destructive-foreground: 0 0% 98%;

    --ring:               240 5% 65%;
  }

  * {
    @apply border-border;
  }

  body {
    @apply bg-background text-foreground font-sans antialiased;
  }

  /* Smooth theme transitions — exclude layout-affecting props to avoid jank */
  *,
  *::before,
  *::after {
    transition-property: color, background-color, border-color, opacity, box-shadow;
    transition-duration: 150ms;
    transition-timing-function: ease;
  }
}
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
import { Copy, Check } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'

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
    <Tooltip content={copied ? 'Copied!' : label} side="bottom">
      <Button variant="ghost" size="icon" onClick={copy} aria-label={label}>
        {copied ? (
          <Check className="h-3.5 w-3.5 text-foreground" />
        ) : (
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        )}
      </Button>
    </Tooltip>
  )
}
```

### `frontend/src/components/RequestDetail.tsx`
```tsx
import { useState } from 'react'
import { Trash2, Send, ChevronRight } from 'lucide-react'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Badge } from './ui/badge'
import { Input } from './ui/input'
import { Separator } from './ui/separator'
import { api } from '../api/client'
import type { Request } from '../types'

interface Props {
  request: Request
  onDelete: (id: string) => void
}

type Tab = 'headers' | 'query' | 'body' | 'replay'

function tryPrettyJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

/** Key-value table with zebra rows */
function KVTable({ data }: { data: Record<string, string> }) {
  const entries = Object.entries(data)
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-4 py-6 text-center">
        <p className="text-xs text-muted-foreground italic">No entries</p>
      </div>
    )
  }
  return (
    <div className="rounded-md border border-border overflow-hidden">
      {entries.map(([k, v], i) => (
        <div
          key={k}
          className={cn(
            'grid grid-cols-[200px_1fr] gap-0 text-xs font-mono',
            i % 2 === 0 ? 'bg-card' : 'bg-muted/30',
            i !== entries.length - 1 && 'border-b border-border'
          )}
        >
          <div className="px-3 py-2 text-muted-foreground border-r border-border truncate font-medium">
            {k}
          </div>
          <div className="px-3 py-2 text-foreground break-all">
            {v}
          </div>
        </div>
      ))}
    </div>
  )
}

export function RequestDetail({ request, onDelete }: Props) {
  const [tab, setTab] = useState<Tab>('headers')
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

  const tabs: { id: Tab; label: string }[] = [
    { id: 'headers', label: 'Headers' },
    { id: 'query',   label: 'Query' },
    { id: 'body',    label: 'Body' },
    { id: 'replay',  label: 'Replay' },
  ]

  const methodVariant = request.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'default'

  return (
    <div className="flex flex-col h-full bg-background">
      {/* ── Request meta bar ── */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card flex-shrink-0">
        <Badge variant={methodVariant}>{request.method}</Badge>

        <div className="flex items-center gap-3 min-w-0 flex-1 text-xs text-muted-foreground">
          <span className="tabular-nums shrink-0">
            {new Date(request.received_at).toLocaleString()}
          </span>
          <span className="hidden sm:inline shrink-0 tabular-nums">
            {request.size} bytes
          </span>
          {request.ip && (
            <span className="hidden md:inline font-mono truncate text-muted-foreground/60">
              {request.ip}
            </span>
          )}
        </div>

        <Button
          variant="destructive"
          size="sm"
          onClick={handleDelete}
          loading={deleting}
          aria-label="Delete request"
          className="h-7 px-2.5 text-xs gap-1.5 shrink-0"
        >
          <Trash2 className="h-3 w-3" />
          <span className="hidden sm:inline">Delete</span>
        </Button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex border-b border-border bg-muted/30 flex-shrink-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex items-center gap-1 px-4 py-2.5 text-xs font-medium transition-colors relative',
              'hover:text-foreground focus-visible:outline-none',
              tab === t.id
                ? 'text-foreground bg-background border-b-2 border-b-foreground -mb-px'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            {t.label}
            {t.id === 'query' && Object.keys(request.query_params).length > 0 && (
              <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                {Object.keys(request.query_params).length}
              </span>
            )}
            {t.id === 'headers' && (
              <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] font-mono tabular-nums text-muted-foreground">
                {Object.keys(request.headers).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0 space-y-3">
        {tab === 'headers' && <KVTable data={request.headers} />}

        {tab === 'query' && <KVTable data={request.query_params} />}

        {tab === 'body' && (
          request.body ? (
            <pre className={cn(
              'text-xs font-mono rounded-md border border-border',
              'bg-card p-4 overflow-x-auto whitespace-pre-wrap break-all',
              'text-foreground leading-relaxed'
            )}>
              {tryPrettyJSON(request.body)}
            </pre>
          ) : (
            <div className="rounded-md border border-border bg-muted/30 px-4 py-6 text-center">
              <p className="text-xs text-muted-foreground italic">Empty body</p>
            </div>
          )
        )}

        {tab === 'replay' && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-card p-4 space-y-3">
              <div>
                <p className="text-xs font-medium text-foreground mb-0.5">Target URL</p>
                <p className="text-xs text-muted-foreground mb-3">
                  Re-sends this {request.method} request with the original headers and body.
                </p>
                <div className="flex gap-2">
                  <Input
                    placeholder="https://your-server.com/webhook"
                    value={replayUrl}
                    onChange={(e) => setReplayUrl(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleReplay()}
                    className="flex-1"
                  />
                  <Button
                    onClick={handleReplay}
                    loading={replaying}
                    disabled={!replayUrl}
                    size="sm"
                    className="shrink-0 gap-1.5"
                  >
                    <Send className="h-3.5 w-3.5" />
                    Send
                  </Button>
                </div>
              </div>
            </div>

            {replayResult && (
              <div className="rounded-md border border-border bg-card overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-muted/40">
                  <span className="text-xs font-medium text-muted-foreground">Response</span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
                  <Badge
                    variant={replayResult.status >= 200 && replayResult.status < 300 ? 'default' : 'destructive'}
                  >
                    {replayResult.status || 'Error'}
                  </Badge>
                </div>
                {replayResult.body ? (
                  <pre className="text-xs font-mono p-4 overflow-x-auto whitespace-pre-wrap break-all text-foreground leading-relaxed">
                    {tryPrettyJSON(replayResult.body)}
                  </pre>
                ) : (
                  <div className="px-4 py-3">
                    <p className="text-xs text-muted-foreground italic">Empty response body</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Request ID footer ── */}
      <Separator />
      <div className="px-4 py-1.5 bg-muted/20 flex-shrink-0">
        <p className="text-[10px] font-mono text-muted-foreground/50 truncate">
          id: {request.id}
        </p>
      </div>
    </div>
  )
}
```

### `frontend/src/components/RequestList.tsx`
```tsx
import { Inbox } from 'lucide-react'
import { cn } from '../lib/utils'
import { Badge } from './ui/badge'
import type { Request } from '../types'

const METHOD_VARIANT: Record<string, 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'default'> = {
  GET:    'GET',
  POST:   'POST',
  PUT:    'PUT',
  PATCH:  'PATCH',
  DELETE: 'DELETE',
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
      <div className="flex flex-col items-center justify-center h-full gap-2 p-8 text-center">
        <Inbox className="h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">No requests yet</p>
        <p className="text-xs text-muted-foreground/60">
          Send an HTTP request to your endpoint URL
        </p>
      </div>
    )
  }

  return (
    <div className="overflow-y-auto h-full">
      {requests.map((req) => {
        const isSelected = selectedId === req.id
        return (
          <button
            key={req.id}
            onClick={() => onSelect(req)}
            className={cn(
              'w-full text-left px-3 py-2.5 border-b border-border',
              'hover:bg-accent transition-colors',
              'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              isSelected && 'bg-accent border-l-2 border-l-foreground'
            )}
          >
            <div className="flex items-center gap-2">
              <Badge variant={METHOD_VARIANT[req.method] ?? 'default'}>
                {req.method}
              </Badge>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatTime(req.received_at)}
              </span>
              <span className="ml-auto text-xs text-muted-foreground/60 tabular-nums">
                {req.size}B
              </span>
            </div>
            {req.content_type && (
              <p className="text-xs text-muted-foreground/60 mt-1 truncate">
                {req.content_type}
              </p>
            )}
          </button>
        )
      })}
    </div>
  )
}
```

### `frontend/src/components/ThemeProvider.tsx`
```tsx
import { ThemeProvider as NextThemeProvider } from 'next-themes'
import type { ThemeProviderProps } from 'next-themes'

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange={false}
      {...props}
    >
      {children}
    </NextThemeProvider>
  )
}
```

### `frontend/src/components/ThemeToggle.tsx`
```tsx
import { useTheme } from 'next-themes'
import { Sun, Moon } from 'lucide-react'
import { Button } from './ui/button'
import { Tooltip } from './ui/tooltip'

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  const toggle = () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')

  return (
    <Tooltip content={resolvedTheme === 'dark' ? 'Light mode' : 'Dark mode'} side="bottom">
      <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
        <Sun className="h-4 w-4 rotate-0 scale-100 transition-transform dark:-rotate-90 dark:scale-0" />
        <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-transform dark:rotate-0 dark:scale-100" />
      </Button>
    </Tooltip>
  )
}
```

### `frontend/src/components/ui/badge.tsx`
```tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-mono font-semibold uppercase tracking-wide transition-colors',
  {
    variants: {
      variant: {
        default:     'border-transparent bg-primary/10 text-foreground',
        outline:     'border-border text-muted-foreground',
        destructive: 'border-transparent bg-destructive/15 text-destructive',
        GET:         'border-transparent bg-muted text-foreground',
        POST:        'border-transparent bg-muted text-foreground',
        PUT:         'border-transparent bg-muted text-foreground',
        PATCH:       'border-transparent bg-muted text-foreground',
        DELETE:      'border-transparent bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
```

### `frontend/src/components/ui/button.tsx`
```tsx
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default:     'bg-primary text-primary-foreground hover:bg-primary/90',
        outline:     'border border-border bg-transparent hover:bg-accent hover:text-accent-foreground',
        ghost:       'hover:bg-accent hover:text-accent-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link:        'text-foreground underline-offset-4 hover:underline',
      },
      size: {
        sm:      'h-8 px-3 text-xs',
        default: 'h-9 px-4 py-2',
        lg:      'h-11 px-8 text-base',
        icon:    'h-8 w-8 p-0',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  loading?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, loading, disabled, children, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading && (
          <svg
            className="h-3.5 w-3.5 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
        )}
        {children}
      </button>
    )
  }
)
Button.displayName = 'Button'

export { Button, buttonVariants }
```

### `frontend/src/components/ui/input.tsx`
```tsx
import * as React from 'react'
import { cn } from '../../lib/utils'

const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-sm',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          'transition-colors',
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = 'Input'

export { Input }
```

### `frontend/src/components/ui/separator.tsx`
```tsx
import * as React from 'react'
import { cn } from '../../lib/utils'

const Separator = React.forwardRef<
  HTMLHRElement,
  React.HTMLAttributes<HTMLHRElement>
>(({ className, ...props }, ref) => (
  <hr
    ref={ref}
    className={cn('border-0 border-t border-border', className)}
    {...props}
  />
))
Separator.displayName = 'Separator'

export { Separator }
```

### `frontend/src/components/ui/tooltip.tsx`
```tsx
import * as React from 'react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '../../lib/utils'

const TooltipProvider = TooltipPrimitive.Provider
const TooltipRoot = TooltipPrimitive.Root
const TooltipTrigger = TooltipPrimitive.Trigger

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Content
    ref={ref}
    sideOffset={sideOffset}
    className={cn(
      'z-50 overflow-hidden rounded-md border border-border bg-card px-2.5 py-1',
      'text-xs text-card-foreground shadow-sm',
      'animate-in fade-in-0 zoom-in-95',
      'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
      'data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2',
      className
    )}
    {...props}
  />
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

/** Convenience wrapper — renders an icon button with a tooltip */
function Tooltip({
  children,
  content,
  side = 'bottom',
}: {
  children: React.ReactNode
  content: React.ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
}) {
  return (
    <TooltipRoot delayDuration={300}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </TooltipRoot>
  )
}

export { Tooltip, TooltipProvider, TooltipRoot, TooltipTrigger, TooltipContent }
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

### `frontend/src/lib/utils.ts`
```typescript
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

### `frontend/src/pages/EndpointPage.tsx`
```tsx
import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Trash2, Terminal, Activity } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Badge } from '../components/ui/badge'
import { Separator } from '../components/ui/separator'
import { Tooltip } from '../components/ui/tooltip'
import { ThemeToggle } from '../components/ThemeToggle'
import { CopyButton } from '../components/CopyButton'
import { RequestList } from '../components/RequestList'
import { RequestDetail } from '../components/RequestDetail'
import { api } from '../api/client'
import { useWebSocket } from '../hooks/useWebSocket'
import type { Request, WSMessage } from '../types'

const STORAGE_KEY = 'wi-last-endpoint'

export function EndpointPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [requests, setRequests] = useState<Request[]>([])
  const [selected, setSelected] = useState<Request | null>(null)
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState(false)

  const inspectUrl = `${window.location.origin}/r/${id}`

  // Persist this endpoint so the landing page can offer "Continue"
  useEffect(() => {
    if (id) localStorage.setItem(STORAGE_KEY, id)
  }, [id])

  // Load existing requests on mount
  useEffect(() => {
    if (!id) return
    api.listRequests(id)
      .then((r) => { setRequests(r); setLoading(false) })
      .catch(() => navigate('/'))
  }, [id, navigate])

  // Real-time WebSocket updates
  const onMessage = useCallback((msg: WSMessage) => {
    if (msg.type === 'request.received') {
      setRequests((prev) => [msg.data, ...prev].slice(0, 100))
    }
  }, [])

  useWebSocket({ endpointId: id!, onMessage })

  const handleDeleteRequest = (reqId: string) => {
    setRequests((prev) => prev.filter((r) => r.id !== reqId))
    if (selected?.id === reqId) setSelected(null)
  }

  const handleDeleteEndpoint = async () => {
    if (!confirm('Delete this endpoint and all its requests? This cannot be undone.')) return
    setDeleting(true)
    try {
      await api.deleteEndpoint(id!)
      localStorage.removeItem(STORAGE_KEY)  // clear persisted endpoint
      navigate('/')
    } finally {
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Loading…
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen bg-background flex flex-col overflow-hidden">
      {/* ── Top navbar ── */}
      <header className="flex items-center gap-2 px-3 h-12 border-b border-border bg-card flex-shrink-0">
        {/* Logo */}
        <button
          onClick={() => navigate('/')}
          className="flex items-center gap-1.5 text-sm font-semibold hover:opacity-70 transition-opacity shrink-0"
        >
          <Terminal className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">webhook inspector</span>
        </button>

        <Separator className="h-4 w-px border-0 bg-border hidden sm:block shrink-0" />

        {/* Endpoint URL + copy */}
        <div className="flex items-center gap-1 min-w-0 flex-1">
          <code className="text-xs font-mono text-muted-foreground truncate">
            {inspectUrl}
          </code>
          <CopyButton text={inspectUrl} label="Copy endpoint URL" />
        </div>

        {/* Live indicator + request count */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Activity className="h-3 w-3 text-muted-foreground/50 animate-pulse" />
          <Badge variant="outline" className="tabular-nums text-xs">
            {requests.length} {requests.length === 1 ? 'request' : 'requests'}
          </Badge>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          <ThemeToggle />
          <Tooltip content="Delete endpoint" side="bottom">
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDeleteEndpoint}
              loading={deleting}
              aria-label="Delete endpoint"
              className="h-7 px-2.5 text-xs gap-1.5"
            >
              <Trash2 className="h-3 w-3" />
              <span className="hidden sm:inline">Delete</span>
            </Button>
          </Tooltip>
        </div>
      </header>

      {/* ── Split panel ── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left — request list */}
        <div className="w-56 sm:w-64 flex-shrink-0 border-r border-border bg-card flex flex-col overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-muted/40 flex-shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
              Incoming Requests
            </span>
          </div>
          <div className="flex-1 overflow-hidden">
            <RequestList
              requests={requests}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          </div>
        </div>

        {/* Right — request detail */}
        <div className="flex-1 overflow-hidden bg-background flex flex-col">
          {selected ? (
            <RequestDetail request={selected} onDelete={handleDeleteRequest} />
          ) : (
            <div className="h-full flex items-center justify-center">
              <div className="text-center space-y-3 max-w-xs px-4">
                <div className="h-10 w-10 rounded-full border border-border flex items-center justify-center mx-auto">
                  <Activity className="h-4 w-4 text-muted-foreground/50" />
                </div>
                <div className="space-y-1">
                  <p className="text-sm font-medium text-foreground">
                    Waiting for requests
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Select one from the list, or send a request to:
                  </p>
                  <p className="text-xs font-mono text-muted-foreground/80 bg-muted rounded px-2 py-1 break-all">
                    {inspectUrl}
                  </p>
                </div>
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
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Zap, RefreshCcw, Clock, Globe, ArrowRight, Terminal } from 'lucide-react'
import { Button } from '../components/ui/button'
import { Separator } from '../components/ui/separator'
import { ThemeToggle } from '../components/ThemeToggle'
import { api } from '../api/client'

const FEATURES = [
  {
    icon: Zap,
    title: 'Real-time delivery',
    description: 'Requests appear instantly via WebSocket — no polling, no refresh.',
  },
  {
    icon: Globe,
    title: 'Any HTTP method',
    description: 'GET, POST, PUT, PATCH, DELETE — every method, every content type.',
  },
  {
    icon: RefreshCcw,
    title: 'Request replay',
    description: 'Forward any captured request to a target URL with one click.',
  },
  {
    icon: Clock,
    title: '48-hour TTL',
    description: 'Requests are automatically cleaned up after 48 hours.',
  },
]

const STEPS = [
  { n: '01', title: 'Create an endpoint', body: 'Click the button below. You get a unique inspect URL instantly — no signup.' },
  { n: '02', title: 'Send requests to it', body: 'Point any webhook, curl command, or HTTP client at your inspect URL.' },
  { n: '03', title: 'Inspect in real time', body: 'See headers, body, query params, and source IP as they arrive live.' },
]

const STORAGE_KEY = 'wi-last-endpoint'

export function HomePage() {
  const [loading, setLoading] = useState(false)
  const [existingId, setExistingId] = useState<string | null>(null)
  const navigate = useNavigate()

  // Silently validate any previously saved endpoint in the background
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      api.getEndpoint(saved)
        .then(() => setExistingId(saved))
        .catch(() => localStorage.removeItem(STORAGE_KEY))
    }
  }, [])

  // If a valid endpoint exists → take them there. Otherwise create a fresh one.
  const handleCreate = async () => {
    setLoading(true)
    try {
      if (existingId) {
        navigate(`/e/${existingId}`)
        return
      }
      const ep = await api.createEndpoint()
      navigate(`/e/${ep.id}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── Navbar ── */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur-sm">
        <div className="mx-auto max-w-5xl px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Terminal className="h-4 w-4 text-foreground" />
            <span className="text-sm font-semibold tracking-tight">webhook inspector</span>
          </div>
          <ThemeToggle />
        </div>
      </header>

      {/* ── Hero ── */}
      <section className="flex-1 flex flex-col items-center justify-center text-center px-4 py-24 gap-8">
        <div className="space-y-4 max-w-2xl">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground animate-pulse" />
            Self-hostable · Open source · No signup
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-foreground leading-tight">
            Inspect webhooks<br />in real time
          </h1>
          <p className="text-base text-muted-foreground max-w-lg mx-auto leading-relaxed">
            Get a unique URL. Send any HTTP request to it. See every header,
            body, and query parameter arrive instantly — no signup required.
          </p>
        </div>

        {/* Two clean buttons — no banner, no extra UI */}
        <div className="flex flex-col sm:flex-row items-center gap-3">
          <Button size="lg" onClick={handleCreate} loading={loading} className="min-w-48">
            Create endpoint
            <ArrowRight className="h-4 w-4" />
          </Button>
          <Button size="lg" variant="outline" onClick={() => window.open('https://github.com', '_blank')}>
            View on GitHub
          </Button>
        </div>

        {/* Quick usage hint */}
        <div className="rounded-lg border border-border bg-muted/50 px-4 py-3 text-left max-w-md w-full">
          <p className="text-xs text-muted-foreground mb-1.5 font-mono">Quick start</p>
          <code className="text-xs font-mono text-foreground block leading-relaxed">
            curl -X POST https://your-url/r/&#123;id&#125; \<br />
            {'  '}-H "Content-Type: application/json" \<br />
            {'  '}-d '&#123;"hello":"world"&#125;'
          </code>
        </div>
      </section>

      <Separator />

      {/* ── Features ── */}
      <section className="py-20 px-4">
        <div className="mx-auto max-w-5xl">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">Everything you need to debug webhooks</h2>
            <p className="text-sm text-muted-foreground mt-2">No fluff. Just the tools.</p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
            {FEATURES.map(({ icon: Icon, title, description }) => (
              <div
                key={title}
                className="rounded-lg border border-border bg-card p-5 space-y-3 hover:bg-accent/50 transition-colors"
              >
                <div className="h-8 w-8 rounded-md border border-border flex items-center justify-center">
                  <Icon className="h-4 w-4 text-foreground" />
                </div>
                <h3 className="text-sm font-semibold">{title}</h3>
                <p className="text-xs text-muted-foreground leading-relaxed">{description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <Separator />

      {/* ── How it works ── */}
      <section className="py-20 px-4">
        <div className="mx-auto max-w-3xl">
          <div className="text-center mb-12">
            <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
          </div>
          <div className="space-y-0">
            {STEPS.map(({ n, title, body }, i) => (
              <div key={n} className="flex gap-6">
                <div className="flex flex-col items-center">
                  <div className="h-9 w-9 rounded-full border border-border flex items-center justify-center flex-shrink-0">
                    <span className="text-xs font-mono text-muted-foreground">{n}</span>
                  </div>
                  {i < STEPS.length - 1 && (
                    <div className="w-px flex-1 bg-border my-2" />
                  )}
                </div>
                <div className="pb-10 pt-1.5 min-w-0">
                  <h3 className="text-sm font-semibold mb-1">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-center">
            <Button size="lg" onClick={handleCreate} loading={loading} className="min-w-48">
              Get started
              <ArrowRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </section>

      <Separator />

      {/* ── Footer ── */}
      <footer className="py-8 px-4">
        <div className="mx-auto max-w-5xl flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-2">
            <Terminal className="h-3 w-3" />
            <span>webhook inspector</span>
          </div>
          <span>Self-hosted · Requests expire after 48 hours</span>
        </div>
      </footer>
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
