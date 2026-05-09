import { authError, badRequestError } from "../errors"
import { sha256Hex } from "../crypto"
import { mintPirateAccessToken } from "../auth/pirate-session-token"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import type { Env } from "../../env"

const CLIENT_ID = "freedom-desktop"
const DEFAULT_DEVICE_CODE_TTL_SECONDS = 15 * 60
const DEFAULT_POLL_INTERVAL_SECONDS = 5
const DEFAULT_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
const ALLOWED_SCOPES = new Set([
  "live_room:attach",
  "live_room:manage",
  "song_artifacts:read",
  "profile:read",
])
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

type DeviceAuthorizationRow = {
  device_code: string
  user_code: string
  client_id: string
  user_id: string | null
  scope: string
  status: "pending" | "authorized" | "consumed" | "expired" | "revoked"
  access_token_hash: string | null
  refresh_token_hash: string | null
  expires_at: number
  authorized_at: number | null
  consumed_at: number | null
  token_expires_at: number | null
  refresh_expires_at: number | null
  created_at: string
  updated_at: string
}

export type DeviceAuthorizeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete: string
  expires_in: number
  interval: number
}

export type DeviceVerifyResponse = {
  client_id: string
  scope: string
  status: "authorized"
  user_code: string
}

export type DeviceTokenSuccessResponse = {
  access_token: string
  refresh_token: string
  token_type: "Bearer"
  expires_in: number
  refresh_expires_in: number
  scope: string
}

