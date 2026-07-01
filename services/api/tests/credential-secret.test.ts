import { describe, expect, test } from "bun:test"
import { decryptCredentialSecret, encryptCredentialSecret } from "../src/lib/crypto/credential-secret"

const VALID_WRAP_KEY = "0".repeat(64)

describe("credential secret crypto", () => {
  describe("encryptCredentialSecret", () => {
    test("encrypts and returns v1-prefixed ciphertext", () => {
      const encrypted = encryptCredentialSecret({
        plaintext: "my-secret-token",
        wrapKey: VALID_WRAP_KEY,
      })
      expect(encrypted.startsWith("v1:")).toBe(true)
    })

    test("rejects empty plaintext", () => {
      expect(() =>
        encryptCredentialSecret({ plaintext: "", wrapKey: VALID_WRAP_KEY }),
      ).toThrow()
    })

    test("rejects whitespace-only plaintext", () => {
      expect(() =>
        encryptCredentialSecret({ plaintext: "   ", wrapKey: VALID_WRAP_KEY }),
      ).toThrow()
    })

    test("rejects invalid wrap key (too short)", () => {
      expect(() =>
        encryptCredentialSecret({ plaintext: "token", wrapKey: "abc123" }),
      ).toThrow()
    })

    test("rejects non-hex wrap key", () => {
      expect(() =>
        encryptCredentialSecret({ plaintext: "token", wrapKey: "g".repeat(64) }),
      ).toThrow()
    })

    test("produces different ciphertext for same input (random IV)", () => {
      const a = encryptCredentialSecret({ plaintext: "same-token", wrapKey: VALID_WRAP_KEY })
      const b = encryptCredentialSecret({ plaintext: "same-token", wrapKey: VALID_WRAP_KEY })
      expect(a).not.toBe(b)
    })
  })

  describe("decryptCredentialSecret", () => {
    test("round-trips encrypt then decrypt", () => {
      const encrypted = encryptCredentialSecret({
        plaintext: "round-trip-secret",
        wrapKey: VALID_WRAP_KEY,
      })
      const decrypted = decryptCredentialSecret({
        encryptedSecret: encrypted,
        encryptionKeyVersion: 1,
        wrapKey: VALID_WRAP_KEY,
      })
      expect(decrypted).toBe("round-trip-secret")
    })

    test("rejects key version 0", () => {
      const encrypted = encryptCredentialSecret({
        plaintext: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: encrypted,
          encryptionKeyVersion: 0,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects negative key version", () => {
      const encrypted = encryptCredentialSecret({
        plaintext: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: encrypted,
          encryptionKeyVersion: -1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects wrong wrap key", () => {
      const encrypted = encryptCredentialSecret({
        plaintext: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      const wrongKey = "f".repeat(64)
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: encrypted,
          encryptionKeyVersion: 1,
          wrapKey: wrongKey,
        }),
      ).toThrow()
    })

    test("rejects malformed ciphertext (missing prefix)", () => {
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: "garbage",
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects malformed ciphertext (wrong prefix)", () => {
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: "v2:aaaa:bbbb:cccc",
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects truncated ciphertext (missing parts)", () => {
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: "v1:aaaa",
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects tampered ciphertext", () => {
      const encrypted = encryptCredentialSecret({
        plaintext: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      const parts = encrypted.split(":")
      const ctBytes = Buffer.from(parts[3] ?? "", "hex")
      ctBytes[0] ^= 0xff
      const tampered = [parts[0], parts[1], parts[2], ctBytes.toString("hex")].join(":")
      expect(() =>
        decryptCredentialSecret({
          encryptedSecret: tampered,
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })
  })
})
