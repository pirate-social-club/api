-- User-visible conditional rewards awaiting the configured unique-human proof.
--
-- These rows are a projection of durable qualification evidence. They do not
-- reserve campaign budget and cannot authorize cashout. Identity-level dedup,
-- caps, campaign state, and available budget are checked again when crediting.

CREATE TABLE reward_pending_qualifications (
    reward_pending_qualification_id TEXT PRIMARY KEY,
    reward_qualification_event_id TEXT NOT NULL UNIQUE
        REFERENCES reward_qualification_events(reward_qualification_event_id),
    reward_campaign_id TEXT NOT NULL
        REFERENCES reward_campaigns(reward_campaign_id),
    user_id TEXT NOT NULL REFERENCES users(user_id),
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    post_id TEXT NOT NULL,
    reward_period_key DATE NOT NULL,
    reward_kind TEXT NOT NULL CHECK (
        reward_kind IN (
            'campaign_practice_day',
            'campaign_milestone_7',
            'campaign_milestone_30'
        )
    ),
    qualification_basis TEXT NOT NULL CHECK (
        qualification_basis IN ('study', 'karaoke', 'both')
    ),
    conditional_amount_cents INTEGER NOT NULL CHECK (conditional_amount_cents > 0),
    status TEXT NOT NULL CHECK (
        status IN ('pending_verification', 'reconciling', 'credited', 'expired', 'ineligible')
    ),
    expires_at TIMESTAMPTZ NOT NULL,
    terminal_reason TEXT CHECK (
        terminal_reason IS NULL OR terminal_reason IN (
            'campaign_ended',
            'budget_unavailable',
            'identity_duplicate',
            'owner_blocked',
            'score',
            'verification_window_expired'
        )
    ),
    credited_reward_event_id TEXT REFERENCES reward_events(reward_event_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT reward_pending_qualifications_terminal_reason_status_check CHECK (
        terminal_reason IS NULL OR status IN ('expired', 'ineligible')
    ),
    CONSTRAINT reward_pending_qualifications_credit_status_check CHECK (
        credited_reward_event_id IS NULL OR status = 'credited'
    )
);

CREATE UNIQUE INDEX reward_pending_qualifications_one_active_account_period
    ON reward_pending_qualifications (
        user_id, community_id, post_id, reward_period_key, reward_kind
    )
    WHERE status IN ('pending_verification', 'reconciling');

CREATE INDEX reward_pending_qualifications_user_status_expiry_idx
    ON reward_pending_qualifications (user_id, status, expires_at);

CREATE INDEX reward_pending_qualifications_campaign_status_idx
    ON reward_pending_qualifications (reward_campaign_id, status, expires_at);
