import { internalError, providerUnavailable } from "../errors"
import type { Env } from "../../env"
import type { VerificationCapabilities } from "../../types"

const PASSPORT_API_URL = "https://api.passport.xyz"
const PASSPORT_TIMEOUT_MS = 15_000
export const PASSPORT_WALLET_SCORE_TTL_MS = 24 * 60 * 60 * 1000

type WalletScoreCapability = VerificationCapabilities["wallet_score"]

type PassportScoreResponse = {
  score?: unknown
  threshold?: unknown
  threshold_score?: unknown
  score_threshold?: unknown
  evidence?: {
    threshold?: unknown
  } | null
  passing_score?: unknown
  status?: unknown
  error?: unknown
  last_score_timestamp?: unknown
  expiration_timestamp?: unknown
  stamp_scores?: unknown
  stamps?: unknown
}

export type PassportProvider = {
  refreshWalletScore(input: {
    address: string
    now?: Date
  }): Promise<WalletScoreCapability>
}

let passportProviderForTests: PassportProvider | null = null

export function setPassportProviderForTests(provider: PassportProvider | null): void {
  passportProviderForTests = provider
}

function trimEnv(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : ""
}

function numericValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function booleanValue(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function decimalString(value: number | null): string | null {
  return value == null ? null : String(value)
}

function unixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000)
}

function parseUnixSeconds(value: string | null, fallback: Date): number {
  if (!value) {
    return unixSeconds(fallback)
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : unixSeconds(fallback)
}

function normalizeStampScores(value: unknown): WalletScoreCapability["stamps"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }
  return Object.entries(value as Record<string, unknown>)
    .map(([stampName, raw]) => {
      const stampScore = typeof raw === "object" && raw != null && !Array.isArray(raw)
        ? numericValue((raw as Record<string, unknown>).score)
        : numericValue(raw)
      return {
        stamp_name: stampName,
        ...(stampScore == null ? {} : { stamp_score_decimal: String(stampScore) }),
      }
    })
    .filter((stamp) => stamp.stamp_name)
}

function unverifiedWalletScore(now: Date): WalletScoreCapability {
  return {
    state: "unverified",
    provider: "passport",
    proof_type: "wallet_score",
    mechanism: "stamps-api-v2",
    verified_at: null,
    score_decimal: null,
    score_threshold_decimal: null,
    passing_score: null,
    last_scored_at: unixSeconds(now),
    expires_at: null,
    stamps: null,
  }
}

function isUnregisteredScoreResponse(status: number, body: PassportScoreResponse | null): boolean {
  if (status === 404) {
    return true
  }
  const errorText = typeof body?.error === "string"
    ? body.error.toLowerCase()
    : typeof body?.error === "object" && body.error != null && "message" in body.error
      ? String((body.error as { message?: unknown }).message).toLowerCase()
      : ""
  return Boolean(errorText.match(/not found|no score|not submitted|does not exist|unregistered/u))
}

function normalizePassportScoreResponse(body: PassportScoreResponse, now: Date): WalletScoreCapability {
  const score = numericValue(body.score)
  if (score == null) {
    return unverifiedWalletScore(now)
  }

  const scoreThreshold = numericValue(body.threshold_score)
    ?? numericValue(body.score_threshold)
    ?? numericValue(body.threshold)
    ?? numericValue(body.evidence?.threshold)
  const passingScore = booleanValue(body.passing_score)
    ?? (scoreThreshold == null ? null : score >= scoreThreshold)
  const lastScoreTimestamp = stringValue(body.last_score_timestamp) ?? now.toISOString()
  const providerExpiration = stringValue(body.expiration_timestamp)
  const cacheExpiration = new Date(now.getTime() + PASSPORT_WALLET_SCORE_TTL_MS).toISOString()

  return {
    state: "verified",
    provider: "passport",
    proof_type: "wallet_score",
    mechanism: "stamps-api-v2",
    verified_at: unixSeconds(now),
    score_decimal: decimalString(score),
    score_threshold_decimal: decimalString(scoreThreshold),
    passing_score: passingScore,
    last_scored_at: parseUnixSeconds(lastScoreTimestamp, now),
    expires_at: parseUnixSeconds(providerExpiration ?? cacheExpiration, now),
    stamps: normalizeStampScores(body.stamp_scores ?? body.stamps),
  }
}

function buildPassportScoreUrl(env: Env, address: string): string {
  const scorerId = trimEnv(env.PASSPORT_SCORER_ID)
  if (!scorerId) {
    throw providerUnavailable("Passport provider not configured: PASSPORT_SCORER_ID must be set")
  }

  const baseUrl = trimEnv(env.PASSPORT_API_URL) || PASSPORT_API_URL
  try {
    const url = new URL(baseUrl)
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v2/stamps/${encodeURIComponent(scorerId)}/score/${encodeURIComponent(address)}`
    return url.toString()
  } catch {
    throw internalError("PASSPORT_API_URL is not a valid URL")
  }
}

export function getPassportProvider(env: Env): PassportProvider {
  if (passportProviderForTests) {
    return passportProviderForTests
  }

  const apiKey = trimEnv(env.PASSPORT_API_KEY)
  if (!apiKey) {
    throw providerUnavailable("Passport provider not configured: PASSPORT_API_KEY must be set")
  }

  return {
    refreshWalletScore: async ({ address, now = new Date() }) => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), PASSPORT_TIMEOUT_MS)
      let response: Response
      try {
        response = await fetch(buildPassportScoreUrl(env, address), {
          method: "GET",
          headers: {
            accept: "application/json",
            "X-API-KEY": apiKey,
          },
          signal: controller.signal,
        })
      } catch (error) {
        throw providerUnavailable("Passport score request failed", {
          cause: error instanceof Error ? error.message : String(error),
        })
      } finally {
        clearTimeout(timeout)
      }

      const body = await response.json().catch(() => null) as PassportScoreResponse | null
      if (isUnregisteredScoreResponse(response.status, body)) {
        return unverifiedWalletScore(now)
      }
      if (!response.ok || !body) {
        throw providerUnavailable(`Passport score request failed with status ${response.status}`)
      }
      return normalizePassportScoreResponse(body, now)
    },
  }
}
