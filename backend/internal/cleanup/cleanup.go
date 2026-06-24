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