export type DeviceTokenPendingResponse = {
  error: "authorization_pending"
  error_description: string
  interval: number
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function nowIso(): string {
  return new Date().toISOString()
}

function buildOpaqueToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

function buildCodeSegment(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  let output = ""
  for (const byte of bytes) {
    output += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  }
  return output
}

function buildUserCode(): string {
  return `PTR-${buildCodeSegment(4)}-${buildCodeSegment(4)}`
}

function normalizeClientId(value: unknown): string {
  const clientId = typeof value === "string" ? value.trim() : ""
  if (clientId !== CLIENT_ID) {
    throw badRequestError("Unsupported OAuth client")
  }
  return clientId
}

function normalizeScope(value: unknown): string {
  const raw = typeof value === "string" && value.trim()
    ? value.trim()
    : "live_room:attach live_room:manage song_artifacts:read profile:read"
  const scopes = [...new Set(raw.split(/\s+/).filter(Boolean))]
  if (scopes.length === 0 || scopes.some((scope) => !ALLOWED_SCOPES.has(scope))) {
    throw badRequestError("Invalid OAuth scope")
  }
  return scopes.join(" ")
}

function normalizeUserCode(value: unknown): string {
  const userCode = typeof value === "string" ? value.trim().toUpperCase() : ""
  if (!/^PTR-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(userCode)) {
    throw badRequestError("Invalid user_code")
  }
  return userCode
}

function normalizeOpaqueToken(value: unknown, field: string): string {
  const token = typeof value === "string" ? value.trim() : ""
  if (!token || token.length > 256 || /\s/.test(token)) {
    throw badRequestError(`${field} is invalid`)
  }
  return token
}

function webOrigin(env: Env): string {
  const raw = String(env.PIRATE_WEB_PUBLIC_ORIGIN || "").trim() || "https://pirate.sc"
  try {
    const url = new URL(raw)
    url.pathname = ""
    url.search = ""
    url.hash = ""
    return url.toString().replace(/\/$/, "")
  } catch {
    return "https://pirate.sc"
  }
}

function toRow(row: unknown): DeviceAuthorizationRow | null {
  if (!row || typeof row !== "object") return null
  const value = row as Record<string, unknown>
  return {
    device_code: String(value.device_code ?? ""),
    user_code: String(value.user_code ?? ""),
    client_id: String(value.client_id ?? ""),
    user_id: typeof value.user_id === "string" ? value.user_id : null,
    scope: String(value.scope ?? ""),
    status: String(value.status ?? "pending") as DeviceAuthorizationRow["status"],
    access_token_hash: typeof value.access_token_hash === "string" ? value.access_token_hash : null,
    refresh_token_hash: typeof value.refresh_token_hash === "string" ? value.refresh_token_hash : null,
    expires_at: Number(value.expires_at),
    authorized_at: value.authorized_at == null ? null : Number(value.authorized_at),
    consumed_at: value.consumed_at == null ? null : Number(value.consumed_at),
    token_expires_at: value.token_expires_at == null ? null : Number(value.token_expires_at),
    refresh_expires_at: value.refresh_expires_at == null ? null : Number(value.refresh_expires_at),
    created_at: String(value.created_at ?? ""),
    updated_at: String(value.updated_at ?? ""),
  }
}

async function getDeviceAuthorizationByCode(client: Client, userCode: string): Promise<DeviceAuthorizationRow | null> {
  const result = await client.execute({
    sql: `
      SELECT device_code, user_code, client_id, user_id, scope, status,
             access_token_hash, refresh_token_hash, expires_at, authorized_at,
             consumed_at, token_expires_at, refresh_expires_at, created_at, updated_at
      FROM oauth_device_authorizations
      WHERE user_code = ?1
      LIMIT 1
    `,
    args: [userCode],
  })
  return toRow(result.rows[0])
}

async function getDeviceAuthorizationByDeviceCode(client: Client, deviceCode: string): Promise<DeviceAuthorizationRow | null> {
  const result = await client.execute({
    sql: `
      SELECT device_code, user_code, client_id, user_id, scope, status,
             access_token_hash, refresh_token_hash, expires_at, authorized_at,
             consumed_at, token_expires_at, refresh_expires_at, created_at, updated_at
      FROM oauth_device_authorizations
      WHERE device_code = ?1
      LIMIT 1
    `,
    args: [deviceCode],
  })
  return toRow(result.rows[0])
}

async function expireRow(client: Client, row: DeviceAuthorizationRow): Promise<void> {
  await client.execute({
    sql: `
      UPDATE oauth_device_authorizations
      SET status = 'expired',
          updated_at = ?2
      WHERE device_code = ?1
        AND status IN ('pending', 'authorized')
    `,
    args: [row.device_code, nowIso()],
  })
}

export async function createDeviceAuthorization(env: Env, body: unknown): Promise<DeviceAuthorizeResponse> {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const clientId = normalizeClientId(payload.client_id)
  const scope = normalizeScope(payload.scope)
  const ttlSeconds = numberEnv(env.OAUTH_DEVICE_CODE_TTL_SECONDS, DEFAULT_DEVICE_CODE_TTL_SECONDS)
  const interval = numberEnv(env.OAUTH_DEVICE_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS)
  const deviceCode = buildOpaqueToken("pdev")
  const userCode = buildUserCode()
  const createdAt = nowIso()
  const expiresAt = nowSeconds() + ttlSeconds
  const verificationUri = `${webOrigin(env)}/authorize-device`

  await getControlPlaneClient(env).execute({
    sql: `
      INSERT INTO oauth_device_authorizations (
        device_code, user_code, client_id, user_id, scope, status,
        access_token_hash, refresh_token_hash, expires_at, authorized_at,
        consumed_at, token_expires_at, refresh_expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, NULL, ?4, 'pending', NULL, NULL, ?5, NULL, NULL, NULL, NULL, ?6, ?6)
    `,
    args: [deviceCode, userCode, clientId, scope, expiresAt, createdAt],
  })

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: `${verificationUri}?user_code=${encodeURIComponent(userCode)}`,
    expires_in: ttlSeconds,
    interval,
  }
}

export async function authorizeDeviceCode(env: Env, input: {
  userCode: unknown
  userId: string
}): Promise<DeviceVerifyResponse> {
  const userCode = normalizeUserCode(input.userCode)
  const client = getControlPlaneClient(env)
  const row = await getDeviceAuthorizationByCode(client, userCode)
  if (!row) {
    throw badRequestError("Device authorization not found")
  }
  if (row.expires_at <= nowSeconds()) {
    await expireRow(client, row)
    throw badRequestError("Device authorization expired")
  }
  if (row.status !== "pending" && row.status !== "authorized") {
    throw badRequestError("Device authorization is no longer pending")
  }

  const authorizedAt = nowSeconds()
  await client.execute({
    sql: `
      UPDATE oauth_device_authorizations
      SET user_id = ?2,
          status = 'authorized',
          authorized_at = COALESCE(authorized_at, ?3),
          updated_at = ?4
      WHERE device_code = ?1
        AND status IN ('pending', 'authorized')
    `,
    args: [row.device_code, input.userId, authorizedAt, nowIso()],
  })

  return {
    client_id: row.client_id,
    scope: row.scope,
    status: "authorized",
    user_code: row.user_code,
  }
}

