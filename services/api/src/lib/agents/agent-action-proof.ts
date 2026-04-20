import { createPublicKey, verify } from "node:crypto"
import { conflictError, eligibilityFailed } from "../errors"
import { hasUniqueConstraintField } from "../auth/auth-db-query-helpers"
import type { Client } from "../sql-client"
import { sha256Hex } from "../crypto"
import type { AgentActionProof } from "../../types"

const CANONICAL_VERSION = "pirate-agent-action-proof-v1"
const SIGNATURE_VERSION = "pirate-agent-action-signature-v1"
const encoder = new TextEncoder()

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson }

function normalizePath(pathname: string): string {
  const trimmed = pathname.trim()
  if (!trimmed || trimmed === "/") {
    return "/"
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`
  return withLeadingSlash.replace(/\/+$/g, "")
}

function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value)
}

function compareUtf8Ascending(left: string, right: string): number {
  const leftBytes = encoder.encode(left)
  const rightBytes = encoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)

  for (let index = 0; index < length; index += 1) {
    const leftByte = leftBytes[index]
    const rightByte = rightBytes[index]
    if (leftByte !== rightByte) {
      return leftByte - rightByte
    }
  }

  return leftBytes.length - rightBytes.length
}

function canonicalizeQuery(searchParams: URLSearchParams): string {
  const pairs = Array.from(searchParams.entries()).sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = compareUtf8Ascending(leftKey, rightKey)
    if (keyCompare !== 0) {
      return keyCompare
    }
    return compareUtf8Ascending(leftValue, rightValue)
  })

  return pairs
    .map(([key, value]) => `${encodeQueryComponent(key)}=${encodeQueryComponent(value)}`)
    .join("&")
}

function sortJsonValue(value: CanonicalJson): CanonicalJson {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item))
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => compareUtf8Ascending(left, right))
    return Object.fromEntries(entries.map(([key, child]) => [key, sortJsonValue(child)]))
  }
  return value
}

function canonicalizeBody(body: unknown): string {
  if (body == null || body === "") {
    return ""
  }
  if (typeof body === "string") {
    return body
  }
  return JSON.stringify(sortJsonValue(body as CanonicalJson))
}

function decodeBase64Like(value: string): Buffer {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/")
  const paddingLength = (4 - (normalized.length % 4)) % 4
  return Buffer.from(`${normalized}${"=".repeat(paddingLength)}`, "base64")
}

export function canonicalizeAgentActionProofRequest(input: {
  method: string
  url: string
  body?: unknown
}): string {
  const url = new URL(input.url, "http://pirate.local")
  const method = input.method.trim().toUpperCase()
  const path = normalizePath(url.pathname)
  const query = canonicalizeQuery(url.searchParams)
  const body = canonicalizeBody(input.body)

  return [
    CANONICAL_VERSION,
    method,
    path,
    query,
    body,
  ].join("\n")
}

export async function computeAgentActionProofHash(input: {
  method: string
  url: string
  body?: unknown
}): Promise<string> {
  return await sha256Hex(canonicalizeAgentActionProofRequest(input))
}

export function getAgentActionProofCanonicalVersion(): string {
  return CANONICAL_VERSION
}

export function canonicalizeAgentActionProofSignaturePayload(input: {
  nonce: string
  signedAt: string
  canonicalRequestHash: string
}): string {
  return [
    SIGNATURE_VERSION,
    input.nonce.trim(),
    input.signedAt.trim(),
    input.canonicalRequestHash.trim(),
  ].join("\n")
}

export function getAgentActionProofSignatureVersion(): string {
  return SIGNATURE_VERSION
}

export function verifyAgentActionProofSignature(input: {
  publicKey: string
  proof: AgentActionProof
}): boolean {
  const publicKeyPem = input.publicKey.trim()
  if (!publicKeyPem.startsWith("-----BEGIN PUBLIC KEY-----")) {
    throw eligibilityFailed("Agent key material is not eligible for write verification")
  }

  let keyObject
  try {
    keyObject = createPublicKey(publicKeyPem)
  } catch {
    throw eligibilityFailed("Agent key material is not eligible for write verification")
  }
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw eligibilityFailed("Agent key material is not eligible for write verification")
  }

  const signatureBytes = decodeBase64Like(input.proof.signature)
  const payload = canonicalizeAgentActionProofSignaturePayload({
    nonce: input.proof.nonce,
    signedAt: input.proof.signed_at,
    canonicalRequestHash: input.proof.canonical_request_hash,
  })

  return verify(null, Buffer.from(payload, "utf8"), keyObject, signatureBytes)
}

export async function recordAgentActionReplay(input: {
  client: Client
  agentId: string
  nonce: string
  signedAt: string
  canonicalRequestHash: string
  expiresAt: string
}): Promise<void> {
  try {
    await input.client.execute({
      sql: `
        INSERT INTO agent_action_nonce_replays (
          agent_id, nonce, signed_at, canonical_request_hash, created_at, expires_at
        ) VALUES (
          ?1, ?2, ?3, ?4, CURRENT_TIMESTAMP, ?5
        )
      `,
      args: [
        input.agentId,
        input.nonce,
        input.signedAt,
        input.canonicalRequestHash,
        input.expiresAt,
      ],
    })
  } catch (error) {
    if (
      hasUniqueConstraintField(error, "agent_action_nonce_replays.agent_id")
      || hasUniqueConstraintField(error, "agent_action_nonce_replays.nonce")
    ) {
      throw conflictError("Agent action proof nonce has already been used")
    }
    throw error
  }
}
