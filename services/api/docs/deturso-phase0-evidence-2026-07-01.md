# De-Turso Phase 0 Evidence - 2026-07-01

Read-only checks run from `api-slice-d`; Phase 1 and Phase 2 changes were
merged to `main` before production deploys.

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

## Phase 1 Deploy And Smoke

Production `api-core` was redeployed from `origin/main` after the D1-native
production vars landed.

- Deployed Worker version: `a11782d7-4c64-401b-9f2e-daa7c7e34272`.
- Deploy output showed `COMMUNITY_PROVISION_BACKEND="d1_native"` and
  `COMMUNITY_D1_SHARD_REGION="eeur"` in the production environment.
- Health check after deploy: `GET https://api.pirate.sc/health` returned
  `{"ok":true}`.

Production smoke `scripts/smoke-d1-provisioning-cutover.ts`:

- Namespaceless create:
  `com_cmt_d4f69eeb5f124320a8260ec8f015ff75` -> `DB_CMTY_0076`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0076'`.
- Namespaced create:
  `com_cmt_37462fc649904deeb96b0a51067bbf21` with
  `nv_deturso_smoke_20260701190344` -> `DB_CMTY_0077`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0077'`.

An earlier smoke run before the corrected redeploy created two throwaway Turso
communities. Both were copied to D1 and flipped:

- `cmt_7f9f95dc8e154ce99649eac9be64c500` -> `DB_CMTY_0078`,
  no active `community_db_credentials`.
- `cmt_f66ce238319345b3846beaf45f25ca11` -> `DB_CMTY_0079`,
  no active `community_db_credentials`.

Post-smoke production aggregates:

- `community_database_routing`: `d1/ready = 79`; no `turso` rows.
- `community-d1-shard-pool-prod`: `total = 100`, `allocated = 79`,
  `free = 21`, `quarantined = 0`.
- Remaining primary `libsql://` rows without D1 routing are not ready
  communities: `32` active/error pending sentinels, `1` archived/active legacy
  row, and `1` deleted/active legacy row.

## Phase 2 Deploy And Smoke

Production `api-core` was redeployed from `origin/main` after removing the API
read/write Turso dispatch branch and removing `COMMUNITY_READ_ROUTING_ENABLED`
from `wrangler.jsonc`.

- Deployed Worker version: `017bd106-6f80-434c-b941-a50ef9e6e854`.
- Deploy output no longer listed `COMMUNITY_READ_ROUTING_ENABLED`.
- Health check after deploy: `GET https://api.pirate.sc/health` returned
  `{"ok":true}`.

Production smoke `scripts/smoke-d1-provisioning-cutover.ts`:

- Namespaceless create:
  `com_cmt_c722d426fa814c369399f353c1cf4c3b` -> `DB_CMTY_0080`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0080'`.
- Namespaced create:
  `com_cmt_8ac035173f52427dba86432d1ad3004b` with
  `nv_deturso_smoke_20260701192227` -> `DB_CMTY_0081`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0081'`.

## API Operator Path Removal Deploy And Smoke

Production `api-core` was redeployed from `origin/main` after removing the API
Turso provisioning operator backend, operator service binding, and admin
database-migration route.

- Deployed Worker version: `4b3498a0-99c7-49f1-a31c-507d25050733`.
- Deploy output no longer listed the `COMMUNITY_PROVISION_OPERATOR` service binding.
- Health check after deploy: `GET https://api.pirate.sc/health` returned
  `{"ok":true}`.
- Provisioning health returned a D1-native readiness payload with shard and
  region readiness fields.

Production smoke `scripts/smoke-d1-provisioning-cutover.ts`:

- Namespaceless create:
  `com_cmt_8b1e37fb85524c3f951f084a630ad4d4` -> `DB_CMTY_0082`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0082'`.
- Namespaced create:
  `com_cmt_024737057bcf4bed935363a1c0c5efb1` with
  `nv_deturso_smoke_20260701193454` -> `DB_CMTY_0083`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0083'`.

## Operator Package Removal Deploy And Smoke

Production `api-core` was redeployed from `origin/main` after deleting the
retired `services/community-provision-operator` package and removing its root
script and CI references.

- Deployed Worker version: `7a087a2e-0c8f-4bbc-9e93-f0255c204c8a`.
- Deploy output still did not list the `COMMUNITY_PROVISION_OPERATOR` service binding.
- Health check after deploy: `GET https://api.pirate.sc/health` returned
  `{"ok":true}`.
- Provisioning health returned the D1-native readiness payload shape with
  `backend`, `environment`, `ok`, `region_configured`, and `shard_configured`.

Production smoke `scripts/smoke-d1-provisioning-cutover.ts`:

- Namespaceless create:
  `com_cmt_c39986f94b594255b558cef6ea89c25d` -> `DB_CMTY_0086`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0086'`.
- Namespaced create:
  `com_cmt_04b81230a9ff43d1a72bc8a76d4e13e8` with
  `nv_deturso_smoke_20260701195847` -> `DB_CMTY_0087`,
  `backend='d1'`, `provisioning_state='ready'`, `database_url='d1://shard/DB_CMTY_0087'`.
