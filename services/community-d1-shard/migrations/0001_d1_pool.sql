-- Shard-owned pool/allowlist table (keystone of the D1-native workstream, step 1).
--
-- This REPLACES the static COMMUNITY_D1_BINDING_MAP_JSON env var as the source of
-- truth for assertCommunityBinding. The static map remains in wrangler.jsonc only
-- as the cold-start SEED for this table (populated once if the table is empty),
-- so step 1 is behavior-preserving: the two pilot communities resolve to the same
-- binding they do today.
--
-- Security property preserved: this table is the shard's OWN independent second
-- gate. The control-plane community_database_routing row (written by the API) is
-- still never trusted on its own — a poisoned routing row pointing community A at
-- community B's binding is rejected here because this table says A -> A's binding
-- (or A is unknown). See D1-NATIVE-PROVISIONING-DESIGN.md §2, §8.2.
--
-- Columns released_at + version are written by later steps (allocator §3.3,
-- reconciler §6) but land now to avoid a follow-up migration. released_at drives
-- the quarantine window that must exceed the in-memory cache TTL (§5).

CREATE TABLE IF NOT EXISTS d1_pool (
  binding_name   TEXT PRIMARY KEY,           -- 'DB_CMTY_*'; matches a wrangler d1_databases binding
  community_id   TEXT UNIQUE,                -- NULL = free; non-NULL = allocated 1:1 to this community
  allocated_at   TEXT,                       -- ISO; set when community_id is claimed
  last_loaded_at TEXT,                       -- ISO; set only on a fully-successful snapshot load
  last_error     TEXT,                       -- last failure message; cleared on success
  released_at    TEXT,                       -- ISO; set by the reconciler on release; gates re-allocation (quarantine)
  version        INTEGER NOT NULL DEFAULT 0  -- optimistic-lock counter for allocate/release
);

-- Free-pool scan (allocator) and quarantine filter both hit (community_id, released_at).
CREATE INDEX IF NOT EXISTS idx_d1_pool_free
  ON d1_pool(community_id, released_at);
