# Handoff → migration agent: unblock prod control plane (PlanetScale)

**To:** whoever owns `migration/turso-to-d1`.
**From:** incident triage on `release/api-tier1-prod`.
**Status:** prod community creation (and all control-plane ops) is broken; the fix
is yours to land on the prod line. Prod was left clean (no secrets/DBs mutated).

## 1. What's broken and why

Prod's `community-provision-operator` secret `CONTROL_PLANE_DATABASE_URL` is a
**PlanetScale Postgres** URL (`…@us-east-1.pg.psdb.cloud:5432/…?sslmode=…&sslrootcert=system`).
The deployed prod operator does a bare `new Pool({ connectionString: url })`
(`api-tier1-prod/services/community-provision-operator/src/lib/control-plane-db.ts:187`),
so Neon's `pg`-style parser hits `sslrootcert=system` and calls
`fs.readFileSync("system")` → `Ir.readFileSync is not a function`. It throws on
the first control-plane query, `load_next_rotation`
(`…/provision-runtime.ts:164`). Provision / rotate-token / doctor / reap-stale
all open the control plane, so all are down on prod.

The Turso control plane no longer exists (the `pirate-prod` org is 158
`main-cmt-*` community DBs, zero control-plane DB) — the data is in PlanetScale.
**There is nothing to repoint the secret to.** The fix is code: ship the
PlanetScale driver wiring to the prod operator.

## 2. Migration state (both layers are live on your branch)

`migration/turso-to-d1` HEAD `714b837` carries **two** in-flight layers:
- **control plane → PlanetScale** (the wiring this incident needs), and
- **community DBs → D1** ("read path, D1 read client, request-scoped sharing").

Community DBs are *physically* still on Turso, but the D1 move is started, not
separate. Sequence the prod deploy with both in mind.

## 3. The targeted unblock

Land the file you've **already written** onto `release/api-tier1-prod`:

- `api/services/community-provision-operator/src/lib/control-plane-db.ts`
  — it already has `isPlanetScalePostgresUrl` / `configurePostgresDriverForUrl`
  (rewires `neonConfig.fetchEndpoint` → `https://${host}/sql`, `wsProxy` →
  `${host}/v2?address=${host}:${port}`) / `normalizePostgresConnectionStringForDriver`
  (strips `sslrootcert=system`) inline at lines **111-150**, and applies them in
  `openPostgresControlPlaneDatabase`.
- Bring its test coverage: `api/services/api/tests/runtime-deps.test.ts:73-93`
  (PlanetScale URL detection + driver configuration).
- Deploy the operator to prod (`wrangler deploy --env production` from the
  operator dir). No secret change needed — the URL is already correct; only the
  code that can read it is missing.

This is the exact change you're already shipping, just on the prod line.

## 4. Explicitly do NOT

- **Do not** port `core/scripts/lib/postgres-url.ts` into the prod operator. It's
  across a repo boundary `api/` can't import, and would make a **4th** copy of
  these helpers (they already exist in `core/scripts/lib/postgres-url.ts`,
  `api/services/api/src/lib/runtime-deps.ts:33-69`, and the operator file above).
- **Do not** reach for Hyperdrive as the immediate unblock — right long-term
  shape, wrong size for an incident (binding + secret + DNS + full operator
  query re-test). Follow-up, not blocker.

## 5. Follow-up (after the unblock, not part of it) — decided

**Sequencing reality (verified):** the inline copies are **uncommitted WIP**, on
no committed branch. They live in working trees only — the migration worktree
(`runtime-deps.ts` + `control-plane-db.ts`, amid ~175 uncommitted files) and the
prod-line `api-tier1-prod` worktree (same two files, the unblock being applied).
`origin/main` has no PlanetScale helpers at all. So the dedup **must be folded
into the commit that lands these copies** — a standalone `main` PR would add a
consumer-less `services/shared` module, i.e. *another* copy, not a dedup.

**The dedup:** when committing the inline copies, instead point both consumers at
the shared package. Create `api/services/shared/src/postgres-url.ts` (the 3
functions, body-for-body from `core/scripts/lib/postgres-url.ts`), re-export it
from `api/services/shared/src/index.ts` (`export * from "./postgres-url.js"`),
and `import { … } from "@pirate/api-shared"` in both
`services/api/src/lib/runtime-deps.ts` and
`services/community-provision-operator/src/lib/control-plane-db.ts` rather than
inlining. `@pirate/api-shared` is the repo's real cross-service package
(`services/shared/package.json`), so this is the api/ convention, not a new home.

