import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { internalError } from "../errors"

export type CommunityDbCredentialEnvelopeV1 = {
  v: 1
  alg: "aes-256-gcm"
  iv_base64: string
  ciphertext_base64: string
  auth_tag_base64: string
}

function decodeBase64Field(value: string, field: string): Buffer {
  try {
    const decoded = Buffer.from(value, "base64")
    if (decoded.length === 0) {
      throw new Error("empty")
    }
    return decoded
  } catch {
    throw internalError(`Encrypted community DB credential field ${field} is invalid`)
  }
}

function requireWrapKeyBytes(wrapKey: string | null | undefined): Buffer {
  const normalized = String(wrapKey || "").trim().replace(/^0x/i, "")
  if (!normalized) {
    throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY is not configured")
  }
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length !== 64) {
    throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY must be a 32-byte hex string")
  }
  return Buffer.from(normalized, "hex")
}

function parseEnvelope(serialized: string): CommunityDbCredentialEnvelopeV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(serialized)
  } catch {
    throw internalError("Encrypted community DB credential uses unsupported format")
  }

  const envelope = parsed as Partial<CommunityDbCredentialEnvelopeV1>
  if (
    envelope.v !== 1
    || envelope.alg !== "aes-256-gcm"
    || typeof envelope.iv_base64 !== "string"
    || typeof envelope.ciphertext_base64 !== "string"
    || typeof envelope.auth_tag_base64 !== "string"
  ) {
    throw internalError("Encrypted community DB credential uses unsupported format")
  }

  return envelope as CommunityDbCredentialEnvelopeV1
}

export function decryptCommunityDbCredential(input: {
  encryptedToken: string
  encryptionKeyVersion: number
  wrapKey: string | null | undefined
}): string {
  const wrapKeyBytes = requireWrapKeyBytes(input.wrapKey)
  const envelope = parseEnvelope(input.encryptedToken)
  const iv = decodeBase64Field(envelope.iv_base64, "iv_base64")
  const ciphertext = decodeBase64Field(envelope.ciphertext_base64, "ciphertext_base64")
  const authTag = decodeBase64Field(envelope.auth_tag_base64, "auth_tag_base64")

  try {
    const decipher = createDecipheriv("aes-256-gcm", wrapKeyBytes, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8").trim()
    if (!plaintext) {
      throw new Error("empty_plaintext")
    }
    return plaintext
  } catch {
    throw internalError(
      `Failed to decrypt community DB credential for wrap key version ${input.encryptionKeyVersion}`,
    )
  }
}

export function encryptCommunityDbCredential(input: {
  plaintextToken: string
  wrapKey: string | null | undefined
}): string {
  const plaintext = input.plaintextToken.trim()
  if (!plaintext) {
    throw internalError("Community database auth token plaintext is missing")
  }

  const wrapKeyBytes = requireWrapKeyBytes(input.wrapKey)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", wrapKeyBytes, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv_base64: iv.toString("base64"),
    ciphertext_base64: ciphertext.toString("base64"),
    auth_tag_base64: authTag.toString("base64"),
  } satisfies CommunityDbCredentialEnvelopeV1)
}
