CREATE TABLE rights_review_cases (
    rights_review_case_id TEXT PRIMARY KEY,
    subject_type TEXT NOT NULL CHECK (
        subject_type IN ('asset', 'live_room', 'replay_asset')
    ),
    subject_id TEXT NOT NULL,
    community_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('open', 'under_review', 'resolved', 'blocked')
    ),
    trigger_source TEXT NOT NULL CHECK (
        trigger_source IN ('acrcloud_match', 'manual_report', 'operator_escalation')
    ),
    analysis_result_ref TEXT,
    submitted_evidence_refs_json TEXT,
    resolution TEXT CHECK (
        resolution IS NULL OR resolution IN ('clear', 'clear_with_upstream_refs', 'block', 'needs_more_evidence')
    ),
    resolver_user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_rights_review_cases_subject_status
    ON rights_review_cases(subject_type, subject_id, status, created_at DESC);

CREATE INDEX idx_rights_review_cases_community_status
    ON rights_review_cases(community_id, status, created_at DESC);
