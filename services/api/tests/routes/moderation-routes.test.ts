import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../src/index"
import { buildLocalCommunityDbUrl } from "../../src/lib/communities/community-local-db"
import type { Env } from "../../src/types"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../helpers"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, body: unknown, env: Env, token?: string, method = "POST"): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { id: string } }
  return { accessToken: body.access_token, userId: body.user.id.replace(/^usr_/, "") }
}

async function completeUniqueHumanVerification(env: Env, accessToken: string): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )
}

async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  await completeUniqueHumanVerification(env, accessToken)

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: "ModerationRoutesCoverageRoot",
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification: string }
  return completedBody.namespace_verification
}

async function createCommunity(env: Env, accessToken: string, displayName: string): Promise<{ communityId: string }> {
  const namespaceVerificationId = await prepareVerifiedNamespace(env, accessToken)
  const response = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    membership_mode: "request",
    namespace: {
      namespace_verification: namespaceVerificationId,
    },
  }, env, accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return { communityId: body.community.id.replace(/^com_/, "") }
}

async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
        ON CONFLICT(membership_id) DO UPDATE SET
          status = excluded.status,
          joined_at = excluded.joined_at,
          left_at = excluded.left_at,
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("moderation routes", () => {
  test("members can report posts and owners can read moderation cases", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "moderation-routes-owner")
    const community = await createCommunity(ctx.env, owner.accessToken, "Moderation Club")

    const member = await exchangeJwt(ctx.env, "moderation-routes-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Review me",
        body: "This post will be reported",
        idempotency_key: "moderation-post-1",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const report = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/reports`,
      {
        reason_code: "spam",
        note: "Looks like spam",
      },
      ctx.env,
      member.accessToken,
    )
    expect(report.status).toBe(201)
    const rawPostId = postBody.id.replace(/^post_/, "")
    const reportBody = await json(report) as { post_id: string | null; comment_id: string | null; reason_code: string }
    expect(reportBody.post_id).toBe(rawPostId)
    expect(reportBody.comment_id).toBeNull()
    expect(reportBody.reason_code).toBe("spam")

    const cases = await app.request(
      `http://pirate.test/communities/${community.communityId}/moderation/cases`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(cases.status).toBe(200)
    const casesBody = await json(cases) as { items: Array<{ moderation_case_id: string; post_id: string | null; comment_id: string | null; status: string }> }
    expect(casesBody.items).toHaveLength(1)
    expect(casesBody.items[0]?.post_id).toBe(rawPostId)
    expect(casesBody.items[0]?.comment_id).toBeNull()
    expect(casesBody.items[0]?.status).toBe("open")

    const denied = await app.request(
      `http://pirate.test/communities/${community.communityId}/moderation/cases`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(denied.status).toBe(403)
  })

  test("members can report comments and owners can resolve cases with comment actions", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "moderation-routes-owner-2")
    const community = await createCommunity(ctx.env, owner.accessToken, "Moderation Comments Club")

    const member = await exchangeJwt(ctx.env, "moderation-routes-member-2")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Comment report thread",
        body: "Body",
        idempotency_key: "moderation-post-2",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const createdComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments`,
      {
        body: "Suspicious comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(createdComment.status).toBe(201)
    const commentBody = await json(createdComment) as { id: string; status: string }
    expect(commentBody.status).toBe("published")

    const report = await requestJson(
      `http://pirate.test/communities/${community.communityId}/comments/${commentBody.id}/reports`,
      {
        reason_code: "harassment",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(report.status).toBe(201)
    const rawCommentId = commentBody.id.replace(/^cmt_/, "")
    const reportBody = await json(report) as { post_id: string | null; comment_id: string | null }
    expect(reportBody.post_id).toBeNull()
    expect(reportBody.comment_id).toBe(rawCommentId)

    const cases = await app.request(
      `http://pirate.test/communities/${community.communityId}/moderation/cases`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(cases.status).toBe(200)
    const casesBody = await json(cases) as { items: Array<{ moderation_case_id: string; comment_id: string | null }> }
    const moderationCaseId = casesBody.items[0]?.moderation_case_id
    expect(typeof moderationCaseId).toBe("string")
    expect(casesBody.items[0]?.comment_id).toBe(rawCommentId)

    const detailBefore = await app.request(
      `http://pirate.test/communities/${community.communityId}/moderation/cases/${moderationCaseId}`,
      {
        headers: {
          authorization: `Bearer ${owner.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(detailBefore.status).toBe(200)
    const detailBeforeBody = await json(detailBefore) as {
      case: { status: string }
      comment: { comment_id: string; status: string } | null
      reports: Array<unknown>
    }
    expect(detailBeforeBody.case.status).toBe("open")
    expect(detailBeforeBody.comment?.comment_id).toBe(rawCommentId)
    expect(detailBeforeBody.comment?.status).toBe("published")
    expect(detailBeforeBody.reports).toHaveLength(1)

    const action = await requestJson(
      `http://pirate.test/communities/${community.communityId}/moderation/cases/${moderationCaseId}/actions`,
      {
        action_type: "remove",
        note: "Removed by owner",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(action.status).toBe(200)
    const actionBody = await json(action) as {
      case: { status: string; resolved_at: string | null }
      comment: { comment_id: string; status: string } | null
      actions: Array<{ action_type: string }>
    }
    expect(actionBody.case.status).toBe("resolved")
    expect(typeof actionBody.case.resolved_at).toBe("string")
    expect(actionBody.comment?.comment_id).toBe(rawCommentId)
    expect(actionBody.comment?.status).toBe("removed")
    expect(actionBody.actions).toHaveLength(1)
    expect(actionBody.actions[0]?.action_type).toBe("remove")
  })
})
