import type { Env } from "../../env"
import { internalError } from "../errors"

export function resolveCredentialWrapKey(env: Env): string {
  const configured = String(env.TURSO_COMMUNITY_DB_WRAP_KEY || "").trim()
  if (configured) {
    return configured
  }

  throw internalError("Credential wrap key is not configured")
}

export function resolveCredentialWrapKeyVersion(env: Env): number {
  const parsed = Number(String(env.TURSO_COMMUNITY_DB_WRAP_KEY_VERSION || "").trim())
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  throw internalError("Credential wrap key version is not configured")
}
