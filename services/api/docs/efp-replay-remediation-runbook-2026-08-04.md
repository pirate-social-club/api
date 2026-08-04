# EFP Replay Remediation Runbook (2026-08-04)

Operational companion to the 2026-08-03 PlanetScale saturation audit: four
consecutive days at 100% CPU on a PS-5 driven by application-generated EFP
indexer workload, not by index bloat alone.

This runbook governs the rollout of five independently deployable PRs. Follow
the order; each step has a stop/go gate. Do not reorder the index work ahead
of the workload fixes — reindexing first just recreates the bloat.

| Step | PR | Branch | Intent |
|------|----|--------|--------|
| 1 | PR1 | `fix/efp-adoption-snapshot-daily-guard` | Once-daily adoption snapshot |
| 3 | PR2 | `fix/efp-chain-block-indexes` (Core + API fixture sync) | Chain/block range indexes |
| 4 | PR3 | `perf/efp-differential-replay` | Zero-DML unchanged replay |
| 5 | PR4 | `perf/efp-differential-projection` | Edge diffing, targeted counts |
| 6 | PR5 | `perf/efp-batched-authoritative-lookup` | One authoritative query per replay |

> **Warning:** the branch `integration/efp-replay-remediation` is a
> reference-only merge of PR3–PR5 used to prove the combined state is green
> (51/51 efp-indexer tests). It is not a deployment target; merge the
> individual PRs in the order above.

## Rollout

### Step 1 — PR1 (snapshot hotfix) → deploy

Gate after deploy:

- **GO** if the `adoption_snapshot` log line appears every minute with
  `recorded: false`, and `recorded: true` appears at most once per UTC date.
  PlanetScale Insights should show the snapshot query's executions/rows-read
  collapse within the hour.
- **STOP / roll back** if the log line is absent (the reconcile job is not
  running) or errors appear.

Concurrency note: the `SCHEDULED_CRON_LOCK` Durable Object lease serializes
scheduled batches, and the insert is `ON CONFLICT DO NOTHING RETURNING`, so a
lost race is both write-safe and logged truthfully (`recorded: false` for the
loser). A rare race can still aggregate twice; it cannot write twice.

### Step 2 — Pre-create the three production indexes CONCURRENTLY

**Hard deployment gate. The riskiest failure mode in this rollout is an
ordinary (blocking) index build on the saturated primary.** Migration 0190
uses `IF NOT EXISTS` precisely so that pre-created indexes make it a no-op.
If this step is skipped, applying 0190 builds all three indexes
non-concurrently in one transaction — stop conditions below assume you do
not let that happen.

Run against the production control-plane database (each statement runs
outside any transaction; run them one at a time):

```sql
CREATE INDEX CONCURRENTLY idx_efp_list_ops_chain_block
    ON efp_list_ops (chain_id, block_number);

CREATE INDEX CONCURRENTLY idx_efp_primary_list_events_chain_block
    ON efp_primary_list_events (chain_id, block_number);

CREATE INDEX CONCURRENTLY idx_efp_list_storage_location_events_chain_block
    ON efp_list_storage_location_events (chain_id, block_number);
```

Verify before proceeding — all three rows must exist with both flags true:

```sql
SELECT c.relname AS index_name, i.indisvalid, i.indisready
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
WHERE c.relname IN (
  'idx_efp_list_ops_chain_block',
  'idx_efp_primary_list_events_chain_block',
  'idx_efp_list_storage_location_events_chain_block'
);
```

- **GO** only when all three indexes are present with `indisvalid = true`
  and `indisready = true`.
- **STOP** if any index is absent or invalid: `DROP INDEX CONCURRENTLY IF
  EXISTS <name>;`, recreate it, re-verify. Do not apply migration 0190 until
  this passes.

### Step 3 — Core PR2 → API fixture-sync PR2

Ordering fact, verified against Core's workflows: **merging the Core PR does
not apply migrations to production** — Core has CI/test/hygiene workflows
only, no deploy pipeline; the runner is operator-invoked. So the merge itself
is production-safe at any point. The production-affecting event is the
reviewed-runner apply of 0190, which this gate blocks until step 2 passes.
Keep the merge after pre-creation anyway: it removes any path by which 0190
can be applied early under time pressure, and it keeps the API pin bump
unambiguous.

Merge Core, then bump `.github/ci-refs/core.sha` to the Core merge
commit (api-ci checks Core out at that pin, so the fixture-freshness check
compares against the pinned tree — the API sync PR stays red by design until
the pin contains 0190, and it must turn green this way, never by override),
then the API sync PR, then apply migration 0190 through the reviewed runner.

- **GO** if 0190 records effectively instantly: the indexes already exist, so
  `IF NOT EXISTS` turns the apply into ledger bookkeeping with no build.
- **STOP** if the apply takes more than a few seconds — that means it is
  building an index non-concurrently. Cancel, return to step 2, and find the
  missing index.

### Step 4 — PR3 (differential raw replay) → deploy

- **GO** if scan logs show `replacement.inserted` / `replacement.deleted`
  near zero on quiet chains (only real reorgs/new blocks produce DML) while
  `efp_indexer_cursors.indexed_through_block` keeps advancing with the chain
  tip every minute.
- **STOP / roll back** if cursor advancement stalls or `replacement` counts
  look inconsistent with on-chain activity.

