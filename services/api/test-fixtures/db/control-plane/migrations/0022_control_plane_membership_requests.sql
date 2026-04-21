PRAGMA foreign_keys = ON;

CREATE TABLE community_membership_requests (
    membership_request_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    applicant_user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'approved', 'rejected', 'canceled', 'expired')
    ),
    note TEXT,
    reviewed_by_user_id TEXT,
    review_reason TEXT,
    resolved_at TEXT,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (applicant_user_id) REFERENCES users(user_id)
);

CREATE UNIQUE INDEX idx_community_membership_requests_pending
    ON community_membership_requests(community_id, applicant_user_id)
    WHERE status = 'pending';
