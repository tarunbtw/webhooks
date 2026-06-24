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
