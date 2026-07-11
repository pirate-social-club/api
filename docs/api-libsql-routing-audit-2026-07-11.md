# API libSQL and community routing audit — 2026-07-11

Baseline: clean `origin/main` at `29266891`. The stale salvage checkout was not
used or modified.

## Disposition

| Surface | Transport and reachability | Disposition |
| --- | --- | --- |
| `community-read-access.ts` | Production and staging resolve the control-plane routing row and use the `COMMUNITY_D1_SHARD` service binding. The local client is selected only when `ENVIRONMENT === "test"` and the shard binding is absent. | Production is D1-only. Keep the explicit test fallback for now. |
| `community-db-factory.ts` | Opens only `file:` SQLite URLs and rejects every non-file binding. No production module calls it directly; the only non-test importer is the test-only fallback above. | Local development/test infrastructure, not a production fallback. |
| `community-local-db.ts` | Creates and migrates filesystem SQLite databases. `LOCAL_COMMUNITY_DB_ROOT` is used by local scripts and tests and is absent from deployed Worker configuration. | Keep as local tooling until the test harness is migrated. |
| `provisioning/backend.ts` | Selects local provisioning only when `LOCAL_COMMUNITY_DB_ROOT` is configured; otherwise selects D1-native provisioning. Staging and production both bind `COMMUNITY_D1_SHARD`. | Production is D1-native and fails if the shard is unavailable. |
| `runtime-deps.ts` | Uses libSQL for non-Postgres control-plane URLs used by local development/tests. Production uses the PostgreSQL adapter. | `@libsql/client` remains a direct dependency; removing community fallback code alone cannot remove it. |
| `ensure-remote-community-membership-indexes.ts` | No production importer; referenced only by its own test. | Remove as dead remote-Turso compatibility code. |
| `ensure-remote-live-room-tables.ts` | No production importer; referenced only by its own test. | Remove as dead remote-Turso compatibility code. |
| `.dev.vars.example` `TURSO_*` entries | No code or documentation consumer. | Remove stale sample variables. |

No remote Turso transport remains: every community libSQL client opens a `file:`
URL, and `openCommunityDb` explicitly rejects non-file bindings.

## Routing failure behavior

- Missing routing row: `404 community_not_found`.
- Provisioning row: retryable `503 binding_pending`, without caching the row.
- Decommissioned row: `410 community_decommissioned`, cached for five seconds.
- Degraded row: still routed to D1, cached for five seconds; unattended booking
  settlement excludes degraded routes.
- Missing shard service binding: retryable `503 d1_backend_not_provisioned`.
- Missing D1 binding name: `500 binding_not_found`.

## Follow-up

`routeCommunityRead` invalidates its cache only when opening the read client
throws. The real shard does not execute RPC during client construction, so a
`binding_stale` returned later by `client.execute()` bypasses that invalidation.
The write client has the same gap. Fix this separately by invalidating and
retrying at the RPC boundary; it is a routing correctness issue, not part of the
mechanical Turso cleanup.

To remove `@libsql/client` entirely, first replace both remaining local uses: the
filesystem community test/development harness and the non-Postgres local
control-plane adapter. Moving the package to `devDependencies` while these
modules remain statically imported would misclassify a build-time Worker
dependency rather than remove it.
