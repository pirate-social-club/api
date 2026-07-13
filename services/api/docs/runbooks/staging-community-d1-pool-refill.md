# Staging Community D1 Pool Refill Runbook

Use this when staging community creation returns `503 d1_pool_exhausted` or the
pool watchdog reports low free capacity. This procedure is for staging only.
Production refill should follow the same bind-before-insert invariant, but must
use production names, production bindings, and the production deploy protocol.

The pool is intentionally monotonic: creating a smoke community consumes a
binding, and archiving the community does not reclaim it. Do not build or use a
loaded-community reset as smoke cleanup.

## Detection And Release Gate

The API scheduled handler checks capacity every minute. It emits an ops alert
when free capacity is at or below `COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD`
(`8` in staging and `15` in production). That alert remains the continuous
detection path.

`GET /health/provisioning` independently reads the live shard-pool stats. It
returns `503 d1_pool_low_capacity` at or below the same threshold, and
`503 d1_pool_stats_unavailable` when the stats RPC fails. Release smoke calls
this endpoint, so a deployment cannot report healthy while community creation
is already near exhaustion.

Do not treat an absent or missed email as proof that the pool is healthy. Check
the health endpoint or query `d1_pool` directly before a release validation that
needs to create a community.

## Safety Invariants

- Work from a clean checkout based on `origin/main`.
- Add only the next contiguous `DB_CMTY_NNNN` range. Check the current high
  watermark before creating D1s.
- Create D1 databases first, deploy the shard with the new bindings second, and
  insert free `d1_pool` rows last.
- Never insert a `d1_pool` row for a binding that is not already deployed on
  `community-d1-shard-staging`.
- Use top-level staging deploy semantics for the shard: `--env=""`, not
  `--env staging`.
- Switch to the Pirate Infisical profile immediately before reading staging
  secrets.

## Preflight

From the API repo, create a clean refill worktree:

```bash
rtk git fetch origin main
rtk git worktree add /home/t42/Documents/pirate-workspace/worktrees/api-staging-d1-refill-YYYY-MM-DD origin/main -b ops/staging-d1-refill-YYYY-MM-DD
```

Install the shard packages in the clean worktree:

```bash
rtk bun install
```

Run that command in both:

```text
services/community-d1-shard
services/shared
```

Check the current staging range in `services/community-d1-shard/wrangler.jsonc`
and the live pool:

```bash
rtk rg -n "DB_CMTY_00[0-9]+|community-d1-pool-[0-9]+-staging" services/community-d1-shard/wrangler.jsonc
rtk bunx wrangler d1 execute community-d1-shard-pool-staging --remote --command "SELECT COUNT(*) AS total, SUM(CASE WHEN community_id IS NOT NULL THEN 1 ELSE 0 END) AS allocated, SUM(CASE WHEN community_id IS NULL AND last_loaded_at IS NULL AND allocated_at IS NULL THEN 1 ELSE 0 END) AS free_unallocated, SUM(CASE WHEN community_id IS NULL AND allocated_at IS NOT NULL AND last_loaded_at IS NULL THEN 1 ELSE 0 END) AS runtime_unloaded_leak, SUM(CASE WHEN community_id IS NULL AND released_at IS NOT NULL THEN 1 ELSE 0 END) AS released_rows FROM d1_pool;"
```

If `runtime_unloaded_leak` is nonzero, investigate the reconciler before
refilling over leaked capacity. If the pool is genuinely exhausted, continue.

## Create D1s

Plan the next contiguous range. Example: if staging ends at `DB_CMTY_0052`,
adding 20 starts at 53:

```bash
rtk bun scripts/allocate-d1-pool.ts --count 20 --start 53
```

If the dry run is correct, create the D1 databases:

```bash
rtk bun scripts/allocate-d1-pool.ts --count 20 --start 53 --apply
```

Copy the printed `d1_databases` entries into the top-level staging
`d1_databases` array in `services/community-d1-shard/wrangler.jsonc`, immediately
after the previous high-water binding. Do not add these entries under
`env.production`.

Run the focused script test:

```bash
rtk bun test scripts/allocate-d1-pool.test.ts
```

## Deploy Bindings

Deploy the staging shard from the clean refill worktree before inserting pool
rows:

```bash
rtk bunx wrangler deploy --env=""
```

