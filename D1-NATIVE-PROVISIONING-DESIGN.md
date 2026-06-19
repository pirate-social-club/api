# D1-Native Provisioning — Keystone Design (shard workstream)

Follow-up to `D1-NATIVE-PROVISIONING-SPEC.md`. The spec maps the API-side
seams and is implementation-ready for the bits that don't touch the shard's
hot-path authorization. This doc settles the bits that DO — the keystone
blocker underneath the spec's open questions 1–3, the failure model, the
v1 scope — so the implementation session starts from a written contract,
not from a guess.

It deliberately does NOT re-derive what the spec already pins
(`CommunityProvisioningBackend` shape, `upsertD1CommunityRoutingRow`,
pending-URL helpers, `persistProvisionedD1Binding`, the 1:1
one-DB-per-community model). The 1:1 model in particular is fixed and not
relitigated here.

---

## 1. Keystone blocker: the shard's allowlist is static

`assertCommunityBinding` (shard-read.ts:52) authorizes every routed
read/write against `communityBindingMap(env)` — which parses
`COMMUNITY_D1_BINDING_MAP_JSON`, a static env var baked at deploy time.
`env.ts:4-8` and the README both frame the two-gate authorization
(control-plane routing row + shard allowlist) as defense-in-depth: a
stale/poisoned control-plane row for community A cannot read community B's
binding on the same shard.

`upsertD1CommunityRoutingRow` (community-routing-repository.ts:151) writes
`backend='d1'` rows at runtime. The API will happily dispatch a routed
read for a newly-allocated community to the shard — and the shard will
reject it with `BINDING_NOT_ALLOWED` because its static map has never
heard of the new community. Dynamic provisioning is fundamentally blocked
until the allowlist is runtime-sourced, not deploy-time-baked.

**No amount of `communityD1Bind` work matters until this is solved.**
Allocation the shard will then refuse to honor is useless.

## 2. The "lazy fix" collapses the security property

The obvious move — have the shard read the same
`community_database_routing` table the API already trusts — is wrong. It
collapses the two gates into one source of truth and deletes the
poisoned-routing-row protection the static map exists to provide. After
that move, any compromise that lets an attacker write a control-plane row
for community X pointing at community Y's binding is enough to read Y's
data. The static map is the second check; removing it makes the first
check the only one.

The correct fix preserves independence: the shard owns its own store of
`community_id → bindingName` mappings, written **only** by the allocator
RPC, read by `assertCommunityBinding`. The control-plane row (read by the
API) and the shard pool table (read by the shard) stay independent. A
poisoned control-plane row that points community A at community B's
binding still fails the shard's local check, because the shard's pool
table has A → its_own_binding, not A → B's binding.

**Concretely: two stores, two writers, two readers.** The API trusts the
control-plane row to know *which* binding to call with; the shard trusts
its pool table to know whether *that* binding is actually this community's.

## 3. Pool store design (shard-owned, not shared)

### 3.1 Storage

The shard gains a small metadata D1 (a separate, internal D1 database
bound on the shard, NOT one of the community pool D1s — these are the
communities' data, the shard must not write to them outside of explicit
DML RPCs). One row per binding; one row per active allocation.

```sql
CREATE TABLE d1_pool (
  binding_name   TEXT PRIMARY KEY,        -- 'DB_CMTY_<id>' (matches wrangler d1_databases entry)
  community_id   TEXT UNIQUE,             -- NULL = free; non-NULL = allocated to this community
  allocated_at   TEXT,                    -- ISO timestamp; NULL when free
  last_loaded_at TEXT,                    -- when snapshot-load last succeeded
  last_error     TEXT,                    -- last failure message, cleared on success
  version        INTEGER NOT NULL DEFAULT 0  -- optimistic-lock counter for cache invalidation
);
```

