import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { internalError } from "../errors"

const ALGORITHM = "aes-256-gcm"
const FORMAT_PREFIX = "v1"
const IV_BYTES = 12

function requireWrapKeyHex(wrapKey: string): Buffer {
  const normalized = wrapKey.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY must be 32 bytes encoded as hex")
  }
  return Buffer.from(normalized, "hex")
}

export function encryptCommunityDbCredential(input: {
  plaintextToken: string
  wrapKey: string
}): string {
  const plaintext = input.plaintextToken.trim()
  if (!plaintext) {
    throw internalError("Community DB plaintext token is required")
  }

  const key = requireWrapKeyHex(input.wrapKey)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return `${FORMAT_PREFIX}:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`
}

export function decryptCommunityDbCredential(input: {
  encryptedToken: string
  encryptionKeyVersion: number
  wrapKey: string
}): string {
  if (!Number.isInteger(input.encryptionKeyVersion) || input.encryptionKeyVersion <= 0) {
    throw internalError("Community DB credential encryption key version is invalid")
  }

  const [format, ivHex, tagHex, ciphertextHex] = input.encryptedToken.trim().split(":")
  if (format !== FORMAT_PREFIX || !ivHex || !tagHex || !ciphertextHex) {
    throw internalError("Community DB credential ciphertext format is invalid")
  }

  const key = requireWrapKeyHex(input.wrapKey)

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"))
    decipher.setAuthTag(Buffer.from(tagHex, "hex"))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, "hex")),
      decipher.final(),
    ]).toString("utf8")
    if (!plaintext.trim()) {
      throw new Error("empty plaintext")
    }
    return plaintext
  } catch {
    throw internalError("Community DB credential ciphertext could not be decrypted")
  }
}
