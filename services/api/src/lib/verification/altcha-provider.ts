import { createChallenge, randomInt, verifySolution, type Challenge, type Payload } from "altcha-lib"
import { deriveKey } from "altcha-lib/algorithms/pbkdf2"
import { internalError, rateLimited } from "../errors"
import { sha256Hex } from "../crypto"
import { getControlPlaneClient } from "../runtime-deps"
import type { Env } from "../../env"

export const ALTCHA_HEADER = "x-pirate-altcha"

export type AltchaScope =
  | "community_join"
  | "post_create"
  | "comment_create"

export type AltchaProofInput = {
  payload: string
  scope: AltchaScope
  action: string
}

export type AltchaVerificationResult = {
  verified: boolean
  reason?: "missing_proof" | "invalid_payload" | "invalid_solution" | "expired" | "binding_mismatch" | "replayed"
}

const ALTCHA_SCOPES = new Set<AltchaScope>([
  "community_join",
  "post_create",
  "comment_create",
])

function parseIntegerEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function getAltchaSecrets(env: Env): { hmacSignatureSecret: string; hmacKeySignatureSecret: string } {
  const hmacSignatureSecret = env.ALTCHA_HMAC_SECRET?.trim()
  const hmacKeySignatureSecret = env.ALTCHA_HMAC_KEY_SECRET?.trim()
  if (!hmacSignatureSecret || !hmacKeySignatureSecret) {
    throw internalError("ALTCHA is not configured")
  }
  return { hmacSignatureSecret, hmacKeySignatureSecret }
}

export function isAltchaScope(value: unknown): value is AltchaScope {
  return typeof value === "string" && ALTCHA_SCOPES.has(value as AltchaScope)
}

export function normalizeAltchaAction(value: unknown): string | null {
  const action = typeof value === "string" ? value.trim() : ""
  return action && action.length <= 300 ? action : null
}

export function readAltchaProof(input: {
  headerValue?: string | null
  body?: unknown
  scope: AltchaScope
  action: string
}): AltchaProofInput | undefined {
  const bodyValue = input.body && typeof input.body === "object" && !Array.isArray(input.body)
    ? (input.body as Record<string, unknown>).altcha
    : null
  const payload = typeof input.headerValue === "string" && input.headerValue.trim()
    ? input.headerValue.trim()
    : typeof bodyValue === "string" && bodyValue.trim()
      ? bodyValue.trim()
      : ""
  return payload ? { payload, scope: input.scope, action: input.action } : undefined
}

export async function createAltchaChallenge(input: {
  env: Env
  actorUserId: string
  scope: AltchaScope
  action: string
}): Promise<Challenge> {
  const { hmacSignatureSecret, hmacKeySignatureSecret } = getAltchaSecrets(input.env)
  const cost = parseIntegerEnv(input.env.ALTCHA_POW_COST, 5_000)
  const counterMin = parseIntegerEnv(input.env.ALTCHA_POW_COUNTER_MIN, 5_000)
  const counterMax = Math.max(counterMin, parseIntegerEnv(input.env.ALTCHA_POW_COUNTER_MAX, 10_000))
  const ttlSeconds = parseIntegerEnv(input.env.ALTCHA_CHALLENGE_TTL_SECONDS, 20 * 60)

  return await createChallenge({
    algorithm: "PBKDF2/SHA-256",
    cost,
    counter: randomInt(counterMax, counterMin),
    data: {
      actor: input.actorUserId,
      scope: input.scope,
      action: input.action,
    },
    deriveKey,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
    hmacSignatureSecret,
    hmacKeySignatureSecret,
  })
}

export async function purgeExpiredAltchaState(input: {
  env: Env
  now?: Date
}): Promise<void> {
  const now = input.now ?? new Date()
  const client = getControlPlaneClient(input.env)
  await client.execute({
    sql: "DELETE FROM altcha_used_challenges WHERE expires_at < ?1",
    args: [now.toISOString()],
  })

  const windowSeconds = parseIntegerEnv(input.env.ALTCHA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS, 60)
  const requestWindowRetentionMs = windowSeconds * 10 * 1000
  await client.execute({
    sql: "DELETE FROM altcha_challenge_rate_limits WHERE window_start < ?1",
    args: [new Date(now.getTime() - requestWindowRetentionMs).toISOString()],
  })
}

