# D1-Native Provisioning — Design Spec

Investigation only. No code changes. Maps what must change so new communities
get a D1 binding allocated at create time and their routing row seeded as
`backend='d1'` from day one.

## 1. Current Turso flow (the baseline)

### End-to-end create path
```
API (services/api)
  communities.create.service.ts → createCommunity()
    └─ provisioning.service.ts → createNamespacelessCommunity() / provisionNamespacedCommunity()
        ├─ resolveCommunityProvisioningBackend(env)            // backend.ts:167
        │   └─ if operator configured → tursoOperatorProvisioningBackend
        │      else                 → localDevProvisioningBackend
        ├─ backend.initialBinding(...)                            // pending libsql URL + group/location
        ├─ communityRepository.createCommunityProvisioningRequest(...)
        │   [tx, in provisioning/repository.ts:18]
        │   INSERT communities (state='provisioning', primary_database_binding_id=NULL)
        │   INSERT community_database_bindings (status='active', requires_credentials=1,
        │                                       database_url='libsql://pending-...invalid')
        │   UPDATE communities SET primary_database_binding_id = ...
        │   INSERT jobs (community_provisioning, status='running')
        ├─ backend.provision(...)                                  // backend.ts:120
        │   └─ provisionCommunityViaOperator(...)                  // operator-client.ts
        │       └─ POST to community-provision-operator Worker
        │           └─ provisionCommunityRuntime(...)                // operator/src/lib/provision-runtime.ts:20
        │               ├─ ensureGroup / ensureDatabase (Turso Platform API)
        │               ├─ mint database auth token
        │               └─ bootstrapCommunityDatabase()              // operator/src/lib/community-bootstrap.ts
        │                   └─ CREATE TABLEs + migrations via the Turso libsql URL
        └─ markCommunityProvisioningSucceeded(...)                 // provisioning/repository.ts:269
            UPDATE communities SET status='active', provisioning_state='active',
                                  primary_database_binding_id=...
            UPDATE jobs SET status='succeeded', result_ref=...
```

### Routing row today
- `community_database_routing` is written ONLY by:
  - `backfill-community-routing.ts` (Phase-0, `backend='turso'`, ON CONFLICT DO NOTHING)
  - `upsertTursoCommunityRoutingRow` (community-routing-repository.ts:98, `backend='turso'`)
  - `flip-community-to-d1.ts` (operator script, flips `turso`→`d1`)
- **There is NO `upsertD1CommunityRoutingRow` yet.** Comment at
  community-routing-repository.ts:89 explicitly says:
  > "D1 rows are written by the provisioning path (PR2+), not here."

### The backend abstraction (the seam for D1-native)
`CommunityProvisioningBackend` (backend.ts:61) — two impls:
- `localDevProvisioningBackend` (mode `local_dev`)
- `tursoOperatorProvisioningBackend` (mode `turso_operator`)

Contract:
```ts
type CommunityProvisioningBackend = {
  mode: CommunityProvisioningMode   // "local_dev" | "turso_operator"
  initialBinding(input): InitialCommunityDatabaseBinding
  provision(input): Promise<ProvisionedCommunityDatabase>
}

type InitialCommunityDatabaseBinding = {
  organizationSlug, groupName, groupId?, databaseName, databaseId?,
  databaseUrl, location?, requiresCredentials, provisioningMode,
}

type ProvisionedCommunityDatabase = {
  mode, binding: InitialCommunityDatabaseBinding,
  credential: ProvisionedCommunityCredential | null,
  localSnapshot: LocalCommunitySnapshot | null,
}
```

### D1 hard constraint (the blocker for dynamic provisioning)
- D1 has no runtime "create database" API. Databases are created out-of-band
  via `wrangler d1 create` and bound statically in
  `services/community-d1-shard/wrangler.jsonc` as `d1_databases` entries.
- The shard's runtime allowlist is
  `COMMUNITY_D1_BINDING_MAP_JSON` — a static `community_id → bindingName`
  JSON map. Currently 2 entries (the pilot + the fixture).
- The shard RPC (`execute`, `batch`, `batchWrite` — services/community-d1-shard/src/index.ts)
  only serves reads + atomic-batch writes. **No create/allocate/migrate RPC.**

So D1-native provisioning requires a **pre-allocated pool of D1 databases** +
a **dynamic binding map** + a **D1-side schema bootstrap path**.

