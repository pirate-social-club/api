PRAGMA foreign_keys = ON;

CREATE TABLE community_money_policies (
    community_id TEXT PRIMARY KEY,
    funding_preference TEXT NOT NULL,
    accepted_funding_assets_json TEXT NOT NULL,
    accepted_source_chains_json TEXT NOT NULL,
    approved_route_providers_json TEXT,
    destination_settlement_chain_json TEXT NOT NULL,
    destination_settlement_token TEXT NOT NULL,
    treasury_denomination TEXT,
    max_slippage_bps INTEGER NOT NULL CHECK (
        max_slippage_bps >= 0
    ),
    quote_ttl_seconds INTEGER NOT NULL CHECK (
        quote_ttl_seconds >= 1
    ),
    route_required INTEGER NOT NULL CHECK (
        route_required IN (0, 1)
    ),
    route_status_policy TEXT NOT NULL CHECK (
        route_status_policy IN ('fail', 'fallback_display', 'queue')
    ),
    route_hop_tolerance INTEGER NOT NULL CHECK (
        route_hop_tolerance >= 0
    ),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX idx_community_money_policies_route_required
    ON community_money_policies(route_required, updated_at DESC);
