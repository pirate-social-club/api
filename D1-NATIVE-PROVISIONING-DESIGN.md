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
  last_loaded_at TEXT,                    -- when snapshot-load last succeeded (NULL = not yet, or rolled back)
  released_at    TEXT,                    -- when the reconciler released this binding; see §3.3 quarantine
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
WHERE community_id IS NULL AND (released_at IS NULL OR released_at < ?)
ORDER BY binding_name LIMIT 1` where the parameter is
`now() - quarantineWindow`. The `released_at` filter is the **quarantine
window** — see §5; without it, a binding released by the reconciler (§6)
and reallocated to a different community can be reached by a stale
cache holding the old (communityId → bindingName) mapping, defeating
the two-gate authorization. The quarantine window must exceed the
maximum of every cache TTL in the system (shard-side pool cache,
API-side `CommunityBindingResolver` cache), with headroom. Concrete
value: **5 minutes**, which covers the 60s shard cache + 60s API
resolver + propagation slack.

The allocator then `UPDATE`s the row in a single statement:

```sql
UPDATE d1_pool
SET community_id = ?2,
    allocated_at = ?3,
    released_at = NULL,
    last_loaded_at = NULL,
    last_error = NULL,
    version = version + 1
WHERE binding_name = ?1
  AND community_id IS NULL
  AND (released_at IS NULL OR released_at < ?4)
```

If 0 rows are affected, the row was claimed by a concurrent allocator
(UNIQUE on community_id will catch it too — see concurrency below) or
the row is still in quarantine. Re-`SELECT` to discover which: if the
row's `community_id` is the one we just claimed, the UPDATE succeeded
on a retry; if it's NULL, the row is still quarantined; if it's a
different community, the row was claimed by someone else and we need to
pick a different free binding. Up to N retries; if still nothing,
return `d1_pool_exhausted`.

**Concurrency: catching the UNIQUE violation.** Two simultaneous
`communityD1Bind(X)` calls (user double-submit, or two API isolates
behind the resolver) both pass the initial `SELECT WHERE community_id
= X` (no row), both `pickFreeBinding()` (possibly different bindings),
and both `UPDATE SET community_id = X` — the `UNIQUE(community_id)`
constraint makes the second one a SQLITE_CONSTRAINT_UNIQUE violation.
The shard implementation MUST catch this in the allocator: on the
UNIQUE violation, re-`SELECT binding_name FROM d1_pool WHERE
community_id = ?` to find the winner, and return that binding (with
`allocated: false`, since this caller did not perform the allocation).
Without this catch, a double-submit surfaces an unmapped 500 instead
of a correct idempotent response.

`shard_pool_write_conflict` (the optimistic-lock error in §4.1) is a
different code path — it's a `version` mismatch on a row we already
tried to UPDATE, not a UNIQUE on `community_id`. Both retries are
transient; both end with the same idempotent return on success.

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
}

export type ShardLoadSnapshotResponse = {
  rowsAffected: number
}

export interface ShardBootstrapRpc {
  communityD1LoadSnapshot(input: ShardLoadSnapshotRequest): Promise<ShardLoadSnapshotResponse>
}
```

The authorization is the existing `assertCommunityBinding` (the
`bindingName` is in `d1_pool.community_id` for this `communityId`).
No `allocationToken` field — the request fields ARE the auth, and
adding a token that is just the request fields restated would imply a
protection that isn't there. If a future design needs a per-allocation
nonce (e.g. for revoking a half-finished load), it should be a real
opaque value stored on the pool row at allocation time and rotated on
every load — but that's a later iteration, not v1.

Two new invariants this RPC must enforce (server-side, in addition to
the existing `assertCommunityBinding` + `resolveD1`):

1. **Re-validate the allocation against the pool table.** The existing
   `assertCommunityBinding` checks the (communityId, bindingName) pair
   against the in-memory pool cache, which can be stale. Before any
   write, the load RPC MUST re-`SELECT community_id FROM d1_pool WHERE
   binding_name = ?` and confirm the row's `community_id` matches
   `input.communityId`. If the row's `community_id` is NULL (released)
   or a different community, reject with `shard_binding_not_allocated`.
   This re-validation is the last line of defense against the
   release-and-reallocate window (see §5 quarantine).
