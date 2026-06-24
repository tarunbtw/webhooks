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
