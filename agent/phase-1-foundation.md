# Phase 1 — Foundation

## Goal

Monorepo scaffold is created. Backend starts, connects to PostgreSQL, runs schema migrations, and `/health` returns `{"status":"ok","db":"ok"}`. Nothing else. No routes, no frontend.

## Prerequisites

- Go 1.22+ installed
- Docker and Docker Compose installed
- Ports 8080 and 5432 free locally

---

## What gets built

```
webhook-inspector/
├── backend/
│   ├── cmd/
│   │   └── server/
│   │       └── main.go          ← entry point
│   ├── internal/
│   │   └── db/
│   │       ├── db.go            ← connection pool + migrations runner
│   │       └── schema.sql       ← full schema, run once on startup
│   ├── go.mod
│   └── Dockerfile
├── docker-compose.yml           ← postgres + backend only (no frontend yet)
└── .env.example
```

---

## Implementation

### `backend/go.mod`

```go
module github.com/tarunbtw/webhook-inspector/backend

go 1.26

require (
    github.com/jackc/pgx/v5 v5.7.2
)
```

Run `go mod tidy` after creating this file.

---

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

All statements use `IF NOT EXISTS`. Safe to run on every server startup — idempotent by design. No migration versioning table needed at this scale.

---

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

---

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

    "github.com/tarunbtw/webhook-inspector/backend/internal/db"
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
    slog.Info("database connected")

    if err := db.Migrate(context.Background(), pool); err != nil {
        slog.Error("migration failed", "err", err)
        os.Exit(1)
    }
    slog.Info("schema ok")

    mux := http.NewServeMux()

    // health — the only route in phase 1
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
    slog.Info("server starting", "addr", addr)
    if err := http.ListenAndServe(addr, mux); err != nil {
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

### `backend/Dockerfile`

```dockerfile
FROM golang:1.26-alpine AS builder
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

---

### `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: inspector
      POSTGRES_PASSWORD: inspector
      POSTGRES_DB: inspector
    ports:
      - "5432:5432"
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
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgres://inspector:inspector@postgres:5432/inspector?sslmode=disable
      - ADDR=:8080
    depends_on:
      postgres:
        condition: service_healthy
    restart: unless-stopped

volumes:
  pgdata:
```

The `pgdata` named volume persists the PostgreSQL data directory across `docker-compose down` and `docker-compose up`. **Do not use `docker-compose down -v` unless you intend to wipe all stored data.**

---

### `.env.example`

```
# Copy to .env for local development outside Docker
DATABASE_URL=postgres://inspector:inspector@localhost:5432/inspector?sslmode=disable
ADDR=:8080
```

---

## Verification — definition of done

Run exactly these commands. Every one must pass before moving to Phase 2.

```bash
# 1. Start the stack
docker-compose up --build -d

# 2. Wait ~5 seconds for PostgreSQL to initialize, then:
curl -s http://localhost:8080/health | jq .
# Expected output:
# {
#   "status": "ok",
#   "db": "ok"
# }

# 3. Confirm the schema was created
docker-compose exec postgres psql -U inspector -d inspector -c "\dt"
# Expected: List showing tables "endpoints" and "requests"

# 4. Confirm the index was created
docker-compose exec postgres psql -U inspector -d inspector \
  -c "SELECT indexname FROM pg_indexes WHERE tablename = 'requests';"
# Expected: idx_requests_endpoint_received appears in the list

# 5. Kill the backend container, bring it back up — health must still return ok
docker-compose restart backend
sleep 3
curl -s http://localhost:8080/health | jq .
# Expected: same { "status": "ok", "db": "ok" }
# Migrations ran again with no error — IF NOT EXISTS is idempotent
```

## Checklist

- [ ] `docker-compose up --build` succeeds with no errors
- [ ] `GET /health` returns `{"status":"ok","db":"ok"}`
- [ ] Both tables exist in PostgreSQL after startup
- [ ] Index exists on `requests(endpoint_id, received_at DESC)`
- [ ] Restarting the backend does not cause migration errors
- [ ] `pgdata` volume exists: `docker volume ls | grep pgdata`
- [ ] No hardcoded credentials in Go source (all from env)
