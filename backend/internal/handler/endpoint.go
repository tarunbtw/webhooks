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