2. **Idempotent on retry.** If `last_loaded_at IS NOT NULL` for this
   binding, the load is a no-op (returns `rowsAffected: 0` and the
   previously-recorded timestamp). Snapshot-load is expensive
   (DDL + rows), and the retry path in `resolveProvisioningRetryAction`
   WILL call this twice for the same community. The reconciler (§6) keys
   off `last_loaded_at` for the same reason — see the §6 fix.

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
behavior the resolver was built around.

**Cache + release/reallocate is a cross-tenant hole without a
quarantine window.** A stale cache entry that holds community A →
bindingY while bindingY is released by the reconciler and reallocated
to community B will authorize a request that arrives during the stale
window against community B's data — exactly the cross-tenant read the
two-gate authorization exists to prevent. The cache being an
optimization is true in isolation; it is false once release+reallocate
exists. The mitigation is the **5-minute quarantine window** on
released bindings (§3.3): `communityD1Release` sets
`d1_pool.released_at = now()`; the allocator's `pickFreeBinding` will
not return that binding until `released_at < now() - 5 minutes`. The
quarantine exceeds the worst-case combined TTL of the shard-side pool
cache (60s) + the API-side `CommunityBindingResolver` cache (60s) +
propagation slack, so any cache that could hold a stale mapping will
have expired before the binding is reusable.

The 5-minute quarantine is a security property, not an optimization,
and ships with the keystone de-staticization. It is NOT deferred.

For the v1 staging drill: a 60s TTL + 5-min quarantine is acceptable.
The cross-isolate invalidation broadcast remains a follow-up
optimization — quarantine makes correctness independent of the
broadcast being implemented.

## 6. Failure model: partial-failure reconciliation

D1 has no cross-database transactions. The `communityD1Bind` →
snapshot-load → routing-flip sequence runs across three independent
stores (shard `d1_pool`, community D1, control-plane Postgres) with no
atomicity boundary. Crashes leave the world in one of these states:

| Crash point | State | Cleanup |
|---|---|---|
| Before `communityD1Bind` returns | No pool row claimed, no routing row, no community D1 writes. | Nothing to clean. The retry path re-runs `provision()`. |
| After `communityD1Bind`, before snapshot-load | Pool row claims binding for community. No community D1 writes. | Reconciliation sweep (below) frees the pool row after N minutes. |
| During snapshot-load | Pool row claims; community D1 is partially written. | Reconciler drops all user tables and frees the pool row (`last_loaded_at IS NULL` is authoritative). |
| After snapshot-load, before `upsertD1CommunityRoutingRow('ready')` | Pool row claims; community D1 fully written; routing row at `provisioning`. | Reconciler advances routing row to `ready` and re-marks the binding row via `persistProvisionedD1Binding` (key off `d1_pool.last_loaded_at IS NOT NULL`). |
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

For each, the reconciler's signal is `d1_pool.last_loaded_at`. The
`communityD1LoadSnapshot` RPC (§4.2) sets `last_loaded_at = now()` on
the pool row only after the full DDL + rows batchWrite completes
successfully; on partial success it leaves the column NULL. So
`last_loaded_at IS NOT NULL` is the authoritative answer to "is this
community fully loaded?" — there is no need to inspect
`sqlite_master` table counts, and using a table-count heuristic would
be both weaker and redundant: a community with all DDL applied but
rows missing would wrongly advance to `ready` (schema count passes,
content is empty).

The reconciler queries the pool table via a new admin RPC
(`communityD1GetPoolRow` — service-level authenticated, NOT the per-
community (communityId, bindingName) auth the read/write RPCs use). On
the API side, the reconciler can `SELECT * FROM d1_pool WHERE
binding_name = ?` via a shard service-binding RPC, but using a
dedicated admin RPC is cleaner: the reconciler is not impersonating the
community, and we don't want to give it a per-community auth token.

Then:
1. If `last_loaded_at IS NOT NULL`, the load completed. Advance the
   routing row to `ready` and run `persistProvisionedD1Binding` to
   re-mark the binding row — the crash was on the last step.
2. Else, drop the community D1's user tables via a new
   `communityD1Reset` admin RPC and call `communityD1Release(bindingName)`
   on the shard to free the pool row. The next retry path re-runs
   `provision()` and gets a fresh binding (subject to the §5
   quarantine window).

The original "count sqlite_master tables" heuristic is removed. The
`communityD1Inspect` admin RPC is dropped from the design (no caller
remains); only `communityD1GetPoolRow` is needed for reconciler
introspection. If a future need arises (e.g. operational debugging
without going through the API), a `communityD1Inspect` returning
`{ tableCount, lastError }` can be added later — it's a one-line
extension of `communityD1GetPoolRow`.

