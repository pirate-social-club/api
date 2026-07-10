-- Off-chain rewards ledger for song practice incentives.
--
-- reward_events is the authoritative append-only credit ledger. Credits are derived
-- by a reconciler from shard song_engagement_days rows; the attempt write path does
-- not write this control-plane table.
--
-- reward_user_days is the row-lockable per-user/day budget row used to enforce the
-- daily cap atomically in the same Postgres transaction as the reward_events insert.

CREATE TABLE reward_user_days (
    user_id TEXT NOT NULL,
    activity_date DATE NOT NULL,
    credited_cents INTEGER NOT NULL DEFAULT 0 CHECK (credited_cents >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, activity_date),
    FOREIGN KEY (user_id) REFERENCES users(user_id)
);

CREATE TABLE reward_events (
    reward_event_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    activity_date DATE NOT NULL,
    reward_kind TEXT NOT NULL CHECK (
        reward_kind IN (
            'study_streak_day',
            'study_streak_milestone_7',
            'study_streak_milestone_30'
        )
    ),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    source TEXT NOT NULL DEFAULT 'song_engagement_reconciler' CHECK (
        source IN ('song_engagement_reconciler')
    ),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE UNIQUE INDEX reward_events_study_streak_day_unique
    ON reward_events (user_id, community_id, post_id, activity_date, reward_kind)
    WHERE reward_kind = 'study_streak_day';

CREATE UNIQUE INDEX reward_events_study_streak_milestone_unique
    ON reward_events (user_id, community_id, post_id, reward_kind)
    WHERE reward_kind IN ('study_streak_milestone_7', 'study_streak_milestone_30');

CREATE INDEX reward_events_user_created_idx
    ON reward_events (user_id, created_at DESC);

CREATE INDEX reward_events_user_activity_date_idx
    ON reward_events (user_id, activity_date DESC);

CREATE INDEX reward_events_community_post_idx
    ON reward_events (community_id, post_id, activity_date DESC);
