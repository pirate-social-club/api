# Pirate API Sidecar

Local Worker for the first executable Pirate API slice.

## Scope

Current implemented path:

- `POST /auth/session/exchange`
- `GET /users/me`
- `GET /onboarding/status`
- `POST /verification-sessions`
- `GET /verification-sessions/{verification_session_id}`
- `POST /verification-sessions/{verification_session_id}/complete`
- `POST /namespace-verification-sessions`
- `GET /namespace-verification-sessions/{namespace_verification_session_id}`
- `POST /namespace-verification-sessions/{namespace_verification_session_id}/complete`
- `GET /namespace-verifications/{namespace_verification_id}`
- `POST /communities`
- `GET /communities/{community_id}`
- `GET /jobs/{job_id}`
- `POST /communities/{community_id}/posts`
- `GET /posts/{post_id}`
- `GET /health`

Current auth support:

- `jwt_based_auth`
  Fully implemented for local and Bruno-driven development.
- `privy_access_token`
  Implemented. When Privy env is configured, the exchange path can verify the access token and reconcile linked wallets.

Current persistence mode:

- control-plane libSQL/Turso repository when `DEV_MEMORY_STORE_ENABLED` is false
- in-memory repository only when `DEV_MEMORY_STORE_ENABLED=true`

## Internal Layout

The service now groups runtime code by domain under `src/lib/`:

- `auth/`
  Session exchange, user/profile reads, bearer-token utilities, and auth backend wiring.
- `onboarding/`
  Reddit verification and snapshot-import integration.
- `verification/`
  Human-verification and namespace-verification persistence.
- `communities/`
  Community provisioning, community DB bootstrap, membership logic, and job/registry orchestration.
- `posts/`
  Post validation, storage, reads, and votes.

Shared primitives that are intentionally cross-domain stay at the `src/lib/` root, such as `errors.ts`, `helpers.ts`, and `sql-row.ts`.

The DB-backed first slice now reads and writes:

- `users`
- `auth_provider_links`
- `global_handles`
- `profiles`
- `verification_sessions`
- `user_attestations`
- `namespace_verification_sessions`
- `namespace_verifications`
- `communities`
- `community_database_bindings`
- `jobs`
- `community_post_projections`
- active `wallet_attachments` reads

Community-owned rows are written to the local per-community DB stub:

- `communities`
- `community_memberships`
- `community_roles`
- `namespace_bindings`
- `namespace_handle_policies`
- `posts`

Current namespace-verification modes:

- `HNS_VERIFICATION_PROVIDER=local_stub`
  Existing deterministic local acceptance path.
- `HNS_VERIFICATION_PROVIDER=hnsdoh`
  Real TXT-challenge verification against the public `hnsdoh.com` resolver.

## Local Dev

Memory mode:

1. Set `DEV_MEMORY_STORE_ENABLED=true`.
2. Fill in `AUTH_UPSTREAM_JWT_SHARED_SECRET` or `JWT_BASED_AUTH_SHARED_SECRET`.
3. Fill in `PIRATE_APP_JWT_PRIVATE_KEY` and `PIRATE_APP_JWT_PUBLIC_KEY`.
4. Run `bun run dev`.

Control-plane DB mode:

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Set `DEV_MEMORY_STORE_ENABLED=false`.
3. Set `TURSO_CONTROL_PLANE_DATABASE_URL`.
4. Set `TURSO_CONTROL_PLANE_AUTH_TOKEN` if required by the target DB.
5. Set `LOCAL_COMMUNITY_DB_ROOT` to a writable directory for per-community DB files.
6. If testing the real internal publisher path, set `REGISTRY_PUBLISHER_URL`, `REGISTRY_PUBLISHER_AUTH_TOKEN`, and `REGISTRY_PUBLISHER_TIMEOUT_MS`.
7. If testing the real HNS TXT flow, set:
   - `HNS_VERIFICATION_PROVIDER=hnsdoh`
   - `HNS_RESOLVER_HOST=hnsdoh.com`
   - `HNS_VERIFICATION_TIMEOUT_MS`
   - optionally `HNS_PIRATE_NS_HOSTS` if you want `pirate_dns_authority_verified` to turn on from specific NS hosts
8. Fill in `AUTH_UPSTREAM_JWT_SHARED_SECRET`, `AUTH_UPSTREAM_JWT_ISSUER`, and `AUTH_UPSTREAM_JWT_AUDIENCE`.
9. Fill in `PIRATE_APP_JWT_PRIVATE_KEY` and `PIRATE_APP_JWT_PUBLIC_KEY`.
10. Apply the control-plane migrations before starting the worker.

