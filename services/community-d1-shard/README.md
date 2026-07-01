# community-d1-shard (Turso→D1 PR2 — read-only)

A Worker that hosts per-community D1 bindings and exposes a **read-only** RPC
surface (`CommunityD1Shard` WorkerEntrypoint: `execute`, `batch`) to the API over
a service binding. The API's `openShardReadClient` (in `community-read-access.ts`)
calls it when a community's `community_database_routing` row has `backend='d1'`.

There is no write/transaction method here — the write path is PR3.

## Authorization (two gates, both server-side, before any D1 access)

1. **`(communityId → bindingName)` allowlist** — `COMMUNITY_D1_BINDING_MAP_JSON`
   var, a JSON object of communities this shard serves. `assertCommunityBinding`
   rejects unless the community is mapped here **and** maps to exactly the
   requested binding (fail-closed). Stops a stale/poisoned routing row for
   community A from reading community B's binding on the same shard.
2. **Real bound D1** — `resolveD1` requires `bindingName` to be an actual bound
   D1 namespace (capability check).
3. **Read-only guard** — the shared `isReadOnlyStatement` allowlist runs on every
   statement (same guard as the API's D1 read client). Batch write mode rejected.

Any NEW RPC method touching D1 MUST go through `runShardRead`/`runShardBatch`
(or call `assertCommunityBinding` + `resolveD1` itself) — never `resolveD1` alone.

## Staging state (PR2 pilot)

- Worker: `community-d1-shard-staging`. Deploy with **`bunx wrangler@4.100.0 deploy`**
  (wrangler 4.81.1 has an undici `fetch failed` bug; retry on transient failures).
- D1: `cmty-pilot-staging` (id `81369dab-8d38-4a7f-842f-dd3bb5c2fd30`), bound as `DB_CMTY_PILOT`.
- `COMMUNITY_D1_BINDING_MAP_JSON = {"cmt_a43c487541154b358837c726b98aea2e":"DB_CMTY_PILOT"}`.
- API staging binds it: service `community-d1-shard-staging`, entrypoint `CommunityD1Shard`, binding `COMMUNITY_D1_SHARD` (api `wrangler.jsonc` staging `services`). **Prod has no shard binding.**

## Migrate a community onto D1 (procedure)

All from `services/community-provision-operator`, via
`infisical run --project-config-dir <core> --env staging --path /services/api -- ...`:

1. `wrangler@4.100.0 d1 create <db>` → add to this wrangler's `d1_databases` as `DB_CMTY_<X>`.
2. `bun run scripts/copy-community-turso-to-d1.ts --community-id <C> --out /tmp/dump.sql`
   (dumps Turso schema+data, prints per-table counts).
3. `bunx wrangler@4.100.0 d1 execute <db> --remote --file /tmp/dump.sql --yes`.
4. **Parity:** compare per-table counts (step 2 output) against
   `d1 execute <db> --remote --command "SELECT count(*) ..."`.
5. Add `"<C>":"DB_CMTY_<X>"` to `COMMUNITY_D1_BINDING_MAP_JSON`; deploy this shard.
6. Ensure the API env has the `COMMUNITY_D1_SHARD` service binding; deploy the API.
7. `bun run scripts/flip-community-to-d1.ts --community-id <C> --shard-worker-id community-d1-shard-staging --binding-name DB_CMTY_<X> --region <r> --apply`.
8. Verify: read the community's preview, confirm shard `wrangler tail` shows
   `rpcMethod: execute` / `outcome: ok`, no fallback, no 5xx.
   (`wrangler tail --format json` is PRETTY-printed, not JSONL — grep `"rpcMethod"`/`"outcome": "ok"`.)

## Rollback (tested on staging)

`bun run scripts/flip-community-to-turso.ts --community-id <C> --apply` flips the
routing row back to `turso`, restoring `turso_database_binding_id` from
`communities.primary_database_binding_id` (the forward flip nulled it; the binding
itself is never deleted). No-op if already `turso`. No schema rollback needed.
Proven on staging via a `d1→turso→d1` round-trip.

## ⚠️ Drift caveat (read-only D1 until PR3)

A flipped community's D1 is a **point-in-time copy**. All writes (and all
non-preview reads) still go to Turso via `openCommunityDb`; only the routed
*preview* read path reads D1. So **any write to a flipped community makes its D1
read stale** until PR3 adds write handling / sync. Until then, only keep
communities flipped that receive no writes (e.g. the inert pilot), or roll back
before activity. PR3 = write path + sync/cutover ordering.
