import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { decryptCommunityDbCredential } from "./community-db-resolver.js";

function encryptFixture(plaintext: string, wrapKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(wrapKey, "hex"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${ciphertext.toString("hex")}`;
}

describe("community DB resolver", () => {
  test("decrypts community DB credentials with the shared ciphertext format", () => {
    const wrapKey = "11".repeat(32);
    const encrypted = encryptFixture("db-token-test", wrapKey);

    expect(decryptCommunityDbCredential({
      encryptedToken: encrypted,
      encryptionKeyVersion: 2,
      wrapKey,
    })).toBe("db-token-test");
  });

  test("rejects invalid wrap keys", () => {
    expect(() => decryptCommunityDbCredential({
      encryptedToken: "v1:iv:tag:ciphertext",
      encryptionKeyVersion: 2,
      wrapKey: "bad",
    })).toThrow("Community DB credential ciphertext could not be decrypted");
  });
});
