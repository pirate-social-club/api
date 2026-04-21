ALTER TABLE users
    ALTER COLUMN verified_at TYPE TIMESTAMPTZ USING verified_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE wallet_attachments
    ALTER COLUMN attached_at TYPE TIMESTAMPTZ USING attached_at::timestamptz,
    ALTER COLUMN detached_at TYPE TIMESTAMPTZ USING detached_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE auth_provider_links
    ALTER COLUMN linked_at TYPE TIMESTAMPTZ USING linked_at::timestamptz,
    ALTER COLUMN revoked_at TYPE TIMESTAMPTZ USING revoked_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE verification_sessions
    ALTER COLUMN started_at TYPE TIMESTAMPTZ USING started_at::timestamptz,
    ALTER COLUMN completed_at TYPE TIMESTAMPTZ USING completed_at::timestamptz,
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE user_attestations
    ALTER COLUMN verified_at TYPE TIMESTAMPTZ USING verified_at::timestamptz,
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz,
    ALTER COLUMN revoked_at TYPE TIMESTAMPTZ USING revoked_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE global_handles
    ALTER COLUMN issued_at TYPE TIMESTAMPTZ USING issued_at::timestamptz,
    ALTER COLUMN replaced_at TYPE TIMESTAMPTZ USING replaced_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE profiles
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE communities
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz,
    ALTER COLUMN registry_published_at TYPE TIMESTAMPTZ USING registry_published_at::timestamptz;

ALTER TABLE community_database_bindings
    ALTER COLUMN transferred_at TYPE TIMESTAMPTZ USING transferred_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE community_db_credentials
    ALTER COLUMN issued_at TYPE TIMESTAMPTZ USING issued_at::timestamptz,
    ALTER COLUMN invalidated_at TYPE TIMESTAMPTZ USING invalidated_at::timestamptz,
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE community_post_projections
    ALTER COLUMN source_created_at TYPE TIMESTAMPTZ USING source_created_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE community_membership_projections
    ALTER COLUMN source_updated_at TYPE TIMESTAMPTZ USING source_updated_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE scrobble_ingest_events
    ALTER COLUMN playback_started_at TYPE TIMESTAMPTZ USING playback_started_at::timestamptz,
    ALTER COLUMN accepted_at TYPE TIMESTAMPTZ USING accepted_at::timestamptz,
    ALTER COLUMN anchored_at TYPE TIMESTAMPTZ USING anchored_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE scrobble_anchor_batches
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN confirmed_at TYPE TIMESTAMPTZ USING confirmed_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE track_anchor_state
    ALTER COLUMN registered_at TYPE TIMESTAMPTZ USING registered_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE projection_outbox
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE jobs
    ALTER COLUMN available_at TYPE TIMESTAMPTZ USING available_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE audit_log
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

ALTER TABLE namespace_verification_sessions
    ALTER COLUMN challenge_expires_at TYPE TIMESTAMPTZ USING challenge_expires_at::timestamptz,
    ALTER COLUMN accepted_at TYPE TIMESTAMPTZ USING accepted_at::timestamptz,
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE namespace_verifications
    ALTER COLUMN accepted_at TYPE TIMESTAMPTZ USING accepted_at::timestamptz,
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE namespace_verification_evidence_bundles
    ALTER COLUMN observed_at TYPE TIMESTAMPTZ USING observed_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE namespace_verification_assertions
    ALTER COLUMN first_accepted_at TYPE TIMESTAMPTZ USING first_accepted_at::timestamptz,
    ALTER COLUMN last_revalidated_at TYPE TIMESTAMPTZ USING last_revalidated_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE namespace_verification_revalidation_events
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz;

ALTER TABLE community_registry_attempts
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE reddit_verification_sessions
    ALTER COLUMN last_checked_at TYPE TIMESTAMPTZ USING last_checked_at::timestamptz,
    ALTER COLUMN verified_at TYPE TIMESTAMPTZ USING verified_at::timestamptz,
    ALTER COLUMN expires_at TYPE TIMESTAMPTZ USING expires_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE external_reputation_snapshots
    ALTER COLUMN captured_at TYPE TIMESTAMPTZ USING captured_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE claim_market_bindings
    ALTER COLUMN snapshot_at TYPE TIMESTAMPTZ USING snapshot_at::timestamptz,
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE community_money_policies
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE song_artifact_bundles
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE song_artifact_uploads
    ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at::timestamptz,
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;

ALTER TABLE community_pricing_policies
    ALTER COLUMN updated_at TYPE TIMESTAMPTZ USING updated_at::timestamptz;
