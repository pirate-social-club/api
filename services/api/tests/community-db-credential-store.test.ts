import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { ControlPlaneCommunityRepository } from "../src/lib/communities/control-plane-community-repository"
import { createControlPlaneDbClient } from "../src/lib/control-plane-db"
import { decryptCommunityDbCredential } from "../src/lib/communities/community-db-credential-crypto"
import { createControlPlaneTestClient, resetRuntimeCaches } from "./helpers"

describe("community DB credential store", () => {
  let cleanup: (() => Promise<void>) | null = null

  beforeEach(() => {
    resetRuntimeCaches()
  })

  afterEach(async () => {
    resetRuntimeCaches()
    if (cleanup) {
      await cleanup()
      cleanup = null
    }
  })

  test("upsertActiveCommunityDatabaseCredential stores an encrypted active credential and decrypts it on read", async () => {
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = controlPlane.cleanup

    const env = {
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
      TURSO_COMMUNITY_DB_WRAP_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }

    const client = createControlPlaneDbClient(env)
    const repository = new ControlPlaneCommunityRepository(client, env)
    const now = "2026-04-12T00:00:00.000Z"

    await controlPlane.client.batch([
      {
        sql: `
          INSERT INTO users (
            user_id, primary_wallet_attachment_id, verification_state, capability_provider,
            verification_capabilities_json, verified_at, nationality, current_verification_session_id,
            created_at, updated_at
          ) VALUES (
            ?1, NULL, 'unverified', 'passport', '{}', NULL, NULL, NULL, ?2, ?2
          )
        `,
        args: ["usr_cred_owner", now],
      },
      {
        sql: `
          INSERT INTO communities (
            community_id, creator_user_id, display_name, status, provisioning_state, transfer_state,
            route_slug, namespace_verification_id, primary_database_binding_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'active', 'active', 'none', NULL, NULL, NULL, ?4, ?4
          )
        `,
        args: ["cmt_cred", "usr_cred_owner", "Credential Club", now],
      },
      {
        sql: `
          INSERT INTO community_database_bindings (
            community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
            database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, 'primary', 'pirate', 'club-cmt_cred', NULL, 'main', NULL, ?3, 'iad', 'active', NULL, ?4, ?4
          )
        `,
        args: ["cdb_cred_primary", "cmt_cred", "libsql://club-cmt-cred-main.turso.io", now],
      },
      {
        sql: `
          UPDATE communities
          SET primary_database_binding_id = ?2,
              updated_at = ?3
          WHERE community_id = ?1
        `,
        args: ["cmt_cred", "cdb_cred_primary", now],
      },
    ])

    const first = await repository.upsertActiveCommunityDatabaseCredential({
      communityDatabaseBindingId: "cdb_cred_primary",
      tokenName: "club-cmt-cred-main-token-v1",
      plaintextToken: "db-token-v1",
      encryptionKeyVersion: 1,
      issuedAt: now,
      updatedAt: now,
    })

    expect(first.status).toBe("active")

    const decrypted = await repository.getActiveCommunityDatabaseAuthToken("cdb_cred_primary")
    expect(decrypted).toBe("db-token-v1")

    const storedRows = await controlPlane.client.execute({
      sql: `
        SELECT community_db_credential_id, token_name, encrypted_token, status, invalidated_at
        FROM community_db_credentials
        WHERE community_database_binding_id = ?1
        ORDER BY created_at ASC
      `,
      args: ["cdb_cred_primary"],
    })

    expect(storedRows.rows).toHaveLength(1)
    const stored = storedRows.rows[0] as Record<string, unknown>
    expect(String(stored.status)).toBe("active")
    expect(String(stored.token_name)).toBe("club-cmt-cred-main-token-v1")
    expect(String(stored.encrypted_token) === "db-token-v1").toBe(false)

    const roundTripped = decryptCommunityDbCredential({
      encryptedToken: String(stored.encrypted_token),
      encryptionKeyVersion: 1,
      wrapKey: env.TURSO_COMMUNITY_DB_WRAP_KEY,
    })
    expect(roundTripped).toBe("db-token-v1")
  })

  test("upsertActiveCommunityDatabaseCredential supersedes the prior active credential for the same binding", async () => {
    const controlPlane = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = controlPlane.cleanup

    const env = {
      CONTROL_PLANE_DATABASE_URL: `file:${controlPlane.databasePath}`,
      TURSO_COMMUNITY_DB_WRAP_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    }

    const client = createControlPlaneDbClient(env)
    const repository = new ControlPlaneCommunityRepository(client, env)
    const now = "2026-04-12T00:00:00.000Z"
    const rotatedAt = "2026-04-12T01:00:00.000Z"

    await controlPlane.client.batch([
      {
        sql: `
          INSERT INTO users (
            user_id, primary_wallet_attachment_id, verification_state, capability_provider,
            verification_capabilities_json, verified_at, nationality, current_verification_session_id,
            created_at, updated_at
          ) VALUES (
            ?1, NULL, 'unverified', 'passport', '{}', NULL, NULL, NULL, ?2, ?2
          )
        `,
        args: ["usr_rotate_owner", now],
      },
      {
        sql: `
          INSERT INTO communities (
            community_id, creator_user_id, display_name, status, provisioning_state, transfer_state,
            route_slug, namespace_verification_id, primary_database_binding_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'active', 'active', 'none', NULL, NULL, NULL, ?4, ?4
          )
        `,
        args: ["cmt_rotate", "usr_rotate_owner", "Rotate Club", now],
      },
      {
        sql: `
          INSERT INTO community_database_bindings (
            community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
            database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, 'primary', 'pirate', 'club-cmt_rotate', NULL, 'main', NULL, ?3, 'iad', 'active', NULL, ?4, ?4
          )
        `,
        args: ["cdb_rotate_primary", "cmt_rotate", "libsql://club-cmt-rotate-main.turso.io", now],
      },
      {
        sql: `
          UPDATE communities
          SET primary_database_binding_id = ?2,
              updated_at = ?3
          WHERE community_id = ?1
        `,
        args: ["cmt_rotate", "cdb_rotate_primary", now],
      },
    ])

    await repository.upsertActiveCommunityDatabaseCredential({
      communityDatabaseBindingId: "cdb_rotate_primary",
      tokenName: "club-cmt-rotate-main-token-v1",
      plaintextToken: "db-token-v1",
      encryptionKeyVersion: 1,
      issuedAt: now,
      updatedAt: now,
    })

    await repository.upsertActiveCommunityDatabaseCredential({
      communityDatabaseBindingId: "cdb_rotate_primary",
      tokenName: "club-cmt-rotate-main-token-v2",
      plaintextToken: "db-token-v2",
      encryptionKeyVersion: 2,
      issuedAt: rotatedAt,
      updatedAt: rotatedAt,
    })

    const activeToken = await repository.getActiveCommunityDatabaseAuthToken("cdb_rotate_primary")
    expect(activeToken).toBe("db-token-v2")

    const rows = await controlPlane.client.execute({
      sql: `
        SELECT token_name, status, invalidated_at
        FROM community_db_credentials
        WHERE community_database_binding_id = ?1
        ORDER BY created_at ASC
      `,
      args: ["cdb_rotate_primary"],
    })

    expect(rows.rows).toHaveLength(2)
    const first = rows.rows[0] as Record<string, unknown>
    const second = rows.rows[1] as Record<string, unknown>
    expect(String(first.token_name)).toBe("club-cmt-rotate-main-token-v1")
    expect(String(first.status)).toBe("superseded")
    expect(String(first.invalidated_at)).toBe(rotatedAt)
    expect(String(second.token_name)).toBe("club-cmt-rotate-main-token-v2")
    expect(String(second.status)).toBe("active")
  })
})