**Leave the vendored split with `core/`.** Do **not** hoist a cross-repo shared
package: `api/` cannot import from `core/scripts/` (sibling repos, per
`core/AGENTS.md`), and ~50 LOC of pure URL/string handling doesn't justify a
cross-repo import surface (version pinning, release-time sync, more
package.jsons, CODEOWNERS). `core/scripts/lib/postgres-url.ts` stays canonical
for the `core/` scripts that legitimately live there.

**One tripwire to add** when you make the shared `api/` file: a top-of-file
comment — `// Mirror of core/scripts/lib/postgres-url.ts — if you change these
function bodies, update that copy too (sibling repo, no shared import).` So the
next person who touches the helpers sees both copies. That's the whole follow-up;
revisit the structure only if these helpers grow non-trivial logic (pooling,
credential rotation, real driver init).

## 6. Related PR (#39) — prevention, and a red you should expect

PR #39 (`fix/control-plane-url-guard` → `main`) adds an operator `/health/deep`,
a public API `/health/provisioning`, and `smoke-provision.ts` that run a real
`SELECT 1` against the control plane. **This would have caught the incident** and
is the safeguard going forward.

⚠️ If #39 is deployed to prod **before** your fix in §3, `/health/deep` and the
smoke will go **red with the same `Ir.readFileSync` error**. That is intended
(loud "migration fix needed" alarm), not a broken PR. The red clears once §3
lands. The scheme-guard in #39 would *not* have caught this (a `postgresql://`
URL passes), so don't rely on it for this class — rely on the smoke.

## 7. Post-deploy verification

After §3 deploys to prod:
- `curl -fsS https://api.pirate.sc/health/provisioning` → expect `200 {ok:true,control_plane_ok:true}` (requires #39's API route deployed; otherwise verify via a real community create + `wrangler tail community-provision-operator --env production`).
- Create a community on pirate.sc → `load_next_rotation` should succeed.
- Reap orphan `main-cmt-fc32ea765099479a9cce4e59f64ff8b5` (delete-protected,
  `region-aws-us-east-1`) — the DB from the original failed run — once the
  control plane is reachable (operator `doctor`/`reap-stale`). It was left intact
  because confirming it's unbound needs a working control plane.

## 8. Confirm prod is clean after you deploy on top (incident close-out)

Triage left the prod operator on **clean base version `641936fa`** with the
original 7 secrets. Two temporary instrumented versions were deployed during
diagnosis and then superseded — **`2cee44f1` and `bfd3aaed` must NOT be the
active version**; if either is, something rolled back. After your §3 deploy lands,
run these to confirm the prod line is in the claimed state (run from
`services/community-provision-operator`):

```bash
# 1. Secrets: exactly the original 7 — no CP_MAINTENANCE / CP_MAINTENANCE_DELETE_DB
bunx wrangler secret list --env production
#    expect: COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN, CONTROL_PLANE_DATABASE_URL,
#    TURSO_COMMUNITY_DB_WRAP_KEY, TURSO_COMMUNITY_DB_WRAP_KEY_VERSION,
#    TURSO_CONTROL_PLANE_AUTH_TOKEN, TURSO_ORGANIZATION_SLUG, TURSO_PLATFORM_API_TOKEN

# 2. Active version is YOUR §3 deploy (or 641936fa if not yet deployed) —
#    never the temp instrumented 2cee44f1 / bfd3aaed
bunx wrangler deployments list --env production
bunx wrangler versions list --env production

# 3. Source line carries no leftover instrumentation (it was never committed;
#    this just proves it)
git grep -nE "CP-MAINT|runCpMaintenance|CP_MAINTENANCE" \
  origin/release/api-tier1-prod -- services/community-provision-operator \
  || echo "clean: no instrumentation on release line"

# 4. Functional green (needs PR #39's API route deployed; else verify via a real
#    community create + wrangler tail)
curl -fsS https://api.pirate.sc/health/provisioning
#    expect: 200 {"ok":true,"control_plane_ok":true,...}
```

If 1–3 hold and 4 is green, the incident is fully closed: prod is clean, the
PlanetScale fix is live, and no diagnosis residue remains.
