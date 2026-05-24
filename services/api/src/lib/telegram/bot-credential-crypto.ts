import {
  decryptCommunityDbCredential,
  encryptCommunityDbCredential,
} from "../communities/community-db-credential-crypto"
import { badRequestError } from "../errors"

export function normalizeTelegramBotToken(input: string): string {
  const normalized = input.trim()
  if (!normalized) {
    throw badRequestError("Telegram bot token is required")
  }
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/u.test(normalized)) {
    throw badRequestError("Telegram bot token must be a BotFather token")
  }
  return normalized
}

export function encryptTelegramBotToken(input: {
  plaintextToken: string
  wrapKey: string
}): string {
  return encryptCommunityDbCredential({
    plaintextToken: normalizeTelegramBotToken(input.plaintextToken),
    wrapKey: input.wrapKey,
  })
}

export function decryptTelegramBotToken(input: {
  encryptedToken: string
  encryptionKeyVersion: number
  wrapKey: string
}): string {
  return decryptCommunityDbCredential({
    encryptedToken: input.encryptedToken,
    encryptionKeyVersion: input.encryptionKeyVersion,
    wrapKey: input.wrapKey,
  })
}
