# community-provision-operator

Private Cloudflare Worker that provisions per-community Turso databases. Called by the API Worker via service binding.

## Architecture

```
API Worker  --service binding-->  community-provision-operator
                                       |
                                       +--> Neon control plane DB (Postgres via Neon serverless)
                                       +--> Turso platform API (fetch)
                                       +--> Community Turso DB (libsql bootstrap)
```

## Routes

All routes require bearer auth (`COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN`).

- `POST /internal/v0/community-provisioning/provision` — Create Turso DB, bootstrap schema, return credentials
- `POST /internal/v0/community-provisioning/rotate-token` — Rotate the community DB auth token
- `POST /internal/v0/community-provisioning/doctor` — Diagnose control plane health
- `POST /internal/v0/community-provisioning/reap-stale` — Reap stale provisioning jobs
- `GET  /health` — Health check (no auth required)

## Development

```bash
bun install
bun run dev
```

## Generate SQL Migrations

Migrations are bundled as TS constants. Regenerate after changing `core/db/community-template/migrations/`:

```bash
bun run generate:migrations
```

**Note:** The generation script reads from `../../../../core/db/community-template/migrations` relative to this package by default. Set `PIRATE_CORE_REPO` to point at a different core checkout.

## Type Check

```bash
bun run check
```

## Deploy

```bash
# Set secrets first:
wrangler secret put CONTROL_PLANE_DATABASE_URL
wrangler secret put TURSO_CONTROL_PLANE_AUTH_TOKEN
wrangler secret put TURSO_PLATFORM_API_TOKEN
wrangler secret put TURSO_ORGANIZATION_SLUG
wrangler secret put COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN

# Deploy per environment:
wrangler deploy --env staging
wrangler deploy --env production
```

## Security

- `workers_dev: false` — no public workers.dev URL
- No `routes` — only reachable via service binding from the API Worker
- Bearer auth on all operational routes
- Organization slug guard: `TURSO_ORGANIZATION_SLUG` must match `EXPECTED_TURSO_ORGANIZATION_SLUG` before any Turso platform calls