Confirm Wrangler prints the newly added `env.DB_CMTY_NNNN` bindings in the deploy
output.

## Insert Free Pool Rows

Only after the shard deploy succeeds, run the insert printed by
`allocate-d1-pool.ts`. For the 2026-07-07 staging refill this was:

```bash
rtk bunx wrangler d1 execute community-d1-shard-pool-staging --remote --command "INSERT OR IGNORE INTO d1_pool (binding_name, community_id, version) VALUES ('DB_CMTY_0053', NULL, 0), ('DB_CMTY_0054', NULL, 0), ('DB_CMTY_0055', NULL, 0), ('DB_CMTY_0056', NULL, 0), ('DB_CMTY_0057', NULL, 0), ('DB_CMTY_0058', NULL, 0), ('DB_CMTY_0059', NULL, 0), ('DB_CMTY_0060', NULL, 0), ('DB_CMTY_0061', NULL, 0), ('DB_CMTY_0062', NULL, 0), ('DB_CMTY_0063', NULL, 0), ('DB_CMTY_0064', NULL, 0), ('DB_CMTY_0065', NULL, 0), ('DB_CMTY_0066', NULL, 0), ('DB_CMTY_0067', NULL, 0), ('DB_CMTY_0068', NULL, 0), ('DB_CMTY_0069', NULL, 0), ('DB_CMTY_0070', NULL, 0), ('DB_CMTY_0071', NULL, 0), ('DB_CMTY_0072', NULL, 0);"
```

Expected `changes` equals the number of new bindings.

Verify capacity:

```bash
rtk bunx wrangler d1 execute community-d1-shard-pool-staging --remote --command "SELECT COUNT(*) AS total, SUM(CASE WHEN community_id IS NOT NULL THEN 1 ELSE 0 END) AS allocated, SUM(CASE WHEN community_id IS NULL AND last_loaded_at IS NULL AND allocated_at IS NULL THEN 1 ELSE 0 END) AS free_unallocated, SUM(CASE WHEN community_id IS NULL AND allocated_at IS NOT NULL AND last_loaded_at IS NULL THEN 1 ELSE 0 END) AS runtime_unloaded_leak, SUM(CASE WHEN community_id IS NULL AND released_at IS NOT NULL THEN 1 ELSE 0 END) AS released_rows FROM d1_pool;"
```

## Smoke Once

Switch to the Pirate Infisical profile:

```bash
rtk printf '\n' | rtk infisical user switch >/dev/null
```

Run one staging smoke with archive-on-success:

```bash
rtk infisical run --project-config-dir /home/t42/Documents/pirate-workspace/core --env staging --path /services/api -- rtk bun scripts/smoke-d1-provisioning-cutover.ts --archive-success
```

Expected success:

- `ok: true`
- `phase: "done"`
- `archived: true`
- `consumedBinding: true`
- a `canonicalHref` under `https://staging.pirate.sc/c/...`

Do not rerun the smoke repeatedly. Each successful run consumes one binding.

## 2026-07-07 Evidence

- Starting state: 54 total rows, 53 allocated, 0 free, 0 runtime unloaded leaks.
- Added `DB_CMTY_0053` through `DB_CMTY_0072`.
- Shard deploy version: `96bc4a1b-c236-439d-b29c-6392ea0c2691`.
- Insert changed 20 rows.
- Pre-smoke verification: 74 total, 54 allocated, 20 free, 0 runtime unloaded
  leaks.

## 2026-07-13 Evidence

- Starting state: 104 total rows, 0 free.
- Added `DB_CMTY_0103` through `DB_CMTY_0122`.
- Shard deploy version: `454d9c3a-4a79-4ca8-a672-de93c1277389`.
- Insert changed 20 rows.
- Post-smoke verification: 124 total, 19 free.
- The existing scheduled watchdog had no surviving KV delivery marker for the
  exhaustion window; the provisioning health release gate was added so alert
  delivery is no longer the only operational signal.
- Smoke created and archived
  `cmt_0b68dc46c6fa4f26832479ba01ab2d2b` at
  `https://staging.pirate.sc/c/com_cmt_0b68dc46c6fa4f26832479ba01ab2d2b`.
- Post-smoke verification: 74 total, 55 allocated, 19 free, 0 runtime unloaded
  leaks. `DB_CMTY_0053` is the consumed smoke binding.
