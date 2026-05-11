CREATE TABLE IF NOT EXISTS public_name_quote_rate_limits (
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('ip', 'wallet')),
    actor_id TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (actor_kind, actor_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_public_name_quote_rate_limits_window_start
    ON public_name_quote_rate_limits(window_start);