async function issueTokens(env: Env, input: {
  client: Client
  row: DeviceAuthorizationRow
  refreshedFromRefreshTokenHash?: string | null
}): Promise<DeviceTokenSuccessResponse> {
  if (!input.row.user_id) {
    throw authError("Authentication failed")
  }
  const accessTokenTtl = numberEnv(env.PIRATE_APP_JWT_TTL_SECONDS, 60 * 60)
  const refreshTokenTtl = numberEnv(env.OAUTH_DEVICE_REFRESH_TOKEN_TTL_SECONDS, DEFAULT_REFRESH_TOKEN_TTL_SECONDS)
  const issuedAt = nowSeconds()
  const accessToken = await mintPirateAccessToken({
    env,
    scope: input.row.scope,
    userId: input.row.user_id,
  })
  const refreshToken = buildOpaqueToken("pdrf")
  const accessTokenHash = await sha256Hex(accessToken)
  const refreshTokenHash = await sha256Hex(refreshToken)

  await input.client.execute({
    sql: `
      UPDATE oauth_device_authorizations
      SET status = 'consumed',
          access_token_hash = ?2,
          refresh_token_hash = ?3,
          consumed_at = COALESCE(consumed_at, ?4),
          token_expires_at = ?5,
          refresh_expires_at = ?6,
          updated_at = ?7
      WHERE device_code = ?1
    `,
    args: [
      input.row.device_code,
      accessTokenHash,
      refreshTokenHash,
      issuedAt,
      issuedAt + accessTokenTtl,
      issuedAt + refreshTokenTtl,
      nowIso(),
    ],
  })

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: accessTokenTtl,
    refresh_expires_in: refreshTokenTtl,
    scope: input.row.scope,
  }
}

export async function pollDeviceToken(env: Env, body: unknown): Promise<DeviceTokenSuccessResponse | DeviceTokenPendingResponse> {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const clientId = normalizeClientId(payload.client_id)
  const deviceCode = normalizeOpaqueToken(payload.device_code, "device_code")
  const client = getControlPlaneClient(env)
  const row = await getDeviceAuthorizationByDeviceCode(client, deviceCode)
  if (!row || row.client_id !== clientId) {
    throw badRequestError("Invalid device_code")
  }
  if (row.expires_at <= nowSeconds()) {
    await expireRow(client, row)
    throw badRequestError("Device authorization expired")
  }
  if (row.status === "pending") {
    return {
      error: "authorization_pending",
      error_description: "The user has not authorized this device yet.",
      interval: numberEnv(env.OAUTH_DEVICE_POLL_INTERVAL_SECONDS, DEFAULT_POLL_INTERVAL_SECONDS),
    }
  }
  if (row.status !== "authorized") {
    throw badRequestError("Device authorization is no longer available")
  }
  return issueTokens(env, { client, row })
}

export async function refreshDeviceToken(env: Env, body: unknown): Promise<DeviceTokenSuccessResponse> {
  const payload = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const clientId = normalizeClientId(payload.client_id)
  const refreshToken = normalizeOpaqueToken(payload.refresh_token, "refresh_token")
  const refreshTokenHash = await sha256Hex(refreshToken)
  const client = getControlPlaneClient(env)
  const result = await client.execute({
    sql: `
      SELECT device_code, user_code, client_id, user_id, scope, status,
             access_token_hash, refresh_token_hash, expires_at, authorized_at,
             consumed_at, token_expires_at, refresh_expires_at, created_at, updated_at
      FROM oauth_device_authorizations
      WHERE client_id = ?1
        AND refresh_token_hash = ?2
        AND status = 'consumed'
      LIMIT 1
    `,
    args: [clientId, refreshTokenHash],
  })
  const row = toRow(result.rows[0])
  if (!row || !row.refresh_expires_at || row.refresh_expires_at <= nowSeconds()) {
    throw authError("Authentication failed")
  }
  return issueTokens(env, { client, row, refreshedFromRefreshTokenHash: refreshTokenHash })
}