This is not a "real-time" recovery (15-min lag), but it is correct
eventual recovery, and the user-facing impact is "a community create
that crashed mid-flight retries on the next provision() call OR on the
next sweep, whichever comes first." The `resolveProvisioningRetryAction`
timeout (30s on `status='running'`, see
`create/repository.ts:127-152`) handles the common case; the sweeper is
the backstop for the rare crash that doesn't update the job's
`updated_at`.

## 7. v1 scope: d1_native is namespaceless-only (request-aware resolution)

`upsertLocalNamespaceAttachment` (service.ts:151-248) calls
`openCommunityDb` directly, which fails on `d1://` URLs (libsql can't
parse the scheme). Routing the namespace-write path is a separate
refactor: the namespace attach call needs to use
`openCommunityWriteClient` (community-read-access.ts:238) and the D1
write client must support the namespace-attach statements (it does, but
the call site hasn't been migrated). v1 deliberately does NOT do that
refactor.

### 7.1 The granularity problem (and why the resolver must change)

`isD1NativeProvisioningSelected(env)` (backend.ts:219) and
`resolveCommunityProvisioningBackend(env)` (backend.ts:223) are pure
env checks — they return the same backend for every request in the
env. If ops sets `COMMUNITY_PROVISION_BACKEND=d1_native` and binds a
shard, every community-create resolves to `d1NativeProvisioningBackend`
regardless of whether the request is namespaceless or namespaced. A
service-layer guard in `provisionNamespacedCommunity` that throws on
`backend.mode === 'd1_native'` (the original §7 design) does NOT solve
this — it would make every namespaced community create fail with
`d1_native_namespace_attach_unsupported` for as long as the env flag
is on. The flag would effectively disable namespaced community
creation globally.

That's not "v1 is namespaceless-only for d1_native" — that's "v1
disables namespaced community creation while d1_native is enabled,"
which is a product cliff, not a scope.

### 7.2 The fix: request-aware backend resolution

Backend selection becomes a function of (env, request-shape), where
`request-shape` is at minimum `{ hasNamespace: boolean }`. A namespaced
request ALWAYS resolves to `tursoOperatorProvisioningBackend` (or
`localDevProvisioningBackend` as the existing fallback); only
namespaceless requests get the d1_native path. Flipping the env flag
on then only changes the namespaceless default, not the namespaced
default.

Concretely:

```ts
// services/api/src/lib/communities/provisioning/backend.ts

export type ProvisioningRequestShape = {
  /** True if the create call carries a namespaceVerificationId (i.e. it's a
   * namespaced create, which routes through provisionNamespacedCommunity). */
  hasNamespace: boolean
}

export function resolveCommunityProvisioningBackend(
  env: Env,
  request: ProvisioningRequestShape,
): CommunityProvisioningBackend {
  // v1: d1_native is namespaceless-only. Namespaced requests always go
  // through the existing Turso path because the namespace-attach path
  // can't be routed to d1 today (§7.1).
  if (!request.hasNamespace && isD1NativeProvisioningSelected(env)) {
    return d1NativeProvisioningBackend
  }
  return isCommunityProvisionOperatorConfigured(env)
    ? tursoOperatorProvisioningBackend
    : localDevProvisioningBackend
}
```

Callers update accordingly: `createNamespacelessCommunity` passes
`{ hasNamespace: false }`, `provisionNamespacedCommunity` passes
`{ hasNamespace: true }`. The existing tests in
`backend.test.ts` (`d1NativeProvisioningBackend` describe block) need
to pass a request shape; the namespaceless tests should be updated to
use `{ hasNamespace: false }` and a new test should cover
`{ hasNamespace: true }` returning `tursoOperatorProvisioningBackend`
even when the env flag is set.

### 7.3 No service-layer rejection

The `d1_native_namespace_attach_unsupported` guard is REMOVED from
this design. The resolver already routed namespaced requests away from
d1_native, so the service layer never sees the combination. Any code
path that lands in `provisionNamespacedCommunity` with a
d1_native-resolved backend is a bug — the resolver is the single
decision point, and the test in §7.2 is the regression net.

This is also the property that makes the v1 rollout safe. Ops can
flip `COMMUNITY_PROVISION_BACKEND=d1_native` on a staging env and:
- Namespaceless creates use d1_native (once step 4 of the impl order
  is complete).
- Namespaced creates continue to use the Turso operator path, with
  zero change in behavior.

If the namespaceless path has a bug, the worst case is "namespaceless
creates fail with notImplementedError" (the current slice-2
behavior). Namespaced traffic is never affected.

