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

- `local-sqlite` mode: file-backed SQLite for control-plane and per-community databases
- `worker-dev` mode: Wrangler worker with in-memory store (`DEV_MEMORY_STORE_ENABLED=true` in `wrangler.jsonc`)

## Modes

The API runs in one of these modes:

| Mode | Runtime | Config file | Intended use |
|---|---|---|---|
| `local-sqlite` | Bun HTTP server | `.env.local-sqlite` | Primary day-to-day development |
| `worker-dev` | Wrangler dev worker | Wrangler config | Worker-runtime debugging |
| `staging` | Bun HTTP server against remote infra | `.env.staging` | Shared integration testing |
| `production` | deployed runtime | `.env.production.example` as reference only | Real production only |

Startup prints the resolved mode and backends:

```
pirate-api mode=local-sqlite
  control_plane_db = file:/tmp/pirate-control-plane-live.db
  community_db_root = /tmp/pirate-community-dbs-live
  registry_publication = local_stub
  hns_verification = local_stub
```

If the env file is missing or the database is not in a usable state, the server exits immediately with a message naming the expected file or the fix command (`rtk bun run local:reset`).

### local-sqlite

Primary day-to-day development mode. Bun server + file-backed SQLite. No remote dependencies.

Setup:

```bash
cd pirate-api/services/api
cp .env.local-sqlite.example .env.local-sqlite
```

Fill in secrets (JWT shared secret, RSA keys, Privy credentials) in `.env.local-sqlite`.

Reset databases to a clean state:

```bash
rtk bun run local:reset
```

Start the server:

```bash
rtk bun run dev:local-sqlite
```

### worker-dev

Wrangler worker runtime for debugging Worker-specific behavior. This is not the standard full local app stack.

```bash
rtk bun run dev:worker
```

### staging / production

Remote infra only. No file-backed databases. No local stub codepaths.

- `staging` loads `.env.staging`
- `production` should be secret-manager or CI driven rather than local hand-edited env files
- `.env.production.example` exists only as a reference template for required keys

The startup guard rejects these local-only settings in `staging` and `production`:

- `CONTROL_PLANE_DATABASE_URL=file:...`
- `LOCAL_COMMUNITY_DB_ROOT`
- `ALLOW_LOCAL_STUB_REGISTRY_PUBLICATION=true`
- `DEV_MEMORY_STORE_ENABLED=true`
- localhost `PIRATE_API_PUBLIC_ORIGIN`

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

See [Modes](#modes) for the full mode reference.

Quick start (local-sqlite):

```bash
cd pirate-api/services/api
cp .env.local-sqlite.example .env.local-sqlite
# fill in secrets
rtk bun run local:reset
rtk bun run dev:local-sqlite
```

Troubleshooting:

- missing `communities` table: `rtk bun run local:reset`
- missing community DB root: `rtk bun run local:reset`
- wrong env file or mode: read the startup banner first

Optional overrides in `.env.local-sqlite`:

- For real song artifact uploads, set `FILEBASE_S3_BUCKET_MUSIC` and related S3 keys.
- For the real internal publisher path, set `REGISTRY_PUBLISHER_URL`, `REGISTRY_PUBLISHER_AUTH_TOKEN`, and `REGISTRY_PUBLISHER_TIMEOUT_MS`.
- For the real HNS TXT flow, set `HNS_VERIFICATION_PROVIDER=hnsdoh` and `HNS_RESOLVER_HOST=hnsdoh.com`.

## Full First Slice Local Setup

This is the shortest path to a real local worker that matches the Bruno collection.

1. Prepare fresh local Bruno state:

```bash
cd pirate-api/services/api
rtk bun run bruno:prepare:local-sqlite
```

This resets:

- the local control-plane SQLite file resolved from `CONTROL_PLANE_DATABASE_URL`
- the local community DB root resolved from `LOCAL_COMMUNITY_DB_ROOT`
- `services/api/bruno/environments/local.bru` with fresh JWT fixtures and a new subject

2. Ensure `.env.local-sqlite` in `pirate-api/services/api` is populated with secrets.

3. Start the Bun local server:

```bash
cd pirate-api/services/api
rtk bun run dev:local-sqlite
```

4. Run the Bruno collection from the service repo wrapper:

```bash
cd pirate-api/services/api
rtk bun run bruno:test:local-sqlite
```

## Real HNS TXT Flow

When `HNS_VERIFICATION_PROVIDER=hnsdoh`, the namespace flow changes from stub acceptance to
real TXT observation:

1. `POST /namespace-verification-sessions` returns:
   - `challenge_host`
   - `challenge_txt_value`
   - `challenge_expires_at`
   - for the same authenticated user and normalized root, this start call now reuses the latest
     non-expired namespace-verification session instead of minting a new challenge every time
2. publish the returned TXT value on the HNS root:
   - host: `_pirate.<root>`
   - value: `pirate-verification=<session_id>`
3. call `POST /namespace-verification-sessions/{id}/complete`

If you need to deliberately rotate the challenge for an existing session, call
`POST /namespace-verification-sessions/{id}/complete` with `{"restart_challenge": true}` instead
of starting a second session for the same root.

The runtime then queries `hnsdoh.com` directly for:

- root existence
- challenge TXT visibility
- basic routing presence
- optional Pirate NS authority if `HNS_PIRATE_NS_HOSTS` is configured

Current verification semantics:

- successful TXT observation proves control of the served DNS zone for the HNS root
- it does not yet prove onchain ownership of the HNS root itself
- `root_control_verified` is therefore a v0 zone-control approximation carried forward for compatibility with the current API shape
- `control_class=single_holder_root` is also a v0 assumption until chain-aware ownership classification exists
- `expiry_horizon_sufficient` is currently derived from deployment config, not chain observation

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

from `.env.local-sqlite` (preferred), `.dev.vars` (fallback), or the current shell environment.

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

For the current normal-runtime Tableland publisher prototype, use a timeout budget closer to
`60000ms` than `25000ms`. The live Base Sepolia publication path can exceed `25s`, which causes
false `publication_error` responses at the Worker boundary even when the publisher eventually
succeeds.

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
rtk bun run bruno:prepare:local-sqlite
rtk bun run dev:local-sqlite
```

Then in a second terminal:

```bash
cd pirate-api/services/api
rtk bun run bruno:test:local-sqlite
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
