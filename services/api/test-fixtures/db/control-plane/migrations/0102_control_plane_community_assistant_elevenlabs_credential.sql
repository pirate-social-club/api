ALTER TABLE community_assistant_credentials
    DROP CONSTRAINT IF EXISTS community_assistant_credentials_provider_check;

ALTER TABLE community_assistant_credentials
    ADD CONSTRAINT community_assistant_credentials_provider_check
    CHECK (provider IN ('openrouter', 'elevenlabs'));
