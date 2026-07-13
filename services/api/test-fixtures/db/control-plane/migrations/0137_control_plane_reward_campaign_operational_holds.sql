-- Durable reward-campaign operational holds and their incident audit trail.
ALTER TABLE reward_campaigns DROP CONSTRAINT reward_campaigns_status_check;
ALTER TABLE reward_campaigns ADD CONSTRAINT reward_campaigns_status_check CHECK (status IN (
    'draft', 'funding_quoted', 'funding_confirming', 'scheduled', 'active', 'paused',
    'operational_hold', 'exhausted', 'ended', 'canceled'
));

ALTER TABLE reward_campaigns ADD COLUMN status_before_operational_hold TEXT
    CHECK (status_before_operational_hold IN ('scheduled', 'active', 'paused'));
ALTER TABLE reward_campaigns ADD COLUMN operational_hold_reason TEXT;
ALTER TABLE reward_campaigns ADD COLUMN operational_held_at TIMESTAMPTZ;
ALTER TABLE reward_campaigns ADD COLUMN operational_held_by TEXT;
ALTER TABLE reward_campaigns ADD COLUMN operational_recovered_at TIMESTAMPTZ;
ALTER TABLE reward_campaigns ADD COLUMN operational_recovered_by TEXT;
ALTER TABLE reward_campaigns ADD CONSTRAINT reward_campaigns_operational_hold_shape CHECK (
    (status = 'operational_hold' AND status_before_operational_hold IS NOT NULL
      AND operational_hold_reason IS NOT NULL AND operational_held_at IS NOT NULL
      AND operational_held_by IS NOT NULL)
    OR status <> 'operational_hold'
);

-- Nullable intentionally: confirmed rows predating this migration have unknown provenance and
-- must be surfaced by the monitor rather than invented or silently treated as monitored.
ALTER TABLE reward_campaign_funding_effects ADD COLUMN confirmed_block_number BIGINT;
ALTER TABLE reward_campaign_funding_effects ADD COLUMN confirmed_block_hash TEXT;

DROP INDEX reward_campaigns_one_live_per_song_post;
CREATE UNIQUE INDEX reward_campaigns_one_live_per_song_post
    ON reward_campaigns (community_id, post_id)
    WHERE status IN ('scheduled', 'active', 'paused', 'operational_hold');

CREATE TABLE reward_campaign_incidents (
    reward_campaign_incident_id TEXT PRIMARY KEY,
    reward_campaign_id TEXT NOT NULL REFERENCES reward_campaigns(reward_campaign_id),
    incident_kind TEXT NOT NULL CHECK (incident_kind IN (
        'accounting_mismatch', 'funding_finality_failure', 'funding_provenance_missing'
    )),
    reason TEXT NOT NULL,
    details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK (occurrence_count > 0),
    alert_owner TEXT NOT NULL CHECK (length(trim(alert_owner)) > 0),
    alert_destination TEXT NOT NULL CHECK (length(trim(alert_destination)) > 0),
    alerted_at TIMESTAMPTZ,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    resolved_at TIMESTAMPTZ,
    resolved_by TEXT,
    resolution_note TEXT,
    incident_version INTEGER NOT NULL DEFAULT 1 CHECK (incident_version > 0)
);
CREATE UNIQUE INDEX reward_campaign_incidents_one_open_kind
    ON reward_campaign_incidents (reward_campaign_id, incident_kind)
    WHERE resolved_at IS NULL;
CREATE INDEX reward_campaign_incidents_open_idx
    ON reward_campaign_incidents (opened_at, reward_campaign_incident_id)
    WHERE resolved_at IS NULL;

CREATE TABLE reward_campaign_monitor_state (
    monitor_name TEXT PRIMARY KEY,
    last_successful_scan_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 0136 compares every immutable term explicitly. Status and these operational columns are not
-- terms, so no trigger replacement or weakening is necessary.
