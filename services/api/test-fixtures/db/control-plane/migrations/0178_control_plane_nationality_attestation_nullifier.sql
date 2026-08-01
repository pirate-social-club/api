-- Bind nationality evidence to the exact document/nullifier that produced it.
-- Existing attestations remain unbound until a separately reviewed classifier
-- can prove their provenance; this migration deliberately performs no backfill.

ALTER TABLE user_attestations
    ADD COLUMN source_identity_nullifier_id TEXT
        REFERENCES identity_nullifiers(identity_nullifier_id);

CREATE INDEX idx_user_attestations_source_identity_nullifier
    ON user_attestations(source_identity_nullifier_id)
    WHERE source_identity_nullifier_id IS NOT NULL;
