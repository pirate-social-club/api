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
