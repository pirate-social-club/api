CREATE TABLE media_analysis_results (
    media_analysis_result_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    source_post_id TEXT,
    source_asset_id TEXT,
    outcome TEXT NOT NULL CHECK (
        outcome IN ('pending', 'allow', 'allow_with_required_reference', 'review_required', 'blocked')
    ),
    content_safety_state TEXT NOT NULL CHECK (
        content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
    ),
    age_gate_policy TEXT NOT NULL CHECK (
        age_gate_policy IN ('none', '18_plus')
    ),
    trigger_sources_json TEXT,
    acrcloud_music_match_json TEXT,
    acrcloud_custom_match_json TEXT,
    acrcloud_error_code TEXT,
    acrcloud_error_message TEXT,
    acrcloud_checked_at TEXT,
    safety_signals_json TEXT,
    authenticity_signals_json TEXT,
    policy_reason_code TEXT,
    policy_reason TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (source_post_id) REFERENCES posts(post_id),
    FOREIGN KEY (source_asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX idx_media_analysis_results_post
    ON media_analysis_results(source_post_id, created_at DESC);

CREATE INDEX idx_media_analysis_results_asset
    ON media_analysis_results(source_asset_id, created_at DESC);
