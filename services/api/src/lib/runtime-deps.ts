import { createClient, type Client } from "@libsql/client"
import { globalSingleton } from "./db-helpers"
import { requireControlPlaneDbUrl } from "./auth/control-plane-auth-queries"
import type { Env } from "../types"

export function getControlPlaneCacheKey(env: Env): string {
  const url = requireControlPlaneDbUrl(env)
  const authToken = String(env.TURSO_CONTROL_PLANE_AUTH_TOKEN || "").trim()
  return `${url}|${authToken}`
}

function getControlPlaneClient(env: Env): Client {
  const cacheKey = `cp:${getControlPlaneCacheKey(env)}`
  return globalSingleton("controlPlaneClient", cacheKey, () =>
    createClient({
      url: requireControlPlaneDbUrl(env),
      authToken: String(env.TURSO_CONTROL_PLANE_AUTH_TOKEN || "").trim() || undefined,
    }),
  )
}

export { getControlPlaneClient }
