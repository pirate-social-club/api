# Pirate API Sidecar

Local Worker for the current Pirate API surface.

## Scope

Current route surface:

- `GET /health`
- discovery routes mounted at `/`
  `GET /.well-known/jwks.json`, `GET /.well-known/oauth-protected-resource`
- `POST /auth/session/exchange`
- `GET /users/me`
- onboarding routes
  `GET /onboarding/status`, Reddit verification/import endpoints under `/onboarding/reddit-*`
- verification routes mounted at `/`
  `POST /verification-sessions`, `GET /verification-sessions/{verification_session_id}`, `POST /verification-sessions/{verification_session_id}/complete`, local Very verification, namespace verification sessions, and namespace verification reads
- profile routes
  `GET /profiles/me`, `PATCH /profiles/me`, handle rename/upgrade/sync endpoints under `/profiles/me/*`, `GET /profiles/{user_id}`
- public profile and agent routes
  `GET /public-profiles/{handle_label}`, `GET /public-agents/{handle_label}`
- media routes
  `POST /profile-media`, `POST /community-media`
- jobs and posts
  `GET /jobs/{job_id}`, `GET /posts/{post_id}`, `POST /posts/{post_id}/vote`, public post and comment read endpoints
- comments, feed, and notifications
  authenticated comment replies/context/vote/delete, `GET /feed/home`, and notification summary/task/feed read and mutation endpoints
- agents
  ownership pairing/session, user-agent handle, delegated credential, and public resolution endpoints
- communities
  create/read/preview, join eligibility, join, namespace attach, pending namespace session, rules, gates, safety, posts, money policy, pricing policy, asset access/content, listings, purchases, purchase quotes/settlements, song artifact uploads, and song artifact bundles under `/communities/{community_id}/*`

Current auth support:

- `jwt_based_auth`
  Fully implemented for local development.
- `privy_access_token`
  Implemented. When Privy env is configured, the exchange path can verify the access token and reconcile linked wallets.

Current persistence mode:

- control-plane DB via the shared `sql-client` abstraction when `DEV_MEMORY_STORE_ENABLED=false`
- libsql/local-file control-plane URLs and PostgreSQL control-plane URLs both work through the same repository layer
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
  Community provisioning, community DB bootstrap, membership logic, job/registry orchestration, and commerce.
- `posts/`
  Post validation, storage, reads, and votes.
- `song-artifacts/`
  Upload intents, content ingest, bundle analysis, and song publishing support.
- `story/`
  Story/CDR access proofs, publish flows, settlement flows, and PKP-backed integrations.

Shared primitives that are intentionally cross-domain stay at the `src/lib/` root, such as `errors.ts`, `helpers.ts`, and `sql-row.ts`.

Route registration now lives under `src/routes/`. The community router is intentionally split into:

- `communities-core.ts`
- `communities-commerce.ts`
- `communities-song-artifacts.ts`

with shared request helpers in `communities-route-helpers.ts`.

## Story/CDR Surface

Story/CDR code is active commerce infrastructure, not dead code. It is reached through locked song assets, asset access, purchase settlement, royalty registration, and runtime signer maintenance.

Local development has an intentional fallback for locked delivery when Story runtime signing keys are not configured. Production-like environments should configure the Story/CDR keys and treat fallback behavior as local-only.

The detailed route-to-service map is maintained in [Story/CDR Path Map](../../STORY_CDR_PATHS.md).

The DB-backed API now reads and writes control-plane rows such as:

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

Community-owned rows are written to the per-community DB:

- `communities`
- `community_memberships`
- `community_roles`
- `namespace_bindings`
- `namespace_handle_policies`
- `posts`
  Includes post-level `visibility` with `public` and `members_only`.

## Post Visibility

Shipped post visibility is intentionally narrow:

- `public`
  Anyone can read the post.
- `members_only`
  Only joined members can read the post through authenticated community routes.

Enforcement rules:

- create-post accepts `visibility` on `CreatePostRequest`
- the community DB `posts` row persists `visibility`
- the control-plane `community_post_projections` row mirrors `visibility`
- public read surfaces only return `visibility = 'public'`
  This includes `GET /public-posts/{post_id}`, `GET /public-communities/{community}/posts`, public comment reads, and the home feed
- authenticated member reads can still return `members_only` posts

## Local Dev

Memory mode:

1. Set `DEV_MEMORY_STORE_ENABLED=true`.
2. Fill in `AUTH_UPSTREAM_JWT_SHARED_SECRET` or `JWT_BASED_AUTH_SHARED_SECRET`.
3. Fill in `PIRATE_APP_JWT_PRIVATE_KEY` and `PIRATE_APP_JWT_PUBLIC_KEY`.
4. Run `bun run dev`.

Control-plane DB mode:

