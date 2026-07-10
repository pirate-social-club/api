-- Enforce single-use of a buyer funding tx for public pirate-name claims: at most one
-- CLAIMED quote per funding_tx_ref, so one on-chain payment cannot register multiple
-- names. The POST /public-names/claims flow is unauthenticated and the name price is
-- per-label-length, so without this a single payment could claim unlimited same-length
-- names by reusing funding_tx_ref across quotes. Race-safe backstop for the app-level
-- check in claimPublicPirateName (api).
--
-- PREFLIGHT (must be 0 rows — the exploit signature; verified 0 in prod 2026-07-02,
-- with 0 total claimed names, before this index):
--   SELECT funding_tx_ref, COUNT(*) FROM pirate_name_quotes
--   WHERE status = 'claimed' AND funding_tx_ref IS NOT NULL
--   GROUP BY funding_tx_ref HAVING COUNT(*) > 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pirate_name_quotes_claimed_funding_tx
    ON pirate_name_quotes(funding_tx_ref)
    WHERE status = 'claimed' AND funding_tx_ref IS NOT NULL;
