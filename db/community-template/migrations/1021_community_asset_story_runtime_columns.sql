ALTER TABLE assets
ADD COLUMN story_ip_nft_contract TEXT;

ALTER TABLE assets
ADD COLUMN story_ip_nft_token_id TEXT;

ALTER TABLE assets
ADD COLUMN story_publish_model TEXT NOT NULL DEFAULT 'pirate_v1'
    CHECK (story_publish_model IN ('pirate_v1', 'story_ip_v1'));

ALTER TABLE assets
ADD COLUMN story_license_terms_id TEXT;

ALTER TABLE assets
ADD COLUMN story_license_template TEXT;

ALTER TABLE assets
ADD COLUMN story_royalty_policy TEXT;

ALTER TABLE assets
ADD COLUMN story_derivative_registered_at TEXT;

ALTER TABLE assets
ADD COLUMN story_revenue_token TEXT;

ALTER TABLE assets
ADD COLUMN story_cdr_encrypted_cid TEXT;

ALTER TABLE assets
ADD COLUMN story_cdr_allocate_tx_ref TEXT;

ALTER TABLE assets
ADD COLUMN story_cdr_write_tx_ref TEXT;
