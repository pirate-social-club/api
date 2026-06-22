-- Paid 1:1 video bookings — host-owned, cross-community data (control plane).
--
-- A hosts booking profile, availability schedule, and variable pricing are a
-- property of the HOST and are reused across every community they are bookable in,
-- so they live once in the control plane keyed by the hosts Pirate user_id.
-- The booking transactions themselves (holds, bookings, custody/settlement refs)
-- live in per-community D1 — see community-template migration 1101.
--
-- Host timezone is stored once on the profile (not per rule): pricing time-of-day
-- rules resolve against booking_profiles.host_timezone, matching the
-- @pirate/bookings-domain ResolveSlotsInput.hostTimezone contract.
-- Money is integer cents, fee is bps. See core/specs/domain/paid-bookings.md.

CREATE TABLE booking_profiles (
    host_user_id TEXT PRIMARY KEY,
    display_headline TEXT,
    bio TEXT,
    topics_json JSONB,                  -- list of topic/subject tags (plain text, no ratings)
    intro_video_ref TEXT,               -- optional intro video asset ref
    host_timezone TEXT NOT NULL,        -- IANA tz, pricing time-of-day resolves against this
    -- Every booking is paid (no free/trial sessions) — price must be positive.
    base_price_cents INTEGER NOT NULL CHECK (base_price_cents > 0),
    default_slot_duration_seconds INTEGER NOT NULL CHECK (default_slot_duration_seconds > 0),
    platform_fee_bps INTEGER NOT NULL DEFAULT 1000 CHECK (platform_fee_bps >= 0 AND platform_fee_bps <= 10000),
    is_published BOOLEAN NOT NULL DEFAULT false,   -- bookable via profile link when true
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (host_user_id) REFERENCES users(user_id)
);

CREATE INDEX idx_booking_profiles_published
    ON booking_profiles(is_published)
    WHERE is_published = true;

-- Recurring availability windows in the hosts local time (host_timezone on the profile).
CREATE TABLE booking_availability_rules (
    rule_id TEXT PRIMARY KEY,
    host_user_id TEXT NOT NULL,
    by_weekday_json JSONB NOT NULL,        -- array of 0=Sun..6=Sat (host-local)
    start_local TEXT NOT NULL,             -- "09:00" (host-local)
    end_local TEXT NOT NULL,               -- "17:00" (host-local)
    slot_duration_seconds INTEGER NOT NULL CHECK (slot_duration_seconds > 0),
    effective_from_utc TIMESTAMPTZ,
    effective_until_utc TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (host_user_id) REFERENCES booking_profiles(host_user_id)
);

CREATE INDEX idx_booking_availability_rules_host
    ON booking_availability_rules(host_user_id);

-- One-off overrides: block removes time from the recurring rules, open adds it.
CREATE TABLE booking_availability_exceptions (
    exception_id TEXT PRIMARY KEY,
    host_user_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('block', 'open')),
    start_utc TIMESTAMPTZ NOT NULL,
    end_utc TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (end_utc > start_utc),
    FOREIGN KEY (host_user_id) REFERENCES booking_profiles(host_user_id)
);

CREATE INDEX idx_booking_availability_exceptions_host
    ON booking_availability_exceptions(host_user_id, start_utc);

-- Variable pricing: any match_* column NULL means "wildcard". Rules are evaluated
-- FIRST-MATCH by @pirate/bookings-domain resolvePrice, the service loads them ordered
-- by `priority` DESC (then a stable tiebreak) before calling resolvePrice, so the
-- highest-priority matching rule wins. The domain does not itself rank specificity —
-- ordering is the services responsibility via `priority`. Time-of-day matches resolve
-- in the host timezone (booking_profiles.host_timezone).
CREATE TABLE booking_price_rules (
    price_rule_id TEXT PRIMARY KEY,
    host_user_id TEXT NOT NULL,
    match_weekday_json JSONB,              -- array of 0..6, or NULL
    match_local_start TEXT,                -- "18:00" (host-local), or NULL
    match_local_end TEXT,                  -- "20:00" (host-local), or NULL
    match_duration_seconds INTEGER CHECK (match_duration_seconds IS NULL OR match_duration_seconds > 0),
    price_cents INTEGER NOT NULL CHECK (price_cents > 0),   -- every booking is paid
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    FOREIGN KEY (host_user_id) REFERENCES booking_profiles(host_user_id)
);

CREATE INDEX idx_booking_price_rules_host
    ON booking_price_rules(host_user_id, priority DESC);

-- Cross-community double-booking guard. Holds and bookings live in per-community D1,
-- so their per-community unique indexes cannot see a conflict in a DIFFERENT community.
-- A host can only be in one 1:1 session at a time, so the authoritative "is this hosts
-- time taken anywhere" lock lives here in the control plane (host-owned, global).
--
-- IMPORTANT — the lock contract is INTERVAL OVERLAP, not exact start. Bookings can have
-- variable durations, so two different starts can still overlap (e.g. 10:00-11:00 in
-- community A vs 10:30-11:00 in community B). The same-start UNIQUE index below is ONLY a
-- cheap race backstop, it does NOT enforce the full contract on its own.
--
-- Service acquisition (enforced + tested in PR3 API), per host, inside ONE control-plane
-- transaction, BEFORE creating the per-community booking_hold:
--   1. SELECT pg_advisory_xact_lock(hashtextextended(host_user_id, 0)),  -- serialize per host
--   2. reject if an active lock for this host already overlaps the request:
--        WHERE status = active AND host_user_id = :host
--          AND slot_start_utc < :requested_end AND slot_end_utc > :requested_start
--   3. INSERT the lock row.
-- Release (status=released) on hold expiry, cancellation, or terminal completion.
-- The advisory lock makes step 2→3 atomic per host, closing the check-then-insert race.
-- (A Postgres EXCLUDE USING gist (host_user_id WITH =, tstzrange(start,end) WITH &&)
--  WHERE status=active would enforce overlap in-DB, but needs the btree_gist extension —
--  deferred to keep the control-plane extension surface minimal.)
-- community_id / hold_id / booking_id are traceability only (cross-DB → no FK).
CREATE TABLE booking_host_slot_locks (
    lock_id TEXT PRIMARY KEY,
    host_user_id TEXT NOT NULL,
    slot_start_utc TIMESTAMPTZ NOT NULL,
    slot_end_utc TIMESTAMPTZ NOT NULL,
    community_id TEXT NOT NULL,         -- where the lock was acquired (no FK, cross-DB)
    hold_id TEXT,                       -- per-community booking_holds.hold_id (no FK)
    booking_id TEXT,                    -- per-community bookings.booking_id (no FK)
    status TEXT NOT NULL CHECK (status IN ('active', 'released')),
    expires_at_utc TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    CHECK (slot_end_utc > slot_start_utc),
    FOREIGN KEY (host_user_id) REFERENCES booking_profiles(host_user_id)
);

-- Same-start race backstop only (NOT the full overlap contract — see comment above):
-- at most ONE active lock per (host, exact slot start) across all communities.
CREATE UNIQUE INDEX idx_booking_host_slot_locks_active_start
    ON booking_host_slot_locks(host_user_id, slot_start_utc)
    WHERE status = 'active';

-- Supports the interval-overlap scan in service step 2 (active locks for a host by start).
CREATE INDEX idx_booking_host_slot_locks_overlap
    ON booking_host_slot_locks(host_user_id, slot_start_utc, slot_end_utc)
    WHERE status = 'active';

CREATE INDEX idx_booking_host_slot_locks_expiry
    ON booking_host_slot_locks(status, expires_at_utc);
