import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"
import {
  createSelfVerifiedSession,
  withFetchMock,
} from "../verification/verification-test-helpers"

const ADMIN_TOKEN = "test-admin-token-abc123"

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

describe("admin auth middleware", () => {
  test("admin token can validate against admin health route", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const actingSession = await exchangeJwt(ctx.env, "admin-health-actor")

    const health = await Promise.resolve(app.request(
      "http://pirate.test/communities/admin/health",
      {
        method: "GET",
        headers: {
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingSession.userId,
        },
      },
      ctx.env,
    ))
    expect(health.status).toBe(200)
    const healthBody = await json(health) as {
      ok: boolean
      mode: string
      acting_user_id: string
    }
    expect(healthBody.ok).toBe(true)
    expect(healthBody.mode).toBe("admin")
    expect(healthBody.acting_user_id).toBe(actingSession.userId)
  })

  test("admin token can update community settings without being the owner", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-test-community-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Admin Test Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const otherSession = await exchangeJwt(ctx.env, "admin-test-acting-user")
    const actingUserId = otherSession.userId

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({
          rules: [
            { title: "Be respectful", body: "Treat others with respect", report_reason: "Be respectful", status: "active" },
          ],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(200)
    const rulesBody = await json(rulesUpdate) as {
      id: string
    }
    expect(rulesBody.id).toBe(`com_${communityId}`)

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE community_id = ?1 AND action = 'community.rules_updated'
      `,
      args: [communityId],
    })
    expect(auditRows.rows).toHaveLength(1)
    const auditRow = auditRows.rows[0]!
    expect(auditRow.actor_type).toBe("operator")
    expect(auditRow.actor_id).toBe("admin-token")
    const metadata = JSON.parse(String(auditRow.metadata_json)) as {
      scope: string
      acting_user_id: string
      owner_user_id: string
    }
    expect(metadata.scope).toBe("full")
    expect(metadata.acting_user_id).toBe(actingUserId)
    expect(metadata.owner_user_id).toBe(ownerSession.userId)
  })

  test("admin token can set gates on another users community", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-gates-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Admin Gates Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const otherSession = await exchangeJwt(ctx.env, "admin-gates-actor")
    const actingUserId = otherSession.userId

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          gate_policy: {
            version: 1,
            expression: {
              op: "gate",
              gate: {
                type: "unique_human",
                provider: "self",
              },
            },
          },
        }),
      },
      ctx.env,
    ))
    expect(gatesUpdate.status).toBe(200)
    const gatesBody = await json(gatesUpdate) as {
      membership_mode: string
      gate_policy?: { expression?: { gate?: { type?: string } } } | null
    }
    expect(gatesBody.membership_mode).toBe("gated")
    expect(gatesBody.gate_policy?.expression?.gate?.type).toBe("unique_human")
  })

  test("admin token can create seed posts on another users community", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-seed-post-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Admin Seed Post Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const otherSession = await exchangeJwt(ctx.env, "admin-seed-post-actor")
    const actingUserId = otherSession.userId

    const seedPost = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
          "x-admin-operation-class": "launch_seed",
        },
        body: JSON.stringify({
          post_type: "text",
          identity_mode: "public",
          idempotency_key: "admin-test-seed-001",
          title: "Welcome",
          body: "Welcome to the community!",
        }),
      },
      ctx.env,
    ))
    expect(seedPost.status === 201 || seedPost.status === 202).toBe(true)
    const postBody = await json(seedPost) as {
      id: string
      status: string
    }
    expect(postBody.id).toBeTruthy()

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, metadata_json
        FROM audit_log
        WHERE action = 'community.seed_post_created'
      `,
      args: [],
    })
    expect(auditRows.rows).toHaveLength(1)
    const auditRow = auditRows.rows[0]!
    expect(auditRow.actor_type).toBe("operator")
    expect(auditRow.actor_id).toBe("admin-token")
    const metadata = JSON.parse(String(auditRow.metadata_json)) as {
      operation_class: string
      acting_user_id: string
      idempotency_key: string
    }
    expect(metadata.operation_class).toBe("launch_seed")
    expect(metadata.acting_user_id).toBe(actingUserId)
    expect(metadata.idempotency_key).toBe("admin-test-seed-001")

    const seedComment = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
          "x-admin-operation-class": "launch_seed",
        },
        body: JSON.stringify({
          idempotency_key: "admin-test-seed-comment-001",
          body: "Glad to be here.",
          identity_mode: "public",
        }),
      },
      ctx.env,
    ))
    expect(seedComment.status).toBe(201)
    const commentBody = await json(seedComment) as { id: string }
    expect(commentBody.id).toBeTruthy()
    const duplicateSeedComment = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
          "x-admin-operation-class": "launch_seed",
        },
        body: JSON.stringify({
          idempotency_key: "admin-test-seed-comment-001",
          body: "Glad to be here.",
          identity_mode: "public",
        }),
      },
      ctx.env,
    ))
    expect(duplicateSeedComment.status).toBe(201)
    const duplicateCommentBody = await json(duplicateSeedComment) as { id: string }
    expect(duplicateCommentBody.id).toBe(commentBody.id)

    const commentAuditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, metadata_json
        FROM audit_log
        WHERE action = 'community.seed_comment_created'
      `,
      args: [],
    })
    expect(commentAuditRows.rows).toHaveLength(2)

    const postVote = await Promise.resolve(app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    ))
    expect(postVote.status).toBe(200)
    const postVoteAuditRows = await ctx.client.execute({
      sql: `
        SELECT action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE action = 'community.admin_post_vote_cast'
      `,
      args: [],
    })
    expect(postVoteAuditRows.rows).toHaveLength(1)

    const commentVote = await Promise.resolve(app.request(
      `http://pirate.test/comments/${commentBody.id}/vote`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    ))
    expect(commentVote.status).toBe(200)
    const commentVoteAuditRows = await ctx.client.execute({
      sql: `
        SELECT action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE action = 'community.admin_comment_vote_cast'
      `,
      args: [],
    })
    expect(commentVoteAuditRows.rows).toHaveLength(1)

    const profileUpdate = await Promise.resolve(app.request(
      "http://pirate.test/profiles/me",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({ display_name: "Seed Operator" }),
      },
      ctx.env,
    ))
    expect(profileUpdate.status).toBe(200)
    const profileAuditRows = await ctx.client.execute({
      sql: `
        SELECT action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE action = 'community.admin_profile_updated'
      `,
      args: [],
    })
    expect(profileAuditRows.rows).toHaveLength(1)
  })

  test("wrong admin token is rejected", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-wrong-token-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Wrong Token Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "wrong-token",
          "x-admin-as-user-id": ownerSession.userId,
        },
        body: JSON.stringify({
          rules: [{ title: "Test", body: "Test", report_reason: "Test", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(401)
  })

  test("admin token can start and read namespace verification for the acting user", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    })
    cleanup = ctx.cleanup

    const actingSession = await exchangeJwt(ctx.env, "admin-namespace-actor")
    await createSelfVerifiedSession(ctx.env, actingSession.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test") && url.includes("/inspect-public?")) {
        return new Response(JSON.stringify({
          zone_exists: false,
          challenge_present: false,
          nameservers: ["ns1.pirate.sc."],
          observation_provider: "web3dns_json_doh",
          failure_reason: "zone_not_provisioned",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input, init)
    }, async () => {
      const created = await Promise.resolve(app.request(
        "http://pirate.test/namespace-verification-sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": ADMIN_TOKEN,
            "x-admin-as-user-id": actingSession.userId,
          },
          body: JSON.stringify({
            family: "hns",
            root_label: "AdminVerifierRoot",
          }),
        },
        ctx.env,
      ))
      expect(created.status).toBe(201)
      const createdBody = await json(created) as {
        id: string
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
        setup_nameservers: string[] | null
      }
      expect(createdBody.status).toBe("challenge_required")
      expect(createdBody.challenge_host).toBe("adminverifierroot")
      expect(typeof createdBody.challenge_txt_value).toBe("string")
      expect(createdBody.setup_nameservers).toEqual(["ns1.pirate.sc."])

      const fetched = await Promise.resolve(app.request(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}`,
        {
          method: "GET",
          headers: {
            "x-admin-token": ADMIN_TOKEN,
            "x-admin-as-user-id": actingSession.userId,
          },
        },
        ctx.env,
      ))
      expect(fetched.status).toBe(200)
      const fetchedBody = await json(fetched) as {
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
        setup_nameservers: string[] | null
      }
      expect(fetchedBody.status).toBe("challenge_required")
      expect(fetchedBody.challenge_host).toBe("adminverifierroot")
      expect(fetchedBody.challenge_txt_value).toBe(createdBody.challenge_txt_value)
      expect(fetchedBody.setup_nameservers).toEqual(["ns1.pirate.sc."])
    })
  })

  test("admin token without as-user-id is rejected", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-no-user-id-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No User ID Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
        },
        body: JSON.stringify({
          rules: [{ title: "Test", body: "Test", report_reason: "Test", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(401)
  })

  test("non-owner without admin token cannot update settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-non-owner-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Non Owner Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const strangerSession = await exchangeJwt(ctx.env, "admin-non-owner-stranger")

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${strangerSession.accessToken}`,
        },
        body: JSON.stringify({
          rules: [{ title: "Hacked", body: "Hacked", report_reason: "Hacked", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(404)
  })

  test("admin token is ignored when PIRATE_ADMIN_TOKEN is not configured", async () => {
    const ctx = await createRouteTestContext({})
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-no-config-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No Config Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "any-token",
          "x-admin-as-user-id": ownerSession.userId,
        },
        body: JSON.stringify({
          rules: [{ title: "Test", body: "Test", report_reason: "Test", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(401)
  })
})
