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
