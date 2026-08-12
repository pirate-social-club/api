-- Allocation attribution for the community D1 pool.
--
-- WHY: the pool drains monotonically (release has never fired -- ever_released
-- was 0 across all 744 bindings on 2026-07-22) and staging exhausted twice in
-- one day, blocking every web release. But we could not say WHICH consumer
-- burned the capacity: nine api-side scripts plus web's createGateBuilderCommunity
-- all provision communities, and the pool row recorded only WHEN a binding was
-- claimed, never BY WHAT. Aggregate counts (alloc_24h=61, alloc_7d=441) could
-- not be apportioned, so there was no evidence-based way to pick a consumer to
-- fix -- only guesses, and the first guess (the Story E2E) was wrong.
--
-- These columns are diagnostic ONLY. Nothing reads them for control flow:
-- allocation must never depend on, or fail because of, attribution. Both are
-- nullable and untagged callers simply record NULL.
ALTER TABLE d1_pool ADD COLUMN allocation_source TEXT;
ALTER TABLE d1_pool ADD COLUMN allocation_run_id TEXT;

-- Ranking consumers is "group by source over a recent allocated_at window", which
-- is exactly this index. Partial (source IS NOT NULL) so it stays small while the
-- long tail of historical untagged rows is never scanned for attribution.
CREATE INDEX IF NOT EXISTS idx_d1_pool_allocation_source
  ON d1_pool(allocation_source, allocated_at)
  WHERE allocation_source IS NOT NULL;
