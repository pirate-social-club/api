-- Durable audit evidence for operational alert delivery. KV remains the
-- short-lived dedupe mechanism; this append-only ledger answers whether a
-- specific alert was attempted, which sink handled it, and whether that sink
-- acknowledged delivery after the dedupe evidence has expired.
CREATE TABLE ops_alert_delivery_attempts (
    ops_alert_delivery_attempt_id TEXT PRIMARY KEY,
    alert_key TEXT NOT NULL CHECK (length(alert_key) BETWEEN 1 AND 240),
    environment TEXT NOT NULL CHECK (length(environment) BETWEEN 1 AND 40),
    severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high')),
    sink TEXT NOT NULL CHECK (sink IN ('none', 'log', 'email', 'webhook')),
    delivery_status TEXT NOT NULL CHECK (
        delivery_status IN ('attempting', 'delivered', 'failed')
    ),
    alert_count INTEGER NOT NULL CHECK (alert_count > 0),
    sent_count INTEGER NOT NULL CHECK (sent_count >= 0),
    bucket_start_ms BIGINT NOT NULL CHECK (bucket_start_ms >= 0),
    provider_message_id TEXT CHECK (
        provider_message_id IS NULL OR length(provider_message_id) BETWEEN 1 AND 240
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
        (delivery_status IN ('attempting', 'delivered'))
        OR (delivery_status = 'failed' AND sent_count = 0)
    )
);

CREATE INDEX ops_alert_delivery_attempts_key_created_idx
    ON ops_alert_delivery_attempts (alert_key, created_at DESC);

CREATE INDEX ops_alert_delivery_attempts_failed_created_idx
    ON ops_alert_delivery_attempts (created_at DESC)
    WHERE delivery_status = 'failed';
