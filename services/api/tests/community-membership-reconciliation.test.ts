import { afterEach, describe, expect, test } from "bun:test"
import type { Client } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { DatabaseCommunityRepository } from "../src/lib/communities/db-community-repository"
import { reconcileCommunityMembershipAndFollowProjections } from "../src/lib/communities/membership/projection-service"
import { createRouteTestContext } from "./helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function insertUser(client: Pick<Client, "execute">, userId: string, now: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO users (
        user_id, primary_wallet_attachment_id, verification_state, capability_provider,
        verification_capabilities_json, verified_at, current_verification_session_id, created_at, updated_at
      ) VALUES (
        ?1, NULL, 'verified', NULL,
        '{}', NULL, NULL, ?2, ?2
      )
    `,
    args: [userId, now],
  })
}

describe("community membership projection reconciliation", () => {
  test("replays local membership and follow state into control-plane projections", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const now = new Date().toISOString()
    const communityId = "cmt_membership_reconcile"
    const ownerUserId = "usr_reconcile_owner"
    const memberUserId = "usr_reconcile_member"
    const followerUserId = "usr_reconcile_follower"

    await insertUser(ctx.client, ownerUserId, now)
    await insertUser(ctx.client, memberUserId, now)
    await insertUser(ctx.client, followerUserId, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status, provisioning_state,
          transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id,
          primary_database_binding_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'Reconcile Test', 'open', 'active', 'active',
          'none', NULL, NULL, NULL,
          NULL, ?3, ?3
        )
      `,
      args: [communityId, ownerUserId, now],
    })

    const repo = new DatabaseCommunityRepository(ctx.client)
    const db = await openCommunityDb(ctx.env, repo, communityId)
    try {
      await db.client.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, description, status, artist_identity_id, artist_governance_state,
            membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
            donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
            settings_json, created_by_user_id, cached_follower_count, created_at, updated_at
          ) VALUES (
            ?1, 'Reconcile Test', NULL, 'active', NULL, 'fan_run',
            'open', 'none', 1, 'thread_stable',
            NULL, 'none', 'unconfigured', 'centralized',
            NULL, ?2, 2, ?3, ?3
          )
        `,
        args: [communityId, ownerUserId, now],
      })
      await db.client.execute({
        sql: `
          INSERT INTO community_memberships (
            membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
          )
        `,
        args: [`mbr_${communityId}_${memberUserId}`, communityId, memberUserId, now],
      })
      for (const userId of [memberUserId, followerUserId]) {
        await db.client.execute({
          sql: `
            INSERT INTO community_follows (
              community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, 'active', NULL, ?4, ?4
            )
          `,
          args: [`flw_${communityId}_${userId}`, communityId, userId, now],
        })
      }
    } finally {
      db.close()
    }

    const summary = await reconcileCommunityMembershipAndFollowProjections({
      env: ctx.env,
      communityRepository: repo,
      maxCommunities: 1,
    })

    expect(summary.checked_communities).toBe(1)
    expect(summary.synced_membership_projections).toBe(1)
    expect(summary.synced_follow_projections).toBe(2)
    expect(summary.corrected_follower_counts).toBe(1)
    expect(summary.failed_communities).toBe(0)

    const membershipRows = await ctx.client.execute({
      sql: `
        SELECT membership_state
        FROM community_membership_projections
        WHERE community_id = ?1 AND user_id = ?2
      `,
      args: [communityId, memberUserId],
    })
    expect(membershipRows.rows[0]?.membership_state).toBe("member")

    const followRows = await ctx.client.execute({
      sql: `
        SELECT user_id, follow_state
        FROM community_follow_projections
        WHERE community_id = ?1
        ORDER BY user_id ASC
      `,
      args: [communityId],
    })
    expect(followRows.rows).toEqual([
      { user_id: followerUserId, follow_state: "active" },
      { user_id: memberUserId, follow_state: "active" },
    ])

    const communityRows = await ctx.client.execute({
      sql: `SELECT follower_count FROM communities WHERE community_id = ?1`,
      args: [communityId],
    })
    expect(communityRows.rows[0]?.follower_count).toBe(2)
  })
})