## 2. Goal

New communities are born on D1: a D1 binding is allocated from the pool at
create time, the local libsql snapshot is loaded into that D1 binding, and
`community_database_routing` is seeded with `backend='d1'`,
`shard_worker_id`, `binding_name`, `region` from the start (no
`flip-community-to-d1` step needed later).

## 3. What `create/repository.ts` + the provisioning seam must change

### 3.1 Add a `d1_native` CommunityProvisioningBackend (backend.ts)
New impl, selected by `resolveCommunityProvisioningBackend(env)` when an
env flag is set (e.g. `COMMUNITY_PROVISION_BACKEND=d1_native`) and the
shard pool is non-empty. Follows the same contract:

```ts
const d1NativeProvisioningBackend: CommunityProvisioningBackend = {
  mode: "d1_native",                                          // NEW enum value
  initialBinding(input) {
    return {
      organizationSlug: "shard",
      groupName: "shard",
      groupId: null,
      databaseName: "pending",                                // resolved on provision
      databaseId: null,
      databaseUrl: buildPendingD1CommunityBindingUrl(input.communityId),
      location: resolveShardRegion(input.env, input.databaseRegion),
      requiresCredentials: false,                            // D1 has no token
      provisioningMode: "d1_native",
    }
  },
  async provision(input) {
    const binding = this.initialBinding({...})
    const allocation = await allocateD1BindingFromPool(input.env, input.communityId)
    // 1. call shard admin RPC (or operator) to claim a free D1 binding
    // 2. load the local libsql snapshot into that D1 binding
    //    (the local snapshot is built by bootstrapCommunityLocalSnapshot —
    //     mirror its table set in the D1 binding)
    // 3. return the resolved binding
    return { mode: "d1_native", binding: resolvedBinding, credential: null, localSnapshot }
  },
}
```

Tasks the impl needs to do (new, all behind `d1_native`):
- **Allocate** a free D1 binding from the shard pool.
- **Load** the community schema + snapshot into that D1 binding (mirrors
  `bootstrapCommunityDatabase` in operator/src/lib/community-bootstrap.ts
  but writes to D1 via the shard `batchWrite` RPC instead of Turso libsql).
- **Persist** the control-plane rows (`community_database_bindings`,
  `community_database_routing` as `backend='d1'`).

The local libsql snapshot bootstrap (`bootstrapCommunityLocalSnapshot` in
create/repository.ts:468) stays — it just becomes the source-of-truth to
load into D1, instead of being a fallback for `local_dev`.

### 3.2 Add `upsertD1CommunityRoutingRow` (community-routing-repository.ts)
Mirror of `upsertTursoCommunityRoutingRow` (line 98) but writing the
`backend='d1'` shape required by the 0117 CHECK:
```ts
export async function upsertD1CommunityRoutingRow(executor, input: {
  communityId, shardWorkerId, bindingName, region,
  now, provisioningState?: "ready" | "degraded",
}): Promise<{ inserted: boolean }>
```
INSERT `backend='d1', shard_worker_id, binding_name, region,
       turso_database_binding_id=NULL`. Unlike the Turso backfill writer
(`DO NOTHING`, which only describes pre-existing communities), the
D1-native path owns the row lifecycle, so this is `ON CONFLICT (community_id)
DO UPDATE` — but guarded `WHERE community_database_routing.backend = 'd1'`
so it can advance its own `provisioning → ready` transition yet can NEVER
clobber or downgrade a `backend='turso'` row that shares the community_id.
Update the doc comment at line 89 to point to the new function.

**IMPLEMENTED** in `community-routing-repository.ts` as
`upsertD1CommunityRoutingRow` (returns `{ written }`), with tests covering
seed-at-ready, the provisioning→ready transition, and the turso-row guard.

The `CommunityDatabaseBinding` row written by
`createCommunityProvisioningRequest` (provisioning/repository.ts:67) also
needs a `d1_native` mode: drop the Turso-only columns
(`organization_slug`, `group_name`, `group_id`, `database_name`,
`database_id`, `database_url` semantics, `requires_credentials`) or
generalize. Practical: make them nullable for `d1_native` and store the D1
identifiers (`shard_worker_id`, `binding_name`) in a new
`community_database_d1_bindings` table (or in
`community_database_bindings` with nullable Turso columns). Decision point —
see §5.