### Step 5 — PR4 (differential projection) → deploy

- **GO** if `projection.unchanged` dominates `projection.derived` on quiet
  replays and `projection.countsRecomputed` is near zero, while follow
  counts on known profiles still serve correctly (missing counts rows read
  as zero only while the projection reports `current` — spot-check both).
- **STOP / roll back** if counts regress or `last_error` appears on the
  projection state.

### Step 6 — PR5 (batched authoritative lookup) → deploy

- **GO** if PlanetScale Insights no longer shows the per-slot window query
  pattern (one globally-ranked authoritative query per replay instead) and
  rebuild p99 improves.
- **STOP / roll back** if follower resolution diverges (shadow-compare
  against the previous build if suspicious).

### Steps 7–10 — Capacity

7. Wait 24–48 hours. Review the checkpoints below.
8. Resize temporarily (PS-20-class) only if maintenance headroom is still
   insufficient.
9. `REINDEX INDEX CONCURRENTLY idx_efp_list_ops_slot_order;` — only now,
   after the churn sources are off. Confirm size and slot/range latency:

   ```sql
   SELECT pg_size_pretty(pg_relation_size('idx_efp_list_ops_slot_order'));
   ```

10. Reassess steady-state capacity; decide whether the larger cluster is
    permanently necessary.

## New observability fields

Logged every minute on the scheduled batch:

- `{"component":"efp_follow_writes","operation":"adoption_snapshot","recorded":bool,"duration_ms":n}`
- `{"component":"efp_indexer","operation":"scan_<chain>", ...}` including:
  - `replacement`: per-table `{existing, inserted, deleted, changed}` for
    `listOps` / `primaryListEvents` / `storageLocationEvents` (changed rows
    count in both inserted and deleted) plus `affectedSlotCount`,
    `affectedAccountCount`, `affectedListIdCount`.
  - `projection`: `{followers, derived, unchanged, inserted, deleted,
    metadataUpdated, countsRecomputed}`.

Healthy steady state on a quiet chain: `replacement.inserted/deleted` ≈ 0,
`projection.unchanged` ≈ `projection.derived`, `countsRecomputed` ≈ 0,
`adoption_snapshot.recorded` = true once per UTC date.

## Checkpoints (24–48 h after step 6)

- CPU: sustained total and per-query leaders in Insights.
- Memory: RSS vs reclaimable cache (100% total memory alone is not OOM
  pressure; check restart/OOM events separately).
- p99: snapshot query, replay range reads/deletes, count recomputation,
  authoritative lookup.
- Rows read/written per minute on the five EFP tables.
- Egress: Insights "bytes returned" — the 4.55 GB source was never
  confirmed; EFP replay/materialization queries are the prime candidates.
- Dead tuples / bloat trend:

  ```sql
  SELECT relname, n_live_tup, n_dead_tup
  FROM pg_stat_user_tables
  WHERE relname IN (
    'efp_list_ops', 'efp_effective_follows', 'efp_primary_list_events',
    'efp_list_storage_location_events', 'efp_follow_counts'
  )
  ORDER BY n_dead_tup DESC;
  ```

  Dead-tuple growth should flatten once PR3/PR4 are live; the pre-existing
  backlog is what step 9's REINDEX clears.

## PlanetScale recommendation dispositions

- `attendance_heartbeats` / `attendance_sessions` (drop): **retain.** The
  live tables are `bookings.attendance_*`, owned by Core's bookings
  migrations — not API control-plane migrations — and booking lifecycle code
  actively reads/writes them.
- `idx_link_enrichment_usages_normalized_url` (drop): **retain.** Tiny; backs
  the implemented `WHERE normalized_url ORDER BY updated_at` read path.
- `idx_jobs_club_status` (drop): **retain/defer.** 40 KB; the earlier
  "current query needs it" justification was incorrect — reassess when
  `jobs` has meaningful cardinality.
- `idx_efp_list_ops_slot_order` (bloat): **accept only after steps 4–6** via
  step 9's `REINDEX INDEX CONCURRENTLY`. Do not drop it: it serves
  authoritative slot replay (~58M recorded scans).

## Rollback guidance

All rollbacks are code/config reverts; no data migration needs unwinding.
Reverse order (PR5 → PR1) if more than one must go back.

- **PR1:** revert the deploy. Snapshot returns to per-minute upserts (the
  pre-existing cost; no correctness risk). No schema change involved.
- **PR2:** indexes are additive. Rollback is
  `DROP INDEX CONCURRENTLY IF EXISTS idx_efp_list_ops_chain_block;` (and the
  other two), never a blocking `DROP INDEX`. The 0190 ledger row may stay —
  `IF NOT EXISTS` makes any re-apply a no-op.
- **PR3:** revert the deploy. Full-range delete/reinsert returns (the
  pre-existing churn). Raw-table contents are semantically identical either
  way.
- **PR4:** revert the deploy. Full follower edge wipe/reinsert returns.
  Counts are recomputed from edges on both code paths, so they stay correct.
- **PR5:** revert the deploy. Per-slot window queries return; resolution
  semantics are identical by construction.

## Deployment verification

After each API deploy, confirm the deployed pair directly:

- `https://api.pirate.sc/__version`
- `https://pirate.sc/__version`

A green workflow or merged PR is not deployment evidence by itself; never
treat a skipped production job as a successful deployment.
