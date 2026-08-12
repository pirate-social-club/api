-- Make redundancy provenance explicit before any availability finding can
-- become enforcing. The original verifier-local observations remain valid
-- report evidence, but are classified so they cannot silently satisfy a
-- multi-vantage policy.

ALTER TABLE hns_root_redundancy_observations
    ADD COLUMN evidence_class TEXT CHECK (
        evidence_class IS NULL OR evidence_class IN (
            'local_single_vantage',
            'external_multi_vantage'
        )
    ),
    ADD COLUMN quorum_policy_version TEXT,
    ADD COLUMN independent_vantage_count INTEGER CHECK (
        independent_vantage_count IS NULL OR independent_vantage_count > 0
    ),
    ADD COLUMN independent_asn_count INTEGER CHECK (
        independent_asn_count IS NULL OR independent_asn_count > 0
    );

-- Existing successful observations came only from the verifier host. Recording
-- that known provenance is not synthesized evidence; it prevents those rows
-- from being mistaken for independent observations later.
UPDATE hns_root_redundancy_observations
SET evidence_class = 'local_single_vantage',
    independent_vantage_count = 1,
    independent_asn_count = 1
WHERE outcome = 'succeeded';

ALTER TABLE hns_root_redundancy_observations
    ADD CONSTRAINT hns_root_redundancy_observations_evidence_matches_outcome CHECK (
        (outcome = 'failed'
            AND evidence_class IS NULL
            AND quorum_policy_version IS NULL
            AND independent_vantage_count IS NULL
            AND independent_asn_count IS NULL)
        OR (outcome = 'succeeded'
            AND evidence_class IS NOT NULL
            AND independent_vantage_count IS NOT NULL
            AND independent_asn_count IS NOT NULL)
    ),
    ADD CONSTRAINT hns_root_redundancy_observations_multivantage_is_independent CHECK (
        evidence_class IS DISTINCT FROM 'external_multi_vantage'
        OR (quorum_policy_version IS NOT NULL
            AND independent_vantage_count >= 2
            AND independent_asn_count >= 2)
    );

CREATE UNIQUE INDEX idx_hns_root_redundancy_observations_id_root_outcome_evidence
    ON hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome,
        evidence_class
    );

-- One immutable record per external vantage participating in a successful
-- root-level finding. `measurement_ref` is the provider's audit handle; ASN is
-- retained because geographic variety inside one network is not an independent
-- failure domain.
CREATE TABLE hns_root_redundancy_vantage_observations (
    redundancy_vantage_observation_id TEXT PRIMARY KEY,
    redundancy_observation_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    redundancy_observation_outcome TEXT NOT NULL DEFAULT 'succeeded' CHECK (
        redundancy_observation_outcome = 'succeeded'
    ),
    redundancy_evidence_class TEXT NOT NULL DEFAULT 'external_multi_vantage' CHECK (
        redundancy_evidence_class = 'external_multi_vantage'
    ),
    provider TEXT NOT NULL,
    measurement_ref TEXT NOT NULL,
    vantage_id TEXT NOT NULL,
    vantage_asn INTEGER NOT NULL CHECK (vantage_asn > 0),
    vantage_region TEXT,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (
        redundancy_observation_id,
        normalized_root_label,
        redundancy_observation_outcome,
        redundancy_evidence_class
    ) REFERENCES hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome,
        evidence_class
    )
);

CREATE UNIQUE INDEX idx_hns_root_redundancy_vantage_unique
    ON hns_root_redundancy_vantage_observations(
        redundancy_observation_id,
        provider,
        vantage_id
    );

CREATE UNIQUE INDEX idx_hns_root_redundancy_vantage_id_observation_root
    ON hns_root_redundancy_vantage_observations(
        redundancy_vantage_observation_id,
        redundancy_observation_id,
        normalized_root_label
    );

CREATE INDEX idx_hns_root_redundancy_vantage_root
    ON hns_root_redundancy_vantage_observations(
        normalized_root_label,
        observed_at DESC
    );

-- Directed authority results stay append-only and retain protocol plus address:
-- UDP success must not be silently generalized to TCP, and a healthy address
-- must not conceal another advertised address that is unreachable.
CREATE TABLE hns_root_redundancy_vantage_authority_observations (
    redundancy_vantage_authority_observation_id TEXT PRIMARY KEY,
    redundancy_vantage_observation_id TEXT NOT NULL,
    redundancy_observation_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    nameserver TEXT NOT NULL,
    target_address TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('udp', 'tcp')),
    reachable INTEGER NOT NULL CHECK (reachable IN (0, 1)),
    authoritative INTEGER NOT NULL CHECK (authoritative IN (0, 1)),
    soa_serial TEXT,
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (
        redundancy_vantage_observation_id,
        redundancy_observation_id,
        normalized_root_label
    )
        REFERENCES hns_root_redundancy_vantage_observations(
            redundancy_vantage_observation_id,
            redundancy_observation_id,
            normalized_root_label
        ),
    CONSTRAINT hns_root_redundancy_vantage_authority_result_coherent CHECK (
        (reachable = 1
            AND authoritative = 1
            AND soa_serial IS NOT NULL
            AND failure_code IS NULL)
        OR (authoritative = 0
            AND soa_serial IS NULL
            AND failure_code IS NOT NULL)
    )
);

CREATE UNIQUE INDEX idx_hns_root_redundancy_vantage_authority_unique
    ON hns_root_redundancy_vantage_authority_observations(
        redundancy_vantage_observation_id,
        nameserver,
        target_address,
        transport
    );

ALTER TABLE hns_root_delegation_state
    DROP CONSTRAINT hns_root_delegation_state_redundancy_complete,
    ADD COLUMN authority_redundancy_evidence_class TEXT CHECK (
        authority_redundancy_evidence_class IS NULL
        OR authority_redundancy_evidence_class IN (
            'local_single_vantage',
            'external_multi_vantage'
        )
    );

UPDATE hns_root_delegation_state
SET authority_redundancy_evidence_class = 'local_single_vantage'
WHERE authority_redundancy_ok IS NOT NULL;

ALTER TABLE hns_root_delegation_state
    ADD CONSTRAINT hns_root_delegation_state_redundancy_complete CHECK (
        (authority_redundancy_ok IS NULL
            AND authority_redundancy_evidence_class IS NULL
            AND last_redundancy_observation_id IS NULL
            AND last_redundancy_observation_outcome IS NULL
            AND last_redundancy_observation_at IS NULL)
        OR (authority_redundancy_ok IS NOT NULL
            AND authority_redundancy_evidence_class IS NOT NULL
            AND last_redundancy_observation_id IS NOT NULL
            AND last_redundancy_observation_outcome = 'succeeded'
            AND last_redundancy_observation_at IS NOT NULL)
    ),
    ADD FOREIGN KEY (
        last_redundancy_observation_id,
        normalized_root_label,
        last_redundancy_observation_outcome,
        authority_redundancy_evidence_class
    ) REFERENCES hns_root_redundancy_observations(
        redundancy_observation_id,
        normalized_root_label,
        outcome,
        evidence_class
    );
