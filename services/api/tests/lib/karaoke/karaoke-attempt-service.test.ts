import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { KARAOKE_SCORING_VERSION } from "@pirate-social-club/karaoke-runtime"

import { karaokeAttemptServiceTestHooks } from "../../../src/lib/karaoke/karaoke-attempt-service"

describe("karaoke attempt leaderboard ranking", () => {
  test("excludes banned community members before ranking", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await client.execute(`
        CREATE TABLE karaoke_attempt (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          post_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          karaoke_revision_id TEXT NOT NULL,
          scoring_version INTEGER NOT NULL,
          scoring_provider TEXT NOT NULL,
          scoring_model TEXT NOT NULL,
          final_score INTEGER NOT NULL,
          completed_at TEXT NOT NULL,
          rank_eligible INTEGER NOT NULL
        )
      `)
      await client.execute(`
        CREATE TABLE community_memberships (
          membership_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL
        )
      `)
      await client.batch([
        {
          sql: `
            INSERT INTO community_memberships (membership_id, community_id, user_id, status)
            VALUES
              ('mbr_banned', 'cmt_karaoke', 'usr_banned', 'banned'),
              ('mbr_viewer', 'cmt_karaoke', 'usr_viewer', 'member'),
              ('mbr_peer', 'cmt_karaoke', 'usr_peer', 'member')
          `,
          args: [],
        },
        {
          sql: `
            INSERT INTO karaoke_attempt (
              id, user_id, post_id, community_id, karaoke_revision_id,
              scoring_version, scoring_provider, scoring_model,
              final_score, completed_at, rank_eligible
            )
            VALUES
              ('kat_banned', 'usr_banned', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 9900, '2026-07-08T08:00:00.000Z', 1),
              ('kat_viewer', 'usr_viewer', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 9100, '2026-07-08T08:05:00.000Z', 1),
              ('kat_viewer_old', 'usr_viewer', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 8500, '2026-07-08T08:01:00.000Z', 1),
              ('kat_peer', 'usr_peer', 'pst_song', 'cmt_karaoke', 'krv_current',
                ?1, 'pirate-karaoke-runtime', 'text-timing-v1', 8800, '2026-07-08T08:10:00.000Z', 1)
          `,
          args: [KARAOKE_SCORING_VERSION],
        },
      ])

      const result = await client.execute({
        sql: `
          ${karaokeAttemptServiceTestHooks.karaokeLeaderboardRankedCte()}
          SELECT user_id, final_score, rank, total_ranked
          FROM ranked
          ORDER BY rank ASC, completed_at ASC, user_id ASC
        `,
        args: [
          "pst_song",
          "krv_current",
          KARAOKE_SCORING_VERSION,
          "pirate-karaoke-runtime",
          "text-timing-v1",
        ],
      })

      expect(result.rows).toEqual([
        { user_id: "usr_viewer", final_score: 9100, rank: 1, total_ranked: 2 },
        { user_id: "usr_peer", final_score: 8800, rank: 2, total_ranked: 2 },
      ])
    } finally {
      client.close()
    }
  })
})
