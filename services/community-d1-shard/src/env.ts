/**
 * The shard Worker's bindings are its D1 namespaces (one per migrated community,
 * named `DB_CMTY_*`), plus a `(communityId → bindingName)` allowlist.
 *
 * Two checks gate every read (see shard-read.ts): the community must map to a
 * binding here (`COMMUNITY_D1_BINDING_MAP_JSON`) AND the requested bindingName
 * must equal that mapped binding AND that binding must be a real bound D1
 * namespace. The control-plane routing row is never trusted on its own.
 */
export interface Env {
  /** JSON object `{ "<communityId>": "<bindingName>" }` of communities this shard serves. */
  COMMUNITY_D1_BINDING_MAP_JSON?: string
  /** PR2 pilot D1 (added to wrangler.jsonc at provisioning time). */
  DB_CMTY_PILOT?: D1Database
  [binding: string]: D1Database | string | undefined
}
