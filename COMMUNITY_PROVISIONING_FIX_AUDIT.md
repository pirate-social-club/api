# Audit: community provisioning "file:" control-plane URL failure + prevention

> Historical note: the Turso community provisioning operator path was removed
> during the de-Turso workstream. Current production evidence is in
> `services/api/docs/deturso-phase0-evidence-2026-07-01.md`.

**Audience:** a reviewing AI/engineer auditing this change set before merge/deploy.
**Worktree:** `api-tier1-prod` (branch `release/api-tier1-prod`, the production line).
**Author intent:** fix the recurrence risk in code; document the parts that require operator credentials (secret repoint + orphan cleanup) so a human can execute them.

---

## 1. Incident

Creating a community on **prod (pirate.sc)** failed with `Community provisioning failed`. The same flow on **staging** works. Observed error detail from the API response:

```json
{
  "code": "internal_error",
  "message": "Community provisioning failed",
  "details": {
    "mode": "turso_operator",
    "cause": "community_provision_operator_failed",
    "cause_details": {
      "operator_status": 500,
      "operator_step": "load_next_rotation",
      "operator_message": "Ir.readFileSync is not a function"
    },
    "community_id": "cmt_fc32ea765099479a9cce4e59f64ff8b5",
    "job_id": "job_eb9193f928ba4474ba597650b571d80d"
  }
}
```

## 2. Root cause (verified in code)

The community-provision-operator opens the control-plane DB in
`services/community-provision-operator/src/lib/control-plane-db.ts` →
`openControlPlaneDatabase()`. For a non-postgres URL it calls
`createClient()` from `@libsql/client`. For a **`file:`** URL, that client
resolves the database via `fs.readFileSync`, which **does not exist in the
Cloudflare Workers runtime** (it surfaces minified as `Ir.readFileSync is not a
function`).

Crucially, the client *constructs* without error; it only fails at the **first
query**. The provisioning sequence is:

```
open_control_plane → load_namespace_verification → ensure_group →
enable_group_delete_protection → ensure_database →
enable_database_delete_protection → mint_database_token →
bootstrap_database → load_next_rotation
```

Every step before `load_next_rotation` uses either the Turso **platform REST
API** (fetch-based) or the **remote** community libsql DB — none touch the
control plane. `load_next_rotation` (`provision-runtime.ts:161`, calling
`getNextRotationNumber()`) is the **first control-plane query**, so that is
exactly where the `file:` URL detonates.