Why a separate D1 (not the shard's existing control-plane Postgres, not a
DO): the shard is a `cloudflare:workers` Worker, and its existing
primitive is D1. A DO is overkill (no per-community coordination needed
— coordination is between allocator and per-binding DML, and per-binding
DML is the community's own D1, not the pool). A separate D1 keeps the
allowlist table physically isolated from the API's control plane and from
any community's data.

### 3.2 Write semantics

The pool table is written **only** by the allocator RPC running on the
shard (`communityD1Bind`). The API NEVER writes to it directly. The
control-plane `community_database_routing` row is written **only** by the
API's `upsertD1CommunityRoutingRow`. The two writes are NOT in a
transaction (cross-process, cross-DB). That is acceptable because they
are independent statements of independent facts:

| Fact | Writer | Store |
|---|---|---|
| "Community X is bound to binding Y on shard Z" | API (provision orchestrator) | control-plane `community_database_routing` |
| "Binding Y on this shard is allocated to community X" | shard (allocator RPC) | shard `d1_pool` |

Both must be consistent for a routed read to succeed. The failure
handling section (§6) covers what happens when they diverge.

### 3.3 The "free pool" query

Allocator's `pickFreeBinding()`: `SELECT binding_name FROM d1_pool
WHERE community_id IS NULL ORDER BY binding_name LIMIT 1`. The
`UNIQUE` constraint on `community_id` ensures at most one free binding is
returned per row, and the `WHERE community_id IS NULL` is the implicit
"this is unallocated" filter. The allocator then `UPDATE`s that row
inside a transaction to set `community_id = ?` and `version = version +
1`, conditional on `version = ?` (optimistic lock). If 0 rows are
affected, retry up to N times; if still 0, return `d1_pool_exhausted`.

### 3.4 Idempotency: get-or-allocate

The retry path (`resolveProvisioningRetryAction`, create/repository.ts:134)
calls `provision()` twice for the same community if the first call
crashed mid-flight. The allocator MUST be idempotent on `community_id`:
`communityD1Bind(communityId)` returns the same `bindingName` whether
called once or N times. Implementation: check `SELECT binding_name FROM
d1_pool WHERE community_id = ?` first; if hit, return it. Otherwise pick
free + claim. Atomicity via the optimistic-lock transaction in §3.3.

A `communityD1Bind` call for an unknown community that already has a
routing row in `provisioning_state='provisioning'` on the API side MUST
NOT re-allocate; it must return the existing binding from the pool. This
is the cleanup-path correctness property — see §6.

## 4. RPC contract additions

### 4.1 `communityD1Bind`

```ts
// services/shared/src/shard-read-contract.ts (additions)

export type ShardBindRequest = {
  communityId: string
  /** ISO timestamp; recorded as allocated_at on the pool row. */
  now: string
}

export type ShardBindResponse = {
  /** The binding allocated to (or already held by) communityId. */
  bindingName: string
  /** The shard's worker id; the API writes this to community_database_routing.shard_worker_id. */
  shardWorkerId: string
  /** True if this call performed the allocation; false if the binding was already held. */
  allocated: boolean
}

export interface ShardPoolRpc {
  communityD1Bind(input: ShardBindRequest): Promise<ShardBindResponse>
}
```

Errors:

| Code | HTTP | Meaning |
|---|---|---|
| `shard_pool_exhausted` | 503 | No free binding in `d1_pool`. Retried with backoff by the API; ops must allocate. |
| `shard_pool_write_conflict` | 503 | Optimistic-lock collision after N retries. Transient; the API retries the whole `communityD1Bind` call. |
| `shard_binding_not_initialized` | 500 | A row in `d1_pool` for the chosen binding exists but the corresponding `env[bindingName]` is not a real D1 namespace (wrangler config drift). The allocator frees the row and retries. |

The shard implementation: `communityD1Bind(env, input)` runs
`assertCommunityBinding`-equivalent for *itself* — no, it doesn't,
because it's the *writer* of the allowlist. The check is "is the
requested community already in `d1_pool`? if so return its binding;
otherwise pick free, claim, return."

### 4.2 `communityD1LoadSnapshot`

```ts
export type ShardLoadSnapshotRequest = {
  communityId: string
  bindingName: string
  /** Ordered D1 statements: schema DDL first, then snapshot rows. */
  statements: ShardSqlStatement[]
  /** Token the allocator returned; the shard checks d1_pool.community_id matches input.communityId for the binding before serving. */
  allocationToken: string
}

export type ShardLoadSnapshotResponse = {
  rowsAffected: number
}

export interface ShardBootstrapRpc {
  communityD1LoadSnapshot(input: ShardLoadSnapshotRequest): Promise<ShardLoadSnapshotResponse>
}
```

Two new invariants this RPC must enforce (server-side, in addition to
the existing `assertCommunityBinding` + `resolveD1`):

1. **Re-validate the allocation.** `SELECT community_id FROM d1_pool
   WHERE binding_name = ? AND community_id = ?` — if no row, the binding
   is free or allocated to a different community, so reject with
   `shard_binding_not_allocated`. The `allocationToken` is the
   (communityId, bindingName) pair itself; the shard re-reads the pool
   table to confirm. (A separate opaque token would be cleaner, but adds
   a round-trip; the pool-row re-read is the same primitive.)
2. **Idempotent on retry.** If `last_loaded_at IS NOT NULL` for this
   binding, the load is a no-op (returns existing `rowsAffected = 0` and
   the previously-recorded timestamp). Snapshot-load is expensive
   (DDL + rows), and the retry path in `resolveProvisioningRetryAction`
   WILL call this twice for the same community.

Schema-DDL is sent as D1 `batchWrite` (D1 is permissive about `CREATE
TABLE IF NOT EXISTS` — confirm in staging; if not, the API must query
`sqlite_master` first and skip existing tables). The shard's existing
`WRITE_NOT_ALLOWED` guard is too strict for bootstrap (rejects DDL by
design) — a new guard `isBootstrapAllowedStatement` allows `CREATE TABLE
IF NOT EXISTS` and `INSERT` only.

### 4.3 Admin RPCs (service-level auth, NOT per-community)

The reconciler (§6.1) and the pool allocator (§3) need operations that
the per-community (communityId, bindingName) auth does not grant:
inspecting a community's D1, resetting it, and releasing a pool row.
These are admin RPCs, called with a service-level auth token bound on
the shard, NOT through the `assertCommunityBinding` path.

```ts
export type ShardInspectRequest = {
  bindingName: string
}

export type ShardInspectResponse = {
  tableCount: number
}

export type ShardResetRequest = {
  bindingName: string
}

export type ShardReleaseRequest = {
  bindingName: string
}

export interface ShardAdminRpc {
  communityD1Inspect(input: ShardInspectRequest): Promise<ShardInspectResponse>
  communityD1Reset(input: ShardResetRequest): Promise<ShardQueryResult>
  communityD1Release(input: ShardReleaseRequest): Promise<void>
}
```

`communityD1Release` is the one admin RPC called from the normal
provisioning path: when a `provision()` call's reconciliation decides
the partial load is bad, it releases the binding before returning the
error. The per-community path's idempotency (§4.1) means re-running
`provision()` will get a different binding on the next call.

## 5. Cache invalidation on the hot path

`assertCommunityBinding` runs on EVERY routed read and write. If it
hits the `d1_pool` D1 on every call, that's a cross-DB round trip per
request, plus the cold-start latency of opening the D1 handle. Bad.

Add a per-shard in-memory cache in front of the pool lookup:

```ts
// Per-shard Worker singleton. Keyed by communityId.
const poolCache = new Map<string, { bindingName: string; version: number; expiresAt: number }>()

// TTL: 60s for stable rows, 5s for "provisioning" / "last_error" rows.
```

The allocator RPC, after a successful `UPDATE d1_pool ... version =
version + 1`, publishes the new version to ALL shard isolates via the
Cloudflare Workers runtime API. The exact mechanism is environment-
dependent (Workers KV with a watch, or a Durable Object the shard binds
just for invalidation broadcasts). Until the broadcast mechanism is
settled, the implementation can rely on the 5s short-TTL for the
"degraded" / "last_error not null" cases and accept up to 60s of
staleness for a fresh allocation — a freshly-provisioned community
sees 503 `binding_pending` for that window if a routed read beats the
control-plane upsert to the API's resolver, which is the existing
behavior the resolver was built around. The cache is an optimization, not
a correctness requirement.

For the v1 staging drill: a 60s TTL is acceptable. The broadcast
mechanism is a follow-up optimization, not a blocker for the
"communities can be born on D1" capability.

## 6. Failure model: partial-failure reconciliation

D1 has no cross-database transactions. The `communityD1Bind` →
snapshot-load → routing-flip sequence runs across three independent
stores (shard `d1_pool`, community D1, control-plane Postgres) with no
atomicity boundary. Crashes leave the world in one of these states:

| Crash point | State | Cleanup |
|---|---|---|
| Before `communityD1Bind` returns | No pool row claimed, no routing row, no community D1 writes. | Nothing to clean. The retry path re-runs `provision()`. |
| After `communityD1Bind`, before snapshot-load | Pool row claims binding for community. No community D1 writes. | Reconciliation sweep (below) frees the pool row after N minutes. |
| During snapshot-load | Pool row claims; community D1 is partially written. | Reconciliation: check community D1 schema completeness (e.g. `SELECT count(*) FROM sqlite_master WHERE type='table'` >= N). If incomplete, drop all tables and free the pool row. If complete, advance to `ready`. |
| After snapshot-load, before `upsertD1CommunityRoutingRow('ready')` | Pool row claims; community D1 fully written; routing row at `provisioning`. | Reconciler advances routing row to `ready` and re-marks the binding row via `persistProvisionedD1Binding`. |
| After `markCommunityProvisioningSucceeded` | Everything done. | Nothing. |

### 6.1 Reconciliation sweep

A periodic job (cron-triggered Worker, or a manual operator script) that
runs:

```sql
-- Find stuck provisioning rows older than N minutes (e.g. 15).
SELECT cr.community_id, cr.binding_name
FROM community_database_routing cr
WHERE cr.backend = 'd1'
  AND cr.provisioning_state = 'provisioning'
  AND cr.updated_at < now() - interval '15 minutes'
```

For each, the reconciler calls a new admin RPC on the shard
(`communityD1Inspect` — service-level authenticated, NOT the per-
community (communityId, bindingName) auth the read/write RPCs use).
The shard runs:

```sql
SELECT count(*) FROM sqlite_master
WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
```

against the community's bound D1. (Using a dedicated admin RPC, not the
existing `execute` RPC: the reconciler is not impersonating the
community, and we don't want to give it a per-community auth token.)

Then:
1. If schema count >= the expected minimum (the count produced by the
   community schema's `COMMUNITY_MIGRATIONS` set, recorded as a constant
   in the orchestrator at provisioning time), advance routing to
   `ready` and run `persistProvisionedD1Binding` — the community is
   good, the crash was on the last step.
2. Else, drop the community D1's user tables via a new
   `communityD1Reset` admin RPC and call `communityD1Release(bindingName)`
   on the shard to free the pool row. The next retry path re-runs
   `provision()` and gets a fresh binding.

This is not a "real-time" recovery (15-min lag), but it is correct
eventual recovery, and the user-facing impact is "a community create
that crashed mid-flight retries on the next provision() call OR on the
next sweep, whichever comes first." The `resolveProvisioningRetryAction`
timeout (30s on `status='running'`, see
`create/repository.ts:127-152`) handles the common case; the sweeper is
the backstop for the rare crash that doesn't update the job's
`updated_at`.

## 7. v1 scope: d1_native is namespaceless-only

`upsertLocalNamespaceAttachment` (service.ts:151-248) calls
`openCommunityDb` directly, which fails on `d1://` URLs (libsql can't
parse the scheme). Routing the namespace-write path is a separate
refactor: the namespace attach call needs to use
`openCommunityWriteClient` (community-read-access.ts:238) and the D1
write client must support the namespace-attach statements (it does, but
the call site hasn't been migrated).

For the v1 "born on D1" capability, the d1_native path rejects
namespaced communities. Implementation: at the top of
`provisionNamespacedCommunity` (service.ts:408), if
`backend.mode === 'd1_native'`, throw an `eligibilityFailed` with
`error_code: 'd1_native_namespace_attach_unsupported'`. The audit calls
this out as the product decision; the resolution is "v1 is
namespaceless-only, route the namespace path later."

`createNamespacelessCommunity` (service.ts:250) does NOT call
`upsertLocalNamespaceAttachment`, so it's safe under d1_native today.
The v1 capability is: a user can create a namespaceless community
that is born on D1 and whose routed reads/writes work, with no
namespace attached.

## 8. Carry-forward acceptance criteria

These are the hard "must pass before this slice merges" checks. They
are recorded here so the implementation session doesn't ship code
without them, and so the merge-blocking bar is reviewable.

1. **Service-level d1_native provisioning test.** When the
   `communityD1Bind` + `communityD1LoadSnapshot` + orchestrator
   wiring is complete, `createNamespacelessCommunity` with
   `COMMUNITY_PROVISION_BACKEND=d1_native` and a real (or fake)
   `COMMUNITY_D1_SHARD` must reach `markCommunityProvisioningSucceeded`
   and produce a `community_database_routing` row at
   `backend='d1', provisioning_state='ready'`. This is the gap-5
   nuance that slice 4 could not reach — it ships with this slice.
2. **Shard allowlist independence test.** A unit test on the shard
   side that proves: writing a `community_database_routing` row that
   points community A at community B's binding (via the API's
   `upsertD1CommunityRoutingRow`) STILL fails
   `assertCommunityBinding` on the shard, because the shard's
   `d1_pool` row has A → A's binding, not A → B's. The
   poisoned-routing-row property survives the de-staticization.
