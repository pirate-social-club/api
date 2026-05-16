ALTER TABLE verification_sessions
    ADD COLUMN IF NOT EXISTS provider_mode TEXT CHECK (
        provider_mode IS NULL OR provider_mode IN ('qr_deeplink', 'widget', 'native_sdk')
    );

UPDATE verification_sessions
SET provider_mode = CASE
    WHEN provider = 'self' THEN 'qr_deeplink'
    WHEN provider = 'very' THEN 'widget'
    ELSE provider_mode
END
WHERE provider_mode IS NULL;
