import { describe, expect, test } from "bun:test"

import { deriveBotWallet, deriveBotXmtpDbKey, normalizeBotHandle, normalizeRootSecretHex } from "./bot-wallet.js"

const ROOT_A = "1111111111111111111111111111111111111111111111111111111111111111"
const ROOT_B = "2222222222222222222222222222222222222222222222222222222222222222"

describe("bot wallet derivation", () => {
  test("normalizes .pirate handles", () => {
    expect(normalizeBotHandle(" Habibi.Pirate ")).toBe("habibi.pirate")
    expect(normalizeBotHandle("swift-comet-1431.pirate")).toBe("swift-comet-1431.pirate")
  })

  test("rejects invalid handles", () => {
    expect(() => normalizeBotHandle("not a handle")).toThrow("Bot handle")
    expect(() => normalizeBotHandle("admin")).toThrow("Bot handle")
    expect(() => normalizeBotHandle("-bad.pirate")).toThrow("Bot handle")
  })

  test("normalizes 32-byte root secrets", () => {
    expect(normalizeRootSecretHex(ROOT_A, "TEST")).toBe(`0x${ROOT_A}`)
    expect(normalizeRootSecretHex(`0x${ROOT_A}`, "TEST")).toBe(`0x${ROOT_A}`)
  })

  test("rejects malformed root secrets", () => {
    expect(() => normalizeRootSecretHex("short", "TEST")).toThrow("TEST")
    expect(() => normalizeRootSecretHex("z".repeat(64), "TEST")).toThrow("TEST")
  })

  test("derives deterministic wallet addresses without exposing randomness", () => {
    const first = deriveBotWallet({ handle: "habibi.pirate", walletMasterSecret: ROOT_A })
    const second = deriveBotWallet({ handle: "HABIBI.PIRATE", walletMasterSecret: ROOT_A })
    const otherHandle = deriveBotWallet({ handle: "swift-comet-1431.pirate", walletMasterSecret: ROOT_A })
    const otherSecret = deriveBotWallet({ handle: "habibi.pirate", walletMasterSecret: ROOT_B })

    expect(first).toEqual(second)
    expect(/^0x[0-9a-f]{40}$/.test(first.walletAddress)).toBe(true)
    expect(/^0x[0-9a-f]{64}$/.test(first.walletPrivateKey)).toBe(true)
    expect(otherHandle.walletAddress === first.walletAddress).toBe(false)
    expect(otherSecret.walletAddress === first.walletAddress).toBe(false)
  })

  test("derives a separate deterministic XMTP DB encryption key", () => {
    const wallet = deriveBotWallet({ handle: "habibi.pirate", walletMasterSecret: ROOT_A })
    const db = deriveBotXmtpDbKey({ handle: "habibi.pirate", xmtpDbEncryptionSecret: ROOT_A })

    expect(/^0x[0-9a-f]{64}$/.test(db.xmtpDbEncryptionKey)).toBe(true)
    expect(db.xmtpDbEncryptionKey === wallet.walletPrivateKey).toBe(false)
  })
})