## 8. Carry-forward acceptance criteria

These are the hard "must pass before this slice merges" checks. They
are recorded here so the implementation session doesn't ship code
without them, and so the merge-blocking bar is reviewable.

0. **Request-aware resolver test.** A unit test that drives
   `resolveCommunityProvisioningBackend(env, { hasNamespace: true })`
   with `COMMUNITY_PROVISION_BACKEND=d1_native` set and
   `COMMUNITY_D1_SHARD` bound, and asserts the result is
   `tursoOperatorProvisioningBackend` (not
   `d1NativeProvisioningBackend`). The mirror test for
   `{ hasNamespace: false }` asserts `d1NativeProvisioningBackend`.
   The existing `backend.test.ts` tests are updated to pass
   `{ hasNamespace: false }`. Ships with step 0.
1. **Service-level d1_native provisioning test.** When the
   `communityD1Bind` + `communityD1LoadSnapshot` + orchestrator
   wiring is complete, `createNamespacelessCommunity` with
   `COMMUNITY_PROVISION_BACKEND=d1_native` and a real (or fake)
   `COMMUNITY_D1_SHARD` must reach `markCommunityProvisioningSucceeded`
   and produce a `community_database_routing` row at
   `backend='d1', provisioning_state='ready'`. This is the gap-5
   nuance that slice 4 could not reach — it ships with step 4.
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
   does NOT receive the first community's binding. A concurrent
   `communityD1Bind(X)` and `communityD1Bind(X)` (two simultaneous
   calls for the same community) both succeed with the same
   `bindingName`, exactly one reports `allocated: true`, and the
   other reports `allocated: false` (the §3.3 UNIQUE(community_id)
   catch path).
4. **Snapshot-load idempotency test.** `communityD1LoadSnapshot`
   called twice with the same `(communityId, bindingName)` does not
   duplicate rows. The second call is a no-op (returns
   `rowsAffected: 0` and the previously-recorded timestamp). The
   `d1_pool.last_loaded_at` is set on the first call's success and
   unchanged on the second.
5. **Reconciliation unit test.** A seeded "stuck provisioning" state
   (pool row claimed, `last_loaded_at` NULL because the snapshot-load
   crashed mid-way, routing row at `provisioning` for 16 minutes)
   runs through the reconciler and lands in the correct terminal
   state (pool row released, community D1 user tables dropped via
   `communityD1Reset`, ready for a fresh `provision()`). A second
   test seeds a "load completed but routing not flipped" state
   (`last_loaded_at` set, routing row still at `provisioning`) and
   asserts the reconciler advances to `ready` and re-marks the
   binding row.
6. **Staging drill.** A real `wrangler d1 create` + an end-to-end
   namespaceless community create via the staging API, with shard
   `wrangler tail` showing `rpcMethod: communityD1Bind` and
   `rpcMethod: communityD1LoadSnapshot` succeeding, and a subsequent
   routed read returning the seeded community metadata. A second
   drill verifies that a namespaced create on the same env still
   routes through the Turso operator path (shard `wrangler tail` shows
   no D1 RPCs for the namespaced request). This is the only
   acceptance criterion that requires ops + Cloudflare API access;
   the rest can be unit-tested with a fake `ShardRpc`.

## 9. Implementation order (sequenced, not parallel)

The order matters because each step depends on the previous. **Step 0
must ship before step 1** — without request-aware resolution, flipping
the env flag on bricks namespaced creation globally (§7.1). Step 0 is
small, locally-testable, and changes already-merged code; it has to
land as the first PR of the workstream.

0. **Request-aware backend resolver.** Per §7.2. `resolveCommunityProvisioningBackend`
   becomes `(env, request: { hasNamespace: boolean }) =>
   CommunityProvisioningBackend`. Namespaced requests always get
   `tursoOperatorProvisioningBackend`; only namespaceless requests
   get `d1NativeProvisioningBackend` when the env flag is set. The
   service.ts callers pass the request shape; existing
   `backend.test.ts` tests are updated to pass
   `{ hasNamespace: false }` and a new test covers
   `{ hasNamespace: true }` returning the Turso backend under the
   d1_native flag. PR diff is small: the function signature, the
   caller updates, and a test. **No new behavior** — the env flag
   still doesn't select d1_native in any current env, so this is
   inert until ops flips the flag. (Reviewable: "are the existing
   tests still passing for the new signature?" plus the new
   namespaced-request test.)
