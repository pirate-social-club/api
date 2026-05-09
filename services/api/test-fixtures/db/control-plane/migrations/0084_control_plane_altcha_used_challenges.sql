CREATE TABLE IF NOT EXISTS altcha_used_challenges (
    challenge_hash text PRIMARY KEY,
    actor_user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    scope text NOT NULL,
    action_ref text NOT NULL,
    used_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_altcha_used_challenges_actor_used
    ON altcha_used_challenges(actor_user_id, used_at DESC);

CREATE INDEX IF NOT EXISTS idx_altcha_used_challenges_expires
    ON altcha_used_challenges(expires_at);

CREATE TABLE IF NOT EXISTS altcha_challenge_rate_limits (
    actor_user_id text NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    window_start timestamptz NOT NULL,
    request_count integer NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL,
    PRIMARY KEY (actor_user_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_altcha_challenge_rate_limits_window
    ON altcha_challenge_rate_limits(window_start);
