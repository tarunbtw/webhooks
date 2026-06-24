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
