CREATE TABLE asset_derivative_links (
    asset_derivative_link_id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL,
    upstream_asset_id TEXT NOT NULL,
    relationship_type TEXT NOT NULL CHECK (
        relationship_type IN ('remix_of', 'references_song', 'inspired_by', 'samples')
    ),
    created_at TEXT NOT NULL,
    FOREIGN KEY (asset_id) REFERENCES assets(asset_id),
    FOREIGN KEY (upstream_asset_id) REFERENCES assets(asset_id)
);

CREATE INDEX idx_asset_derivative_links_asset
    ON asset_derivative_links(asset_id, created_at DESC);

CREATE INDEX idx_asset_derivative_links_upstream
    ON asset_derivative_links(upstream_asset_id, created_at DESC);
