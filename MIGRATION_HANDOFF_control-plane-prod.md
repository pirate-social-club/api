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

## 5. Follow-up (after the unblock, not part of it)

Collapse the 3-way duplication: one shared module under
`api/services/.../lib/postgres-url.ts` consumed by both `runtime-deps.ts` and the
operator's `control-plane-db.ts`; drop the inline copies. Whether to also unify
with `core/`'s canonical copy is a structural call independent of this incident.

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
