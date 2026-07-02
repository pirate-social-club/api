import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { internalError } from "../errors"

// Neutral AES-256-GCM credential wrapping used for secrets encrypted at rest in the
// control plane (telegram bot tokens, assistant-policy provider keys, etc.). The
// ciphertext format (`v1:iv:tag:ciphertext`) and the wrap key material are unchanged
// from the former community-db-credential-crypto module, so existing ciphertext stays
// decryptable — do NOT change the algorithm, format, or key material.
const ALGORITHM = "aes-256-gcm"
const FORMAT_PREFIX = "v1"
const IV_BYTES = 12

function requireWrapKeyHex(wrapKey: string): Buffer {
  const normalized = wrapKey.trim()
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw internalError("Credential wrap key must be 32 bytes encoded as hex")
  }
  return Buffer.from(normalized, "hex")
}

<<<<<<<< HEAD:services/api/src/lib/crypto/credential-secret.ts
export function encryptCredentialSecret(input: {
  plaintext: string
========
export function encryptCredential(input: {
  plaintextToken: string
>>>>>>>> 10e76444 (chore(deturso): remove Turso community-database backend from the API):services/api/src/lib/crypto/credential-crypto.ts
  wrapKey: string
}): string {
  const plaintext = input.plaintext.trim()
  if (!plaintext) {
<<<<<<<< HEAD:services/api/src/lib/crypto/credential-secret.ts
    throw internalError("Credential plaintext is required")
========
    throw internalError("Credential plaintext token is required")
>>>>>>>> 10e76444 (chore(deturso): remove Turso community-database backend from the API):services/api/src/lib/crypto/credential-crypto.ts
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

<<<<<<<< HEAD:services/api/src/lib/crypto/credential-secret.ts
export function decryptCredentialSecret(input: {
  encryptedSecret: string
========
export function decryptCredential(input: {
  encryptedToken: string
>>>>>>>> 10e76444 (chore(deturso): remove Turso community-database backend from the API):services/api/src/lib/crypto/credential-crypto.ts
  encryptionKeyVersion: number
  wrapKey: string
}): string {
  if (!Number.isInteger(input.encryptionKeyVersion) || input.encryptionKeyVersion <= 0) {
    throw internalError("Credential encryption key version is invalid")
  }

  const [format, ivHex, tagHex, ciphertextHex] = input.encryptedSecret.trim().split(":")
  if (format !== FORMAT_PREFIX || !ivHex || !tagHex || !ciphertextHex) {
    throw internalError("Credential ciphertext format is invalid")
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
    throw internalError("Credential ciphertext could not be decrypted")
  }
}