3. **Idempotent allocator test.** `communityD1Bind(communityId)`
   called twice in a row returns the same `bindingName` and reports
   `allocated: false` on the second call. A second community's call
   does NOT receive the first community's binding.
4. **Snapshot-load idempotency test.** `communityD1LoadSnapshot`
   called twice with the same `(communityId, bindingName)` does not
   duplicate rows. The second call's `rowsAffected` is the actual
   changes from the re-run, not the cumulative count.
5. **Reconciliation unit test.** A seeded "stuck provisioning" state
   (pool row claimed, community D1 partially written, routing row at
   `provisioning` for 16 minutes) runs through the reconciler and
   lands in the correct terminal state (either `ready` + re-mark, or
   pool row freed, depending on the seeded partial state).
6. **Staging drill.** A real `wrangler d1 create` + an end-to-end
   community create via the staging API, with shard `wrangler tail`
   showing `rpcMethod: communityD1Bind` and
   `rpcMethod: communityD1LoadSnapshot` succeeding, and a subsequent
   routed read returning the seeded community metadata. This is the
   only acceptance criterion that requires ops + Cloudflare API
   access; the rest can be unit-tested with a fake `ShardRpc`.

## 9. Implementation order (sequenced, not parallel)

The order matters because each step depends on the previous.