### 3.3 D1 binding pool (shard side)
The current static `COMMUNITY_D1_BINDING_MAP_JSON` must become a dynamic
allocator. Options:

**Option A (in-shard allocator):** add a `communityD1Bind` RPC on the shard
that takes a `community_id` and returns a free `bindingName` from a
shard-side pool table. The pool is seeded by an operator script
(`allocateD1Pool --count N`) that creates N D1 databases via
`wrangler d1 create` and inserts them into a shard `d1_pool` table.
Pros: consistent authz (shard is the only writer of D1 data). Cons: D1
db creation is still CLI; the pool just tracks which bindings are free.

**Option B (control-plane allocator):** keep the shard as a static
`wrangler d1_databases` list, but track assignments in the control-plane
`community_database_routing` and a new `d1_pool` table. Allocation happens
in the operator (or a new `d1-pool-allocator` service) before the shard
sees the community.
Pros: shard stays a dumb RPC. Cons: another service to deploy.

**Recommendation: Option A.** The shard is already the authz boundary for D1
reads/writes; making it the allocator too keeps the trust boundary tight.
The pool table is a small addition. The operator script that creates the
underlying D1 dbs (`allocate-d1-pool.ts`) is the only CLI step.

### 3.4 Schema bootstrap into D1
The Turso `bootstrapCommunityDatabase` (operator/src/lib/community-bootstrap.ts:558)
runs `CREATE TABLE`s + `COMMUNITY_MIGRATIONS` over a libsql URL. For D1-native
provisioning, the equivalent loads the same schema into the allocated D1
binding via the shard `batchWrite` RPC. This is a SQL-script transform
(generate one D1-compatible batchWrite from `COMMUNITY_MIGRATIONS`),
sharded-loadable, idempotent.

The local libsql snapshot rows (`bootstrapCommunityLocalSnapshot`) are
loaded as a separate batchWrite (the same rows the Turso path copies via
`copy-community-turso-to-d1`).

### 3.5 What `create/repository.ts` itself changes
Minimal. The D1-native backend reuses the existing
`bootstrapCommunityLocalSnapshot` (line 468) to build the snapshot in
memory, then the new backend's `provision` loads it into D1. So:
- **No change** to `bootstrapCommunityLocalSnapshot`.
- **Add** `buildPendingD1CommunityBindingUrl(communityId)` and
  `isPendingD1CommunityBindingUrl(...)` (mirrors the Turso pending helpers
  at lines 94/106).
- **No change** to `bootstrapCommunityLocalSnapshot` callers — the d1
  backend calls it the same way.
- The `LocalCommunitySnapshot` interface may need a D1-relevant field
  (shard_worker_id, binding_name) so the loader knows where to write.
  Decision point — see §5.

### 3.6 The provisioning hand-off (who calls who)
For `turso_operator`, the API Worker calls the operator Worker via
`provisionCommunityViaOperator` (operator-client.ts:178) — async, async
provisioning is the operator's job. For `d1_native`, the same hand-off
shape can be used: the API Worker calls a new
`allocateAndLoadD1BindingViaOperator(...)` (or directly via the shard
admin RPC, per §3.3 Option A). The provisioning job row already in
`createCommunityProvisioningRequest` (provisioning/repository.ts:102) is
reused — the `mode` payload field carries `d1_native` for the new path.

`markCommunityProvisioningSucceeded` (line 269) is backend-agnostic
already; no change. But the `metadata` it writes should include
`{ backend: "d1_native", shard_worker_id, binding_name }` so the
audit trail reflects the D1 origin.

### 3.7 The `InitialCommunityDatabaseBinding` + `ProvisionedCommunityDatabase`
For `d1_native`:
- `binding.organizationSlug = "shard"` (or the env's
  `COMMUNITY_D1_SHARD_WORKER_ID` value).
- `binding.databaseUrl = "d1://shard/<bindingName>"` (a synthetic URL the
  routed read/write clients parse to extract `bindingName`).
- `binding.requiresCredentials = false`.
- `binding.provisioningMode = "d1_native"`.

`CommunityProvisioningMode` enum (community-repository-types.ts:39) adds
`"d1_native"`.

## 4. File-by-file change list (for the implementation session)

