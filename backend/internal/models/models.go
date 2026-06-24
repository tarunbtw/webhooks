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