1. **Shard `d1_pool` migration + cache layer.** Migrations directory
   new file. `d1_pool` table created on the shard's metadata D1.
   In-memory cache in front of `assertCommunityBinding`. The static
   `COMMUNITY_D1_BINDING_MAP_JSON` becomes the bootstrap seed for
   `d1_pool` (read once on cold start, insert into the table, then
   read from the table thereafter). This is the keystone — it
   unblocks everything else and is the most security-sensitive
   change.
2. **Shard `communityD1Bind` RPC + idempotency.** Per §3.3, §4.1.
   Staging test: claim a binding, query `d1_pool` from outside, see
   the claim.
3. **Shard `communityD1LoadSnapshot` RPC + bootstrap guard.** Per
   §4.2. Staging test: load a small schema into a claimed binding,
   inspect `sqlite_master` to confirm.
4. **API `d1_native.provision()` orchestration.** Replace the
   `notImplementedError` with: `communityD1Bind` →
   `upsertD1CommunityRoutingRow('provisioning')` →
   `communityD1LoadSnapshot` → `upsertD1CommunityRoutingRow('ready')`
   → `persistProvisionedD1Binding`. The gap-5 service test (§8.1)
   ships here. The local snapshot is built by the existing
   `bootstrapCommunityLocalSnapshot` (no change to that helper), then
   translated to a `ShardSqlStatement[]` and handed to the load RPC.