| File | Change |
|---|---|
| `services/api/src/lib/communities/community-repository-types.ts` | add `"d1_native"` to `CommunityProvisioningMode` |
| `services/api/src/lib/communities/create/repository.ts` | add `buildPendingD1CommunityBindingUrl`, `isPendingD1CommunityBindingUrl`; consider `LocalCommunitySnapshot` D1 fields |
| `services/api/src/lib/communities/provisioning/backend.ts` | add `d1NativeProvisioningBackend` impl; extend `resolveCommunityProvisioningBackend` with env-flag + pool-availability check |
| `services/api/src/lib/communities/provisioning/operator-client.ts` | add `allocateAndLoadD1Binding(...)` hand-off (or shard-direct RPC) |
| `services/api/src/lib/communities/community-routing-repository.ts` | add `upsertD1CommunityRoutingRow`; update doc comment at line 89 |
| `services/api/src/lib/communities/provisioning/repository.ts` | generalize binding INSERT for D1 fields (nullable Turso cols, or split table); include `mode`/`shard_worker_id` in success metadata |
| `services/community-d1-shard/src/index.ts` | add `communityD1Bind` (allocate) + `communityD1LoadSnapshot` (batchWrite bootstrap) RPCs; the pool table |
| `services/community-d1-shard/src/shard-read.ts` | extend with the new pool + bootstrap helpers |
| `services/community-d1-shard/wrangler.jsonc` | D1 database pool entries + `COMMUNITY_D1_POOL_SIZE` env; keep the static `d1_databases` block (pool is just tracking) |
| `services/community-d1-shard/migrations/` | new migration: `d1_pool` table (`binding_name PK, community_id NULL, allocated_at NULL`) |
| `services/community-provision-operator/scripts/allocate-d1-pool.ts` | new script: `wrangler d1 create` N dbs, insert into `d1_pool` |
| `services/community-provision-operator/scripts/provision-d1-native.ts` | new script: end-to-end D1-native provision (load snapshot, mark ready) — for ops + bootstrap |
| `services/api/tests/community-routing-repository.test.ts` | add test for `upsertD1CommunityRoutingRow` |
| `services/api/src/lib/communities/provisioning/backend.test.ts` (new) | add `d1NativeProvisioningBackend` tests |
| `.github/workflows/api-ci.yml` | add `COMMUNITY_PROVISION_BACKEND=d1_native` to a staging matrix; no bun-version change |

## 5. Open questions / risks (resolve before coding)

1. **D1 binding table shape.** Two options:
   - (a) Generalize `community_database_bindings` to carry both Turso and
     D1 fields (make the Turso-only cols nullable, add
     `shard_worker_id`/`binding_name`). Migration: add nullable cols, no
     data backfill needed.
   - (b) Split into `community_database_bindings` (Turso) and
     `community_database_d1_bindings` (D1), with
     `community_database_routing` pointing at one or the other. Cleaner
     separation; more migration work.
   **Recommend (a).** Smaller diff, `upsertD1CommunityRoutingRow` already
   references `turso_database_binding_id` as nullable in the 0117 schema.

2. **D1 database creation.** `wrangler d1 create` is the only way today.
   The `allocate-d1-pool.ts` script must be run as an operator step before
   D1-native provisioning can serve real traffic. Document this as an
   operational prerequisite; for staging, pre-allocate 1–2 dbs.

3. **Pool exhaustion.** What happens when the pool is empty? Two options:
   fall back to `turso_operator` (mixed environment), or fail the create
   with a clear error (force ops to allocate). Recommend: fail with a
   `d1_pool_exhausted` error and a Cloudflare metrics counter; ops
   allocate + redeploy. Falling back silently defeats the "D1-native"
   goal.

4. **Local libsql snapshot → D1 load.** The snapshot is built as
   libsql-compatible SQL. D1's SQL dialect is close (it's libsql under
   the hood) but the loader must use `batchWrite` (buffered-batch RPC),
   not interactive transactions. The `copy-community-turso-to-d1` script
   has the right pattern; port the SQL generation to a D1-targeted
   `batchWrite` payload.

5. **Routing row write timing — RESOLVED.** `upsertD1CommunityRoutingRow`
   is a guarded `DO UPDATE` (not `DO NOTHING`), so the provisioning→ready
   transition is supported by a single primitive: write the row at
   `provisioning_state='provisioning'` when the binding is allocated, then
   call the same function again with `'ready'` once the shard load
   completes. (The earlier `DO NOTHING` proposal in an earlier §3.2 draft
   could not perform that transition — inconsistency resolved.) The d1
   read router must treat a `backend='d1', provisioning_state='provisioning'`
   row as not-yet-routable (the 0117 `idx_..._shard` partial index only
   covers `provisioning_state='ready'`), so the intermediate row is safe.

