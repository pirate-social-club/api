ALTER TABLE users
    ALTER COLUMN verification_capabilities_json TYPE JSONB
    USING verification_capabilities_json::jsonb;

ALTER TABLE verification_sessions
    ALTER COLUMN requested_capabilities_json TYPE JSONB
    USING requested_capabilities_json::jsonb;

ALTER TABLE user_attestations
    ALTER COLUMN value_json TYPE JSONB
    USING value_json::jsonb;

ALTER TABLE community_money_policies
    ALTER COLUMN accepted_funding_assets_json TYPE JSONB
    USING accepted_funding_assets_json::jsonb;

ALTER TABLE community_money_policies
    ALTER COLUMN accepted_source_chains_json TYPE JSONB
    USING accepted_source_chains_json::jsonb;

ALTER TABLE community_money_policies
    ALTER COLUMN approved_route_providers_json TYPE JSONB
    USING approved_route_providers_json::jsonb;

ALTER TABLE community_money_policies
    ALTER COLUMN destination_settlement_chain_json TYPE JSONB
    USING destination_settlement_chain_json::jsonb;

ALTER TABLE community_post_projections
    ALTER COLUMN projected_payload_json TYPE JSONB
    USING projected_payload_json::jsonb;

ALTER TABLE community_membership_projections
    ALTER COLUMN role_summary_json TYPE JSONB
    USING role_summary_json::jsonb;

ALTER TABLE jobs
    ALTER COLUMN payload_json TYPE JSONB
    USING payload_json::jsonb;

ALTER TABLE audit_log
    ALTER COLUMN metadata_json TYPE JSONB
    USING metadata_json::jsonb;

ALTER TABLE projection_outbox
    ALTER COLUMN payload_json TYPE JSONB
    USING payload_json::jsonb;

ALTER TABLE external_reputation_snapshots
    ALTER COLUMN snapshot_payload_json TYPE JSONB
    USING snapshot_payload_json::jsonb;

ALTER TABLE community_pricing_policies
    ALTER COLUMN tiers_json TYPE JSONB
    USING tiers_json::jsonb;

ALTER TABLE community_pricing_policies
    ALTER COLUMN country_assignments_json TYPE JSONB
    USING country_assignments_json::jsonb;
