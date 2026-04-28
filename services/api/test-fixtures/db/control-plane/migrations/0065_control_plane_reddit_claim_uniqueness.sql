CREATE UNIQUE INDEX IF NOT EXISTS idx_global_handles_reddit_claim_label
    ON global_handles(label_normalized)
    WHERE issuance_source = 'reddit_verified_claim';

CREATE UNIQUE INDEX IF NOT EXISTS idx_global_handles_reddit_claim_user
    ON global_handles(user_id)
    WHERE issuance_source = 'reddit_verified_claim';
