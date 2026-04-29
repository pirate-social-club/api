import { hkdfSync } from "node:crypto"

import { privateKeyToAccount } from "viem/accounts"

const DERIVATION_SALT = "pirate-bot-derivation-v1"
const BOT_HANDLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*\.pirate$/
const HEX_32_BYTE_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/

export type DerivedBotWallet = {
  handle: string
  walletAddress: `0x${string}`
  walletPrivateKey: `0x${string}`
}

export type DerivedBotXmtpDbKey = {
  handle: string
  xmtpDbEncryptionKey: `0x${string}`
}

export function normalizeBotHandle(handle: string): string {
  const normalized = handle.trim().toLowerCase()
  if (!BOT_HANDLE_PATTERN.test(normalized)) {
    throw new Error("Bot handle must be a valid .pirate handle")
  }
  return normalized
}

export function normalizeRootSecretHex(value: string, name: string): `0x${string}` {
  const normalized = value.trim().toLowerCase()
  if (!HEX_32_BYTE_PATTERN.test(normalized)) {
    throw new Error(`${name} must be a 32-byte hex string`)
  }
  return normalized.startsWith("0x") ? normalized as `0x${string}` : `0x${normalized}` as `0x${string}`
}

function hexToBytes(value: `0x${string}`): Buffer {
  return Buffer.from(value.slice(2), "hex")
}

function deriveHex32(rootSecret: `0x${string}`, info: string): `0x${string}` {
  const bytes = Buffer.from(hkdfSync(
    "sha256",
    hexToBytes(rootSecret),
    Buffer.from(DERIVATION_SALT),
    Buffer.from(info),
    32,
  ))
  return `0x${bytes.toString("hex")}` as `0x${string}`
}

export function deriveBotWallet(input: {
  handle: string
  walletMasterSecret: string
}): DerivedBotWallet {
  const handle = normalizeBotHandle(input.handle)
  const rootSecret = normalizeRootSecretHex(input.walletMasterSecret, "BOT_WALLET_MASTER_SECRET")
  const walletPrivateKey = deriveHex32(rootSecret, `pirate-bot-wallet:${handle}`)
  const account = privateKeyToAccount(walletPrivateKey)

  return {
    handle,
    walletAddress: account.address.toLowerCase() as `0x${string}`,
    walletPrivateKey,
  }
}

export function deriveBotXmtpDbKey(input: {
  handle: string
  xmtpDbEncryptionSecret: string
}): DerivedBotXmtpDbKey {
  const handle = normalizeBotHandle(input.handle)
  const rootSecret = normalizeRootSecretHex(input.xmtpDbEncryptionSecret, "BOT_XMTP_DB_ENCRYPTION_SECRET")
  return {
    handle,
    xmtpDbEncryptionKey: deriveHex32(rootSecret, `pirate-bot-xmtp-db:${handle}`),
  }
}
