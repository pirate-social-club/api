import { sign as signWithPrivateKey } from "node:crypto"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  canonicalizeAgentActionProofSignaturePayload,
  computeAgentActionProofHash,
} from "../../../src/lib/agents/agent-action-proof"
import { setClawkeyProviderForTests } from "../../../src/lib/agents/clawkey-provider"
import { setSelfProviderForTests } from "../../../src/lib/verification/self-provider"
import { buildVerifiedSelfProvider, createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { createSignedAgentChallenge } from "../../agent-test-helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  prepareVerifiedNamespace,
  requestJson,
  updateLocalCommunityAgentPostingPolicy,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setSelfProviderForTests(buildVerifiedSelfProvider("self-community-agent-post-test-ref"))
})

afterEach(async () => {
  setClawkeyProviderForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("community agent post routes", () => {
  test("community post create accepts a verified user-owned agent post and rejects nonce replay", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-agent-post-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Agent Posting Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    const member = await exchangeJwt(ctx.env, "community-agent-post-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), member.userId)
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
        ) VALUES ('lnk_agent_post_owner_ens', ?1, NULL, 'ens', 'communityagent.eth', 'communityagent.eth', 'verified', '{}', ?2, ?2)
      `,
      args: [member.userId, "2026-04-19T12:30:00.000Z"],
    })
    await ctx.client.execute({
      sql: `
        UPDATE profiles
        SET primary_linked_handle_id = 'lnk_agent_post_owner_ens',
            updated_at = ?2
        WHERE user_id = ?1
      `,
      args: [member.userId, "2026-04-19T12:30:00.000Z"],
    })

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500001000",
      deviceId: "claw-device-agent-post",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_posting_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_posting_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-agent-post",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Captain Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
      resolved_agent_ownership_record_id: string
    }

    const createUrl = `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`
    const createPayload = {
      post_type: "text" as const,
      title: "Captain Bot says hi",
      body: "Ships are clear.",
      idempotency_key: "agent-post-key-1",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const canonicalRequestHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: createPayload,
    })
    const nonce = "nonce-agent-post-1"
    const signedAt = new Date().toISOString()
    const signature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce,
        signedAt,
        canonicalRequestHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const createdPost = await requestJson(
      createUrl,
      {
        ...createPayload,
        agent_action_proof: {
          nonce,
          signed_at: signedAt,
          canonical_request_hash: canonicalRequestHash,
          signature,
        },
      },
      ctx.env,
      member.accessToken,
    )

    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as {
      id: string
      author_user: string | null
      authorship_mode: string
      agent: string | null
      agent_ownership_record: string | null
      agent_handle_snapshot: string | null
      agent_display_name_snapshot: string | null
      agent_owner_handle_snapshot: string | null
      agent_ownership_provider_snapshot: string | null
    }
    expect(createdPostBody.author_user).toBe(`usr_${member.userId}`)
    expect(createdPostBody.authorship_mode).toBe("user_agent")
    expect(createdPostBody.agent).toBe(`agt_${ownershipCompleteBody.agent_id}`)
    expect(createdPostBody.agent_ownership_record).toBe(`aor_${ownershipCompleteBody.resolved_agent_ownership_record_id}`)
    expect(createdPostBody.agent_handle_snapshot).toBe("captain-bot.clawitzer")
    expect(createdPostBody.agent_display_name_snapshot).toBe("Captain Bot")
    expect(createdPostBody.agent_owner_handle_snapshot).toBe("communityagent.eth")
    expect(createdPostBody.agent_ownership_provider_snapshot).toBe("clawkey")

    const replayPayload = {
      ...createPayload,
      idempotency_key: "agent-post-key-2",
      title: "Captain Bot says hi again",
    }
    const replayHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: replayPayload,
    })
    const replaySignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce,
        signedAt,
        canonicalRequestHash: replayHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const replayAttempt = await requestJson(
      createUrl,
      {
        ...replayPayload,
        agent_action_proof: {
          nonce,
          signed_at: signedAt,
          canonical_request_hash: replayHash,
          signature: replaySignature,
        },
      },
      ctx.env,
      member.accessToken,
    )

    expect(replayAttempt.status).toBe(409)
    const replayBody = await json(replayAttempt) as { code: string; message: string }
    expect(replayBody.code).toBe("conflict")
    expect(replayBody.message).toContain("nonce")
  })

  test("delegated agent access tokens can create top-level posts", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-delegated-agent-post-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Delegated Agent Posting Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    const member = await exchangeJwt(ctx.env, "community-delegated-agent-post-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), member.userId)

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500000400",
      deviceId: "claw-device-delegated-post",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_delegated_post_123",
        registrationUrl: "https://clawkey.test/register/cks_delegated_post_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-delegated-post",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Delegated Captain Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipStartBody.agent_ownership_session_id}/complete`,
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

    const createUrl = `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`
    const createPayload = {
      post_type: "text" as const,
      title: "Delegated Captain Bot says hi",
      body: "Ships are still clear.",
      idempotency_key: "delegated-agent-post-key-1",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const canonicalRequestHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: createPayload,
    })
    const signedAt = new Date().toISOString()
    const signature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "delegated-agent-post-nonce-1",
        signedAt,
        canonicalRequestHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const createdPost = await requestJson(
      createUrl,
      {
        ...createPayload,
        agent_action_proof: {
          nonce: "delegated-agent-post-nonce-1",
          signed_at: signedAt,
          canonical_request_hash: canonicalRequestHash,
          signature,
        },
      },
      ctx.env,
      issueBody.access_token,
    )

    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as {
      authorship_mode: string
      agent: string | null
    }
    expect(createdPostBody.authorship_mode).toBe("user_agent")
    expect(createdPostBody.agent).toBe(`agt_${ownershipCompleteBody.agent_id}`)
  })

  test("community post create derives clawkey acceptance from the very lane and enforces the daily agent post cap", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-derived-agent-post-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Derived Agent Posting Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      humanVerificationLane: "very",
      agentDailyPostCap: 1,
    })

    const member = await exchangeJwt(ctx.env, "community-derived-agent-post-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), member.userId)

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500001100",
      deviceId: "claw-device-derived-post",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_derived_agent_post_123",
        registrationUrl: "https://clawkey.test/register/cks_derived_agent_post_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-derived-post",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Derived Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
    }

    const createUrl = `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`
    const firstPayload = {
      post_type: "text" as const,
      title: "Derived Bot first post",
      body: "This should pass with derived very-lane acceptance.",
      idempotency_key: "derived-agent-post-key-1",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const firstHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: firstPayload,
    })
    const firstSignedAt = new Date().toISOString()
    const firstSignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "derived-agent-post-nonce-1",
        signedAt: firstSignedAt,
        canonicalRequestHash: firstHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const firstPost = await requestJson(
      createUrl,
      {
        ...firstPayload,
        agent_action_proof: {
          nonce: "derived-agent-post-nonce-1",
          signed_at: firstSignedAt,
          canonical_request_hash: firstHash,
          signature: firstSignature,
        },
      },
      ctx.env,
      member.accessToken,
    )
    expect(firstPost.status).toBe(201)

    const secondPayload = {
      ...firstPayload,
      idempotency_key: "derived-agent-post-key-2",
      title: "Derived Bot second post",
      body: "This should hit the daily cap.",
    }
    const secondHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: secondPayload,
    })
    const secondSignedAt = new Date().toISOString()
    const secondSignature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "derived-agent-post-nonce-2",
        signedAt: secondSignedAt,
        canonicalRequestHash: secondHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const secondPost = await requestJson(
      createUrl,
      {
        ...secondPayload,
        agent_action_proof: {
          nonce: "derived-agent-post-nonce-2",
          signed_at: secondSignedAt,
          canonical_request_hash: secondHash,
          signature: secondSignature,
        },
      },
      ctx.env,
      member.accessToken,
    )
    expect(secondPost.status).toBe(403)
    const secondPostBody = await json(secondPost) as { code: string; message: string }
    expect(secondPostBody.code).toBe("eligibility_failed")
    expect(secondPostBody.message).toContain("daily user-owned agent post limit")
  })

  test("community post create rejects derived very-lane agent writes when the platform KYA allowlist is explicitly empty", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
      PLATFORM_APPROVED_KYA_PROVIDERS: "",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-empty-kya-allowlist-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Empty KYA Allowlist Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      humanVerificationLane: "very",
    })

    const member = await exchangeJwt(ctx.env, "community-empty-kya-allowlist-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), member.userId)

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500001200",
      deviceId: "claw-device-empty-allowlist",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_empty_kya_allowlist_123",
        registrationUrl: "https://clawkey.test/register/cks_empty_kya_allowlist_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-empty-allowlist",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "No Allowlist Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
    }

    const createUrl = `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`
    const createPayload = {
      post_type: "text" as const,
      title: "No Allowlist Bot says hi",
      body: "This should fail because the configured allowlist is empty.",
      idempotency_key: "empty-kya-allowlist-post-key-1",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const canonicalRequestHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: createPayload,
    })
    const signedAt = new Date().toISOString()
    const signature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: "empty-kya-allowlist-nonce-1",
        signedAt,
        canonicalRequestHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const createdPost = await requestJson(
      createUrl,
      {
        ...createPayload,
        agent_action_proof: {
          nonce: "empty-kya-allowlist-nonce-1",
          signed_at: signedAt,
          canonical_request_hash: canonicalRequestHash,
          signature,
        },
      },
      ctx.env,
      member.accessToken,
    )
    expect(createdPost.status).toBe(403)
    const createdPostBody = await json(createdPost) as { code: string; message: string }
    expect(createdPostBody.code).toBe("eligibility_failed")
    expect(createdPostBody.message).toContain("does not currently accept any available agent ownership provider")
  })

  test("community post create rejects a future-dated agent action proof", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "community-agent-future-proof-owner")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, owner.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Future Proof Club",
