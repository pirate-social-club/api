ALTER TABLE namespace_verifications
    DROP CONSTRAINT IF EXISTS namespace_verifications_spaces_root_label_ascii_check;

ALTER TABLE namespace_verifications
    ADD CONSTRAINT namespace_verifications_spaces_root_label_ascii_check
    CHECK (
        family <> 'spaces'
        OR normalized_root_label ~ '^[a-z0-9-]+$'
    );
