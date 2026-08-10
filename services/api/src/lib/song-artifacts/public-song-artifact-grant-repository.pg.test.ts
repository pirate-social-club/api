// Production-dialect coverage for anonymous artifact authorization. The grant
// lookup runs on every byte-range request, so its SQL must execute on the
// PostgreSQL control plane rather than merely passing the SQLite unit fixture.
import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { Client, InStatement } from "../sql-client"
import { hasPublicSongArtifactGrant } from "./public-song-artifact-grant-repository"

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
if (process.env.PUBLIC_ARTIFACT_GRANT_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for public artifact grant PostgreSQL CI")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "public_artifact_grant_test"

function urlFor(database?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (database) url.pathname = `/${database}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(database?: string): SQL {
  return new SQL({
    connectionTimeout: 5,
    max: 1,
    tls: false,
    url: urlFor(database),
  } as Record<string, unknown>)
}

function postgresClient(connection: SQL): Client {
  return {
    async execute(statement: string | InStatement) {
      const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
      const sql = normalized.sql.replace(/\?(\d+)/gu, (_match: string, index: string) => `$${index}`)
      const rows = await connection.unsafe(sql, normalized.args ?? []) as Record<string, unknown>[]
      return { rows }
    },
    async batch() {
      throw new Error("batch is not used by the grant lookup")
    },
    async transaction() {
      throw new Error("transaction is not used by the grant lookup")
    },
  }
}

describe.skipIf(!RUN)("public song artifact grants (real Postgres)", () => {
  let database: SQL

  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    database = connect(TEST_DB)
    await database.unsafe(`
      CREATE TABLE communities (
        community_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE community_post_projections (
        community_id TEXT NOT NULL,
        source_post_id TEXT NOT NULL,
        status TEXT NOT NULL,
        visibility TEXT NOT NULL,
        projected_payload_json TEXT NOT NULL,
        PRIMARY KEY (community_id, source_post_id)
      );
      CREATE TABLE public_song_artifact_grants (
        community_id TEXT NOT NULL,
        song_artifact_upload_id TEXT NOT NULL,
        source_post_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (community_id, song_artifact_upload_id, source_post_id)
      );
    `)
    await database.unsafe(`
      INSERT INTO communities (community_id, status) VALUES ('cmt_music', 'active');
      INSERT INTO community_post_projections (
        community_id, source_post_id, status, visibility, projected_payload_json
      ) VALUES ('cmt_music', 'pst_video', 'published', 'public', '{"access_mode":"public"}');
      INSERT INTO public_song_artifact_grants (
        community_id, song_artifact_upload_id, source_post_id, created_at, updated_at
      ) VALUES ('cmt_music', 'sau_video', 'pst_video', NOW(), NOW());
    `)
  })

  afterAll(async () => {
    if (database) await database.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    await root.end()
  })

  test("executes the read-time authorization query in PostgreSQL and revokes stale grants", async () => {
    const client = postgresClient(database)
    const input = { client, communityId: "cmt_music", songArtifactUploadId: "sau_video" }

    expect(await hasPublicSongArtifactGrant(input)).toBe(true)
    await database.unsafe("UPDATE community_post_projections SET visibility = 'members_only'")
    expect(await hasPublicSongArtifactGrant(input)).toBe(false)
    await database.unsafe("UPDATE community_post_projections SET visibility = 'public'")
    await database.unsafe("UPDATE communities SET status = 'archived'")
    expect(await hasPublicSongArtifactGrant(input)).toBe(false)
  })
})
