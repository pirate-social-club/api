import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import type { CommunityPreview, Env } from "../../../src/types"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function createTestCommunity(input: {
  env: Env
  accessToken: string
}): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Role Test Community",
    handle_policy: { policy_template: "standard" },
  }, input.env, input.accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { community_id: string } }
  return body.community.community_id
}

async function getPreview(input: {
  env: Env
  communityId: string
  accessToken: string
}): Promise<CommunityPreview> {
  const response = await Promise.resolve(app.request(
    `http://pirate.test/communities/${input.communityId}/preview`,
    {
      method: "GET",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
      },
    },
    input.env,
  ))
  expect(response.status).toBe(200)
  return await json(response) as CommunityPreview
}

async function countActiveRole(input: {
  communityDbRoot: string
  communityId: string
  userId: string
  role: "admin" | "moderator"
}): Promise<number> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM community_roles
        WHERE community_id = ?1
          AND user_id = ?2
          AND role = ?3
          AND status = 'active'
      `,
      args: [input.communityId, input.userId, input.role],
    })
    return Number(result.rows[0]?.count ?? 0)
  } finally {
    client.close()
  }
}

describe("community role routes", () => {
  test("owner can grant and revoke moderator roles that appear in community preview", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-role-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const moderator = await exchangeJwt(ctx.env, "community-role-moderator")
    const secondModerator = await exchangeJwt(ctx.env, "community-role-second-moderator")
    const admin = await exchangeJwt(ctx.env, "community-role-admin")
    const secondAdmin = await exchangeJwt(ctx.env, "community-role-second-admin")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
    })

    const grantModerator = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/grant`,
      {
        user_id: moderator.userId,
        role: "moderator",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(grantModerator.status).toBe(200)

    const duplicateGrant = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/grant`,
      {
        user_id: moderator.userId,
        role: "moderator",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(duplicateGrant.status).toBe(200)
    expect(await countActiveRole({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      userId: moderator.userId,
      role: "moderator",
    })).toBe(1)

    const grantAdmin = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/grant`,
      {
        user_id: admin.userId,
        role: "admin",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(grantAdmin.status).toBe(200)

    const adminGrantsModerator = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/grant`,
      {
        user_id: secondModerator.userId,
        role: "moderator",
      },
      ctx.env,
      admin.accessToken,
    )
    expect(adminGrantsModerator.status).toBe(200)

    const adminCannotGrantAdmin = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/grant`,
      {
        user_id: secondAdmin.userId,
        role: "admin",
      },
      ctx.env,
      admin.accessToken,
    )
    expect(adminCannotGrantAdmin.status).toBe(404)

    const preview = await getPreview({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    expect(preview.owner?.user_id).toBe(owner.userId)
    expect(preview.moderators.map((role) => ({
      user_id: role.user_id,
      role: role.role,
    }))).toEqual([
      { user_id: admin.userId, role: "admin" },
      { user_id: moderator.userId, role: "moderator" },
      { user_id: secondModerator.userId, role: "moderator" },
    ])

    const revokeModerator = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/revoke`,
      {
        user_id: moderator.userId,
        role: "moderator",
      },
      ctx.env,
      admin.accessToken,
    )
    expect(revokeModerator.status).toBe(200)

    const afterRevoke = await getPreview({
      env: ctx.env,
      communityId,
      accessToken: owner.accessToken,
    })
    expect(afterRevoke.moderators.map((role) => role.user_id)).toEqual([admin.userId, secondModerator.userId])
  })

  test("non-owner cannot grant community roles", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-role-owner-deny")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const nonOwner = await exchangeJwt(ctx.env, "community-role-non-owner")
    const target = await exchangeJwt(ctx.env, "community-role-target")
    const communityId = await createTestCommunity({
      env: ctx.env,
      accessToken: owner.accessToken,
    })

    const response = await requestJson(
      `http://pirate.test/communities/${communityId}/roles/grant`,
      {
        user_id: target.userId,
        role: "moderator",
      },
      ctx.env,
      nonOwner.accessToken,
    )
    expect(response.status).toBe(404)
  })
})
