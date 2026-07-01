import {
  decryptCredentialSecret,
  encryptCredentialSecret,
} from "../../crypto/credential-secret"
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

export function normalizeElevenLabsKey(input: string): string {
  const normalized = input.trim()
  if (!normalized) {
    throw badRequestError("ElevenLabs API key is required")
  }
  if (normalized.length < 20) {
    throw badRequestError("ElevenLabs API key is too short")
  }
  return normalized
}

export function encryptOpenRouterKey(input: {
  plaintextKey: string
  wrapKey: string
}): string {
  return encryptCredentialSecret({
    plaintext: normalizeOpenRouterKey(input.plaintextKey),
    wrapKey: input.wrapKey,
  })
}

export function encryptElevenLabsKey(input: {
  plaintextKey: string
  wrapKey: string
}): string {
  return encryptCredentialSecret({
    plaintext: normalizeElevenLabsKey(input.plaintextKey),
    wrapKey: input.wrapKey,
  })
}

export function decryptOpenRouterKey(input: {
  encryptedSecret: string
  encryptionKeyVersion: number
  wrapKey: string
}): string {
  return decryptCredentialSecret({
    encryptedSecret: input.encryptedSecret,
    encryptionKeyVersion: input.encryptionKeyVersion,
    wrapKey: input.wrapKey,
  })
}

export function decryptElevenLabsKey(input: {
  encryptedSecret: string
  encryptionKeyVersion: number
  wrapKey: string
}): string {
  return decryptCredentialSecret({
    encryptedSecret: input.encryptedSecret,
    encryptionKeyVersion: input.encryptionKeyVersion,
    wrapKey: input.wrapKey,
  })
}
