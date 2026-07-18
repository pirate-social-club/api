/**
 * The shard Worker's bindings are its D1 namespaces (one per migrated community,
 * named `DB_CMTY_*`), plus the pool metadata D1 (`D1_POOL`) that is the
 * runtime source of truth for the (communityId → bindingName) allowlist.
 *
 * Two checks gate every read (see shard-read.ts):
 *   1. The community must map to a binding in the `d1_pool` table (the shard's
 *      OWN second gate — seeded from `COMMUNITY_D1_BINDING_MAP_JSON` on cold
 *      start). The control-plane routing row is never trusted on its own.
 *   2. The requested bindingName must equal that mapped binding AND that
 *      binding must be a real bound D1 namespace (`resolveD1`).
 *
 * Step 1 of the D1-native workstream: the static `COMMUNITY_D1_BINDING_MAP_JSON`
 * is now only a cold-start seed for `d1_pool`; the runtime allowlist lives in
 * the `D1_POOL` D1. See D1-NATIVE-PROVISIONING-DESIGN.md §3, §5, §8.2.
 */
export interface Env {
  /**
   * JSON object `{ "<communityId>": "<bindingName>" }` — cold-start seed for
   * `d1_pool`. Inserted with `INSERT OR IGNORE` on the first cache miss per
   * isolate. Not consulted after seeding until the pool cache expires.
   */
  COMMUNITY_D1_BINDING_MAP_JSON?: string
  /** Shard-owned pool metadata D1 — the runtime allowlist. */
  D1_POOL?: D1Database
  /**
   * Service-level admin secret (wrangler secret) gating the step-5 reconciler
   * admin RPCs. Unset → admin RPCs fail closed. Set via
   * `wrangler secret put SHARD_ADMIN_TOKEN --env staging`.
   */
  SHARD_ADMIN_TOKEN?: string
  /** Explicit kill switch for destructive loaded-binding reclamation. Staging only. */
  STAGING_RECLAIM_ENABLED?: string
  /** PR2 pilot D1 (added to wrangler.jsonc at provisioning time). */
  DB_CMTY_PILOT?: D1Database
  /** PR2 pilot D1 (the second pilot community, "fixture"). */
  DB_CMTY_FIXTURE?: D1Database
  [binding: string]: D1Database | string | undefined
}
