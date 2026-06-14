# Audit: prod community provisioning failure — root cause (corrected) + prevention

**Audience:** a reviewing AI/engineer auditing this before merge/deploy.
**Worktree:** `api-tier1-prod` (branch `release/api-tier1-prod`, the production line).

> **CORRECTION:** an earlier version of this doc blamed a `file:`
> `CONTROL_PLANE_DATABASE_URL`. That was wrong. Live diagnosis against prod (via
> the operator's own Turso platform token, read through `wrangler tail`) shows
> the URL is a **PlanetScale Postgres** `postgresql://` URL. The `readFileSync`
> *mechanism* was right; the *cause* was not. Details below.

---

## 1. Incident

Creating a community on **prod (pirate.sc)** fails with `Community provisioning
failed`; staging works. Operator error at step `load_next_rotation`:
`Ir.readFileSync is not a function`.

## 2. Root cause (verified live against prod)

`CONTROL_PLANE_DATABASE_URL` on the prod operator is:

```
postgresql://…@us-east-1.pg.psdb.cloud:5432/…?sslmode=…&sslrootcert=…
```

i.e. **PlanetScale Postgres**. The deployed prod operator
(`control-plane-db.ts`) routes any `postgres(ql)://` URL to
`@neondatabase/serverless` (`new Pool({ connectionString })`). That driver's
`pg`-style connection-string parser, on seeing **`sslrootcert`**, calls
`fs.readFileSync(<sslrootcert>)` to load a CA file. The Cloudflare Workers
runtime has **no filesystem**, so it throws `Ir.readFileSync is not a function`.

The Pool is created lazily, so `open_control_plane` (just `new Pool`) succeeds;
the parse+`readFileSync` fires on the **first query**, which is
`load_next_rotation` (`provision-runtime.ts:161`) — matching the observed step.

**This is a half-completed migration, not a misconfigured secret:**

- Live enumeration of the `pirate-prod` Turso org shows **158 databases, all
  `main-cmt-*` community DBs, and ZERO non-community DBs.** The Turso control
  plane no longer exists — its data was migrated to PlanetScale.
- The prod operator code (`api-tier1-prod`) predates PlanetScale support. The
  PlanetScale connection handling (`isPlanetScalePostgresUrl`,
  `configurePostgresDriverForUrl`, `normalizePostgresConnectionStringForDriver`
  in `core/scripts/lib/postgres-url.ts`) exists **only on the migration branch
  (`api/`)**, not in prod.

So: the control-plane data moved to PlanetScale, but the operator code that can
*talk* to PlanetScale was never deployed to prod. Every control-plane operation
(provision, rotate-token, doctor, reap-stale) is therefore broken on prod.

## 3. Why staging works

Staging's `CONTROL_PLANE_DATABASE_URL` is still a control plane the deployed
driver can reach (not a PlanetScale `postgresql://` with `sslrootcert`).

## 4. The fix is the migration's — NOT a secret change and NOT in this branch

There is **no Turso control plane to repoint to** (the data is in PlanetScale).
The correct fix is to deploy PlanetScale-capable control-plane support to the
prod operator — i.e. land the migration branch's PlanetScale driver/URL
normalization (or Hyperdrive-based Postgres access) on `release/api-tier1-prod`
and deploy. Porting that code here unilaterally would collide head-on with the
in-flight migration, so it is intentionally **out of scope**.

Interim options for whoever owns the migration:
- Deploy the migration's PlanetScale operator code to prod (preferred), **or**
- Normalize the connection string so the driver never calls `fs` (strip
  `sslrootcert`, configure TLS programmatically) — but note Neon's fetch driver
  cannot speak PlanetScale's protocol anyway, so a driver change is likely
  required regardless.

## 5. What this PR (#39) actually buys — reframed

The PR does **not** fix prod (the fix is the migration's). It adds prevention so
this class of failure is caught at deploy instead of by a user:

- **`GET /health/deep`** (operator) + **`GET /health/provisioning`** (API,
  public, booleans only) + **`smoke-provision.ts`**: these run a real `SELECT 1`
  against the control plane. **This is the part that WOULD have caught the
  incident** — a post-deploy smoke check goes red the moment the control plane
  is unreachable, regardless of *why*. Keep these.
- **`assertRemoteControlPlaneUrl()` guard:** rejects `file:`/schemeless/empty
  URLs. **Honest limitation: it would NOT have caught this bug** — a PlanetScale
  `postgresql://` URL passes the scheme allow-list. Its value is narrower than
  first stated (catches a different misconfig class). A reviewer may choose to
  extend it to flag `sslrootcert`/SSL-file params on the Neon-driver path, but
  that overlaps the migration's URL normalization and may be better left to it.

Verification of the PR code: operator `bun test` 37/0; operator `tsc` clean; API
`bun run check` exit 0.

## 6. Live diagnosis method + prod state left behind

To diagnose without Turso/Infisical credentials (neither was available), the
operator's own embedded `TURSO_PLATFORM_API_TOKEN` was used **server-side**: a
temporary, secret-gated (`CP_MAINTENANCE`) routine was deployed that enumerated
the org and probed the control plane, logging only names/URLs/param-keys (never
token values), read via `wrangler tail`.

**Prod was returned to a clean state — nothing was mutated except adding then
deleting the gate secret:**

- `CONTROL_PLANE_DATABASE_URL` and all other secrets: **untouched**.
- Temporary `CP_MAINTENANCE` secret: **deleted**.
- Operator redeployed to clean base code (version `641936fa`); the temporary
  instrumentation is **not** present in prod or in the PR branch.
- No database was created, modified, or deleted.

## 7. Outstanding items (owned by the migration)

1. **Unblock prod:** deploy PlanetScale control-plane support to the prod
   operator (§4). This is the actual incident fix.
2. **Orphan:** `main-cmt-fc32ea765099479a9cce4e59f64ff8b5` (delete-protected,
   `region-aws-us-east-1`) is the DB from the original failed run. It still
   exists. It was **not** deleted here because confirming it is truly unbound
   requires a working control plane (now PlanetScale). Reap it once the control
   plane is reachable (operator `doctor`/`reap-stale`, or platform delete).
3. **Community DBs are still on Turso** (158). If the migration intends to move
   those too, that is separate and not started.

## 8. Audit checklist

1. Confirm §2: is prod's control plane intentionally on PlanetScale already, or
   was the secret changed ahead of the code deploy? Either way the code to reach
   it must ship to prod.
2. Confirm the PR's deep-health/smoke is retained as the real safeguard, and the
   guard's limitation (§5) is understood.
3. Confirm prod cleanliness (§6): secret list shows the original 7 only; live
   operator version is the clean base, not the instrumented build.
4. API typecheck (deps-present) — done (exit 0), re-confirm in CI.
