-- Replace the paused reward-domain identity-evidence snapshot with the minimal,
-- versioned decision record approved by the reward nationality data policy.
-- The production evidence table was empty when collection was paused. The
-- migration removes any non-production shadow rows with the old
-- provenance-bearing table so environments converge without hand cleanup.

CREATE TABLE reward_nationality_decisions (
    reward_nationality_decision_id TEXT PRIMARY KEY,
    reward_qualification_event_id TEXT NOT NULL UNIQUE
        REFERENCES reward_qualification_events(reward_qualification_event_id),
    reward_campaign_id TEXT NOT NULL
        REFERENCES reward_campaigns(reward_campaign_id),
    user_id TEXT NOT NULL REFERENCES users(user_id),
    result_key TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN (
        'resolved_tier',
        'resolved_default',
        'identity_document_not_selected',
        'nationality_evidence_missing',
        'identity_binding_mismatch',
        'identity_evidence_conflict'
    )),
    retryability TEXT NOT NULL CHECK (retryability IN ('resolved', 'retryable', 'terminal')),
    campaign_terms_version INTEGER NOT NULL CHECK (campaign_terms_version > 0),
    evaluator_version TEXT NOT NULL CHECK (length(evaluator_version) > 0),
    evaluated_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT reward_nationality_decisions_result_shape_check CHECK (
        (outcome IN ('resolved_tier', 'resolved_default')
            AND retryability = 'resolved'
            AND result_key IS NOT NULL
            AND length(result_key) > 0)
        OR
        (outcome NOT IN ('resolved_tier', 'resolved_default')
            AND retryability <> 'resolved'
            AND result_key IS NULL)
    ),
    CONSTRAINT reward_nationality_decisions_expiry_check CHECK (expires_at > evaluated_at)
);

DROP TABLE reward_claim_identity_evidence;

CREATE INDEX idx_reward_nationality_decisions_expiry
    ON reward_nationality_decisions(expires_at, reward_nationality_decision_id);

CREATE INDEX idx_reward_nationality_decisions_campaign_outcome
    ON reward_nationality_decisions(reward_campaign_id, outcome, evaluated_at);
