import { KARAOKE_TRANSPORT_PROTOCOL_VERSION } from "@pirate-social-club/karaoke-runtime"

export const KARAOKE_GATEWAY_TOKEN_VERSION = 1 as const
export const KARAOKE_GATEWAY_TOKEN_TTL_SECONDS = 60 as const
const KARAOKE_TOKEN_CLOCK_SKEW_SECONDS = 30 as const

const TOKEN_HEADER = { alg: "HS256", typ: "JWT" } as const
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export interface KaraokeGatewayClaims {
  tokenVersion: typeof KARAOKE_GATEWAY_TOKEN_VERSION
  protocolVersion: typeof KARAOKE_TRANSPORT_PROTOCOL_VERSION
  subject: string
  communityId: string
  postId: string
  sessionId: string
  attemptId: string
  issuedAt: number
  expiresAt: number
  nonce: string
}

type KaraokeGatewayTokenErrorCode =
  | "invalid_token"
  | "invalid_token_claims"
  | "token_expired"
  | "token_issued_in_future"
  | "token_lifetime_exceeded"
  | "unsupported_token_version"
  | "unsupported_protocol_version"

export type VerifyKaraokeGatewayTokenResult =
  | { claims: KaraokeGatewayClaims; error?: never }
  | { error: KaraokeGatewayTokenErrorCode; claims?: never }

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "")
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")
  try {
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function importHmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new Error("KARAOKE_GATEWAY_SIGNING_KEY must contain at least 32 characters")
  }
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    [usage],
  )
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)))
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256
}

function parseClaims(value: unknown): KaraokeGatewayClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const claims = value as Record<string, unknown>
  if (
    claims.tokenVersion !== KARAOKE_GATEWAY_TOKEN_VERSION
    || claims.protocolVersion !== KARAOKE_TRANSPORT_PROTOCOL_VERSION
    || !isNonEmptyString(claims.subject)
    || !isNonEmptyString(claims.communityId)
    || !isNonEmptyString(claims.postId)
    || !isNonEmptyString(claims.sessionId)
    || !isNonEmptyString(claims.attemptId)
    || !isNonEmptyString(claims.nonce)
    || !Number.isSafeInteger(claims.issuedAt)
    || !Number.isSafeInteger(claims.expiresAt)
  ) {
    return null
  }
  return {
    attemptId: claims.attemptId,
    communityId: claims.communityId,
    expiresAt: claims.expiresAt as number,
    issuedAt: claims.issuedAt as number,
    nonce: claims.nonce,
    postId: claims.postId,
    protocolVersion: KARAOKE_TRANSPORT_PROTOCOL_VERSION,
    sessionId: claims.sessionId,
    subject: claims.subject,
    tokenVersion: KARAOKE_GATEWAY_TOKEN_VERSION,
  }
}

export async function issueKaraokeGatewayToken(input: {
  claims: KaraokeGatewayClaims
  secret: string
}): Promise<string> {
  const header = encodeJson(TOKEN_HEADER)
  const payload = encodeJson(input.claims)
  const signingInput = `${header}.${payload}`
  const key = await importHmacKey(input.secret, "sign")
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput))
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`
}

export async function verifyKaraokeGatewayToken(input: {
  token: string
  secret: string
  nowSeconds: number
}): Promise<VerifyKaraokeGatewayTokenResult> {
  const parts = input.token.split(".")
  if (parts.length !== 3) return { error: "invalid_token" }
  const [headerPart, payloadPart, signaturePart] = parts
  if (!headerPart || !payloadPart || !signaturePart) return { error: "invalid_token" }
  const headerBytes = base64UrlDecode(headerPart)
  const payloadBytes = base64UrlDecode(payloadPart)
  const signature = base64UrlDecode(signaturePart)
  if (!headerBytes || !payloadBytes || !signature) return { error: "invalid_token" }

  let header: unknown
  let payload: unknown
  try {
    header = JSON.parse(decoder.decode(headerBytes))
    payload = JSON.parse(decoder.decode(payloadBytes))
  } catch {
    return { error: "invalid_token" }
  }
  if (
    !header
    || typeof header !== "object"
    || Array.isArray(header)
    || (header as Record<string, unknown>).alg !== TOKEN_HEADER.alg
    || (header as Record<string, unknown>).typ !== TOKEN_HEADER.typ
  ) {
    return { error: "invalid_token" }
  }

  const key = await importHmacKey(input.secret, "verify")
  const verified = await crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(signature),
    encoder.encode(`${headerPart}.${payloadPart}`),
  )
  if (!verified) return { error: "invalid_token" }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { error: "invalid_token_claims" }
  }
  const raw = payload as Record<string, unknown>
  if (raw.tokenVersion !== KARAOKE_GATEWAY_TOKEN_VERSION) {
    return { error: "unsupported_token_version" }
  }
  if (raw.protocolVersion !== KARAOKE_TRANSPORT_PROTOCOL_VERSION) {
    return { error: "unsupported_protocol_version" }
  }
  const claims = parseClaims(payload)
  if (!claims) return { error: "invalid_token_claims" }
  if (claims.issuedAt > input.nowSeconds + KARAOKE_TOKEN_CLOCK_SKEW_SECONDS) {
    return { error: "token_issued_in_future" }
  }
  if (claims.expiresAt <= input.nowSeconds) return { error: "token_expired" }
  if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > KARAOKE_GATEWAY_TOKEN_TTL_SECONDS) {
    return { error: "token_lifetime_exceeded" }
  }
  return { claims }
}