membership_mode: "request",
      namespace: {
        namespace_verification: namespaceVerificationId,
      },
    }, ctx.env, owner.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    await updateLocalCommunityAgentPostingPolicy({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.id.replace(/^com_/, ""),
      agentPostingPolicy: "allow",
      agentPostingScope: "top_level_and_replies",
      acceptedAgentOwnershipProviders: ["clawkey"],
    })

    const member = await exchangeJwt(ctx.env, "community-agent-future-proof-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.id.replace(/^com_/, ""), member.userId)

    const registerChallenge = createSignedAgentChallenge({
      message: "clawkey-register-1738500001300",
      deviceId: "claw-device-future-proof",
    })
    const { privateKey } = registerChallenge

    setClawkeyProviderForTests({
      startRegistration: async () => ({
        sessionId: "cks_agent_future_proof_123",
        registrationUrl: "https://clawkey.test/register/cks_agent_future_proof_123",
        expiresAt: "2036-04-20T12:00:00.000Z",
      }),
      getRegistrationStatus: async () => ({
        status: "completed",
        deviceId: "claw-device-future-proof",
        publicKey: null,
        registeredAt: "2026-04-19T12:00:00.000Z",
      }),
    })

    const ownershipStart = await requestJson("http://pirate.test/agent-ownership-sessions", {
      session_kind: "register",
      ownership_provider: "clawkey",
      display_name: "Future Bot",
      agent_challenge: registerChallenge.challenge,
    }, ctx.env, member.accessToken)
    expect(ownershipStart.status).toBe(201)
    const ownershipStartBody = await json(ownershipStart) as {
      agent_ownership_session_id: string
    }

    const ownershipComplete = await requestJson(
      `http://pirate.test/agent-ownership-sessions/aos_${ownershipStartBody.agent_ownership_session_id}/complete`,
      {},
      ctx.env,
      member.accessToken,
    )
    expect(ownershipComplete.status).toBe(200)
    const ownershipCompleteBody = await json(ownershipComplete) as {
      agent_id: string
    }

    const createUrl = `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/posts`
    const createPayload = {
      post_type: "text" as const,
      title: "Future Bot says hi",
      body: "This should fail on freshness.",
      idempotency_key: "agent-post-future-key-1",
      authorship_mode: "user_agent" as const,
      agent_id: ownershipCompleteBody.agent_id,
    }
    const canonicalRequestHash = await computeAgentActionProofHash({
      method: "POST",
      url: createUrl,
      body: createPayload,
    })
    const nonce = "nonce-agent-future-1"
    const signedAt = new Date(Date.now() + 2 * 60 * 1000).toISOString()
    const signature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce,
        signedAt,
        canonicalRequestHash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    const createdPost = await requestJson(
      createUrl,
      {
        ...createPayload,
        agent_action_proof: {
          nonce,
          signed_at: signedAt,
          canonical_request_hash: canonicalRequestHash,
          signature,
        },
      },
      ctx.env,
      member.accessToken,
    )

    expect(createdPost.status).toBe(400)
    const createdPostBody = await json(createdPost) as { code: string; message: string }
    expect(createdPostBody.code).toBe("bad_request")
    expect(createdPostBody.message).toContain("freshness window")
  })
})
