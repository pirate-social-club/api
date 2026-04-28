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
  mode: "user" | "admin"
  accessToken: string | null
  adminToken: string | null
  adminAsUserId: string | null
  userId: string
} {
  const state = readAuthState()
  if (!state || !state.base_url || !state.user_id) {
    throw new Error("No stored Pirate session. Run `pirate auth login --jwt <token>` first.")
  }
  const mode = state.mode === "admin" ? "admin" : "user"
  if (mode === "admin" && !state.admin_token) {
    throw new Error("Stored Pirate admin session is missing admin_token. Run `pirate auth admin-login --admin-token <token>` first.")
  }
  if (mode === "user" && !state.access_token) {
    throw new Error("Stored Pirate user session is missing access_token. Run `pirate auth login --jwt <token>` first.")
  }
  return {
    baseUrl: state.base_url,
    mode,
    accessToken: state.access_token ?? null,
    adminToken: state.admin_token ?? null,
    adminAsUserId: state.admin_as_user_id ?? null,
    userId: state.user_id,
  }
}

export function apiAuthHeadersForSession(session: ReturnType<typeof requireStoredSession>, asUserId?: string | null): {
  accessToken?: string | null
  adminToken?: string | null
  adminAsUserId?: string | null
} {
  if (session.mode === "admin") {
    return {
      adminToken: session.adminToken,
      adminAsUserId: asUserId ?? session.adminAsUserId ?? session.userId,
    }
  }
  return {
    accessToken: session.accessToken,
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
