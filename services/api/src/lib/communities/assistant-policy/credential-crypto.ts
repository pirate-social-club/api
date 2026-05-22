import {
  decryptCommunityDbCredential,
  encryptCommunityDbCredential,
} from "../community-db-credential-crypto"
import { badRequestError } from "../../errors"

export function normalizeOpenRouterKey(input: string): string {
  const normalized = input.trim()
  if (!normalized) {
    throw badRequestError("OpenRouter API key is required")
  }
  if (!normalized.startsWith("sk-or-")) {
    throw badRequestError("OpenRouter API key must start with sk-or-")
  }
  return normalized
}

export function encryptOpenRouterKey(input: {
  plaintextKey: string
  wrapKey: string
}): string {
  return encryptCommunityDbCredential({
    plaintextToken: normalizeOpenRouterKey(input.plaintextKey),
    wrapKey: input.wrapKey,
  })
}

export function decryptOpenRouterKey(input: {
  encryptedSecret: string
  encryptionKeyVersion: number
  wrapKey: string
}): string {
  return decryptCommunityDbCredential({
    encryptedToken: input.encryptedSecret,
    encryptionKeyVersion: input.encryptionKeyVersion,
    wrapKey: input.wrapKey,
  })
}
