ALTER TABLE verification_sessions
    ADD COLUMN verification_intent TEXT;

ALTER TABLE verification_sessions
    ADD COLUMN policy_id TEXT;
