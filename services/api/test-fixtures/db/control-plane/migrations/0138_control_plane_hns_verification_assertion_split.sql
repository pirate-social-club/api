-- HNS verification assertion split (core specs/domain/hns-verification-flow.md):
-- record which owner-published evidence path proved root ownership, and the
-- post-provision authority-health outcome. Both are nullable: sessions created
-- before the split keep NULL and MUST NOT be backfilled or reinterpreted —
-- NULL means "legacy evidence, assertion provenance unknown".

ALTER TABLE namespace_verification_sessions
    ADD COLUMN ownership_source TEXT CHECK (
        ownership_source IS NULL OR ownership_source IN (
            'hns_parent_chain_txt',
            'owner_authoritative_dns_txt'
        )
    );

ALTER TABLE namespace_verification_sessions
    ADD COLUMN authority_health_verified INTEGER CHECK (
        authority_health_verified IS NULL OR authority_health_verified IN (0, 1)
    );

-- Health must also live on the accepted verification, not only the session:
-- pirate_web_routing_allowed / pirate_subdomain_issuance_allowed are derived
-- from it, and downstream readers (public-namespaces) join this table.
ALTER TABLE namespace_verifications
    ADD COLUMN ownership_source TEXT CHECK (
        ownership_source IS NULL OR ownership_source IN (
            'hns_parent_chain_txt',
            'owner_authoritative_dns_txt'
        )
    );

ALTER TABLE namespace_verifications
    ADD COLUMN authority_health_verified INTEGER CHECK (
        authority_health_verified IS NULL OR authority_health_verified IN (0, 1)
    );

-- ...and as a first-class assertion row alongside the others.
ALTER TABLE namespace_verification_assertions
    DROP CONSTRAINT IF EXISTS namespace_verification_assertions_assertion_name_check;

ALTER TABLE namespace_verification_assertions
    ADD CONSTRAINT namespace_verification_assertions_assertion_name_check CHECK (
        assertion_name IN (
            'root_exists',
            'root_control_verified',
            'expiry_horizon_sufficient',
            'routing_enabled',
            'pirate_dns_authority_verified',
            'authority_health_verified',
            'root_key_proof_verified',
            'fabric_publish_verified',
            'anchor_fresh_enough',
            'owner_signed_updates_verified'
        )
    );
