import { describe, expect, test } from "bun:test"
import { encryptCommunityDbCredential, decryptCommunityDbCredential } from "../src/lib/communities/community-db-credential-crypto"
import { internalError } from "../src/lib/errors"

const VALID_WRAP_KEY = "0".repeat(64)

describe("community-db-credential-crypto", () => {
  describe("encryptCommunityDbCredential", () => {
    test("encrypts and returns v1-prefixed ciphertext", () => {
      const encrypted = encryptCommunityDbCredential({
        plaintextToken: "my-secret-token",
        wrapKey: VALID_WRAP_KEY,
      })
      expect(encrypted.startsWith("v1:")).toBe(true)
    })

    test("rejects empty plaintext", () => {
      expect(() =>
        encryptCommunityDbCredential({ plaintextToken: "", wrapKey: VALID_WRAP_KEY }),
      ).toThrow()
    })

    test("rejects whitespace-only plaintext", () => {
      expect(() =>
        encryptCommunityDbCredential({ plaintextToken: "   ", wrapKey: VALID_WRAP_KEY }),
      ).toThrow()
    })

    test("rejects invalid wrap key (too short)", () => {
      expect(() =>
        encryptCommunityDbCredential({ plaintextToken: "token", wrapKey: "abc123" }),
      ).toThrow()
    })

    test("rejects non-hex wrap key", () => {
      expect(() =>
        encryptCommunityDbCredential({ plaintextToken: "token", wrapKey: "g".repeat(64) }),
      ).toThrow()
    })

    test("produces different ciphertext for same input (random IV)", () => {
      const a = encryptCommunityDbCredential({ plaintextToken: "same-token", wrapKey: VALID_WRAP_KEY })
      const b = encryptCommunityDbCredential({ plaintextToken: "same-token", wrapKey: VALID_WRAP_KEY })
      expect(a).not.toBe(b)
    })
  })

  describe("decryptCommunityDbCredential", () => {
    test("round-trips encrypt then decrypt", () => {
      const encrypted = encryptCommunityDbCredential({
        plaintextToken: "round-trip-secret",
        wrapKey: VALID_WRAP_KEY,
      })
      const decrypted = decryptCommunityDbCredential({
        encryptedToken: encrypted,
        encryptionKeyVersion: 1,
        wrapKey: VALID_WRAP_KEY,
      })
      expect(decrypted).toBe("round-trip-secret")
    })

    test("rejects key version 0", () => {
      const encrypted = encryptCommunityDbCredential({
        plaintextToken: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: encrypted,
          encryptionKeyVersion: 0,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects negative key version", () => {
      const encrypted = encryptCommunityDbCredential({
        plaintextToken: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: encrypted,
          encryptionKeyVersion: -1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects wrong wrap key", () => {
      const encrypted = encryptCommunityDbCredential({
        plaintextToken: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      const wrongKey = "f".repeat(64)
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: encrypted,
          encryptionKeyVersion: 1,
          wrapKey: wrongKey,
        }),
      ).toThrow()
    })

    test("rejects malformed ciphertext (missing prefix)", () => {
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: "garbage",
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects malformed ciphertext (wrong prefix)", () => {
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: "v2:aaaa:bbbb:cccc",
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects truncated ciphertext (missing parts)", () => {
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: "v1:aaaa",
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })

    test("rejects tampered ciphertext", () => {
      const encrypted = encryptCommunityDbCredential({
        plaintextToken: "token",
        wrapKey: VALID_WRAP_KEY,
      })
      const parts = encrypted.split(":")
      const ctBytes = Buffer.from(parts[3], "hex")
      ctBytes[0] ^= 0xff
      const tampered = [parts[0], parts[1], parts[2], ctBytes.toString("hex")].join(":")
      expect(() =>
        decryptCommunityDbCredential({
          encryptedToken: tampered,
          encryptionKeyVersion: 1,
          wrapKey: VALID_WRAP_KEY,
        }),
      ).toThrow()
    })
  })
})
