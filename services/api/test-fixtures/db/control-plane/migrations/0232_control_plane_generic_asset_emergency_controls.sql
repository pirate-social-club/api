-- Operator-controlled fail-closed brakes for generic digital goods.
-- Rows are append/update state, never destructive: clearing a control records
-- the operator evidence and leaves the original decision auditable.
CREATE TABLE generic_asset_emergency_controls (
    control_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL CHECK (
        scope IN ('all', 'content_hash', 'asset', 'uploader', 'community', 'validation_profile')
    ),
    target_ref TEXT,
    state TEXT NOT NULL CHECK (state IN ('active', 'cleared')),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    actor_ref TEXT NOT NULL CHECK (length(trim(actor_ref)) > 0),
    created_at TIMESTAMPTZ NOT NULL,
    cleared_at TIMESTAMPTZ,
    cleared_by TEXT,
    CONSTRAINT generic_asset_emergency_controls_scope_target_check
        CHECK ((scope = 'all' AND target_ref IS NULL) OR (scope <> 'all' AND target_ref IS NOT NULL)),
    CONSTRAINT generic_asset_emergency_controls_state_clear_check
        CHECK ((state = 'active' AND cleared_at IS NULL AND cleared_by IS NULL)
        OR (state = 'cleared' AND cleared_at IS NOT NULL AND cleared_by IS NOT NULL))
);

CREATE UNIQUE INDEX idx_generic_asset_emergency_controls_active
    ON generic_asset_emergency_controls(scope, COALESCE(target_ref, ''))
    WHERE state = 'active';

CREATE INDEX idx_generic_asset_emergency_controls_lookup
    ON generic_asset_emergency_controls(state, scope, target_ref);
