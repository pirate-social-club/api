ALTER TABLE verification_sessions
    ADD COLUMN verification_requirements_json JSONB NOT NULL DEFAULT '[]'::jsonb;
