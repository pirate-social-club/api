import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { withRequestControlPlaneClients } from "../runtime-deps"
import { listHomeFeedProjectionPage } from "./home-feed-service"

const ADMIN_URL = process.env.HOME_FEED_PG_TEST_ADMIN_URL
  ?? process.env.BOOKINGS_REPO_TEST_ADMIN_URL
if (process.env.HOME_FEED_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("A PostgreSQL admin URL is required for home-feed PostgreSQL CI")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "home_feed_pagination_test"
const NOW = Date.parse("2026-08-12T12:00:00.000Z")

function urlFor(database?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (database) url.pathname = `/${database}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(database?: string): SQL {
  return new SQL({
    url: urlFor(database),
    tls: false,
    max: 1,
    connectionTimeout: 5,
  } as Record<string, unknown>)
}

describe.skipIf(!RUN)("home feed pagination (production PostgreSQL path)", () => {
  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    const database = connect(TEST_DB)
    await database.unsafe(`
      CREATE TABLE community_post_projections (
        community_id TEXT NOT NULL,
        source_post_id TEXT NOT NULL,
        author_user_id TEXT,
        identity_mode TEXT,
        source_created_at TIMESTAMPTZ NOT NULL,
        visibility TEXT NOT NULL,
        upvote_count INTEGER NOT NULL,
        downvote_count INTEGER NOT NULL,
        comment_count INTEGER NOT NULL,
        like_count INTEGER NOT NULL,
        projection_version INTEGER NOT NULL,
        status TEXT NOT NULL
      )
    `)
    for (let index = 0; index < 27; index += 1) {
      await database.unsafe(`
        INSERT INTO community_post_projections (
          community_id, source_post_id, author_user_id, identity_mode,
          source_created_at, visibility,
          upvote_count, downvote_count, comment_count, like_count,
          projection_version, status
        ) VALUES ($1, $2, 'usr_feed_operator', 'public', $3, 'public', $4, 0, $5, $6, 1, 'published')
      `, [
        "cmt_feed",
        `pst_${String(index).padStart(2, "0")}`,
        new Date(NOW - (index + 1) * 61_000).toISOString(),
        index % 5,
        index % 3,
        index % 7,
      ])
    }
    await database.end()
  })

  afterAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    await root.end()
  })

  test("round-trips the best rank and excludes the first-page boundary row", async () => {
    const env = {
      CONTROL_PLANE_DATABASE_URL: `  ${urlFor(TEST_DB)}  `,
      ENVIRONMENT: "test",
    } as unknown as Env

    await withRequestControlPlaneClients(async () => {
      const common = {
        env,
        communityIds: ["cmt_feed"],
        memberCommunityIds: [] as string[],
        sort: "best" as const,
        now: NOW,
        cutoffIso: null,
      }
      const first = await listHomeFeedProjectionPage({ ...common, anchor: null })
      const boundary = first.rows.at(-1)

      expect(first.rows).toHaveLength(25)
      expect(first.hasMore).toBe(true)
      expect(boundary).toBeDefined()
      expect(typeof boundary?.feed_sort_key).toBe("number")
      expect(boundary?.author_user_id).toBe("usr_feed_operator")
      expect(boundary?.identity_mode).toBe("public")

      const second = await listHomeFeedProjectionPage({
        ...common,
        anchor: {
          now: NOW,
          sortKey: boundary?.feed_sort_key ?? null,
          createdIso: boundary?.source_created_at ?? "",
          postId: boundary?.source_post_id ?? "",
        },
      })

      const firstIds = new Set(first.rows.map((row) => row.source_post_id))
      expect(second.rows).toHaveLength(2)
      expect(second.rows.some((row) => firstIds.has(row.source_post_id))).toBe(false)
    })
  })
})
