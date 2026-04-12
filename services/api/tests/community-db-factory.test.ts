import { createCipheriv, randomBytes } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { decryptCommunityDbCredential } from "../src/lib/communities/community-db-credential-crypto"
import { resetRuntimeCaches } from "./helpers"

const communityDbFactoryModulePath = new URL("../src/lib/communities/community-db-factory.ts", import.meta.url).pathname

async function expectErrorMessage(
  promise: Promise<unknown> | (() => unknown),
  pattern: string,
): Promise<void> {
  try {
    if (typeof promise === "function") {
      promise()
    } else {
      await promise
    }
    throw new Error("expected_error")
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toMatch(new RegExp(pattern))
  }
}

function encryptCredentialEnvelope(plaintext: string, wrapKeyHex: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(wrapKeyHex, "hex"), iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return JSON.stringify({
    v: 1,
    alg: "aes-256-gcm",
    iv_base64: iv.toString("base64"),
    ciphertext_base64: ciphertext.toString("base64"),
    auth_tag_base64: authTag.toString("base64"),
  })
}

describe("community-db-factory", () => {
  beforeEach(() => {
    resetRuntimeCaches()
  })

  afterEach(() => {
    resetRuntimeCaches()
  })

  test("decryptCommunityDbCredential unwraps a versioned AES-GCM envelope", () => {
    const wrapKeyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const encryptedToken = encryptCredentialEnvelope("db-secret-token", wrapKeyHex)

    const token = decryptCommunityDbCredential({
      encryptedToken,
      encryptionKeyVersion: 1,
      wrapKey: wrapKeyHex,
    })

    expect(token).toBe("db-secret-token")
  })

  test("decryptCommunityDbCredential fails closed when the wrap key is missing", () => {
    const wrapKeyHex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    const encryptedToken = encryptCredentialEnvelope("db-secret-token", wrapKeyHex)

    return expectErrorMessage(() => decryptCommunityDbCredential({
      encryptedToken,
      encryptionKeyVersion: 1,
      wrapKey: "",
    }), "TURSO_COMMUNITY_DB_WRAP_KEY is not configured")
  })

  test("openCommunityDb supplies the decrypted auth token for remote libSQL URLs", async () => {
    const { openCommunityDb } = await import(communityDbFactoryModulePath)
    const requestedBindingIds: string[] = []

    const db = await openCommunityDb({
      async getPrimaryCommunityDatabaseBinding() {
        return {
          community_database_binding_id: "cdb_bind_123",
          community_id: "comm_123",
          binding_role: "primary",
          organization_slug: "pirate",
          group_name: "club-comm_123",
          group_id: null,
          database_name: "main",
          database_id: null,
          database_url: "libsql://club-comm_123-main.turso.io",
          location: null,
          status: "active",
          transferred_at: null,
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        }
      },
      async getActiveCommunityDatabaseAuthToken(bindingId: string) {
        requestedBindingIds.push(bindingId)
        return "db-secret-token"
      },
    } as never, "comm_123")

    expect(requestedBindingIds).toEqual(["cdb_bind_123"])
    expect(db.databaseUrl).toBe("libsql://club-comm_123-main.turso.io")
    db.close()
  })

  test("openCommunityDb fails closed when a remote libSQL binding has no active auth token", async () => {
    const { openCommunityDb } = await import(communityDbFactoryModulePath)

    await expectErrorMessage(openCommunityDb({
      async getPrimaryCommunityDatabaseBinding() {
        return {
          community_database_binding_id: "cdb_bind_456",
          community_id: "comm_456",
          binding_role: "primary",
          organization_slug: "pirate",
          group_name: "club-comm_456",
          group_id: null,
          database_name: "main",
          database_id: null,
          database_url: "libsql://club-comm_456-main.turso.io",
          location: null,
          status: "active",
          transferred_at: null,
          created_at: "2026-04-12T00:00:00.000Z",
          updated_at: "2026-04-12T00:00:00.000Z",
        }
      },
      async getActiveCommunityDatabaseAuthToken() {
        return null
      },
    } as never, "comm_456"), "Community database auth token is missing")
  })
})
