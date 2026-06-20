# Shard D1-Native Workstream — Implementation Tracking

> **Deploy surface:** the API D1 workstream lives on `pirate-api-d1-staging`
> (Worker v `0e64adc9-8298-4d3c-a716-6f804149e79b`). The shared
> `pirate-api-staging` is reserved for the karaoke workstream; the two
> workstreams do NOT clobber each other. All step 1-4 deploys below
> target `pirate-api-d1-staging`.

> **Shared resource — control plane (PlanetScale).** The control plane is
> the one resource all workstreams contend on. It hosts global app-data
> tables (`song_artifact_bundles`, `scrobble_*`, `community_database_routing`,
> `community_database_bindings`, `jobs`, etc.) and is migrated via a
> numbered sequence (`0116_…`, `0117_…`, `0118_…`, …). At the time of
> this writing, `0119` is claimed by the TON/Omniston workstream
> (`0119_control_plane_spend_intents.sql`, on disk in
> core-ton-omniston-funding). Any future D1 step that introduces a
> **new** control-plane table must:
> 1. Check the live migration sequence across all worktrees (the
>    PlanetScale migration dir is the canonical source).
> 2. Number the new migration at the next free slot, NOT assume
>    "different databases" implies an isolated sequence.
> 3. Coordinate against any in-flight worktrees via the workstream
>    memory.
>
> Steps 1-4 of this workstream DO NOT add new control-plane tables —
> they write to existing tables (`community_database_routing` 0117,
> `community_database_bindings` pre-existing). The above discipline
> applies only when a future step introduces a new table.

PR-series tracking for the workstream after PR #57 lands. The design
is in `D1-NATIVE-PROVISIONING-DESIGN.md` (10 sections, keystone +
security + RPC contract + failure model + v1 scope + acceptance
criteria + impl order). This file makes the PR-series order reviewable
by attaching acceptance criteria to each step, marking dependencies
explicitly, and listing the files each step touches.

The workstream requires:
- Shard Worker deploy access (`wrangler deploy` to
  `community-d1-shard-staging`).
- A real Cloudflare account to run `wrangler d1 create` for the
  operator allocator script.
- A staging API env to flip `COMMUNITY_PROVISION_BACKEND=d1_native`
  for the drill.

This environment has none of those. Steps 1–7 cannot be unit-tested
with `bun test` against in-memory SQLite; the local-testable surface
is exhausted in PR #57.

---

## Status

