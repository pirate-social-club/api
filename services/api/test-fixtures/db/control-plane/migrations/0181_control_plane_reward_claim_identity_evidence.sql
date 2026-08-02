-- Shadow decisions for document-bound nationality resolution. Retryable rows
-- may advance until evidence resolves; resolved/terminal decisions are durable
-- snapshots. These rows reserve no budget, authorize no credit, and cannot
-- change qualification or campaign lifecycle state.

CREATE TABLE reward_claim_identity_evidence (
    reward_claim_identity_evidence_id TEXT PRIMARY KEY,
    reward_qualification_event_id TEXT NOT NULL UNIQUE
        REFERENCES reward_qualification_events(reward_qualification_event_id),
    reward_campaign_id TEXT NOT NULL
        REFERENCES reward_campaigns(reward_campaign_id),
    user_id TEXT NOT NULL REFERENCES users(user_id),
    reward_identity_binding_id TEXT
        REFERENCES reward_identity_bindings(reward_identity_binding_id),
    identity_nullifier_id TEXT REFERENCES identity_nullifiers(identity_nullifier_id),
    user_attestation_id TEXT REFERENCES user_attestations(user_attestation_id),
    provider TEXT NOT NULL CHECK (provider = 'self'),
    outcome TEXT NOT NULL CHECK (outcome IN (
        'resolved',
        'identity_document_not_selected',
        'nationality_evidence_missing',
        'identity_binding_mismatch',
        'identity_evidence_conflict'
    )),
    retryability TEXT NOT NULL CHECK (retryability IN ('resolved', 'retryable', 'terminal')),
    nationality TEXT CHECK (
        nationality IS NULL OR (length(nationality) = 3 AND nationality = upper(nationality))
    ),
    reward_identity_id TEXT,
    binding_selected_at TIMESTAMPTZ,
    evidence_verification_session_id TEXT,
    evidence_verified_at TIMESTAMPTZ,
    evaluated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT reward_claim_identity_evidence_resolved_shape_check CHECK (
        (outcome = 'resolved'
            AND retryability = 'resolved'
            AND reward_identity_binding_id IS NOT NULL
            AND identity_nullifier_id IS NOT NULL
            AND user_attestation_id IS NOT NULL
            AND nationality IS NOT NULL
            AND reward_identity_id IS NOT NULL
            AND binding_selected_at IS NOT NULL
            AND evidence_verified_at IS NOT NULL)
        OR
        (outcome <> 'resolved' AND retryability <> 'resolved'
            AND nationality IS NULL AND reward_identity_id IS NULL)
    )
);

CREATE INDEX idx_reward_claim_identity_evidence_campaign_outcome
    ON reward_claim_identity_evidence(reward_campaign_id, outcome, evaluated_at);
