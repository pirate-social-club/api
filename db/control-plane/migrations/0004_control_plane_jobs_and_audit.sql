PRAGMA foreign_keys = ON;

CREATE TABLE jobs (
    job_id TEXT PRIMARY KEY,
    job_type TEXT NOT NULL,
    job_scope TEXT NOT NULL CHECK (
        job_scope IN ('platform', 'community')
    ),
    community_id TEXT,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'running', 'succeeded', 'failed')
    ),
    payload_json TEXT,
    result_ref TEXT,
    error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_jobs_status_available
    ON jobs(status, available_at);

CREATE INDEX idx_jobs_subject
    ON jobs(subject_type, subject_id);

CREATE INDEX idx_jobs_club_status
    ON jobs(community_id, status);

CREATE TABLE audit_log (
    audit_event_id TEXT PRIMARY KEY,
    actor_type TEXT NOT NULL CHECK (
        actor_type IN ('user', 'worker', 'system', 'operator')
    ),
    actor_id TEXT,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    community_id TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_audit_log_actor
    ON audit_log(actor_id, created_at DESC);

CREATE INDEX idx_audit_log_target
    ON audit_log(target_type, target_id, created_at DESC);

CREATE INDEX idx_audit_log_club
    ON audit_log(community_id, created_at DESC);