| Step | Status | Commit | Acceptance criteria | Notes |
|---|---|---|---|---|
| 0 | ✅ Shipped (PR #57) | `1b86876` | §8.0 | Request-aware resolver; the load-bearing v1-scope fix. |
| 1 | ✅ Shipped (live on staging) | this PR | §8.2 | Keystone: shard's `d1_pool` + de-staticized allowlist. 26 unit tests pass including the §8.2 keystone test. Pool D1 `community-d1-shard-pool-staging` is live in EEUR with the 2 pilots seeded. Shard deployed to `community-d1-shard-staging` v `3714fbf0-393a-406a-9952-ff6507972174`. |
| 2 | ✅ Shipped (live on staging) | this PR | §8.3 | `communityD1Bind` RPC + concurrent-allocator catch + quarantine-window-respecting free-pool scan. 9 new runShardBind tests, total 35 pass including all §8.3 cases (idempotency, concurrent UNIQUE catch, pool exhausted, quarantine, BINDING_NOT_INITIALIZED, missing D1_POOL). Shard deployed v `2523116f-2d3d-4144-8150-5ad86178d60e`. |
| 2.5 | ✅ Shipped (live on staging) | this PR | (contract fix, no §X) | All shard RPCs now return `ShardResult<T>` (typed errors as VALUES) instead of throwing. Custom error codes survive the WorkerEntrypoint RPC boundary — the API can now distinguish `shard_pool_write_conflict` (retry) from `shard_pool_exhausted` (fail to ops) from `shard_binding_not_allowed` (security deny). Live smoke verified: poisoned pair returns `code: "shard_binding_not_allowed"`, empty pool returns `code: "shard_pool_exhausted"` — no more "error:unknown". |
| 3 | ✅ Shipped (live on staging) | this PR | §8.4 | `communityD1LoadSnapshot` RPC + bootstrap guard (`isBootstrapAllowedStatement`, allows CREATE TABLE IF NOT EXISTS + INSERT) + pool-table re-validation (§4.2 invariant against release+reallocate) + last_loaded_at set on success + idempotent no-op on retry. 9 new runShardLoadSnapshot tests, total 44 pass including all §8.4 cases (load, idempotency, BINDING_NOT_ALLOCATED with stale cache, bootstrap guard rejects DROP/SELECT, BINDING_NOT_ALLOWED, empty statements still marks loaded). Shard deployed v `1a89838a-3f86-4277-9cc7-63965b650f4d`. |
| 4 | ⚠️ Code-complete; control-plane path NOT live | this PR | §8.1 | `d1_native.provision()` orchestrator: `communityD1Bind` → `communityD1LoadSnapshot` → `upsertD1CommunityRoutingRow('ready')` → `persistProvisionedD1Binding`. Branches on raw `ShardResult`; each error code has a distinct recovery (pool_exhausted/write_conflict/binding_not_allocated → 503, others → 500/403). Unit + route test (fake `COMMUNITY_D1_SHARD` + control-plane assertions) pass. **The orchestrator's live control-plane writes have NEVER run** — `pirate-api-d1-staging` is a code-only deploy with NO `CONTROL_PLANE_DATABASE_URL` (and ~no secrets). Code deployed v `108d9450`, but the routing/binding writes are inert there. Live integration deferred to the step-7 drill on a properly-configured worker. |
| 5 | ✅ LIVE-verified on d1-staging | this PR `3fb87dc` | §8.5 | Reconciliation sweep — **runs live against the real staging control plane**: `[d1-reconciler] sweep { scanned: 0, advanced: 0, released: 0, errorCount: 0 }` (0 stuck rows → safe no-op; confirmed pre-enable via control-plane query: 2 d1 ready + 17 turso ready, 0 provisioning). CONTROL_PLANE_DATABASE_URL sourced from Infisical + set on d1-staging. d1-staging is now a DEDICATED reconciler host (runs ONLY the reconciler — its SCHEDULED_CRON_LOCK DO is NOT shared with main staging, so the general batch is gated off to avoid double-processing shared data). Underlying: Admin RPCs (GetPoolRow/Reset/Release, service-authed, fail-closed) `ed4c495` + reset server-side load-guard `f7042d3` (closes the load-vs-reset TOCTOU) + pure sweep orchestrator `c185847` (advance / reset+release / race→advance / error paths — 7/7 tests) + stuck-row query `f1ba37f` + host glue `36e40ad` (mounted in the scheduled batch under the existing DO lease → single-flight free; advance path does both routing flip AND binding-URL persist; errors capped). Live smoke confirmed the cron fires + DO lease + gate all work, but the sweep itself fails on the same missing `CONTROL_PLANE_DATABASE_URL`. Reconciler is unit-verified end-to-end; live exercise pending step 7. |
| 6 | ✅ Code-complete (script) | this PR `d1079d7` | (operator runbook) | `scripts/allocate-d1-pool.ts` — `wrangler d1 create` wrapper. Pure tested core (naming, output parse, d1_databases entry + d1_pool INSERT) + CLI: DRY-RUN by default, `--apply` for the irreversible create; two-phase (create → add bindings + deploy → INSERT). 8 tests. The live `--apply` run (creating Cloudflare D1s) is an explicit operator step, naturally part of the step-7 drill. |
| 7 | ✅ PASSED (drill complete) | this PR | §8.6 | **A real community born on D1, end-to-end on live staging.** `POST /communities` (namespaceless, membership_mode=request) → 202, job `community_provisioning` succeeded, `result_ref=d1://shard/DB_CMTY_0001`. Verified in shared control plane: routing row `backend='d1', provisioning_state='ready', binding_name='DB_CMTY_0001'`; binding row `database_url='d1://shard/DB_CMTY_0001', requires_credentials=0`; pool row `DB_CMTY_0001` allocated + `last_loaded_at` set; reconciler clean no-op. **Drill artifact:** community `cmt_d60e231c7b424bdf826e39a862d155e2` ("D1 Native Drill 2026-06-20"), binding DB_CMTY_0001, created by usr_d7bb6722…, 2026-06-20. **v1 LIMITATION (verified, sharper than first stated):** the community's D1 has **0 community tables** (only the CF-internal `_cf_KV`). The orchestrator passes `statements: []` (backend.ts:295), AND nothing pre-applies the community-template migrations to pool D1s (allocate-d1-pool.ts does not; no other mechanism does). So the backend.ts comment "schema is in the binding's pre-applied migrations" describes a mechanism that DOESN'T EXIST — a community born on D1 today is **completely schemaless**, not merely missing bootstrap data. Community-local reads/writes fail entirely. **§8.7 (next slice) MUST apply the community schema (template migrations) to the binding, not just translate snapshot data.**

**⚠️ DEPLOYMENT GUARD until §8.7 ships:** do NOT set `COMMUNITY_PROVISION_BACKEND=d1_native` on any env other than `pirate-api-d1-staging`. Every d1_native create today yields a schemaless, non-functional community; cleanup is `communityD1Reset` + `communityD1Release` + delete the control-plane rows. Production + main staging keep the operator/turso path (default); the flag is opt-in per env.

## Step 8 — real snapshot/schema load (§8.7)

**Status:** ✅ DONE + PROVEN LIVE (2026-06-20). A community is now born on D1
**functional** — full schema + seed data, end-to-end on live staging.

**Drill v2 artifact:** community `cmt_99c7a4e145e446a8820e0e46717829a2`
("D1 Native Drill v2 (schema)") on `DB_CMTY_0002`. Verified: the community's D1
(`community-d1-pool-0002-staging`) has **57 tables + 102 schema_migrations + the
seeded community row + owner role** (vs 0 tables for the v1 empty-load artifact on
DB_CMTY_0001). Control plane: routing `backend='d1'/ready`, binding
`d1://shard/DB_CMTY_0002`, pool allocated. The 287-statement load (181 schema + 102
migration seeds + ~4 data) went through `communityD1LoadSnapshot` in one batch —
no D1 batch-size error, no bootstrap-guard rejection.

**Implementation (commits `383cfe8` schema gen, `d6169a5` seed extraction, `ef9acfe`
translator+wiring):** option 2 (final-schema dump) + option C (pure
`buildCommunitySeedStatements` shared with the operator path, no drift). All
CREATE/INSERT → no shard-guard widening.

**CONSUMER-READ PROOF (the integration gate):** `GET /communities/cmt_99c7…/preview`
on the live d1-staging worker → `getCommunityPreview` → `openCommunityReadClient` →
shard RPC → `DB_CMTY_0002` → **HTTP 200** with `member_count: 1` (from
`community_memberships`) + `owner.role: "owner"` + `viewer_community_role: "owner"`
(from `community_roles`) — all read from the community's D1. Pre-§8.7 this read
failed "no such table"; now it returns the seeded data. The d1_native community is
genuinely USABLE through an already-routed surface.

**⚠️ Pool now EXHAUSTED (a FEATURE, observed live):** all 4 bindings allocated (2
pilots + 2 drill communities, 0 FREE). The next d1_native create now returns
`shard_pool_exhausted` (503) — the §8.3 acceptance criterion exercised in production
for the first time, not a regression. Path back to headroom: `allocate-d1-pool
--apply`. Pool-sizing decision worth scheduling: pre-allocate 4–8 slots before the
§8.8 factory migration creates demand (under-allocating forces a deploy+runbook step
mid-migration). The deployment guard (d1_native only on pirate-api-d1-staging) still
applies.

## Step §8.8 — factory migration (the next workstream, NOT started)

§8.7 made the destination *usable*; §8.8 makes existing code able to *reach* it.
**~98 `openCommunityDb(` call sites** (measured: `rg "openCommunityDb\(" services/api/src
| wc -l`) still go through the legacy factory and can't reach d1_native communities.
The surfaces routed in PRs #53–56 (preview/membership/post/comment/vote/moderation)
ALREADY reach D1 — the preview proof above rides one of them. §8.8 converts the
remaining legacy sites. Recommended slice shape (mirrors the merge-gate discipline):
pick one READ site → audit its legacy-factory contract → prove a single routed read
against `DB_CMTY_0002` (the §8.7 artifact, already schema'd + seeded) → extract a
factory-side adapter the other sites adopt incrementally. This is the workstream that
actually moves the 17 live Turso communities toward D1.

### §8.8 established pattern (first slice done: commit `17cb439`)

**Clean-read site (the template — profile-activity-read-service):**
1. `openCommunityDb(env, repo, id)` → `openCommunityReadClient(env, repo, id)` (routes
   `backend='d1'` to the shard read RPC, falls back to legacy Turso otherwise). Same
   3 args, `.client` + `.close()` shape preserved.
2. Widen any read helper typed `client: Client` → `client: DbExecutor` (the read
   client has execute/batch but no `transaction`). The shared read stores
   (`getPostById`/`getCommentById`/`getPostReadMetrics`) already take `DbExecutor`.
3. Drop the now-unused `Client` import.

**The per-site classification §8.8 requires (NOT a uniform sweep):**
- **Pure read** → `openCommunityReadClient` (as above).
- **Write / transaction** → `openCommunityWriteClient` (the read RPC's read-only guard
  rejects writes, so a write site routed to the read client FAILS for d1 communities).
- **⚠️ Read-with-side-effect-write** (e.g. `home-feed-community-reader` site 212 —
  `enqueuePostReadJobsForCommunity` calls `enqueue…OnReadIfNeeded`, which write jobs
  during a read). These need the write path (or to route the enqueue separately);
  they are the trickiest and must be hand-classified, not bulk-converted.

**Progress (clean-read grind, 2026-06-20):** 3 slices, 7 read sites across 5 files —
profile-activity (`17cb439`), mcp board-read-tools + board-read-service (`350c2c1`),
debug-pipeline + safety-settings (`b00476d`). All behavior-preserving (464 unit pass,
typecheck clean each).

**Refinement found (public-posts, DEFERRED):** the widen-the-read-helper step has a
type subtlety — `DbExecutor = Pick<Client, "execute">` (execute ONLY, no `batch`),
while the routed read client has execute+batch. Helpers that only `execute` widen to
`DbExecutor` (slices 1–3); helpers that `batch`, or pass `client` to sub-helpers that
do, must widen to `CommunityReadClient` (execute+batch) instead — and that can cascade
across a chain (public-posts → getPublicPostFromCommunityDb → sub-helpers). Those
deeper chains are past "mechanical" and belong in focused work, not the clean grind.

**Remaining: ~89 `openCommunityDb(` sites.** Buckets: (a) clean-read mechanical
(remaining feed reads, mcp.ts, etc.); (b) deeper-read-cascade (public-posts — needs
CommunityReadClient widening down a chain); (c) write/transaction (openCommunityWriteClient,
gated on buffer-safe surfaces per the design — result-dependent txns need refactor
first); (d) read-with-side-effect-write (home-feed site 212). Order: finish (a), then
(b), then (c)/(d) with per-site care. (c) splits further into buffer-safe (mechanical)
vs result-dependent-tx (refactor) per the write-client constraint.

---

### (historical) original §8.7 plan

`localSnapshotToShardStatements(LocalCommunitySnapshot) -> ShardSqlStatement[]` — must emit the community-template **schema DDL** (the 102 `1xxx_*.sql` files in `core/db/community-template/migrations/`) first, then the bootstrap rows. Replace `statements: []` at backend.ts:295 with it.

**Design research done 2026-06-20 (read-only) — the "statements-only, no guard change" plan does NOT hold. Grounded findings:**

- **Q1 (template SQL at runtime):** bundled as a generated TS module `COMMUNITY_MIGRATIONS` (`community-provision-operator/src/generated/community-migrations.ts`, produced by `scripts/generate-migration-manifest.ts`). The operator's `applyMigrationTransaction` (community-bootstrap.ts:386–416) already shapes it as `{ sql }` statements + a `schema_migrations` checksum INSERT per migration. **The API does not import this** — §8.7 must generate/bundle the manifest into the API (or @pirate/api-shared) to reach it at request time.
- **Q2 (snapshot contents):** `LocalCommunitySnapshot` (community-local-db.ts:93) is a **DATA** object (metadata, settings_json, gate_policy, rules) — NOT schema, NOT SQL. So §8.7 needs BOTH: (1) replay the template schema, AND (2) seed the snapshot data. The operator does both; the d1_native path does neither.
- **🔴 The blocker:** **~70 of 102 template migrations use `ALTER TABLE`**, and the bootstrap guard (`isBootstrapAllowedStatement`) allows `CREATE`/`INSERT`/`UPDATE`/`DELETE`/`REPLACE` but **rejects `ALTER`**. So you cannot just replay `COMMUNITY_MIGRATIONS` through the existing RPC.

**Three viable approaches (decide before code):**
1. **Extend the bootstrap guard to allow `ALTER TABLE`** on the load path → replay `COMMUNITY_MIGRATIONS` via the existing `communityD1LoadSnapshot`. Smallest code; widens the shard's bootstrap write surface to ALTER (security review on a destructive-capable surface).
2. **Final-schema-dump build artifact:** apply the 102 migrations at build time, dump the FINAL-form schema as `CREATE TABLE`/`CREATE INDEX` (no ALTERs, guard-compatible) + seed `schema_migrations` rows so schema-state checks pass. No guard change; needs a build step + checksum seeding.
3. **New `communityD1ApplyMigration` RPC** with its own migration-apply guard. Cleanest separation; the new shard surface step 3 originally avoided.

**DECISION: option 2 (final-schema-dump).** Option 1 is OUT — the migrations use not just `ALTER TABLE` (173×) but `DROP TABLE` (23×), `DROP INDEX` (13×), and `PRAGMA` (22×). Widening the bootstrap guard to allow all of those defeats the guard (`DROP TABLE` on the bootstrap path is the exact destructive capability it exists to block). Option 2 keeps the guard unchanged: a build-time generator applies the 104 migrations to a throwaway in-memory DB, dumps the FINAL-form schema (`CREATE TABLE`/`CREATE INDEX` only — no ALTER/DROP/PRAGMA), emits a generated module the API imports; the translator sends those CREATEs + a `schema_migrations` checksum seed (so the operator's schema-state checks pass) + the snapshot-data INSERTs — all `CREATE`/`INSERT`, guard-compatible. The dangerous verbs run only at build time in a trusted context.

Acceptance: `SELECT count(*) FROM sqlite_master WHERE type='table'` returns the expected community tables; a routed read against the binding returns 200 (no "no such table"); reconciler stays a no-op; a service test pins the translator output. **Verification:** a focused bun-test integration driving the load + one routed read against the same `COMMUNITY_D1_SHARD` stub (asserts both "schema loaded" AND "readable from the API path") — no temporary prod endpoint.

### §8.7 progress + remaining (2026-06-20)

**DONE — schema half (commit `383cfe8`):** `scripts/generate-community-schema-snapshot.ts` replays the 102 template migrations in-memory and emits `generated/community-schema-snapshot.ts`: `COMMUNITY_SCHEMA_STATEMENTS` (181 CREATE TABLE/INDEX, final-form, guard-compatible — 57 tables + 124 indexes) + `COMMUNITY_SCHEMA_MIGRATIONS` (102 name+checksum for seeding `schema_migrations`). Validated: re-applies cleanly to a fresh DB.

**REMAINING — data half (the translator):** `localSnapshotToShardStatements(LocalCommunitySnapshot)` = `COMMUNITY_SCHEMA_STATEMENTS` + a `schema_migrations` seed INSERT per `COMMUNITY_SCHEMA_MIGRATIONS` entry + the snapshot DATA INSERTs. The data rows mirror `bootstrapLocalCommunityDb` (community-local-db.ts:437–594): `communities`, `community_memberships`, `community_roles`, `community_gate_policies`, `community_rules` (+ `namespace_bindings`/`namespace_handle_policies` — N/A for v1 namespaceless). **Constraint:** can't reuse `bootstrapLocalCommunityDb` directly — it reads migration files from disk (`applyMigrationFile`), which fails in a deployed Worker. Two options: (A) refactor `bootstrapLocalCommunityDb` to accept the bundled schema (no file reads) + run it in-memory + dump rows — no INSERT drift, bigger refactor of an operator-shared fn; (B) a standalone translator that emits the 6 INSERTs directly — self-contained, but duplicates the seeding logic (drift risk; a test pinning output vs `bootstrapLocalCommunityDb` mitigates). Then wire into backend.ts:295, add the integration test, re-drill on `DB_CMTY_0002`.

PR #57 (4 inert code slices + design doc + design amendment + step 0
code) is the foundation boundary and is the last thing this
environment produces.

---

## Dependency graph

```
                            ┌──────────────┐
                            │ ✅ Step 0    │
                            │ (PR #57)     │
                            └──────┬───────┘
                                   │
                                   ▼
                            ┌──────────────┐
                            │ ⬜ Step 1    │
                            │ d1_pool +    │
                            │ cache        │
                            └──┬───────┬───┘
                               │       │
                  ┌────────────┘       └────────────┐
                  ▼                                 ▼
           ┌──────────────┐                  ┌──────────────┐
           │ ⬜ Step 2    │                  │ ⬜ Step 3    │
           │ communityD1  │                  │ communityD1  │
           │ Bind         │                  │ LoadSnapshot │
           └──────┬───────┘                  └──────┬───────┘
                  │                                 │
                  └────────────┬────────────────────┘
                               ▼
                        ┌──────────────┐
                        │ ⬜ Step 4    │
                        │ provision()  │
                        │ orchestration│
                        └──────┬───────┘
                               │
                               ▼
                        ┌──────────────┐
                        │ ⬜ Step 5    │
                        │ reconciler   │
                        └──────┬───────┘
                               │
        ┌──────────────┐       │       ┌──────────────┐
        │ ⬜ Step 6    │       └──────▶│ ⬜ Step 7    │
        │ allocator    │               │ staging drill│
        │ (parallel)   │               │ (merge gate) │
        └──────────────┘               └──────────────┘
```

Step 6 is parallelizable with 1–5 (the operator script is independent
of the orchestrator code). Step 7 is the merge gate: it depends on
4, 5, and 6.

---

## Step 0 — Request-aware backend resolver ✅ SHIPPED

**Status:** Shipped in PR #57 (commit `1b86876`).

**Scope:** `resolveCommunityProvisioningBackend` now takes a
`ProvisioningRequestShape { hasNamespace: boolean }`. Namespaced
requests always go to `tursoOperatorProvisioningBackend` regardless
of the d1_native env flag; only namespaceless requests get
`d1NativeProvisioningBackend` when the flag is set + shard is bound.

**Why this is step 0:** Without request-aware resolution, flipping
`COMMUNITY_PROVISION_BACKEND=d1_native` on any env would brick every
namespaced community create (the env flag is global, but the
namespace-attach path can't be routed to d1 today). The fix must
ship before the keystone de-staticization, not after.

**Files touched:**
- `services/api/src/lib/communities/provisioning/backend.ts` (signature + body)
- `services/api/src/lib/communities/provisioning/service.ts` (2 call sites)
- `services/api/src/lib/communities/provisioning/backend.test.ts` (7 existing tests updated + 1 new test)

**Acceptance criteria (§8.0):**
- `resolveCommunityProvisioningBackend(env, { hasNamespace: true })`
  with `COMMUNITY_PROVISION_BACKEND=d1_native` set and
  `COMMUNITY_D1_SHARD` bound returns `tursoOperatorProvisioningBackend`
  (NOT `d1NativeProvisioningBackend`).
- Mirror case for `{ hasNamespace: false }` returns
  `d1NativeProvisioningBackend`.

**Verified:** 8/8 pass in `bun test backend.test.ts`; typecheck clean.

---

## Step 1 — Shard `d1_pool` migration + cache layer (the keystone)

**Status:** ✅ Shipped live on staging.

### Discipline — what step 1 is and isn't

Step 1 is a **behavior-preserving refactor, not a feature**. Its
entire job: change the source of `assertCommunityBinding`'s allowlist
from the static env JSON to a shard-owned `d1_pool` table, seeded
from that same JSON on cold start — so the existing 2 pilot
communities keep working with **zero new capability and zero
behavior change**. No allocation, no new RPC, no `communityD1Bind`
surface area, no changes to the routed read/write code paths beyond
making `assertCommunityBinding` async-aware. If step 1 changes any
observable behavior for the 2 pilots, it's wrong.

The failure mode for a keystone refactor is "step 1 + a bit of step
2" — the allocator starts bleeding into the migration, scope creeps,
the diff becomes unreviewable, and security review has to chase
moving parts. The discipline is the line that keeps step 1
shippable in isolation. Step 2 builds on a dynamic allowlist that
actually exists.

### Merge gate — when step 1 is done

The §8.2 poisoned-routing-row test passes. The 2 pilots' routed
reads/writes are **byte-identical** before and after (capture
before/after at the wrangler tail level: same SQL, same results,
same row counts, no new errors in the logs). No new RPC is exposed
on the shard's `WorkerEntrypoint`. The cache layer is in place but
cold — the 2 pilots' `assertCommunityBinding` calls all hit
`d1_pool` directly on the first read, then warm the cache. The
quarantine window constant is in the code with a comment pointing
at the cache TTL (see the supporting detail below) so step 5's
implementer cannot violate the relationship.

### Supporting detail

#### 1. Ops prerequisite first, before any code

Before touching any TypeScript:

1. `wrangler d1 create` a **separate metadata D1** — NOT a
   community pool database, NOT an existing shard D1. This is the
   shard's internal store for `d1_pool`. Bind it in
   `services/community-d1-shard/wrangler.jsonc` as a new D1 entry
   (e.g. `D1_POOL`). The shard must never write community data to
   this database and must never run pool queries against a
   community database. Get this binding live in staging (deploy the
   shard with an empty `d1_databases` plus the new `D1_POOL` entry,
   even before the code changes) so `wrangler dev` resolves it. If
   you skip this, the rest of step 1 cannot be tested locally and
   you're flying blind against production-shaped deployments.

2. Confirm Cloudflare API access for D1 create in this environment
   (per the operational prerequisites section). The
   `allocate-d1-pool.ts` script in step 6 needs the same access; if
   it's not here, step 1 still works (it doesn't create new
   community pool DBs — only the metadata D1 above), but step 6
   blocks.

#### 2. Migration — full column set now, not later

The `d1_pool` migration ships with the **complete** column set
from design §3.1: `binding_name`, `community_id`, `allocated_at`,
`last_loaded_at`, `released_at`, `last_error`, `version`. Even
though step 5 is what exercises `released_at` and step 2 is what
exercises `version` and the optimistic-lock UPDATE, landing the
full set in step 1 means step 5 doesn't need a separate migration.
The cost is one extra nullable column now; the cost of deferring is
a second migration with concurrent ALTER-TABLE coordination
across shard isolates.

`released_at` and `version` are nullable / have defaults so the
cold-start seed (§5 below) can INSERT with only the columns it
knows about.

#### 3. The async ripple is the bulk of the diff

`assertCommunityBinding` (shard-read.ts:52) is currently
**synchronous** — it reads the env JSON. Reading `d1_pool` makes it
async. Every caller must be updated:

- `runShardRead` (shard-read.ts:116): `await assertCommunityBinding(...)`
- `runShardBatch` (shard-read.ts:123): same
- `runShardWrite` (shard-read.ts:137): same

That signature change rippling through the hot path is mechanical
but must be complete — missing one caller is a silent auth bypass.
The diff is small in lines but high in reviewer attention because
it's the security-relevant change.

#### 4. Cache with the quarantine constraint written down

Per design §5: in-memory `Map<communityId, { bindingName, version,
expiresAt }>`, 60s TTL for stable rows / 5s for
`provisioning`/`last_error not null` rows. The quarantine window
(step 5's `communityD1Release` sets `released_at = now()`, the
allocator's `pickFreeBinding` filters `released_at < now() -
quarantineWindow`) must exceed this TTL — write that constraint as
a comment on BOTH the cache TTL constant AND the
`quarantineWindowMs` constant, so step 5's implementer (working
in a different PR, possibly a different week) cannot violate the
relationship by adjusting one and not the other. Concrete values:
60s stable TTL, 5s short TTL, 5-min quarantine — but the comment
is the load-bearing artifact, not the values.

#### 5. Cold-start seed, idempotent

Read `COMMUNITY_D1_BINDING_MAP_JSON` once on cold start, INSERT ...
ON CONFLICT (binding_name) DO NOTHING into `d1_pool` with
`community_id` set (allocated) for the 2 pilots. This means the
seed only fires the first time a binding is seen — re-deploys
don't clobber the rows step 2's allocator later writes. The
`ON CONFLICT` is on `binding_name` (the PRIMARY KEY), not
`community_id` — the conflict is about the row existing at all,
not about who's allocated. After seeding, drop the env var from
`wrangler.jsonc` (the seed already ran, future isolates read from
`d1_pool`).

If the env var is present and the row is already in `d1_pool` with
a different `community_id` (a real conflict, not a fresh seed),
DO NOT overwrite. Log and move on. The seed is non-authoritative
once step 2 lands.

#### 6. The security regression net is non-negotiable

The §8.2 poisoned-routing-row test is the **entire justification**
for the keystone — the two-gate property must survive
de-staticization. The test:

- Seeds `d1_pool` with community A → A's binding and community B →
  B's binding (the realistic post-step-2 state, but achievable in
  step 1 by hand-inserting the rows).
- Calls `upsertD1CommunityRoutingRow` (on the API's
  `community-routing-repository.ts`) to write a control-plane row
  that points community A at B's binding.
- Calls `assertCommunityBinding` for A with B's bindingName on
  the shard.
- Asserts: rejected with `BINDING_NOT_ALLOWED`, because the
  shard's `d1_pool` says A → A, not A → B.

If this test doesn't pass, the design is wrong, not the test.
That's the keystone's reason for existing — without
shard-independent authorization, the control plane becomes a
single point of compromise, and the static map's defense-in-depth
property is gone.

### Scope (one-paragraph reference)

The shard gains a separate internal D1 (the metadata D1 from
prerequisite 1) with a `d1_pool` table tracking `(binding_name,
community_id, allocated_at, last_loaded_at, released_at,
last_error, version)`. The static `COMMUNITY_D1_BINDING_MAP_JSON`
env var becomes the cold-start bootstrap seed (read once,
inserted idempotently, then read from `d1_pool` thereafter). An
in-memory cache fronts `assertCommunityBinding` (60s TTL stable,
5s short for degraded rows). `assertCommunityBinding` becomes
async; all three callers (`runShardRead`, `runShardBatch`,
`runShardWrite`) await it. The `released_at` column ships here
even though step 5 is what writes it — the column is free now,
expensive as a follow-up migration.

**Why this is the keystone:** Until the shard has a runtime-sourced
allowlist, every `communityD1Bind` allocation the API hands the
shard is rejected with `BINDING_NOT_ALLOWED` — the shard's static
map has never heard of the new community. Without the keystone,
steps 2–7 are building against an integration that fails closed.

**Security property at risk:** the two-gate authorization (control-
plane row + shard allowlist). The "lazy fix" (have the shard read
the same control-plane row the API trusts) collapses them into one
source of truth and deletes the poisoned-routing-row protection.
This step keeps the two stores independent: the API owns the
control-plane row, the shard owns `d1_pool`, neither trusts the
other's writer.

**Files touched:**
- `services/community-d1-shard/wrangler.jsonc` (new `D1_POOL`
  binding; seed the env var initially, drop after first deploy)
- `services/community-d1-shard/migrations/` (new migration for
  `d1_pool` with the full §3.1 column set)
- `services/community-d1-shard/src/shard-read.ts` (`assertCommunityBinding`
  becomes async; cache layer; cold-start seed)
- `services/community-d1-shard/src/env.ts` (keep
  `COMMUNITY_D1_BINDING_MAP_JSON` for the seed; the
  `ShardEnv` type drops it after seeding lands — or keeps it as
  an explicit "seed source" field, not a runtime auth source)
- `services/community-d1-shard/src/shard-read.test.ts`
  (allowlist-independence test per §6 below; the existing tests
  are updated for the async signature)

**Acceptance criteria (§8.2):**
- Unit test that proves: writing a `community_database_routing` row
  that points community A at community B's binding (via the API's
  `upsertD1CommunityRoutingRow`) STILL fails `assertCommunityBinding`
  on the shard, because the shard's `d1_pool` row has A → A's
  binding, not A → B's. The poisoned-routing-row property survives
  the de-staticization.
- The 2 pilots' routed reads/writes are byte-identical before and
  after the step 1 deploy (verified via `wrangler tail` capture
  on a representative read for each pilot).
- No new RPC is exposed on `CommunityD1Shard`'s
  `WorkerEntrypoint`. The shard's public surface is unchanged.

**Risk:** Highest in the workstream. The static allowlist has
served as a defense-in-depth backstop for every read since PR2. The
keystone is replacing that backstop with a runtime-sourced table
that's written by the new allocator RPC; security review is the
gate.

**Blocked by:** Step 0.
**Blocks:** Steps 2, 3, 4, 5, 6.

---

## Step 2 — Shard `communityD1Bind` RPC + idempotency

**Status:** ✅ Shipped live on staging.

**Scope:** New RPC on `CommunityD1Shard` (services/community-d1-shard/
src/index.ts). Per §3.3, §4.1: get-or-allocate keyed on `community_id`,
with the UNIQUE(community_id) catch-and-return-winner for concurrent
allocators, the optimistic-lock `version` field, and the
`released_at < now() - 5min` quarantine filter on `pickFreeBinding`.

**Why this before snapshot-load:** `communityD1LoadSnapshot` re-
validates the pool-row before any write; the pool row exists only
after `communityD1Bind` claims it. Order: claim → load.

**Files touched:**
- `services/shared/src/shard-read-contract.ts` (add `ShardBindRequest`,
  `ShardBindResponse`, extend `ShardPoolRpc`)
- `services/community-d1-shard/src/shard-read.ts` (new
  `runShardBind` function)
- `services/community-d1-shard/src/index.ts` (wire `communityD1Bind`
  to `runShardBind`)
- `services/community-d1-shard/src/shard-read.test.ts` (idempotency
  test, concurrent-allocator test)

**Acceptance criteria (§8.3):**
- `communityD1Bind(X)` called twice in a row returns the same
  `bindingName` and reports `allocated: false` on the second call.
  A second community's call does NOT receive the first community's
  binding.
- Concurrent `communityD1Bind(X)` + `communityD1Bind(X)` (two
  simultaneous calls for the same community) both succeed with the
  same `bindingName`, exactly one reports `allocated: true`, the
  other reports `allocated: false` (the UNIQUE(community_id) catch
  path).
- `d1_pool_exhausted` returned when the pool is empty (after
  exhausting the quarantine window).

**Blocked by:** Step 1.
**Blocks:** Step 4.

---

## Step 3 — Shard `communityD1LoadSnapshot` RPC + bootstrap guard

**Status:** ✅ Shipped live on staging.

**Scope:** New RPC per §4.2. Atomic `batchWrite` of schema DDL +
snapshot rows. Sets `d1_pool.last_loaded_at = now()` only on full
success. Re-validates the pool-row before any write (the §4.2
invariant against the release-and-reallocate window). New guard
`isBootstrapAllowedStatement` allows `CREATE TABLE IF NOT EXISTS` +
`INSERT` only (the existing `WRITE_NOT_ALLOWED` rejects DDL by
design). The existing `assertCommunityBinding` is the per-request
auth.

**Why this is parallel to step 2:** the two new RPCs are independent
implementations; they can be developed and reviewed in parallel PRs.

**Files touched:**
- `services/shared/src/shard-read-contract.ts` (add
  `ShardLoadSnapshotRequest`, `ShardLoadSnapshotResponse`, extend
  `ShardBootstrapRpc`)
- `services/community-d1-shard/src/shard-read.ts` (new
  `runShardLoadSnapshot`, the bootstrap guard, the pool-row re-
  validation, the `last_loaded_at` write)
- `services/community-d1-shard/src/index.ts` (wire
  `communityD1LoadSnapshot`)
- `services/community-d1-shard/src/shard-read.test.ts` (idempotency
  test, `last_loaded_at` semantics test)

**Acceptance criteria (§8.4):**
- `communityD1LoadSnapshot` called twice with the same
  `(communityId, bindingName)` does not duplicate rows. The second
  call's `rowsAffected` is the actual changes from the re-run, not
  the cumulative count.
- `d1_pool.last_loaded_at` is set on the first call's success and
  unchanged on the second (idempotent no-op).
- A pool row whose `community_id` doesn't match the request's
  `communityId` is rejected with `shard_binding_not_allocated`
  (the re-validation invariant).

**Blocked by:** Step 1.
**Blocks:** Step 4.

---

## Step 4 — API `d1_native.provision()` orchestration

**Status:** ✅ Shipped live on staging.

**Scope:** Replace the `notImplementedError` in
`d1NativeProvisioningBackend.provision` (backend.ts:211) with:
`communityD1Bind` → `upsertD1CommunityRoutingRow('provisioning')` →
`communityD1LoadSnapshot` → `upsertD1CommunityRoutingRow('ready')` →
`persistProvisionedD1Binding`. The local snapshot is built by the
existing `bootstrapCommunityLocalSnapshot` (no change to that helper),
then translated to a `ShardSqlStatement[]` and handed to the load
RPC. The `d1_native.provision()` finally returns
`{ mode: "d1_native", binding: <concrete>, credential: null, localSnapshot: null }`.

**Why the §8.1 service test ships here:** the gap-5 defensive test
in PR #57 covered the repo-level primitives (create + null-credential
persist + succeed). It could not reach the service-level orchestration
because `provision()` was a hard throw. Once `provision()` is wired
with the four new RPCs, the service-level test (a single
`createNamespacelessCommunity` call against a fake `ShardRpc` + a
real control plane + the routed read/write clients) becomes writable.
That's the §8.1 acceptance criterion.

**Files touched:**
- `services/api/src/lib/communities/provisioning/backend.ts`
  (replace the throw with the orchestration)
- `services/api/src/lib/communities/provisioning/service.ts` (no
  change expected — the persist path is already tolerant of the
  d1 shape from PR #57)
- `services/api/src/lib/communities/provisioning/backend.test.ts`
  (replace the "fails loud" test with an end-to-end fake-shard test)

**Acceptance criteria (§8.1):**
- `createNamespacelessCommunity` with
  `COMMUNITY_PROVISION_BACKEND=d1_native` and a real (or fake)
  `COMMUNITY_D1_SHARD` reaches `markCommunityProvisioningSucceeded`
  and produces a `community_database_routing` row at
  `backend='d1', provisioning_state='ready'`.

**Risk:** The orchestration crosses three independent stores (shard
`d1_pool`, community D1, control-plane Postgres) with no atomicity.
The failure model is in §6; the partial-failure handling lives in
step 5.

**Blocked by:** Steps 2 and 3.
**Blocks:** Steps 5, 7.

---

## Step 5 — Reconciliation sweep

**Status:** Pending.

**Scope:** New cron-triggered Worker (or addition to an existing
cron Worker). Reads `community_database_routing` for
`backend='d1', provisioning_state='provisioning', updated_at <
now() - 15 minutes`; for each, calls
`communityD1GetPoolRow(bindingName)` (new admin RPC); on
`last_loaded_at IS NOT NULL` advances the routing row to `ready` and
re-runs `persistProvisionedD1Binding`; on `last_loaded_at IS NULL`
drops the community D1's user tables via `communityD1Reset` (new
admin RPC) and calls `communityD1Release` (new admin RPC) to free
the pool row (which sets `released_at = now()` so the §3.3
quarantine applies).

**Why this is its own step (not bundled with step 4):** the
reconciler is admin-level, uses a separate service-level auth path
(per §4.3), and has its own test surface. Bundling it with the
orchestration would entangle two reviewers.

**Files touched:**
- `services/community-d1-shard/src/index.ts` (new admin RPCs:
  `communityD1GetPoolRow`, `communityD1Reset`, `communityD1Release`)
- `services/shared/src/shard-read-contract.ts` (add admin request/
  response types, extend `ShardAdminRpc`)
- `services/api/src/lib/communities/provisioning/reconciler.ts`
  (new — the cron handler)
- New cron Worker, or addition to an existing one
- `services/api/tests/provisioning-reconciler.test.ts` (new)

**Acceptance criteria (§8.5):**
- Seeded "stuck provisioning" state (pool row claimed,
  `last_loaded_at` NULL because the snapshot-load crashed mid-way,
  routing row at `provisioning` for 16 minutes) runs through the
  reconciler and lands in the correct terminal state: pool row
  released, community D1 user tables dropped via
  `communityD1Reset`, ready for a fresh `provision()`.
- Second test: seeded "load completed but routing not flipped"
  state (`last_loaded_at` set, routing row still at `provisioning`)
  asserts the reconciler advances to `ready` and re-marks the
  binding row.

**Blocked by:** Step 4.
**Blocks:** Step 7.

---

## Step 6 — Pool allocator operator script (parallelizable)

**Status:** Pending. Can run in parallel with steps 2–5.

**Scope:** New operator script `allocate-d1-pool.ts` (in
services/community-provision-operator/scripts/). Runs
`wrangler d1 create` N times, adds the new bindings to
`services/community-d1-shard/wrangler.jsonc` `d1_databases`, INSERTs
them into `d1_pool` with `community_id = NULL` and
`released_at = NULL`. The script is idempotent (re-running it
creates only the missing entries).

**Why this is a separate step:** the script is purely operational —
no new code in the API or shard, no new RPC, no new test surface. It
is a `wrangler d1 create` wrapper + a few `INSERT`s.

**Files touched:**
- `services/community-provision-operator/scripts/allocate-d1-pool.ts` (new)
- `services/community-d1-shard/wrangler.jsonc` (new entries, managed
  by the script — not hand-edited)
- `services/community-provision-operator/README.md` (operator
  runbook entry)

**Acceptance criteria:**
- `bun run allocate-d1-pool.ts --count N` creates N D1 databases,
  adds them to the shard's `d1_databases`, and inserts them into
  `d1_pool` as free. Re-running with the same `--count` is a no-op.
- Manual verify: `SELECT binding_name, community_id, released_at
  FROM d1_pool` shows the new bindings at `community_id = NULL,
  released_at = NULL`.

**Blocked by:** Step 1 (the `d1_pool` table must exist).
**Blocks:** Step 7.

---

## Step 7 — Staging drill (the merge gate)

**Status:** Pending.

**PREREQUISITE (discovered during step 5's live smoke — do this FIRST):**
`pirate-api-d1-staging` is a **code-only deploy** — its only secret is
`SHARD_ADMIN_TOKEN`. It has **no `CONTROL_PLANE_DATABASE_URL`** (and ~none of the
other secrets the working `pirate-api-staging` worker has). So every
control-plane operation on it is inert — the step-4 orchestrator's routing/binding
writes AND the step-5 reconciler sweep have NEVER run live (both verified only
against fake control planes in unit tests). The drill's worker must be **fully
secret-configured first**: source `CONTROL_PLANE_DATABASE_URL` (the staging
control-plane connection string — from Infisical / the secret store, NOT a guess)
+ the rest of the staging secret set. NOTE: this points the worker at the SHARED
staging control plane (same one main staging uses) — the reconciler will then
read/write real `community_database_routing` rows (currently just the 2 pilots,
both `ready` → no-op, but it is shared data). Requires explicit go for shared-data
writes. Until this is done, "live on d1-staging" is true for the shard side only.

**Scope:** End-to-end on staging:
1. Pre-allocate 1–2 D1 dbs with the step 6 script.
2. Set `COMMUNITY_PROVISION_BACKEND=d1_native` on the staging API
   env; deploy.
3. Create a namespaceless community via the staging API.
4. Verify: shard `wrangler tail` shows
   `rpcMethod: communityD1Bind` and `rpcMethod: communityD1LoadSnapshot`
   succeeding.
5. Read the community's preview / metadata via the API; confirm
   the routed read hits the shard and returns the seeded community
   metadata.
6. Create a namespaced community on the same env; confirm the shard
   `wrangler tail` shows NO D1 RPCs for the namespaced request
   (verifying the v1 scope rule).
7. Run the reconciliation sweep with a stuck-provisioning state;
   confirm it advances to `ready` (or releases the pool row).
8. Roll back the env flag.

**Why this is the merge gate:** every other step is unit-tested with
a fake `ShardRpc` and an in-memory SQLite. The first real signal
that all the pieces fit together is a staging create + a shard tail.
The namespaced-vs-namespaceless split is also the only place the
v1 scope rule is exercised end-to-end.

**Files touched:**
- Operator runbook (not committed; lives in the ops doc repo).
- `services/api/wrangler.jsonc` (staging env vars — the env flag
  is reverted after the drill).

**Acceptance criteria (§8.6):**
- Namespaceless create: end-to-end success, shard tail shows the
  two D1 RPCs, routed read returns the seeded metadata.
- Namespaced create: zero D1 RPCs in the shard tail (the v1 scope
  rule is in effect).
- Reconciliation: a seeded stuck state is recovered correctly by
  the sweep.

**Blocked by:** Steps 4, 5, 6.
**Blocks:** Merge of any of the above to `main` (the workstream
isn't done until the staging drill passes).

---

## Operational prerequisites (set up before step 1)

- Shard Worker deploy access: `wrangler deploy` to
  `community-d1-shard-staging` from this workspace.
- Cloudflare account with D1 create permission for the operator
  allocator script.
- A staging API env that can flip `COMMUNITY_PROVISION_BACKEND` and
  bind the `COMMUNITY_D1_SHARD` service binding.
- A staging control plane with the
  `community_database_routing` 0117 migration applied (it is, as of
  the prior slices).
- `services/shared` published with the new RPC contract types (the
  step 1/2/3 changes need to land in `services/shared` first or
  alongside).

---

## Non-scope (deliberately deferred)

Mirrors `D1-NATIVE-PROVISIONING-DESIGN.md §10`. Carried forward so
the workstream doesn't drift into them:

- Per-region D1 placement (one shard per region + `shard_worker_id`
  picker). Out of scope; the spec's §7 already defers this.
- D1-native migration of existing Turso communities. That's the
  `flip-community-to-d1` flow, already built.
- Cache invalidation broadcast across Worker isolates. The 60s TTL
  + 5-min quarantine is acceptable for staging; a DO-based
  invalidation channel is its own design.
- D1-side rate limiting / quota.
- The ~98 `openCommunityDb(` call sites (measured 2026-06-20:
  `rg "openCommunityDb\(" services/api/src | wc -l` = 98; prior 113/161
  figures counted mentions/imports, not calls) still on the legacy
  factory. None target `d1://shard/%` yet, so the merge-gate D1 community
  is not reachable by existing read/write code until this migration runs.
  Independent workstream, tracked separately.
- Decommission of a d1_native community. D1 deletion is CLI-only.
  Mirror the existing Turso decommission flow once the basics land.

---

## How to use this file

- **Reviewing the workstream:** start at the dependency graph; the
  critical path is 0 → 1 → {2, 3} → 4 → 5 → 7. Step 6 is
  parallelizable.
- **Picking up a step:** each step has Files touched + Acceptance
  criteria + Blocked by / Blocks. Open the design doc, jump to the
  section references, and you have everything you need.
- **Closing a step:** mark the Status column in the table at the
  top; if the step landed in a PR, link the PR. If the step needs
  a design change, write a new revision of the design doc and bump
  the section references in this file.

Last updated: alongside PR #57 (7 commits, foundation boundary).