1. **Shard `d1_pool` migration + cache layer.** Migrations directory
   new file. `d1_pool` table created on the shard's metadata D1
   (with the `released_at` column for the §3.3 quarantine). In-memory
   cache in front of `assertCommunityBinding` (60s TTL stable, 5s
   short). The static `COMMUNITY_D1_BINDING_MAP_JSON` becomes the
   bootstrap seed for `d1_pool` (read once on cold start, insert
   into the table, then read from the table thereafter). This is the
   keystone — it unblocks everything else and is the most
   security-sensitive change. The §8.2 allowlist-independence test
   ships here.
2. **Shard `communityD1Bind` RPC + idempotency.** Per §3.3, §4.1.
   Includes the UNIQUE(community_id) catch-and-return-winner for
   concurrent allocators, and the quarantine window on the
   `pickFreeBinding` query. The §8.3 allocator-idempotency test
   ships here. Staging test: claim a binding, query `d1_pool` from
   outside, see the claim.
3. **Shard `communityD1LoadSnapshot` RPC + bootstrap guard.** Per
   §4.2. Includes the pool-table re-validation before any write
   (the §4.2 invariant against the release-and-reallocate window).
   Sets `last_loaded_at = now()` only on full success. The §8.4
   snapshot-load-idempotency test ships here. Staging test: load a
   small schema into a claimed binding, re-read `d1_pool` to confirm
   `last_loaded_at` is set, then call again and confirm no-op.
4. **API `d1_native.provision()` orchestration.** Replace the
   `notImplementedError` with: `communityD1Bind` →
   `upsertD1CommunityRoutingRow('provisioning')` →
   `communityD1LoadSnapshot` → `upsertD1CommunityRoutingRow('ready')`
   → `persistProvisionedD1Binding`. The §8.1 service-level test
   ships here (the gap-5 nuance slice 4 could not reach). The local
   snapshot is built by the existing `bootstrapCommunityLocalSnapshot`
   (no change to that helper), then translated to a
   `ShardSqlStatement[]` and handed to the load RPC.
5. **Reconciliation sweep.** Per §6. The job is a new Worker
   (or an addition to an existing cron Worker). Reads
   `d1_pool.last_loaded_at` to decide advance-to-ready vs
   drop+release. The §8.5 reconciliation unit test ships here.
6. **Pool allocator operator script.** `allocate-d1-pool.ts`:
   `wrangler d1 create` N times, add to `wrangler.jsonc`'s
   `d1_databases`, INSERT into `d1_pool` with `community_id = NULL`
   and `released_at = NULL`. Documented as an operational
   prerequisite. Staging: pre-allocate 1–2 dbs for the drill.
7. **Staging drill.** Per §8.6. This is the only step that cannot
   be done by `bun test`. Confirms end-to-end: env flag on,
   namespaceless create reaches `markCommunityProvisioningSucceeded`,
   routed read on the new community hits the shard and returns the
   seeded metadata, namespaced create continues to use the Turso
   operator path with zero change.

Each step is a separate PR. Step 0 is small and reviewable in 10
minutes. Steps 1 and 2 are the riskiest and are where the security
review needs to land. Steps 4 and 5 are the most behavior. Step 7 is
the merge gate.

**Pre-step-0 housekeeping (already in PR #57):** the four inert slices
of PR #57 (foundation, initialBinding + gated resolver,
`persistProvisionedD1Binding`, gap-5 defensive test) and the
D1-NATIVE-PROVISIONING-DESIGN.md doc are the foundation boundary
that's already merged/ready. Step 0 amends the resolver from slice 2;
everything else in slice 2 stays.

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
implementation-ready, with §3.3 covering the concurrent-allocation
catch and the §5 quarantine window. §7.2 is the request-aware resolver
change that makes the v1 scope work — without it, flipping the env
flag bricks namespaced creation globally. §8 is the merge bar. §9 is
the PR sequence, with the new step 0 (request-aware resolver) landing
before the keystone de-staticization. §10 is the deliberate non-scope.
§9 is the PR sequence. §10 is the deliberate non-scope.
