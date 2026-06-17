/**
 * The shard Worker's bindings are its D1 namespaces (one per migrated community,
 * named `DB_CMTY_*`). The index signature is what `resolveD1` validates against:
 * a requested bindingName is only honored if it maps to a real bound D1 here —
 * the control-plane routing row is never trusted on its own.
 */
export interface Env {
  /** PR2 pilot D1 (added to wrangler.jsonc at provisioning time). */
  DB_CMTY_PILOT?: D1Database
  [binding: string]: D1Database | undefined
}
