import type { Env } from "../../env"

export function shouldUseLocalCommunityDb(env: Env): boolean {
  if (env.COMMUNITY_D1_SHARD) return false
  if (!String(env.LOCAL_COMMUNITY_DB_ROOT ?? "").trim()) return false

  const environment = String(env.ENVIRONMENT ?? "").trim().toLowerCase()
  return environment === "development" || environment === "test"
}