6. **Consumer code (`community-read-access`, routing resolver).** Should
   pick up `d1_native` without changes — the routing row shape is the
   same as a flipped community. Verify with a test that a
   `mode='d1_native', backend='d1', provisioning_state='ready'` row
   routes identically to a flipped one.

7. **Per-community D1 isolation — RESOLVED: one database per community (1:1).**
   An earlier draft assumed multiple communities could share one D1
   database with `community_id` as a per-query partition key "already
   enforced by `assertCommunityBinding`." That is **wrong** and was
   removed. `assertCommunityBinding` (shard-read.ts:52) only authorizes
   the `(communityId → bindingName)` allowlist pair — it does **not**
   inject a `WHERE community_id = ?` filter; the shard runs whatever SQL
   it is handed against the whole bound database. The current model
   (mirroring Turso) is **one database per community**: isolation is
   physical (binding/database level), not row-level within a shared DB.
   So the pool is a pool of **whole D1 databases**, each allocated 1:1 to
   exactly one community (`map[communityId] = its own dedicated binding`).
   This preserves the existing isolation model with **zero** community-local
   query changes. Bound by D1's per-account database cap (~50k), not a
   small fixed pool multiplexing many communities. Genuine shared-DB
   multitenancy would require a full community-local query audit + a
   shard-side `community_id` filter injector and is explicitly **out of
   scope** (see §7).

8. **Backwards compatibility.** Existing Turso-provisioned communities
   (the 17 on the staging control plane) are unaffected — they keep
   their `backend='turso'` rows. D1-native is opt-in per
   `COMMUNITY_PROVISION_BACKEND` env, and the operator can flip the
   staging default. Plan a staged rollout: (i) D1-native behind env,
   (ii) canary on the fixture, (iii) default the staging env to
   `d1_native`, (iv) only then think about main.

## 6. Implementation order (for the fast implementation session)

1. `community-repository-types.ts` — add `"d1_native"` enum value.
2. `create/repository.ts` — add the 2 pending-D1 helpers.
3. `community-routing-repository.ts` — add `upsertD1CommunityRoutingRow`
   + tests.
4. `provisioning/repository.ts` — generalize the binding INSERT (nullable
   Turso cols), include D1 fields in success metadata.
5. `community-d1-shard/` — pool table migration, allocator RPC, bootstrap
   RPC, pool-state tracking.
6. `allocate-d1-pool.ts` — operator script (CLI wrapper around
   `wrangler d1 create`).
7. `provisioning/backend.ts` — add `d1NativeProvisioningBackend`; wire
   `COMMUNITY_PROVISION_BACKEND` env; integrate with
   `upsertD1CommunityRoutingRow` + the binding INSERT.
8. `operator-client.ts` — add the hand-off RPC.
9. `provision-d1-native.ts` — end-to-end ops script (allocate + provision
   + mark ready).
10. Tests + staging drill (pre-allocate 1 D1 db, provision a new
    community end-to-end, verify routing row + reads/writes).

## 7. What this spec explicitly does NOT cover

- **Per-region D1 placement.** The 2 pilot D1s are in EEUR; the shard is
  one Worker. Multi-region would need a shard-per-region + a
  `shard_worker_id` picker (currently just `community-d1-shard-staging`).
  Out of scope for D1-native provisioning; that's a separate
  shard-federation effort.
- **D1-native migration of existing Turso communities.** That's the
  `copy-community-turso-to-d1` + `flip-community-to-d1` flow — already
  built. This spec only covers NEW communities born on D1.
- **Community reads/writes that are still unrouted** (the ~161
  unrouted `openCommunityDb` sites). Independent of provisioning; the
  audit is the right place to track those.
- **D1 database deletion / community decommission.** D1 deletion is
  CLI-only; the existing Turso decommission flow is the template.

---

Investigation complete. The seams are clear (`CommunityProvisioningBackend`
+ `upsertD1CommunityRoutingRow` + the shard pool), the constraints are
known (no D1 create API, static `wrangler d1_databases` block), and the
open questions are bounded. The implementation session should be fast.
