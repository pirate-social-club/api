ALTER TABLE verification_sessions
    DROP CONSTRAINT IF EXISTS verification_sessions_provider_mode_check;

ALTER TABLE verification_sessions
    ADD CONSTRAINT verification_sessions_provider_mode_check CHECK (
        provider_mode IS NULL OR provider_mode IN ('qr_deeplink', 'widget', 'native_sdk', 'web_sdk')
    );

ALTER TABLE identity_nullifiers
    DROP CONSTRAINT IF EXISTS identity_nullifiers_provider_check;

ALTER TABLE identity_nullifiers
    ADD CONSTRAINT identity_nullifiers_provider_check CHECK (
        provider IN ('self', 'very', 'zkpassport')
    );

ALTER TABLE identity_nullifiers
    DROP CONSTRAINT IF EXISTS identity_nullifiers_mechanism_check;

ALTER TABLE identity_nullifiers
    ADD CONSTRAINT identity_nullifiers_mechanism_check CHECK (
        mechanism IN ('zk-nullifier', 'palm-nullifier', 'zkpassport-unique-identifier')
    );
