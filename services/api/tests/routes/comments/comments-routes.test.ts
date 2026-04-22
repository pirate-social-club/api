import { sign as signWithPrivateKey } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import {
  canonicalizeAgentActionProofSignaturePayload,
  computeAgentActionProofHash,
} from "../../../src/lib/agents/agent-action-proof"
import { setClawkeyProviderForTests } from "../../../src/lib/agents/clawkey-provider"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import { buildVerifiedSelfProvider, createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { createSignedAgentChallenge } from "../../agent-test-helpers"
import { updateLocalCommunityAgentPostingPolicy } from "../communities/community-routes-test-helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  createCommunity,
  exchangeJwt,
  insertThreadSnapshot,
  requestJson,
} from "./comments-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setSelfProviderForTests(buildVerifiedSelfProvider("self-comments-route-test-ref"))
})

afterEach(async () => {
  setClawkeyProviderForTests(null)
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("comments routes", () => {
  test("user-owned agents can create top-level comments and replies in replies_only communities", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-agent-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Agent Club")
    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      agentPostingPolicy: "allow",
      agentPostingScope: "replies_only",
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    const member = await exchangeJwt(ctx.env, "comments-agent-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)
    await ctx.client.execute({
      sql: `
        INSERT INTO linked_handles (
          linked_handle_id,
          user_id,
          wallet_attachment_id,
          kind,
          label_normalized,
          label_display,
          verification_state,
          metadata_json,
          created_at,
          updated_at
        ) VALUES ('lnk_comment_agent_owner_ens', ?1, NULL, 'ens', 'commentagent.eth', 'commentagent.eth', 'verified', '{}', ?2, ?2)
      `,
      args: [member.userId, "2026-04-19T12:31:00.000Z"],
    })
    await ctx.client.execute({
      sql: `
        UPDATE profiles
        SET primary_linked_handle_id = 'lnk_comment_agent_owner_ens',
            updated_at = ?2
        WHERE user_id = ?1
      `,
      args: [member.userId, "2026-04-19T12:31:00.000Z"],
    })

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Comment agent thread",
        body: "Build the agent thread",
        idempotency_key: "comments-agent-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500002000",
      deviceId: "claw-device-comments-reply-bot",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_comments_agent_123",
        registrationUrl: "https://clawkey.test/register/cks_comments_agent_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-comments-reply-bot",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Reply Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
      resolved_agent_ownership_record_id: string
    }

    const topLevelCommentUrl = `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`
    const topLevelCommentPayload = {
      body: "Reply Bot top-level comment",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const topLevelCommentHash = await computeAgentActionProofHash({
      method: "POST",
      url: topLevelCommentUrl,
      body: topLevelCommentPayload,
    })
    const topLevelCommentSignedAt = new Date().toISOString()
    const topLevelCommentSignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "comments-agent-nonce-1",
        signedAt: topLevelCommentSignedAt,
        canonicalRequestHash: topLevelCommentHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const topLevelComment = await requestJson(
      topLevelCommentUrl,
      {
        ...topLevelCommentPayload,
        agent_action_proof: {
          nonce: "comments-agent-nonce-1",
          signed_at: topLevelCommentSignedAt,
          canonical_request_hash: topLevelCommentHash,
          signature: topLevelCommentSignature,
        },
      },
      ctx.env,
      member.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as {
      comment_id: string
      authorship_mode: string
      agent_id: string | null
      agent_ownership_record_id: string | null
      agent_handle_snapshot: string | null
      agent_display_name_snapshot: string | null
      agent_owner_handle_snapshot: string | null
      agent_ownership_provider_snapshot: string | null
    }
    expect(topLevelBody.authorship_mode).toBe("user_agent")
    expect(topLevelBody.agent_id).toBe(ownershipCompleteBody.agent_id)
    expect(topLevelBody.agent_ownership_record_id).toBe(ownershipCompleteBody.resolved_agent_ownership_record_id)
    expect(topLevelBody.agent_handle_snapshot).toBe("reply-bot.clawitzer")
    expect(topLevelBody.agent_display_name_snapshot).toBe("Reply Bot")
    expect(topLevelBody.agent_owner_handle_snapshot).toBe("commentagent.eth")
    expect(topLevelBody.agent_ownership_provider_snapshot).toBe("clawkey")

    const replyUrl = `http://pirate.test/comments/${topLevelBody.comment_id}/replies`
    const replyPayload = {
      body: "Reply Bot nested reply",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const replyHash = await computeAgentActionProofHash({
      method: "POST",
      url: replyUrl,
      body: replyPayload,
    })
    const replySignedAt = new Date().toISOString()
    const replySignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "comments-agent-nonce-2",
        signedAt: replySignedAt,
        canonicalRequestHash: replyHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const reply = await requestJson(
      replyUrl,
      {
        ...replyPayload,
        agent_action_proof: {
          nonce: "comments-agent-nonce-2",
          signed_at: replySignedAt,
          canonical_request_hash: replyHash,
          signature: replySignature,
        },
      },
      ctx.env,
      member.accessToken,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as {
      parent_comment_id: string | null
      authorship_mode: string
      agent_id: string | null
    }
    expect(replyBody.parent_comment_id).toBe(topLevelBody.comment_id)
    expect(replyBody.authorship_mode).toBe("user_agent")
    expect(replyBody.agent_id).toBe(ownershipCompleteBody.agent_id)
  })

  test("delegated agent access tokens can create top-level comments and nested replies", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-delegated-agent-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Delegated Comment Agent Club")
    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      agentPostingPolicy: "allow",
      agentPostingScope: "replies_only",
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    const member = await exchangeJwt(ctx.env, "comments-delegated-agent-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Delegated comment agent thread",
        body: "Build the delegated agent thread",
        idempotency_key: "comments-delegated-agent-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500002100",
      deviceId: "claw-device-comments-delegated-reply-bot",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_comments_delegated_agent_123",
        registrationUrl: "https://clawkey.test/register/cks_comments_delegated_agent_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-comments-delegated-reply-bot",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Delegated Reply Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
      resolved_agent_ownership_record_id: string
    }

    const issueResponse = await requestJson(
      `http://pirate.test/agents/${ownershipCompleteBody.agent_id}/credential`,
      {
        current_ownership_record_id: ownershipCompleteBody.resolved_agent_ownership_record_id,
      },
      ctx.env,
      member.accessToken,
    )
    expect(issueResponse.status).toBe(200)
    const issueBody = await json(issueResponse) as { access_token: string }

    const topLevelCommentUrl = `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`
    const topLevelCommentPayload = {
      body: "Delegated Reply Bot top-level comment",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const topLevelCommentHash = await computeAgentActionProofHash({
      method: "POST",
      url: topLevelCommentUrl,
      body: topLevelCommentPayload,
    })
    const topLevelCommentSignedAt = new Date().toISOString()
    const topLevelCommentSignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "comments-delegated-agent-nonce-1",
        signedAt: topLevelCommentSignedAt,
        canonicalRequestHash: topLevelCommentHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const topLevelComment = await requestJson(
      topLevelCommentUrl,
      {
        ...topLevelCommentPayload,
        agent_action_proof: {
          nonce: "comments-delegated-agent-nonce-1",
          signed_at: topLevelCommentSignedAt,
          canonical_request_hash: topLevelCommentHash,
          signature: topLevelCommentSignature,
        },
      },
      ctx.env,
      issueBody.access_token,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as {
      comment_id: string
      authorship_mode: string
      agent_id: string | null
    }
    expect(topLevelBody.authorship_mode).toBe("user_agent")
    expect(topLevelBody.agent_id).toBe(ownershipCompleteBody.agent_id)

    const replyUrl = `http://pirate.test/comments/${topLevelBody.comment_id}/replies`
    const replyPayload = {
      body: "Delegated Reply Bot nested reply",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const replyHash = await computeAgentActionProofHash({
      method: "POST",
      url: replyUrl,
      body: replyPayload,
    })
    const replySignedAt = new Date().toISOString()
    const replySignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "comments-delegated-agent-nonce-2",
        signedAt: replySignedAt,
        canonicalRequestHash: replyHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const reply = await requestJson(
      replyUrl,
      {
        ...replyPayload,
        agent_action_proof: {
          nonce: "comments-delegated-agent-nonce-2",
          signed_at: replySignedAt,
          canonical_request_hash: replyHash,
          signature: replySignature,
        },
      },
      ctx.env,
      issueBody.access_token,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as {
      parent_comment_id: string | null
      authorship_mode: string
      agent_id: string | null
    }
    expect(replyBody.parent_comment_id).toBe(topLevelBody.comment_id)
    expect(replyBody.authorship_mode).toBe("user_agent")
    expect(replyBody.agent_id).toBe(ownershipCompleteBody.agent_id)
  })

  test("replies_only communities with a self lane reject derived clawkey agent comment writes", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-derived-selflane-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Derived Self Lane Club")
    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      agentPostingPolicy: "allow",
      agentPostingScope: "replies_only",
      humanVerificationLane: "self",
    })

    const member = await exchangeJwt(ctx.env, "comments-derived-selflane-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Derived self lane thread",
        body: "Build the derived self lane thread",
        idempotency_key: "comments-derived-selflane-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500002100",
      deviceId: "claw-device-comments-self-lane",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_comments_derived_selflane_123",
        registrationUrl: "https://clawkey.test/register/cks_comments_derived_selflane_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-comments-self-lane",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Self Lane Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
    }

    const commentUrl = `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`
    const commentPayload = {
      body: "This should fail on derived provider acceptance.",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const commentHash = await computeAgentActionProofHash({
      method: "POST",
      url: commentUrl,
      body: commentPayload,
    })
    const signedAt = new Date().toISOString()
    const signature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "comments-derived-selflane-nonce-1",
        signedAt,
        canonicalRequestHash: commentHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const deniedComment = await requestJson(
      commentUrl,
      {
        ...commentPayload,
        agent_action_proof: {
          nonce: "comments-derived-selflane-nonce-1",
          signed_at: signedAt,
          canonical_request_hash: commentHash,
          signature,
        },
      },
      ctx.env,
      member.accessToken,
    )
    expect(deniedComment.status).toBe(403)
    const deniedCommentBody = await json(deniedComment) as { code: string; message: string }
    expect(deniedCommentBody.code).toBe("eligibility_failed")
    expect(deniedCommentBody.message).toContain("does not currently accept any available agent ownership provider")
  })

  test("creates top-level comments, replies, and exposes paginated list/context reads", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Routes Club")

    const member = await exchangeJwt(ctx.env, "comments-routes-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Comment thread",
        body: "Build the thread",
        idempotency_key: "comments-routes-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const topLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "First top-level comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { comment_id: string; depth: number; body: string }
    expect(topLevelBody.depth).toBe(0)
    expect(topLevelBody.body).toBe("First top-level comment")

    const reply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies`,
      {
        body: "Reply under the top-level comment",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as { comment_id: string; parent_comment_id: string | null; depth: number }
    expect(replyBody.parent_comment_id).toBe(topLevelBody.comment_id)
    expect(replyBody.depth).toBe(1)

    const secondReply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies`,
      {
        body: "Second reply under the top-level comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(secondReply.status).toBe(201)
    const secondReplyBody = await json(secondReply) as { comment_id: string }

    const secondTopLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Second top-level comment",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(secondTopLevelComment.status).toBe(201)
    const secondTopLevelBody = await json(secondTopLevelComment) as { comment_id: string }

    const thirdTopLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Third top-level comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(thirdTopLevelComment.status).toBe(201)
    const thirdTopLevelBody = await json(thirdTopLevelComment) as { comment_id: string }

    await insertThreadSnapshot({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: postBody.post_id,
      commentCount: 5,
      swarmManifestRef: "swarm-manifest:test-thread",
      swarmFeedRef: "swarm-feed:test-thread",
    })

    const listedComments = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments?sort=new&limit=2`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedComments.status).toBe(200)
    const listedCommentsBody = await json(listedComments) as {
      next_cursor: string | null
      thread_snapshot: {
        thread_root_post_id: string
        swarm_manifest_ref: string
        swarm_feed_ref: string | null
      } | null
      items: Array<{ comment: { comment_id: string; direct_reply_count: number } }>
    }
    expect(listedCommentsBody.items).toHaveLength(2)
    expect(listedCommentsBody.items[0]?.comment.comment_id).toBe(thirdTopLevelBody.comment_id)
    expect(listedCommentsBody.items[1]?.comment.comment_id).toBe(secondTopLevelBody.comment_id)
    expect(typeof listedCommentsBody.next_cursor).toBe("string")
    expect(listedCommentsBody.thread_snapshot?.thread_root_post_id).toBe(postBody.post_id)
    expect(listedCommentsBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:test-thread")
    expect(listedCommentsBody.thread_snapshot?.swarm_feed_ref).toBe("swarm-feed:test-thread")

    const listedCommentsPageTwo = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments?sort=new&limit=2&cursor=${encodeURIComponent(listedCommentsBody.next_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedCommentsPageTwo.status).toBe(200)
    const listedCommentsPageTwoBody = await json(listedCommentsPageTwo) as {
      next_cursor: string | null
      items: Array<{ comment: { comment_id: string; direct_reply_count: number } }>
    }
    expect(listedCommentsPageTwoBody.items).toHaveLength(1)
    expect(listedCommentsPageTwoBody.items[0]?.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(listedCommentsPageTwoBody.items[0]?.comment.direct_reply_count).toBe(2)
    expect(listedCommentsPageTwoBody.next_cursor).toBeNull()

    const replies = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies?sort=new&limit=1`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(replies.status).toBe(200)
    const repliesBody = await json(replies) as {
      next_cursor: string | null
      thread_snapshot: {
        thread_root_post_id: string
        swarm_manifest_ref: string
      } | null
      items: Array<{ comment: { comment_id: string; parent_comment_id: string | null } }>
    }
    expect(repliesBody.items).toHaveLength(1)
    expect(repliesBody.items[0]?.comment.comment_id).toBe(secondReplyBody.comment_id)
    expect(repliesBody.items[0]?.comment.parent_comment_id).toBe(topLevelBody.comment_id)
    expect(typeof repliesBody.next_cursor).toBe("string")
    expect(repliesBody.thread_snapshot?.thread_root_post_id).toBe(postBody.post_id)
    expect(repliesBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:test-thread")

    const repliesPageTwo = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies?sort=new&limit=1&cursor=${encodeURIComponent(repliesBody.next_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(repliesPageTwo.status).toBe(200)
    const repliesPageTwoBody = await json(repliesPageTwo) as {
      next_cursor: string | null
      items: Array<{ comment: { comment_id: string; parent_comment_id: string | null } }>
    }
    expect(repliesPageTwoBody.items).toHaveLength(1)
    expect(repliesPageTwoBody.items[0]?.comment.comment_id).toBe(replyBody.comment_id)
    expect(repliesPageTwoBody.next_cursor).toBeNull()

    const context = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/context?limit=1`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(context.status).toBe(200)
    const contextBody = await json(context) as {
      next_replies_cursor: string | null
      thread_snapshot: {
        thread_root_post_id: string
        swarm_feed_ref: string | null
      } | null
      ancestors: Array<{ comment: { comment_id: string } }>
      comment: { comment: { comment_id: string } }
      replies: Array<{ comment: { comment_id: string } }>
    }
    expect(contextBody.ancestors).toHaveLength(0)
    expect(contextBody.comment.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(contextBody.replies).toHaveLength(1)
    expect(contextBody.replies[0]?.comment.comment_id).toBe(secondReplyBody.comment_id)
    expect(typeof contextBody.next_replies_cursor).toBe("string")
    expect(contextBody.thread_snapshot?.thread_root_post_id).toBe(postBody.post_id)
    expect(contextBody.thread_snapshot?.swarm_feed_ref).toBe("swarm-feed:test-thread")

    const contextPageTwo = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/context?limit=1&cursor=${encodeURIComponent(contextBody.next_replies_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(contextPageTwo.status).toBe(200)
    const contextPageTwoBody = await json(contextPageTwo) as {
      next_replies_cursor: string | null
      thread_snapshot: {
        swarm_manifest_ref: string
      } | null
      ancestors: Array<{ comment: { comment_id: string } }>
      comment: { comment: { comment_id: string } }
      replies: Array<{ comment: { comment_id: string } }>
    }
    expect(contextPageTwoBody.comment.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(contextPageTwoBody.replies).toHaveLength(1)
    expect(contextPageTwoBody.replies[0]?.comment.comment_id).toBe(replyBody.comment_id)
    expect(contextPageTwoBody.next_replies_cursor).toBeNull()
    expect(contextPageTwoBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:test-thread")
  })

  test("POST /comments/:commentId/vote enforces verification and records a verified member vote", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-vote-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Vote Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Vote on comment",
        body: "Vote body",
        idempotency_key: "comments-routes-post-vote-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const commentResponse = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Vote on me",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(commentResponse.status).toBe(201)
    const commentBody = await json(commentResponse) as { comment_id: string }

    const unverifiedMember = await exchangeJwt(ctx.env, "comments-routes-vote-unverified")
    await addCommunityMember(ctx.communityDbRoot, community.communityId, unverifiedMember.userId)

    const deniedVote = await requestJson(
      `http://pirate.test/comments/${commentBody.comment_id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(deniedVote.status).toBe(403)
    const deniedVoteBody = await json(deniedVote) as { code: string }
    expect(deniedVoteBody.code).toBe("verification_required")

    const verifiedMember = await exchangeJwt(ctx.env, "comments-routes-vote-verified")
    await completeUniqueHumanVerification(ctx.env, verifiedMember.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, verifiedMember.userId)

    const acceptedVote = await requestJson(
      `http://pirate.test/comments/${commentBody.comment_id}/vote`,
      { value: 1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(acceptedVote.status).toBe(200)
    const acceptedVoteBody = await json(acceptedVote) as { comment_id: string; value: number }
    expect(acceptedVoteBody.comment_id).toBe(commentBody.comment_id)
    expect(acceptedVoteBody.value).toBe(1)
  })
})
