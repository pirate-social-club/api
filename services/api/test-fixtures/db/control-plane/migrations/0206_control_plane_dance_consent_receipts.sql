-- Versioned recording consent is persisted on the session before upload
-- authorization. Existing dark-pilot rows remain explicitly unconsented.

ALTER TABLE dance_attempt_sessions
    ADD COLUMN consent_policy_version TEXT,
    ADD COLUMN consented_at TIMESTAMPTZ,
    ADD COLUMN consent_source TEXT;

-- migration-safety: existing-table-check-reviewed: existing rows satisfy the all-null branch; new receipts must be complete and bounded
ALTER TABLE dance_attempt_sessions
    ADD CONSTRAINT dance_attempt_session_consent_receipt_check CHECK (
      (
        consent_policy_version IS NULL
        AND consented_at IS NULL
        AND consent_source IS NULL
      )
      OR (
        consent_policy_version = 'dance_recording_v1'
        AND consented_at IS NOT NULL
        AND consent_source IN ('api', 'telegram', 'ios', 'android')
      )
    );