**Why staging works:** staging's `CONTROL_PLANE_DATABASE_URL` is a remote URL
(libsql:// or postgres://), which the libsql/Neon clients service over
fetch/websocket — no filesystem.

**Why it was invisible until a user hit it:** the operator's `/health`
(`index.ts:165`) returns `ok:true` purely from env vars; it never opens the
control plane. There was **no validation of the URL at any boundary**.

**Side effect (orphan):** because steps up to `enable_database_delete_protection`
succeeded, prod now has a **delete-protected** Turso DB
`main-cmt-fc32ea765099479a9cce4e59f64ff8b5` (and its region group) in the
`pirate-prod` org with **no control-plane binding record**. This needs manual
cleanup (see §6).

## 3. Two distinct fixes

1. **Unblock prod (config; requires operator credentials — NOT in this diff):**
   no code can make a `file:` URL work in Workers. Prod's
   `CONTROL_PLANE_DATABASE_URL` must be repointed at the remote control-plane
   URL for `pirate-prod`. Runbook in §6.
2. **Prevent recurrence (this diff):** fail fast + add a real health probe + a
   post-deploy smoke gate so a bad control-plane URL is impossible to ship
   silently.

## 4. Change set (this diff) — file by file

All paths relative to the `api-tier1-prod` worktree root.

### 4.1 `services/community-provision-operator/src/lib/control-plane-db.ts` (modified)
Adds a **pure, exported** guard `assertRemoteControlPlaneUrl(url, { environment })`
and a typed error `ControlPlaneUrlError` (`code = "control_plane_url_invalid"`).

- Rejects `file:`, schemeless (bare path), empty, and unsupported schemes when
  the environment is **not** `development`/`test`.
- Accepts `libsql:`, `https:`, `http:`, `wss:`, `ws:`, `postgres:`, `postgresql:`.
- Allows anything in `development`/`test` (local SQLite is the intended test
  control plane; the runtime there is Node/Bun with a filesystem).
- **Security:** error messages echo only the *scheme*, never the full URL, so a
  connection string carrying credentials cannot leak into logs/Sentry.

Rationale for location + purity: the migration agent is rewriting this file
(Turso→PlanetScale/D1). A standalone pure function with no dependency on the
driver branching keeps the merge surface tiny and the behavior driver-agnostic.

### 4.2 `services/community-provision-operator/src/index.ts` (modified)
- New helper `requireControlPlaneUrl(env)` = `requireText(...)` +
  `assertRemoteControlPlaneUrl(url, { environment: env.ENVIRONMENT })`. This is
  the **single chokepoint**: all four routes that read the control plane
  (`provision`, `rotate-token`, `doctor`, `reap-stale`) now call it instead of
  `requireText(env.CONTROL_PLANE_DATABASE_URL, …)`. (`migrate` does not read the
  control plane — it takes `database_url` from the body — so it is untouched.)
- New authenticated route **`GET /health/deep`**: validates the URL via
  `requireControlPlaneUrl`, opens the control plane, runs ``db.sql`SELECT 1` ``,
  closes it. Returns `200 {ok:true, control_plane_ok:true}` or `503` with an
  `error_code` (`control_plane_url_invalid` | `control_plane_unreachable`) and a
  message truncated to 300 chars. Placed **after** `requireOperatorAuth` and
  **before** the `POST`-only guard (it is a GET).
- `OperatorDeps.openControlPlaneDbFn?` added so the DB open is injectable for
  tests (deep-health success/failure tested without network).

Behavior preservation: the guard throws inside the existing `try/catch`, so a
bad URL maps to the existing `500 community_provision_operator_failed` envelope
(correct: it is a server-side config error). The pre-existing `/health` is
unchanged (still cheap + unauthenticated, used by the API `/__version` fan-out).

### 4.3 `services/community-provision-operator/src/lib/control-plane-db.test.ts` (new)
Unit tests for the guard: accepts all remote schemes in production; accepts when
`environment` is unset (treated as deployed); rejects `file:` in
production/staging; **allows** `file:` in development/test; case/whitespace
insensitivity; empty + schemeless + unsupported-scheme rejection; and asserts
the **full path is never echoed** in the message.

### 4.4 `services/community-provision-operator/src/index.test.ts` (modified)
Adds handler-level tests: `/health/deep` requires auth; returns `200` on
`SELECT 1` success (injected DB); returns `503 control_plane_url_invalid` for a
`file:` URL in production **without** reaching the DB open; returns
`503 control_plane_unreachable` when the query throws; and that `provision`
rejects a `file:` URL in production **before** doing any work.

### 4.5 `services/api/src/lib/communities/provisioning/operator-client.ts` (modified)
Adds `getCommunityProvisionOperatorHealth(env)` → calls operator
`GET /health/deep` over the service binding with the operator bearer token.
Returns booleans + `error_code` only (never the operator's raw message). Mirrors
the existing `getCommunityProvisionOperatorVersion` patterns (`parsedRecord`,
`trim`, `COMMUNITY_PROVISION_OPERATOR.fetch`).

### 4.6 `services/api/src/index.ts` (modified)
Adds public **`GET /health/provisioning`** → calls the above, returns
`200/503` with **booleans + error_code only** (`ok`, `configured`,
`control_plane_ok`, `environment`) and `cache-control: no-store`. No secrets, no
connection strings — safe to curl from a deploy pipeline without credentials.

### 4.7 `services/community-provision-operator/scripts/smoke-provision.ts` (new) + `package.json` (modified)
`smoke:provision` script. `bun run scripts/smoke-provision.ts https://api.pirate.sc`
GETs `/health/provisioning`; exits `0` healthy, `1` unhealthy/unreachable, `2`
bad invocation. **This is the gate that would have caught the incident**, because
it reaches the operator's `/health/deep`, which actually opens the control plane.

## 5. Test evidence

- `bun test` in `services/community-provision-operator`: **37 pass / 0 fail**.
- `bun run check` (tsc --noEmit) in the operator: **clean**.
- API (`services/api`) typecheck **not run**: deps are not installed in this
  worktree and an install was explicitly out of scope. The two API edits mirror
  an existing function's patterns 1:1; they should be typechecked in CI or a
  deps-present checkout before deploy. **← reviewer: please confirm.**

## 6. Operator-credential actions (NOT in this diff — human runs these)

**6a. Repoint the prod control-plane secret.** Confirm in the secret source of
truth (Infisical) that the prod operator's `CONTROL_PLANE_DATABASE_URL` is a
`file:`/local value, then set it to the remote control-plane URL for
`pirate-prod` (+ `TURSO_CONTROL_PLANE_AUTH_TOKEN`), mirroring staging's shape.
Fix at the Infisical source and re-sync/redeploy so the next sync doesn't revert
it. After deploy, verify:

```
wrangler tail community-provision-operator --env production --format pretty
curl -fsS https://api.pirate.sc/health/provisioning   # expect 200 {ok:true,control_plane_ok:true}
```

**6b. Clean up the orphan** delete-protected DB in `pirate-prod`:
`main-cmt-fc32ea765099479a9cce4e59f64ff8b5` (disable delete protection, then
`turso db destroy …`). It otherwise lingers and shows up in `doctor` findings.

## 7. Migration coordination

A separate agent is migrating the control plane off Turso (PlanetScale/D1).
Findings that affect this work, surfaced for that agent:
- `@neondatabase/serverless` is **still imported** in `control-plane-db.ts`
  across multiple worktrees, **including** the migration branch.
- Per-community DBs are still Turso/libsql everywhere; D1 appears only as a WIP
  test on the migration branch.
- This worktree (`api-tier1-prod`) is **100% Turso** and has none of the
  migration — which is why §6a points back at a remote *Turso* URL.

The guard (§4.1) is intentionally driver-agnostic: when the control plane
becomes PlanetScale, `postgres:`/`postgresql:` is already in the allow-list, so
the guard keeps working; only the *value* in §6a changes.

## 8. Audit checklist for the reviewer

1. **Does the guard fail closed?** With `environment` unset/unknown it treats
   the deploy as production (validates). Confirm that matches deploy reality
   (prod sets `ENVIRONMENT=production`; dev/test set `development`/`test`).
2. **No secret leakage:** confirm `assertRemoteControlPlaneUrl`, `/health/deep`,
   `getCommunityProvisionOperatorHealth`, and `/health/provisioning` never emit
   the URL/token — only scheme/booleans/error_code (+ ≤300-char message at the
   operator layer, which is auth-gated and behind a non-public binding).
3. **`/health/provisioning` exposure:** it is public and reveals a
   `control_plane_ok` boolean. Acceptable (status-page-grade)? Same precedent as
   `/health` and `/__version`. Reviewer to confirm policy.
4. **Chokepoint completeness:** the only `requireText(env.CONTROL_PLANE_DATABASE_URL,…)`
   left is inside `requireControlPlaneUrl` (index.ts:122). `migrate` correctly
   excluded (body-supplied URL). Confirm no other reader exists.
5. **Backward compatibility:** existing operator tests unchanged and passing;
   `/health` semantics unchanged.
6. **API typecheck** (§5) still owed in a deps-present environment.
7. **Behavioral equivalence of `SELECT 1`** across both driver branches
   (libsql `execute` and postgres `query`) — both compile to no-arg `SELECT 1`.
