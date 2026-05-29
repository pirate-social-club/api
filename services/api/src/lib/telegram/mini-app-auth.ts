import { createHmac, timingSafeEqual } from "node:crypto"
import { authError, badRequestError } from "../errors"

const DEFAULT_TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60

export type TelegramMiniAppUser = {
  id: string
  username: string | null
  firstName: string | null
  lastName: string | null
  photoUrl: string | null
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/iu.test(left) || !/^[0-9a-f]+$/iu.test(right)) {
    return false
  }
  const leftBytes = Buffer.from(left, "hex")
  const rightBytes = Buffer.from(right, "hex")
  if (leftBytes.length !== rightBytes.length) {
    return false
  }
  return timingSafeEqual(leftBytes, rightBytes)
}

function normalizeTelegramIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value)
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  return null
}

function normalizeTelegramString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseTelegramUser(value: string | null): TelegramMiniAppUser {
  if (!value) {
    throw authError("Telegram Mini App init data is missing the user")
  }
  const parsed = JSON.parse(value) as Record<string, unknown>
  const id = normalizeTelegramIdentifier(parsed.id)
  if (!id) {
    throw authError("Telegram Mini App user is invalid")
  }
  return {
    id,
    username: normalizeTelegramString(parsed.username),
    firstName: normalizeTelegramString(parsed.first_name),
    lastName: normalizeTelegramString(parsed.last_name),
    photoUrl: normalizeTelegramString(parsed.photo_url),
  }
}

function telegramInitDataMaxAgeSeconds(value: string | undefined): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TELEGRAM_INIT_DATA_MAX_AGE_SECONDS
}

export function verifyTelegramMiniAppInitData(input: {
  botTokens: string[]
  initData: string
  maxAgeSeconds?: number
  nowMs?: number
}): TelegramMiniAppUser {
  const initData = input.initData.trim()
  if (!initData) {
    throw badRequestError("init_data is required")
  }
  const botTokens = input.botTokens.map((token) => token.trim()).filter(Boolean)
  if (botTokens.length === 0) {
    throw authError("Telegram Mini App verification is not configured")
  }

  const params = new URLSearchParams(initData)
  const receivedHash = params.get("hash")?.trim().toLowerCase()
  if (!receivedHash) {
    throw authError("Telegram Mini App init data is missing the hash")
  }
  const authDate = Number(params.get("auth_date"))
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw authError("Telegram Mini App init data is missing auth_date")
  }
  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000)
  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_TELEGRAM_INIT_DATA_MAX_AGE_SECONDS
  if (nowSeconds - authDate > maxAgeSeconds) {
    throw authError("Telegram Mini App init data expired")
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")

  const verified = botTokens.some((botToken) => {
    const secret = createHmac("sha256", "WebAppData").update(botToken).digest()
    const calculatedHash = createHmac("sha256", secret).update(dataCheckString).digest("hex")
    return safeEqualHex(calculatedHash, receivedHash)
  })
  if (!verified) {
    throw authError("Telegram Mini App init data is invalid")
  }

  try {
    return parseTelegramUser(params.get("user"))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw authError("Telegram Mini App user is invalid")
    }
    throw error
  }
}

export function configuredTelegramInitDataMaxAgeSeconds(env: {
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_MINI_APP_INIT_DATA_MAX_AGE_SECONDS?: string
}): number {
  return telegramInitDataMaxAgeSeconds(env.TELEGRAM_MINI_APP_INIT_DATA_MAX_AGE_SECONDS)
}
