-- Version shadow nationality decisions before their first evaluator change.
-- Existing rows were all produced by the original document-bound evaluator,
-- so this backfill labels rather than recomputes or rewrites any decision.

ALTER TABLE reward_claim_identity_evidence
    ADD COLUMN evaluator_version TEXT;

UPDATE reward_claim_identity_evidence
SET evaluator_version = 'nationality_binding_v1'
WHERE evaluator_version IS NULL;

ALTER TABLE reward_claim_identity_evidence
    ALTER COLUMN evaluator_version SET NOT NULL,
    ADD CONSTRAINT reward_claim_identity_evidence_evaluator_version_check
        CHECK (length(evaluator_version) > 0);
