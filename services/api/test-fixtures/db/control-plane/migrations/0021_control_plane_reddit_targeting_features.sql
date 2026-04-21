CREATE TABLE user_reddit_subreddit_affinities (
    affinity_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_snapshot_id TEXT NOT NULL,
    subreddit TEXT NOT NULL,
    post_count INTEGER NOT NULL,
    comment_count INTEGER NOT NULL,
    post_score INTEGER NOT NULL,
    comment_score INTEGER NOT NULL,
    total_score INTEGER NOT NULL,
    first_seen_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ,
    weight DOUBLE PRECISION NOT NULL,
    feature_version TEXT NOT NULL,
    derived_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (source_snapshot_id) REFERENCES external_reputation_snapshots(external_reputation_snapshot_id),
    UNIQUE (user_id, source_snapshot_id, subreddit)
);

CREATE INDEX idx_user_reddit_subreddit_affinities_user_score
    ON user_reddit_subreddit_affinities(user_id, total_score DESC, subreddit);

CREATE INDEX idx_user_reddit_subreddit_affinities_snapshot
    ON user_reddit_subreddit_affinities(source_snapshot_id, total_score DESC);

CREATE TABLE user_interest_tags (
    interest_tag_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_snapshot_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    source TEXT NOT NULL CHECK (
        source IN ('taxonomy', 'llm')
    ),
    confidence DOUBLE PRECISION NOT NULL,
    weight DOUBLE PRECISION NOT NULL,
    evidence_json JSONB,
    feature_version TEXT NOT NULL,
    derived_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (source_snapshot_id) REFERENCES external_reputation_snapshots(external_reputation_snapshot_id),
    UNIQUE (user_id, source_snapshot_id, tag, source)
);

CREATE INDEX idx_user_interest_tags_user_tag
    ON user_interest_tags(user_id, tag, confidence DESC);

CREATE INDEX idx_user_interest_tags_snapshot
    ON user_interest_tags(source_snapshot_id, source, confidence DESC);

CREATE TABLE user_audience_segments (
    audience_segment_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_snapshot_id TEXT NOT NULL,
    segment_key TEXT NOT NULL,
    source TEXT NOT NULL CHECK (
        source IN ('deterministic', 'llm', 'hybrid')
    ),
    confidence DOUBLE PRECISION NOT NULL,
    eligibility_state TEXT NOT NULL CHECK (
        eligibility_state IN ('eligible', 'ineligible', 'suppressed')
    ),
    evidence_json JSONB,
    derivation_version TEXT NOT NULL,
    derived_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (source_snapshot_id) REFERENCES external_reputation_snapshots(external_reputation_snapshot_id),
    UNIQUE (user_id, source_snapshot_id, segment_key, source)
);

CREATE INDEX idx_user_audience_segments_segment
    ON user_audience_segments(segment_key, eligibility_state, confidence DESC);

CREATE INDEX idx_user_audience_segments_user
    ON user_audience_segments(user_id, segment_key, confidence DESC);

CREATE TABLE user_reddit_feature_profiles (
    feature_profile_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_snapshot_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (
        source IN ('llm')
    ),
    profile_json JSONB NOT NULL,
    confidence DOUBLE PRECISION NOT NULL,
    feature_version TEXT NOT NULL,
    derived_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(user_id),
    FOREIGN KEY (source_snapshot_id) REFERENCES external_reputation_snapshots(external_reputation_snapshot_id),
    UNIQUE (user_id, source_snapshot_id, source, feature_version)
);

CREATE INDEX idx_user_reddit_feature_profiles_user
    ON user_reddit_feature_profiles(user_id, derived_at DESC);
