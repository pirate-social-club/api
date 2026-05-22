import { describe, expect, test } from "bun:test"
import {
  decryptOpenRouterKey,
  encryptOpenRouterKey,
  normalizeOpenRouterKey,
} from "./credential-crypto"

const VALID_WRAP_KEY = "0".repeat(64)

describe("assistant-policy credential crypto", () => {
  test("normalizes OpenRouter keys by trimming whitespace", () => {
    expect(normalizeOpenRouterKey("  sk-or-secret-key  ")).toBe("sk-or-secret-key")
  })

  test("rejects empty OpenRouter keys", () => {
    expect(() => normalizeOpenRouterKey("")).toThrow()
    expect(() => normalizeOpenRouterKey("   ")).toThrow()
  })

  test("rejects non-OpenRouter key prefixes", () => {
    expect(() => normalizeOpenRouterKey("sk-proj-not-openrouter")).toThrow()
    expect(() => normalizeOpenRouterKey("or-secret")).toThrow()
  })

  test("encrypts OpenRouter keys using the shared v1 credential format", () => {
    const encrypted = encryptOpenRouterKey({
      plaintextKey: "sk-or-secret-key",
      wrapKey: VALID_WRAP_KEY,
    })

    expect(encrypted.startsWith("v1:")).toBe(true)
    expect(encrypted).not.toContain("sk-or-secret-key")
  })

  test("round-trips encrypted OpenRouter keys", () => {
    const encrypted = encryptOpenRouterKey({
      plaintextKey: "  sk-or-round-trip-key  ",
      wrapKey: VALID_WRAP_KEY,
    })
    const decrypted = decryptOpenRouterKey({
      encryptedSecret: encrypted,
      encryptionKeyVersion: 1,
      wrapKey: VALID_WRAP_KEY,
    })

    expect(decrypted).toBe("sk-or-round-trip-key")
  })

  test("rejects invalid wrap keys through the shared crypto helper", () => {
    expect(() =>
      encryptOpenRouterKey({
        plaintextKey: "sk-or-secret-key",
        wrapKey: "abc123",
      }),
    ).toThrow()
  })

  test("rejects invalid encrypted payloads through the shared crypto helper", () => {
    expect(() =>
      decryptOpenRouterKey({
        encryptedSecret: "v2:aaaa:bbbb:cccc",
        encryptionKeyVersion: 1,
        wrapKey: VALID_WRAP_KEY,
      }),
    ).toThrow()
  })
})
