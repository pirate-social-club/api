-- Community health totals are projected from complete Tinybird UTC-day slices.
-- Advancing this row in the same transaction as additive count updates makes
-- retries idempotent and prevents the former unbounded full-history scan.

CREATE TABLE community_health_sync_state (
    projection_key TEXT PRIMARY KEY CHECK (
        projection_key = 'tinybird_community_health_daily'
    ),
    next_date DATE NOT NULL,
    reset_required INTEGER NOT NULL DEFAULT 1 CHECK (reset_required IN (0, 1)),
    updated_at TIMESTAMPTZ NOT NULL
);

INSERT INTO community_health_sync_state (
    projection_key,
    next_date,
    reset_required,
    updated_at
) VALUES (
    'tinybird_community_health_daily',
    CURRENT_DATE,
    1,
    CURRENT_TIMESTAMP
)
ON CONFLICT (projection_key) DO NOTHING;
