-- HNS DS delegation lifecycle, root-scoped state (core specs/domain/hns-ds-delegation-lifecycle.md).
--
-- Scope rule, and the reason these are new tables rather than columns on the
-- existing verification tables: the DS lifecycle belongs to the canonical root.
-- A root has one authoritative zone and one keyset. Every existing namespace
-- verification table is session- or verification-scoped, so persisting DS state
-- there would give each attaching community its own copy of one root's security
-- lifecycle -- the per-community lifecycle the spec says never exists,
-- reintroduced through storage.
--
-- Authority rule: these tables are the ONLY authority for DNSSEC delegation
-- state. namespace_verification_assertions retains ownership and attachment
-- facts and MUST NOT carry parent_ds_matches_live_dnskey or
-- authoritative_dnssec_valid rows; a read-time adapter may project root state
-- into the existing API response shape, but must never write it back.
--
-- Absent rule: secure_delegation_verified has no column here, deliberately.
-- It is derived (parent_ds_matches_live_dnskey AND authoritative_dnssec_valid
-- AND observation_fresh), it changes with the clock and no write, and a durably
-- stored true would recreate exactly the stale-security problem the freshness
-- predicate exists to prevent. It is not storable, so it cannot drift.

-- Every keyset Pirate has ever provisioned for the root. Append-only:
-- retirement is recorded by setting retired_at, never by deleting the row.
CREATE TABLE hns_root_issued_keysets (
    issued_keyset_id TEXT PRIMARY KEY,
    normalized_root_label TEXT NOT NULL,
    activated_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_hns_root_issued_keysets_root
    ON hns_root_issued_keysets(normalized_root_label, activated_at DESC);

-- Composite target: children reference (id, root) so a child can never name a
-- different root than the keyset it belongs to.
CREATE UNIQUE INDEX idx_hns_root_issued_keysets_id_root
    ON hns_root_issued_keysets(issued_keyset_id, normalized_root_label);

-- The DNSKEYs making up a keyset. is_ksk marks the key DS is derived from.
CREATE TABLE hns_root_zone_dnskeys (
    zone_dnskey_id TEXT PRIMARY KEY,
    issued_keyset_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    key_tag INTEGER NOT NULL,
    algorithm INTEGER NOT NULL,
    flags INTEGER NOT NULL,
    public_key TEXT NOT NULL,
    is_ksk INTEGER NOT NULL CHECK (is_ksk IN (0, 1)),
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (issued_keyset_id, normalized_root_label)
        REFERENCES hns_root_issued_keysets(issued_keyset_id, normalized_root_label)
);

CREATE INDEX idx_hns_root_zone_dnskeys_keyset
    ON hns_root_zone_dnskeys(issued_keyset_id);

CREATE INDEX idx_hns_root_zone_dnskeys_root_tag
    ON hns_root_zone_dnskeys(normalized_root_label, key_tag);

-- Every DS value Pirate has ever derived and asked an owner to publish, linked
-- to the keyset it came from. Append-only, and retained until no parent DS
-- corresponds to any entry: after a zone rebuild this history is the only way
-- to tell a stranded Pirate-issued anchor from an unrelated record.
CREATE TABLE hns_root_issued_ds (
    issued_ds_id TEXT PRIMARY KEY,
    issued_keyset_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    key_tag INTEGER NOT NULL,
    algorithm INTEGER NOT NULL,
    digest_type INTEGER NOT NULL,
    digest TEXT NOT NULL,
    derived_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (issued_keyset_id, normalized_root_label)
        REFERENCES hns_root_issued_keysets(issued_keyset_id, normalized_root_label)
);

CREATE UNIQUE INDEX idx_hns_root_issued_ds_id_root
    ON hns_root_issued_ds(issued_ds_id, normalized_root_label);

CREATE UNIQUE INDEX idx_hns_root_issued_ds_unique
    ON hns_root_issued_ds(normalized_root_label, key_tag, algorithm, digest_type, digest);

CREATE INDEX idx_hns_root_issued_ds_keyset
    ON hns_root_issued_ds(issued_keyset_id);

-- Append-only log of every attempt to read the Handshake parent, successful or
-- not. A failed observation is recorded here as an outage; it must not be
-- reinterpreted as a security result, and must not overwrite the last finding.
CREATE TABLE hns_root_parent_observations (
    parent_observation_id TEXT PRIMARY KEY,
    normalized_root_label TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    provider TEXT NOT NULL,
    failure_code TEXT,
    -- The NORMALIZED finding: `drifted` vs `unsecured` is decided by the
    -- observer against this root's observation history before insert, so no
    -- reader has to re-derive it from a neighbouring row. `pending` never
    -- appears here -- it is a claim about an owner action, not an observation.
    observed_delegation_security TEXT CHECK (
        observed_delegation_security IS NULL OR observed_delegation_security IN (
            'unknown',
            'unsecured',
            'secure',
            'bogus',
            'drifted'
        )
    ),
    parent_ds_matches_live_dnskey INTEGER CHECK (
        parent_ds_matches_live_dnskey IS NULL OR parent_ds_matches_live_dnskey IN (0, 1)
    ),
    authoritative_dnssec_valid INTEGER CHECK (
        authoritative_dnssec_valid IS NULL OR authoritative_dnssec_valid IN (0, 1)
    ),
    earliest_rrsig_expires_at TIMESTAMPTZ,
    raw_response_json JSONB,
    evidence_hash TEXT,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    -- A failed observation carries no security finding, and a successful one
    -- must carry a complete finding. Without this, an outage row could be read
    -- back as a security result -- the exact conflation the spec forbids.
    CONSTRAINT hns_root_parent_observations_findings_match_outcome CHECK (
        (outcome = 'failed'
            AND observed_delegation_security IS NULL
            AND parent_ds_matches_live_dnskey IS NULL
            AND authoritative_dnssec_valid IS NULL)
        OR (outcome = 'succeeded'
            AND observed_delegation_security IS NOT NULL
            AND parent_ds_matches_live_dnskey IS NOT NULL
            AND authoritative_dnssec_valid IS NOT NULL)
    ),
    CONSTRAINT hns_root_parent_observations_failure_code_matches_outcome CHECK (
        (outcome = 'failed' AND failure_code IS NOT NULL)
        OR (outcome = 'succeeded' AND failure_code IS NULL)
    ),
    -- A successful observation reporting `secure` must agree with its own
    -- components, mirroring the evaluator's coherence rule at the storage layer.
    CONSTRAINT hns_root_parent_observations_secure_is_coherent CHECK (
        observed_delegation_security IS DISTINCT FROM 'secure'
        OR (parent_ds_matches_live_dnskey = 1
            AND authoritative_dnssec_valid = 1
            -- Authenticated resolution requires temporal validity, so storage
            -- must not call an observation `secure` without expiry evidence the
            -- evaluator would then correctly refuse to route on.
            AND earliest_rrsig_expires_at IS NOT NULL)
    )
);

-- Composite targets so child rows cannot name a different root than the
-- observation they belong to. The second carries `outcome` as well, so the
-- state row's FK can require a *successful* observation: a partial unique index
-- cannot be an FK target, so the discriminator travels in the key instead.
CREATE UNIQUE INDEX idx_hns_root_parent_observations_id_root
    ON hns_root_parent_observations(parent_observation_id, normalized_root_label);

CREATE UNIQUE INDEX idx_hns_root_parent_observations_id_root_outcome
    ON hns_root_parent_observations(parent_observation_id, normalized_root_label, outcome);

CREATE INDEX idx_hns_root_parent_observations_root
    ON hns_root_parent_observations(normalized_root_label, observed_at DESC);

CREATE INDEX idx_hns_root_parent_observations_outcome
    ON hns_root_parent_observations(normalized_root_label, outcome, observed_at DESC);

-- Per-DS classification, one row per DS record seen in the parent for a given
-- observation. Kept normalized rather than embedded in the state row so each
-- classification stays individually auditable over time.
--
-- 'orphaned' means the DS is Pirate-issued (it matches hns_root_issued_ds) but
-- anchors no live key. 'unverifiable' means we could not classify it -- an
-- unknown digest type, or no issuance history to compare against.
CREATE TABLE hns_root_observed_ds (
    observed_ds_id TEXT PRIMARY KEY,
    parent_observation_id TEXT NOT NULL,
    normalized_root_label TEXT NOT NULL,
    key_tag INTEGER NOT NULL,
    algorithm INTEGER NOT NULL,
    digest_type INTEGER NOT NULL,
    digest TEXT NOT NULL,
    classification TEXT NOT NULL CHECK (
        classification IN ('matching', 'orphaned', 'unverifiable')
    ),
    matched_issued_ds_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (parent_observation_id, normalized_root_label)
        REFERENCES hns_root_parent_observations(parent_observation_id, normalized_root_label),
    FOREIGN KEY (matched_issued_ds_id, normalized_root_label)
        REFERENCES hns_root_issued_ds(issued_ds_id, normalized_root_label),
    -- `matching` and `orphaned` both mean "this is a Pirate-issued DS", so both
    -- must name the issuance row that justifies the claim. `unverifiable` means
    -- we could not classify it, so it must not name one.
    CONSTRAINT hns_root_observed_ds_match_requires_issuance CHECK (
        (classification IN ('matching', 'orphaned') AND matched_issued_ds_id IS NOT NULL)
        OR (classification = 'unverifiable' AND matched_issued_ds_id IS NULL)
    )
);

CREATE INDEX idx_hns_root_observed_ds_observation
    ON hns_root_observed_ds(parent_observation_id);

CREATE INDEX idx_hns_root_observed_ds_root_classification
    ON hns_root_observed_ds(normalized_root_label, classification);

-- Current state, one row per root.
--
-- This table deliberately holds NO security findings. It carries a pointer to
-- the latest successful observation and the state that genuinely belongs to the
-- root (rollover progress, keysets, pending-action evidence); readers join the
-- referenced observation for delegation_security, the two component booleans,
-- the observation timestamp, the provider, and RRSIG expiry.
--
-- Copying those fields here -- even guarded by CHECKs and written in one
-- transaction -- would let a row reference a stale or unsecured observation
-- while supplying a fresh timestamp and secure values of its own. Every one of
-- those fields controls routing, so a forgeable copy is a routing bypass. There
-- is no copy to forge.
--
-- delegation_security is likewise absent. It is derived at read time from the
-- referenced observation plus pending-action evidence: `pending` is a claim we
-- assert about an owner action in flight, not something observed, so it cannot
-- live in the observation row either.
CREATE TABLE hns_root_delegation_state (
    normalized_root_label TEXT PRIMARY KEY,
    rollover_state TEXT NOT NULL CHECK (
        rollover_state IN (
            'none',
            'required',
            'new_key_prepublished',
            'new_ds_pending',
            'overlap',
            'old_ds_removal_pending'
        )
    ),
    -- expected_ds is a versioned snapshot, valid only while this keyset is
    -- live: the DS rows are hns_root_issued_ds for expected_keyset_id. A
    -- snapshot whose keyset is no longer published is stale by definition and
    -- must be re-derived, never served.
    expected_keyset_id TEXT,
    expected_ds_derived_at TIMESTAMPTZ,
    -- The keyset a rollover is moving to, if any.
    pending_keyset_id TEXT,
    -- Evidence backing a `pending` reading: a wallet-submitted Handshake txid,
    -- a mempool observation of it, or an explicit user acknowledgement.
    -- `pending` without evidence is optimism, not state, so the derivation
    -- keys off the presence of these fields.
    pending_evidence_kind TEXT CHECK (
        pending_evidence_kind IS NULL OR pending_evidence_kind IN (
            'wallet_transaction_id',
            'mempool_observation',
            'user_acknowledgement'
        )
    ),
    pending_evidence_ref TEXT,
    pending_evidence_at TIMESTAMPTZ,
    -- The latest SUCCESSFUL observation. Findings and timestamps are read from
    -- it, never duplicated here.
    last_parent_observation_id TEXT,
    -- Constraint carrier only: pinned to 'succeeded' so the composite FK below
    -- cannot resolve to a failed observation. Never read as data.
    last_parent_observation_outcome TEXT CHECK (
        last_parent_observation_outcome IS NULL OR last_parent_observation_outcome = 'succeeded'
    ),
    -- Distinct from the observation's observed_at: an outage updates this
    -- without refreshing freshness, so a run of failures is visible as such.
    -- It is not an input to freshness, which reads the referenced observation.
    last_parent_observation_attempt_at TIMESTAMPTZ,
    -- So drift duration is measurable.
    state_changed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (expected_keyset_id, normalized_root_label)
        REFERENCES hns_root_issued_keysets(issued_keyset_id, normalized_root_label),
    FOREIGN KEY (pending_keyset_id, normalized_root_label)
        REFERENCES hns_root_issued_keysets(issued_keyset_id, normalized_root_label),
    FOREIGN KEY (last_parent_observation_id, normalized_root_label, last_parent_observation_outcome)
        REFERENCES hns_root_parent_observations(parent_observation_id, normalized_root_label, outcome),
    -- Bidirectional: evidence fields are all present or all absent. A ref or
    -- timestamp without a kind is an unreadable half-write.
    CONSTRAINT hns_root_delegation_state_pending_evidence_complete CHECK (
        (pending_evidence_kind IS NULL
            AND pending_evidence_ref IS NULL
            AND pending_evidence_at IS NULL)
        OR (pending_evidence_kind IS NOT NULL
            AND pending_evidence_ref IS NOT NULL
            AND pending_evidence_at IS NOT NULL)
    ),
    CONSTRAINT hns_root_delegation_state_last_observation_complete CHECK (
        (last_parent_observation_id IS NULL AND last_parent_observation_outcome IS NULL)
        OR (last_parent_observation_id IS NOT NULL AND last_parent_observation_outcome IS NOT NULL)
    )
);

-- The scheduled observer's work queue: roots never observed sort first.
-- The boolean expression sorts false (NULL timestamps) before true without
-- PostgreSQL's non-portable NULLS FIRST index syntax.
CREATE INDEX idx_hns_root_delegation_state_observation_due
    ON hns_root_delegation_state(
        (last_parent_observation_attempt_at IS NOT NULL),
        last_parent_observation_attempt_at
    );

CREATE INDEX idx_hns_root_delegation_state_last_observation
    ON hns_root_delegation_state(last_parent_observation_id);

CREATE INDEX idx_hns_root_delegation_state_rollover
    ON hns_root_delegation_state(rollover_state)
    WHERE rollover_state <> 'none';
