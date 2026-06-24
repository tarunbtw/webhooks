# Phase 5 — Ship

## Goal

`docker-compose up` runs the full stack — PostgreSQL, Go backend, React frontend behind nginx — and the product is accessible at `http://localhost` (port 80). GitHub Actions CI validates every push.

## Prerequisites

Phase 4 complete. Full product working in development mode.

---

## What gets built

```
webhook-inspector/
├── frontend/
│   ├── Dockerfile              ← multi-stage: vite build → nginx
│   └── nginx.conf              ← serves frontend, proxies /api /r /ws to backend
├── backend/
│   └── Dockerfile              ← unchanged from Phase 1 (already correct)
├── docker-compose.yml          ← updated: adds frontend service
└── .github/
    └── workflows/
        └── ci.yml              ← build + vet backend; tsc + build frontend
```

---

## Implementation

### `frontend/nginx.conf`

nginx serves the built React app and proxies API and WebSocket requests to the backend container. This is why the backend never needs to serve static files.

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
        proxy_read_timeout 3600s;  # keep WS connections alive for 1 hour
        proxy_send_timeout 3600s;
    }

    # proxy health check
    location /health {
        proxy_pass         http://backend:8080;
    }

    # SPA fallback — all other paths serve index.html
    # react-router handles client-side routing
    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

---

### `frontend/Dockerfile`

Two stages: build the React app with Node, then copy the output into an nginx image. The final image has no Node, no npm, no source files — only the compiled static output and nginx.

```dockerfile
# Stage 1 — build
FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2 — serve
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
```

`npm ci` instead of `npm install` — uses the lockfile exactly, faster and reproducible in CI.

---

### `docker-compose.yml` — final version

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

The frontend is the only container with an exposed port (80). The backend and postgres are on the internal Docker network only. nginx proxies traffic to the backend by service name (`http://backend:8080`).

**No port 8080 exposed.** In development you accessed the backend directly; in production all traffic goes through nginx on port 80.

---

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
          go-version: "1.26"
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
        run: npm ci

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

Three jobs that run in parallel (backend, frontend), then a third job (docker) that only runs if both pass. The docker job confirms the Dockerfiles are not broken.

---

## Verification — definition of done

```bash
# Full production build from scratch
docker-compose down -v  # clear any dev state
docker-compose up --build -d

# Wait ~15 seconds for postgres init + both builds

# 1. Check all services are healthy
docker-compose ps
# Expected: postgres (healthy), backend (running), frontend (running)

# 2. Hit the app on port 80 (production nginx)
curl -s http://localhost/ | grep -c "webhook inspector"
# Expected: 1

# 3. Health check via nginx proxy
curl -s http://localhost/health | jq .
# Expected: {"status":"ok","db":"ok"}

# 4. Full flow via port 80
EP=$(curl -s -X POST http://localhost/api/endpoints | jq -r '.id')
echo "Endpoint: $EP"

# inspect_url should use port 80 now (not 8080)
curl -s http://localhost/api/endpoints/$EP | jq .

# Send a webhook through nginx
curl -s -X POST http://localhost/r/$EP \
  -H "Content-Type: application/json" \
  -d '{"production": true}'

# Verify stored
curl -s http://localhost/api/endpoints/$EP/requests | jq '.requests | length'
# Expected: 1

# 5. Open http://localhost in browser
# Full flow: create endpoint → copy URL → curl → see in real time

# 6. Confirm backend not directly accessible (no port 8080 exposed)
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health
# Expected: connection refused

# 7. Verify data persists across restart
docker-compose restart backend
sleep 3
curl -s http://localhost/api/endpoints/$EP/requests | jq '.requests | length'
# Expected: still 1 (PostgreSQL survived the restart)
```

## Checklist

- [ ] `docker-compose up --build` completes with no build errors
- [ ] All three services running: `docker-compose ps`
- [ ] `http://localhost` serves the React app (not a 502)
- [ ] `http://localhost/health` returns `{"status":"ok","db":"ok"}`
- [ ] API routes work through nginx (no 502 on `/api/*`)
- [ ] WebSocket connects through nginx (`ws://localhost/ws/:id`)
- [ ] Real-time request delivery works in the browser (end-to-end via port 80)
- [ ] Port 8080 is NOT directly accessible (backend on internal network only)
- [ ] Data persists across `docker-compose restart backend`
- [ ] Data persists across `docker-compose restart` (pgdata volume)
- [ ] `docker-compose down` (without `-v`) preserves the pgdata volume
- [ ] GitHub Actions CI passes on push to main (green checks)
- [ ] Frontend Docker image contains no node_modules (multi-stage build)
- [ ] `docker images | grep webhook` — frontend image is under 50MB (nginx:alpine base)

---

## What you have when this is done

A live product. A real URL. A Go backend. A React frontend. PostgreSQL. WebSockets. nginx in production. Docker for everything. CI on every push.

When someone asks "walk me through this project" in an interview, you:

1. Open the URL live in the browser
2. Create an endpoint
3. Run `curl` in the terminal, they watch the request appear in real time
4. Show them the Go hub code and explain the room-per-endpoint pattern
5. Explain why PostgreSQL and not SQLite
6. Explain why WebSocket and not polling
7. Explain the nginx reverse proxy config and why backend is not exposed

That's a 20-minute interview conversation that requires zero preparation because you built every line of it.