## Full First Slice Local Setup

This is the shortest path to a real local worker that matches the Bruno collection.

1. Prepare fresh local Bruno state:

```bash
cd pirate-api/services/api
rtk bun run bruno:prepare:local
```

This resets:

- the local control-plane SQLite file resolved from `TURSO_CONTROL_PLANE_DATABASE_URL`
- the local community DB root resolved from `LOCAL_COMMUNITY_DB_ROOT`
- `services/api/bruno/environments/local.bru` with fresh JWT fixtures and a new subject

2. Ensure `.dev.vars` in `pirate-api/services/api` is populated for local file-backed Bun runs.

3. Start the Bun local server:

```bash
cd pirate-api/services/api
rtk bun run dev:local
```

4. Run the Bruno collection from the service repo wrapper:

```bash
cd pirate-api/services/api
rtk bun run bruno:test:local
```

This local Bruno path intentionally uses Bun, not Wrangler, because the first-slice local control-plane/community databases are `file:`-backed.

## Real HNS TXT Flow

When `HNS_VERIFICATION_PROVIDER=hnsdoh`, the namespace flow changes from stub acceptance to
real TXT observation:

1. `POST /namespace-verification-sessions` returns:
   - `challenge_host`
   - `challenge_txt_value`
   - `challenge_expires_at`
2. publish the returned TXT value on the HNS root:
   - host: `_pirate.<root>`
   - value: `pirate-verification=<session_id>`
3. call `POST /namespace-verification-sessions/{id}/complete`

The runtime then queries `hnsdoh.com` directly for:

- root existence
- challenge TXT visibility
- basic routing presence
- optional Pirate NS authority if `HNS_PIRATE_NS_HOSTS` is configured

Current limitation:

- expiry-horizon enforcement is still a resolver-side heuristic in this runtime path
- `HNS_ASSUME_EXPIRY_HORIZON_SUFFICIENT=true` is the current default until a public expiry-aware provider is wired in

## Mint A Dev JWT

```bash
rtk bun run mint:dev-jwt --sub dev-user --wallet 0x1111111111111111111111111111111111111111
```

The script reads:

- `AUTH_UPSTREAM_JWT_SHARED_SECRET` or `JWT_BASED_AUTH_SHARED_SECRET`
- `AUTH_UPSTREAM_JWT_ISSUER` or `JWT_BASED_AUTH_ISSUERS`
- `AUTH_UPSTREAM_JWT_AUDIENCE` or `JWT_BASED_AUTH_AUDIENCE`

from `.dev.vars` or the current shell environment.

## Pirate Session JWT

Pirate bearer tokens are signed with `RS256`.

Required env:

- `PIRATE_APP_JWT_PRIVATE_KEY`
- `PIRATE_APP_JWT_PUBLIC_KEY`
- `PIRATE_APP_JWT_ISSUER`
- `PIRATE_APP_JWT_AUDIENCE`

## Registry Publisher

The default local path still uses the in-process registry stub.

To exercise the internal publisher boundary instead, configure:

- `REGISTRY_PUBLISHER_URL`
- `REGISTRY_PUBLISHER_AUTH_TOKEN`
- `REGISTRY_PUBLISHER_TIMEOUT_MS`

When `REGISTRY_PUBLISHER_URL` is configured, the Worker first calls the publisher to create the
public community-create attempt before it writes the mirrored Turso `community_registry_attempts`
row. This is the beginning of the audit-first ordering required by the registry-plane decision.

## Example Exchange

```bash
curl -X POST http://127.0.0.1:8787/auth/session/exchange \
  -H 'content-type: application/json' \
  -d '{
    "proof": {
      "type": "jwt_based_auth",
      "jwt": "REPLACE_WITH_MINTED_JWT"
    }
  }'
```

## Bruno

The live API acceptance collection is under [bruno](/home/t42/Documents/pirate-v2/pirate-api/services/api/bruno).

Recommended local run:

```bash
cd pirate-api/services/api
rtk bun run bruno:prepare:local
rtk bun run dev:local
```

Then in a second terminal:

```bash
cd pirate-api/services/api
rtk bun run bruno:test:local
```

Run order:

1. `00-auth`
2. `01-verification`
3. `02-namespace-verification`
4. `03-communities`
5. `04-posts`
6. `90-failures`

After `04-posts/create-post`, validate both storage layers:

- one `posts` row exists in the community DB
- one `community_post_projections` row exists in the control-plane DB
- `projection_version = 1`
- `source_post_id` matches the returned `post_id`
