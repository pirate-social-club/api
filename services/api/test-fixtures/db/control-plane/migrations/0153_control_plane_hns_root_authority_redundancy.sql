-- Root-scoped authoritative-NS redundancy evidence and controlled rollout.
--
-- Redundancy is availability evidence, not DNSSEC security evidence. It may
-- withdraw routing under policy, but must never alter delegation_security.

CREATE TABLE hns_root_redundancy_observations (
    redundancy_observation_id TEXT PRIMARY KEY,
    normalized_root_label TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    provider TEXT NOT NULL,
    failure_code TEXT,
    observed_parent_ns_json JSONB,
    authority_redundancy_ok INTEGER CHECK (
        authority_redundancy_ok IS NULL OR authority_redundancy_ok IN (0, 1)
    ),
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT hns_root_redundancy_observations_result_matches_outcome CHECK (
        (outcome = 'failed'
            AND failure_code IS NOT NULL
            AND observed_parent_ns_json IS NULL
            AND authority_redundancy_ok IS NULL)
        OR (outcome = 'succeeded'
            AND failure_code IS NULL
            AND observed_parent_ns_json IS NOT NULL
            AND authority_redundancy_ok IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_hns_root_redundancy_observations_id_root_outcome
    ON hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome
    );

CREATE INDEX idx_hns_root_redundancy_observations_root
    ON hns_root_redundancy_observations(normalized_root_label, observed_at DESC);

-- One row per authority tested during a successful observation. Serial parity
-- is retained as evidence rather than collapsed into the root-level verdict.
CREATE TABLE hns_root_redundancy_authority_observations (
    redundancy_authority_observation_id TEXT PRIMARY KEY,
    redundancy_observation_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    redundancy_observation_outcome TEXT NOT NULL DEFAULT 'succeeded' CHECK (
        redundancy_observation_outcome = 'succeeded'
    ),
    nameserver TEXT NOT NULL,
    reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
    soa_serial TEXT,
    serial_in_sync INTEGER CHECK (
        serial_in_sync IS NULL OR serial_in_sync IN (0, 1)
    ),
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (
        redundancy_observation_id,
        normalized_root_label,
        redundancy_observation_outcome
    ) REFERENCES hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome
    ),
    CONSTRAINT hns_root_redundancy_authority_reachability_coherent CHECK (
        (reachable = 1
            AND soa_serial IS NOT NULL
            AND serial_in_sync IS NOT NULL
            AND failure_code IS NULL)
        OR (reachable = 0
            AND soa_serial IS NULL
            AND serial_in_sync IS NULL
            AND failure_code IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_hns_root_redundancy_authority_unique
    ON hns_root_redundancy_authority_observations(
        redundancy_observation_id,
        nameserver
    );

CREATE INDEX idx_hns_root_redundancy_authority_root
    ON hns_root_redundancy_authority_observations(
        normalized_root_label,
        nameserver
    );

ALTER TABLE hns_root_delegation_state
    ADD COLUMN authority_redundancy_ok INTEGER CHECK (
        authority_redundancy_ok IS NULL OR authority_redundancy_ok IN (0, 1)
    ),
    ADD COLUMN last_redundancy_observation_id TEXT,
    ADD COLUMN last_redundancy_observation_outcome TEXT CHECK (
        last_redundancy_observation_outcome IS NULL
        OR last_redundancy_observation_outcome = 'succeeded'
    ),
    ADD COLUMN last_redundancy_observation_at TIMESTAMPTZ,
    ADD COLUMN last_redundancy_observation_attempt_at TIMESTAMPTZ,
    ADD COLUMN canonical_routing_eligible INTEGER NOT NULL DEFAULT 0 CHECK (
        canonical_routing_eligible IN (0, 1)
    ),
    ADD COLUMN routing_hard_denied INTEGER NOT NULL DEFAULT 0 CHECK (
        routing_hard_denied IN (0, 1)
    ),
    ADD CONSTRAINT hns_root_delegation_state_redundancy_complete CHECK (
        (authority_redundancy_ok IS NULL
            AND last_redundancy_observation_id IS NULL
            AND last_redundancy_observation_outcome IS NULL
            AND last_redundancy_observation_at IS NULL)
        OR (authority_redundancy_ok IS NOT NULL
            AND last_redundancy_observation_id IS NOT NULL
            AND last_redundancy_observation_outcome = 'succeeded'
            AND last_redundancy_observation_at IS NOT NULL)
    ),
    ADD FOREIGN KEY (
        last_redundancy_observation_id,
        normalized_root_label,
        last_redundancy_observation_outcome
    ) REFERENCES hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome
    );

CREATE INDEX idx_hns_root_delegation_state_redundancy_due
    ON hns_root_delegation_state(
        (last_redundancy_observation_attempt_at IS NOT NULL),
        last_redundancy_observation_attempt_at
    );

CREATE INDEX idx_hns_root_delegation_state_rollout
    ON hns_root_delegation_state(
        routing_hard_denied,
        canonical_routing_eligible
    );
