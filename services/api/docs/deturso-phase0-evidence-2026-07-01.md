# De-Turso Phase 0 Evidence - 2026-07-01

Read-only checks run from `api-slice-d` on branch `deturso-phase1`.

## Control Plane Aggregates

Production `/services/control-plane`:

- `community_database_routing`: `d1/ready = 75`; no `turso` rows.
- `communities`: `total = 110`, `namespace_attached = 64`, `route_slug_set = 64`.
- `community_database_bindings`: `109`.
- `community_db_credentials`: `77`.

Staging `/services/control-plane`:

- `community_database_routing`: `d1/decommissioned = 1`, `d1/ready = 4`, `turso/ready = 17`.
- `communities`: `total = 109`, `namespace_attached = 1`, `route_slug_set = 1`.
- `community_database_bindings`: `109`.
- `community_db_credentials`: `26`.

## Prod Shard Pool

`community-d1-shard-pool-prod` via `wrangler d1 execute --remote`:

- `total = 100`.
- `free = 25`.
- `allocated = 75`.
- `quarantined = 0`.

## Phase 1 Branch Decision

Production has substantial namespace-attached community usage (`64` route-backed
communities), so Phase 1 uses the D1-native namespaced provisioning path instead
of gating namespaced creates off.