1. Copy `.dev.vars.example` to `.dev.vars`.
2. Set `DEV_MEMORY_STORE_ENABLED=false`.
3. Set `CONTROL_PLANE_DATABASE_URL` if you want a specific DB. Leave it blank to use `services/api/.local/control-plane.db`.
4. Set `LOCAL_COMMUNITY_DB_ROOT` if you want a specific community DB directory. Leave it blank to use `services/api/.local/community-dbs`.
5. For community avatar and banner uploads, set `FILEBASE_S3_ACCESS_KEY`, `FILEBASE_S3_SECRET_KEY`, and `FILEBASE_MEDIA_BUCKET`. Optional: `FILEBASE_S3_ENDPOINT` and `FILEBASE_S3_REGION`.
6. For OpenAI visual moderation, set `OPENAI_API_KEY`. Optional overrides: `OPENAI_MODERATION_MODEL`, `OPENAI_MODERATION_BASE_URL`, `OPENAI_MODERATION_SEXUAL_MINORS_BLOCK_THRESHOLD`, and `OPENAI_MODERATION_TIMEOUT_MS`.
7. For the real song pipeline and machine translations, set `OPENROUTER_API_KEY`, `ACRCLOUD_ACCESS_KEY`, `ACRCLOUD_ACCESS_SECRET`, `ACRCLOUD_HOST`, and `ELEVENLABS_API_KEY`. Optional overrides: `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `ACRCLOUD_IDENTIFY_PATH`, and `ELEVENLABS_FORCE_ALIGNMENT_URL`.
8. Fill in `AUTH_UPSTREAM_JWT_SHARED_SECRET`, `AUTH_UPSTREAM_JWT_ISSUER`, and `AUTH_UPSTREAM_JWT_AUDIENCE`.
9. Fill in `PIRATE_APP_JWT_PRIVATE_KEY` and `PIRATE_APP_JWT_PUBLIC_KEY`.
10. Start `rtk bun run dev:local` for the API only, or `rtk bun run dev:local:full` to run the API, web dev server, public API tunnel, assistant worker, and community job worker together. These scripts inject dev secrets from Infisical path `/services/api` using the workspace `core/.infisical.json` project config; use `dev:local:raw` or `dev:local:full:raw` only when intentionally running without Infisical. The local server bootstraps the control-plane migrations automatically for local file-backed DBs.
11. Post and comment translations, OpenAI moderation, plus Bedsheet replies require provider keys from Infisical.

If local startup fails with a migration checksum mismatch, reset only the local file-backed dev DBs:

```bash
rtk bun run dev:local:reset -- --yes
rtk bun run dev:local:full
```

The reset command refuses to touch paths outside `services/api/.local`.

## Full Local Setup

This is the shortest path to a real local worker.

1. Reset local dev storage:

```bash
cd api/services/api
rtk bun run dev:local:reset -- --yes
```

This resets:

- the local control-plane SQLite file resolved from `CONTROL_PLANE_DATABASE_URL`, or `services/api/.local/control-plane.db` when unset
- the local community DB root resolved from `LOCAL_COMMUNITY_DB_ROOT`, or `services/api/.local/community-dbs` when unset

2. Ensure `.dev.vars` in `api/services/api` is populated for local file-backed Bun runs.

For local Very widget testing:

- set `VERY_APP_ID`
- optionally set `VERY_API_URL` or `VERY_VERIFY_URL` when testing against a non-default Very endpoint
- the API returns `launch.verify_url` for the Very widget; there is no local verifier proxy

3. Start the Bun local API, web dev server, local verifiers, assistant worker, plus the community job worker:

```bash
cd api/services/api
rtk bun run dev:local:full
```

`dev:local:full` loads dev secrets from Infisical, keeps the SQLite files in `services/api/.local/` by default, reapplies pending control-plane migrations on startup, starts local HNS and Spaces verifiers, prefers a managed `cloudflared` origin or configured `PIRATE_API_PUBLIC_ORIGIN` for the API public origin, runs the assistant worker on port `8791`, routes local Bedsheet model calls through a Bun-side OpenRouter proxy on port `8792`, and runs the translation worker with the same environment as the API process. If no public origin is available, it falls back to `http://127.0.0.1:8787` for local-only API work. If web port `5173`, assistant worker port `8791`, or OpenRouter proxy port `8792` is already in use, the script leaves that existing server alone. Set `PIRATE_DEV_TUNNEL=required` to require a `cloudflared` quick tunnel, `PIRATE_DEV_TUNNEL=auto` to use a tunnel when available, `PIRATE_DEV_USE_REMOTE_CONTROL_PLANE=true` to use the Infisical control-plane database instead of local SQLite, `PIRATE_DEV_USE_REMOTE_VERIFIERS=true` to use verifier URLs from `.dev.vars`, `PIRATE_DEV_START_WEB=false` to leave web startup to a separate terminal, `PIRATE_DEV_START_ASSISTANT=false` to leave Bedsheet startup to a separate terminal, `PIRATE_DEV_OPENROUTER_PROXY_PORT=8793` to move the local OpenRouter proxy, or `PIRATE_DEV_ASSISTANT_INSPECTOR_PORT=9249` to move the assistant worker inspector port search.