export async function enforceAltchaChallengeRateLimit(input: {
  env: Env
  actorUserId: string
  now?: Date
}): Promise<void> {
  const maxRequests = parseIntegerEnv(input.env.ALTCHA_CHALLENGE_RATE_LIMIT, 10)
  const windowSeconds = parseIntegerEnv(input.env.ALTCHA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS, 60)
  const now = input.now ?? new Date()
  const windowStartSeconds = Math.floor(Math.floor(now.getTime() / 1000) / windowSeconds) * windowSeconds
  const windowStart = new Date(windowStartSeconds * 1000).toISOString()
  const client = getControlPlaneClient(input.env)

  await client.execute({
    sql: `
      INSERT INTO altcha_challenge_rate_limits (
        actor_user_id, window_start, request_count, updated_at
      ) VALUES (?1, ?2, 1, ?3)
      ON CONFLICT(actor_user_id, window_start) DO UPDATE SET
        request_count = altcha_challenge_rate_limits.request_count + 1,
        updated_at = excluded.updated_at
    `,
    args: [input.actorUserId, windowStart, now.toISOString()],
  })

  const current = await client.execute({
    sql: `
      SELECT request_count
      FROM altcha_challenge_rate_limits
      WHERE actor_user_id = ?1 AND window_start = ?2
    `,
    args: [input.actorUserId, windowStart],
  })
  const requestCount = Number(current.rows[0]?.request_count ?? 0)
  if (requestCount > maxRequests) {
    throw rateLimited("ALTCHA challenge rate limit exceeded", {
      limit: maxRequests,
      window_seconds: windowSeconds,
    })
  }
}

function parseAltchaPayload(payload: string): Payload | null {
  try {
    const decoded = atob(payload)
    const parsed = JSON.parse(decoded) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    const record = parsed as Partial<Payload>
    if (!record.challenge || !record.solution) {
      return null
    }
    return record as Payload
  } catch {
    return null
  }
}

function readChallengeData(challenge: Challenge): { actor: string | null; scope: string | null; action: string | null } {
  const data = challenge.parameters.data ?? {}
  return {
    actor: typeof data.actor === "string" ? data.actor : null,
    scope: typeof data.scope === "string" ? data.scope : null,
    action: typeof data.action === "string" ? data.action : null,
  }
}

async function consumeAltchaChallenge(input: {
  env: Env
  actorUserId: string
  proof: AltchaProofInput
  challenge: Challenge
}): Promise<boolean> {
  const replayMaterial = [
    input.challenge.parameters.nonce,
    input.challenge.signature ?? "",
    input.challenge.parameters.keyPrefix,
  ].join(":")
  const challengeHash = await sha256Hex(replayMaterial)
  const now = new Date().toISOString()
  const expiresAtSeconds = input.challenge.parameters.expiresAt
  const expiresAt = typeof expiresAtSeconds === "number"
    ? new Date(expiresAtSeconds * 1000).toISOString()
    : new Date(Date.now() + 20 * 60 * 1000).toISOString()
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT OR IGNORE INTO altcha_used_challenges (
        challenge_hash, actor_user_id, scope, action_ref, used_at, expires_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `,
    args: [challengeHash, input.actorUserId, input.proof.scope, input.proof.action, now, expiresAt],
  })
  return result.rowsAffected === 1
}

export async function verifyAndConsumeAltchaProof(input: {
  env: Env
  actorUserId: string
  proof?: AltchaProofInput
}): Promise<AltchaVerificationResult> {
  if (!input.proof?.payload) {
    return { verified: false, reason: "missing_proof" }
  }

  const payload = parseAltchaPayload(input.proof.payload)
  if (!payload) {
    return { verified: false, reason: "invalid_payload" }
  }

  const { hmacSignatureSecret, hmacKeySignatureSecret } = getAltchaSecrets(input.env)
  const result = await verifySolution({
    challenge: payload.challenge,
    solution: payload.solution,
    deriveKey,
    hmacSignatureSecret,
    hmacKeySignatureSecret,
  })
  if (!result.verified) {
    return { verified: false, reason: result.expired ? "expired" : "invalid_solution" }
  }

  const data = readChallengeData(payload.challenge)
  if (
    data.actor !== input.actorUserId
    || data.scope !== input.proof.scope
    || data.action !== input.proof.action
  ) {
    return { verified: false, reason: "binding_mismatch" }
  }

  const consumed = await consumeAltchaChallenge({
    env: input.env,
    actorUserId: input.actorUserId,
    proof: input.proof,
    challenge: payload.challenge,
  })
  return consumed ? { verified: true } : { verified: false, reason: "replayed" }
}
