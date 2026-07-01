import { afterEach, describe, expect, test } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl, ensureCommunityDbSchema } from "../../../src/lib/communities/community-local-db"
import { splitSqlStatements, toSqliteCompatibleStatements } from "../../../shared/sql-migration"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt } from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function applyStudyMigration(client: Client): Promise<void> {
  const studyExisting = await client.execute("PRAGMA table_info(song_study_unit)")
  if (studyExisting.rows.length === 0) {
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1109_song_study.sql")
  }

  const communityColumns = await client.execute("PRAGMA table_info(communities)")
  if (!communityColumns.rows.some((row) => String(row.name) === "study_enabled")) {
    await applyMigrationFile(client, "../../../test-fixtures/db/community-template/migrations/1115_community_study_enabled.sql")
  }
}

async function applyMigrationFile(client: Client, relativePath: string): Promise<void> {
  const path = fileURLToPath(new URL(relativePath, import.meta.url))
  const raw = await readFile(path, "utf8")
  for (const statement of splitSqlStatements(raw)) {
    for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
      await client.execute(sqliteStatement)
    }
  }
}

async function seedStudySong(input: {
  communityDbRoot: string
  communityId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await ensureCommunityDbSchema(client)
    await applyStudyMigration(client)
    const now = "2026-06-29T08:00:00.000Z"
    await client.execute({
      sql: `
        INSERT INTO communities (
          community_id, display_name, status, artist_governance_state,
          membership_mode, default_age_gate_policy, donation_policy_mode,
          donation_partner_status, governance_mode, created_by_user_id,
          created_at, updated_at, study_enabled
        )
        VALUES (?1, 'Study Route Club', 'active', 'fan_run', 'open', 'none',
                'none', 'unconfigured', 'centralized', 'route_author', ?2, ?2, 1)
      `,
      args: [input.communityId, now],
    })
    await client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, identity_mode, post_type,
          status, song_mode, title, lyrics, source_language, rights_basis,
          analysis_state, content_safety_state, age_gate_policy, created_at,
          updated_at, access_mode, asset_id, visibility, song_title, song_cover_art_ref
        )
        VALUES ('pst_study_route_song', ?1, 'route_author', 'public', 'song',
                'published', 'original', 'Route Song',
                'Line one for route study
Line two for route study',
                'en', 'original', 'allow', 'safe', 'none', ?2, ?2,
                'public', 'ast_route_song', 'public', 'Route Song', 'ipfs://study-route-cover')
      `,
      args: [input.communityId, now],
    })
  } finally {
    client.close()
  }
}

describe("community study routes", () => {
  test("GET /communities/:communityId/posts/:postId/study is registered and returns a gated study payload", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "study-route-reader")
    const communityId = "cmt_study_route"
    await seedStudySong({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, capability_provider,
          verification_capabilities_json, verified_at,
          created_at, updated_at
        )
        VALUES (
          'route_author', 'verified', 'self', '["unique_human"]',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z',
          '2026-06-29T08:00:00.000Z'
        )
        ON CONFLICT (user_id) DO NOTHING
      `,
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description,
          membership_mode, status, provisioning_state, transfer_state,
          route_slug, created_at, updated_at
        )
        VALUES (
          ?1, 'route_author', 'Study Route Club', NULL,
          'open', 'active', 'active', 'none',
          NULL, '2026-06-29T08:00:00.000Z', '2026-06-29T08:00:00.000Z'
        )
      `,
      args: [communityId],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO community_assistant_credentials (
          community_assistant_credential_id, community_id, provider, encrypted_secret,
          key_last4, encryption_key_version, status, created_at, revoked_at,
          rotated_from, actor_user_id
        )
        VALUES (
          'cac_study_route_elevenlabs', ?1, 'elevenlabs', 'test-encrypted-key',
          'labs', 1, 'active', '2026-06-29T08:00:00.000Z', NULL, NULL,
          'route_author'
        )
      `,
      args: [communityId],
    })

    const response = await app.request(
      `http://pirate.test/communities/${communityId}/posts/pst_study_route_song/study?target_language=es`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )

    expect(response.status).toBe(200)
    const body = await json(response) as {
      access?: string
      exercise_count?: number
      exercises?: Array<{ type?: string }>
      object?: string
    }
    expect(body.object).toBe("song_study_payload")
    expect(body.access).toBe("ready")
    expect(body.exercise_count).toBe(2)
    expect(body.exercises?.every((exercise) => exercise.type === "say_it_back")).toBe(true)
  }, 120_000)
})
