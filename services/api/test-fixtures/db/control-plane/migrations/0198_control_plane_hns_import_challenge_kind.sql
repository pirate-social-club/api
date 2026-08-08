ALTER TABLE namespace_verification_sessions
    DROP CONSTRAINT IF EXISTS namespace_verification_sessions_challenge_kind_check;

-- migration-safety: existing-table-check-reviewed: widens the accepted challenge kind; existing rows remain valid
ALTER TABLE namespace_verification_sessions
    ADD CONSTRAINT namespace_verification_sessions_challenge_kind_check
    CHECK (
        challenge_kind IS NULL OR challenge_kind IN ('dns_txt', 'hns_import', 'fabric_txt_publish')
    );
