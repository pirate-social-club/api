import { readAuthState } from "./config.js"

const DEFAULT_BASE_URL = process.env.PIRATE_BASE_URL || "http://127.0.0.1:8787"
type JwtPayload = {
  iat?: number
  exp?: number
}

export function resolveBaseUrl(override?: string | null): string {
  return override || readAuthState()?.base_url || DEFAULT_BASE_URL
}

export function requireStoredSession(): {
  baseUrl: string
  accessToken: string
  userId: string
} {
  const state = readAuthState()
  if (!state || !state.access_token || !state.base_url || !state.user_id) {
    throw new Error("No stored Pirate session. Run `pirate auth login --jwt <token>` first.")
  }
  return {
    baseUrl: state.base_url,
    accessToken: state.access_token,
    userId: state.user_id,
  }
}

export function decodeJwtTimes(token: string): {
  issuedAt: string | null
  expiresAt: string | null
} {
  const payload = decodeJwtPayload(token)
  return {
    issuedAt: typeof payload.iat === "number" ? new Date(payload.iat * 1000).toISOString() : null,
    expiresAt: typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : null,
  }
}

function decodeJwtPayload(token: string): JwtPayload {
  const parts = token.split(".")
  if (parts.length < 2) {
    return {}
  }
  const payload = parts[1]
  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4))
  const decoded = Buffer.from(normalized + pad, "base64").toString("utf8")
  return JSON.parse(decoded) as JwtPayload
}