5. **Reconciliation sweep.** Per §6. The job is a new Worker
   (or an addition to an existing cron Worker). Unit test with
   seeded partial state.
6. **Pool allocator operator script.** `allocate-d1-pool.ts`:
   `wrangler d1 create` N times, add to `wrangler.jsonc`'s
   `d1_databases`, INSERT into `d1_pool` with `community_id = NULL`.
   Documented as an operational prerequisite. Staging: pre-allocate
   1–2 dbs for the drill.
7. **v1 scope guard.** Per §7. `provisionNamespacedCommunity` rejects
   d1_native with `d1_native_namespace_attach_unsupported`.
8. **Staging drill.** Per §8.6. This is the only step that cannot
   be done by `bun test`.

Each step is a separate PR. Steps 1 and 2 are the riskiest and are
where the security review needs to land. Steps 4 and 5 are the most
behavior; step 7 is one line. Step 8 is the merge gate.

## 10. What this design explicitly does NOT cover

Mirrors §7 of the spec; updated to reflect what this doc adds.

- **Per-shard allocation across multiple shard workers.** One shard
  per region, `shard_worker_id` picker in the API side. Out of
  scope; the spec's §7 already defers this.
- **D1-native migration of existing Turso communities.** That's the
  `flip-community-to-d1` flow, already built.
- **Cache invalidation broadcast across Worker isolates.** §5 calls
  this out as a follow-up optimization; the 60s TTL is acceptable for
  staging. A DO-based invalidation channel is its own design.
- **D1-side rate limiting / quota.** D1 has its own quotas; we
  inherit them. No application-side throttling is designed.
- **The unrouted `openCommunityDb` call sites that are still on the
  legacy factory.** The audit's gap 3 (and §7 of this doc) covers
  the namespace-attach path; the remaining ~161 unrouted call sites
  are an independent workstream, tracked separately.
- **Decommission of a d1_native community.** D1 deletion is CLI-only.
  Mirror the existing Turso decommission flow once the basics land.

---

Keystone design complete. The keystone (§1) and its security
implications (§2) are the load-bearing decisions. §3–§6 are
implementation-ready. §7 is the product call. §8 is the merge bar.
§9 is the PR sequence. §10 is the deliberate non-scope.
