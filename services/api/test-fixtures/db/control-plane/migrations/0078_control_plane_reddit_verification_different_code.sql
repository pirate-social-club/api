ALTER TABLE reddit_verification_sessions
    DROP CONSTRAINT IF EXISTS reddit_verification_sessions_failure_code_check;

ALTER TABLE reddit_verification_sessions
    ADD CONSTRAINT reddit_verification_sessions_failure_code_check CHECK (
        failure_code IS NULL OR failure_code IN ('code_not_found', 'different_code_found', 'username_not_found', 'rate_limited', 'source_error')
    );