Live Self callback testing requires an HTTPS public API origin. Use a live `PIRATE_API_PUBLIC_ORIGIN` or `PIRATE_DEV_TUNNEL=required`; otherwise Self session startup fails instead of generating a QR code that cannot complete.

## Mint A Dev JWT

```bash
rtk bun run mint:dev-jwt --sub dev-user --wallet 0x1111111111111111111111111111111111111111
```

The script reads:

- `AUTH_UPSTREAM_JWT_SHARED_SECRET` or `JWT_BASED_AUTH_SHARED_SECRET`
- `AUTH_UPSTREAM_JWT_ISSUER` or `JWT_BASED_AUTH_ISSUERS`
- `AUTH_UPSTREAM_JWT_AUDIENCE` or `JWT_BASED_AUTH_AUDIENCE`

from `.dev.vars` or the current shell environment.

## Seed And Smoke

The API package includes a manifest-driven lifecycle harness for creating or reusing users and communities through the public HTTP API:

```bash
rtk bun run seed:local-smoke -- --execute
```

Default manifests live under `scripts/seed-manifests/`:

- `local-smoke.json`
  Synthetic local users, dev Very widget-trust verification, open community creation, joins/follows, public and members-only posts, comments, replies, votes, public markdown, Link header, and top-comment checks. It intentionally does not require namespace verification so it can run without an HNS/Spaces verifier.
- `dev-seed.json`
  Synthetic dev users with profile names, global handles, bios, three realistic boards, starter posts, comments, replies, and light engagement.
- `staging-seed.json`
  Richer staging/demo seed. Synthetic users and votes are allowed. Imported TLDs/spaces should be represented with `namespace.provenance` and a real `namespace_verification_id`. Non-prod verification seeding uses the Very local-widget trust path, so staging must explicitly enable that trust setting if synthetic verification is desired.
- `prod-launch.json`
  Production template. Requires real access tokens from `access_token_env`, requires `--confirm-production`, rejects JWT-subject users, rejects synthetic users, and rejects vote seeding.

Useful commands:

```bash
rtk bun run seed:local-smoke
rtk bun run seed:local-smoke -- --execute
rtk env PIRATE_API_URL=https://dev-api.example.com bun run seed:dev -- --execute
rtk env PIRATE_API_URL=https://staging-api.example.com bun run seed:staging -- --execute
rtk env PIRATE_API_URL=https://api.pirate.sc bun run seed:prod-launch -- --execute --confirm-production
```

Dry-runs print planned counts and preflight warnings without mutating remote state. `--execute` upgrades missing env placeholders, unknown user references, duplicate keys, missing post idempotency keys, and missing imported namespace IDs into hard failures before creating content.

Until community creation has an API-level idempotency key, staging and production manifests should provide `community_id` for reruns after the first creation. Otherwise, rerunning a create-mode manifest can create duplicate communities even though posts are protected by `idempotency_key`.

Run `seed:prod-launch` only after replacing the template content with real curated launch content and real namespace verification IDs. Production launch content should come from staff/founding accounts or imported content with provenance; synthetic engagement belongs in local and staging only.

## JWT-Based Upstream Auth

`jwt_based_auth` is a service-to-service exchange path. In staging and production it must only trust an environment-specific issuer and audience, with `AUTH_UPSTREAM_JWT_SHARED_SECRET` stored as a secret outside `wrangler.jsonc`.

Production currently expects:

- `AUTH_UPSTREAM_JWT_ISSUER=pirate-production-upstream`
- `AUTH_UPSTREAM_JWT_AUDIENCE=api-core`

Rotate the upstream shared secret through the secret manager, and do not reuse development or staging issuers/secrets in production.

### JWT Wallet Attestation

When `jwt_based_auth` is enabled, the trusted upstream JWT issuer may attest EVM wallets with either a `wallet_address` claim or a `wallet_addresses` claim. The API verifies the JWT, normalizes and deduplicates valid EVM addresses, and reconciles them through the normal session exchange wallet path. Persisted rows keep provider provenance with `wallet_attachments.source_provider = 'jwt'` and `wallet_attachments.source_subject` set to the verified JWT issuer and subject.

This is an identity-provider attestation, not a wallet-control signature. Only configure JWT issuers and shared secrets for upstreams whose wallet claims you accept as identity assertions. Invalid wallet claims fail authentication. JWTs without wallet claims keep the previous behavior and create no wallet attachments.

## Pirate Session JWT

Pirate bearer tokens are signed with `RS256`.

Required env:

- `PIRATE_APP_JWT_PRIVATE_KEY`
- `PIRATE_APP_JWT_PUBLIC_KEY`
- `PIRATE_APP_JWT_ISSUER`
- `PIRATE_APP_JWT_AUDIENCE`

## OpenAPI Service Description

The runtime `/.well-known/service-desc/public.openapi.json` endpoint serves the full implemented OpenAPI spec derived from `core/specs/api/openapi-implemented.yaml`. To regenerate the bundled spec after contract changes:

```bash
rtk bun run generate:openapi-spec
```

This writes `src/generated/openapi-spec.ts`, which is imported by the discovery router and included in the worker bundle.

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
