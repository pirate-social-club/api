CREATE TABLE IF NOT EXISTS royalty_claim_events (
  claim_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  claimable_wip_wei_at_submission TEXT NOT NULL,
  ip_ids_json TEXT NOT NULL,
  auto_unwrap_ip_tokens BOOLEAN NOT NULL DEFAULT TRUE,
  claimed_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_royalty_claim_events_tx_hash
  ON royalty_claim_events (tx_hash);

CREATE INDEX IF NOT EXISTS idx_royalty_claim_events_user_claimed
  ON royalty_claim_events (user_id, claimed_at DESC);
