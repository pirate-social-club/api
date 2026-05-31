import { createPublicKey, verify } from "node:crypto"
import { badRequestError } from "../errors"
import type { AgentChallenge } from "./types"

const AGENT_CHALLENGE_FRESHNESS_MS = 15 * 60 * 1000
const AGENT_CHALLENGE_MAX_FUTURE_SKEW_MS = 30 * 1000

function decodeBase64Like(value: string): Buffer {
  const normalized = value.trim().replace(/-/g, "+").replace(/_/g, "/")
  const paddingLength = (4 - (normalized.length % 4)) % 4
  return Buffer.from(`${normalized}${"=".repeat(paddingLength)}`, "base64")
}

function parseClawkeyPublicKey(publicKey: string) {
  try {
    return createPublicKey({
      key: decodeBase64Like(publicKey),
      format: "der",
      type: "spki",
    })
  } catch {
    throw badRequestError("agent_challenge public_key must be a valid Ed25519 DER SPKI public key")
  }
}

export function normalizeClawkeyPublicKeyToPem(publicKey: string): string {
  const keyObject = parseClawkeyPublicKey(publicKey)
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw badRequestError("agent_challenge public_key must be a valid Ed25519 DER SPKI public key")
  }
  return keyObject.export({ format: "pem", type: "spki" }).toString()
}

export function assertVerifiedAgentChallenge(challenge: AgentChallenge): void {
  const deviceId = challenge.device_id?.trim()
  const message = challenge.message?.trim()
  const signature = challenge.signature?.trim()
  const publicKey = challenge.public_key?.trim()
  const timestamp = Number(challenge.timestamp)

  if (!deviceId || !message || !signature || !publicKey || !Number.isFinite(timestamp)) {
    throw badRequestError("Invalid agent challenge payload")
  }

  const nowMs = Date.now()
  if (
    timestamp > nowMs + AGENT_CHALLENGE_MAX_FUTURE_SKEW_MS
    || timestamp < nowMs - AGENT_CHALLENGE_FRESHNESS_MS
  ) {
    throw badRequestError("agent_challenge timestamp is outside the allowed freshness window")
  }

  const keyObject = parseClawkeyPublicKey(publicKey)
  if (keyObject.asymmetricKeyType !== "ed25519") {
    throw badRequestError("agent_challenge public_key must be a valid Ed25519 DER SPKI public key")
  }

  let signatureBytes: Buffer
  try {
    signatureBytes = decodeBase64Like(signature)
  } catch {
    throw badRequestError("agent_challenge signature is invalid")
  }

  const verified = verify(
    null,
    Buffer.from(message, "utf8"),
    keyObject,
    signatureBytes,
  )
  if (!verified) {
    throw badRequestError("agent_challenge signature is invalid")
  }
}
