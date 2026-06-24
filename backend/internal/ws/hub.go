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
