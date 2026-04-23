import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeAgeOver18Verification,
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

describe("community settings routes", () => {
  test("community owner can persist and read a pending namespace verification session", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-pending-session-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pending Namespace Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
        pending_namespace_verification_session_id: string | null
      }
    }
    expect(communityCreateBody.community.pending_namespace_verification_session_id).toBeNull()

    const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "PendingAttachRoot",
    }, ctx.env, session.accessToken)
    expect(namespaceSession.status).toBe(201)
    const namespaceSessionBody = await json(namespaceSession) as {
      namespace_verification_session_id: string
    }

    const pendingUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pending-namespace-session`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          namespace_verification_session_id: namespaceSessionBody.namespace_verification_session_id,
        }),
      },
      ctx.env,
    ))
    expect(pendingUpdate.status).toBe(200)
    const updatedCommunity = await json(pendingUpdate) as {
      pending_namespace_verification_session_id: string | null
    }
    expect(updatedCommunity.pending_namespace_verification_session_id).toBe(
      namespaceSessionBody.namespace_verification_session_id,
    )

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      pending_namespace_verification_session_id: string | null
    }
    expect(fetchedBody.pending_namespace_verification_session_id).toBe(
      namespaceSessionBody.namespace_verification_session_id,
    )
  })

  test("community owner can reattach a newly verified session for the same namespace root", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-same-namespace-reattach-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Same Namespace Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const firstNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "SameNamespaceRoot",
    }, ctx.env, session.accessToken)
    const firstNamespaceSessionBody = await json(firstNamespaceSession) as {
      namespace_verification_session_id: string
    }
    const firstCompleted = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${firstNamespaceSessionBody.namespace_verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    const firstCompletedBody = await json(firstCompleted) as { namespace_verification_id: string }

    const firstAttach = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/namespace`,
      { namespace_verification_id: firstCompletedBody.namespace_verification_id },
      ctx.env,
      session.accessToken,
    )
    expect(firstAttach.status).toBe(200)

    const secondNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "SameNamespaceRoot",
    }, ctx.env, session.accessToken)
    const secondNamespaceSessionBody = await json(secondNamespaceSession) as {
      namespace_verification_session_id: string
    }
    const secondCompleted = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${secondNamespaceSessionBody.namespace_verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    const secondCompletedBody = await json(secondCompleted) as { namespace_verification_id: string }
    expect(secondCompletedBody.namespace_verification_id).not.toBe(firstCompletedBody.namespace_verification_id)

    const pendingUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/pending-namespace-session`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          namespace_verification_session_id: secondNamespaceSessionBody.namespace_verification_session_id,
        }),
      },
      ctx.env,
    ))
    expect(pendingUpdate.status).toBe(200)

    const secondAttach = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/namespace`,
      { namespace_verification_id: secondCompletedBody.namespace_verification_id },
      ctx.env,
      session.accessToken,
    )
    expect(secondAttach.status).toBe(200)
    const secondAttachBody = await json(secondAttach) as {
      namespace_verification_id: string | null
      pending_namespace_verification_session_id: string | null
      route_slug: string | null
    }
    expect(secondAttachBody.namespace_verification_id).toBe(firstCompletedBody.namespace_verification_id)
    expect(secondAttachBody.pending_namespace_verification_session_id).toBeNull()
    expect(secondAttachBody.route_slug).toBe("samenamespaceroot")
  })

  test("community owner can persist safety moderation settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-safety-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Safety Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const safetyUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/safety`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          adult_content_policy: {
            suggestive: "review",
            artistic_nudity: "allow",
            explicit_nudity: "disallow",
            explicit_sexual_content: "disallow",
            fetish_content: "review",
          },
          graphic_content_policy: {
            injury_medical: "allow",
            gore: "review",
            extreme_gore: "disallow",
            body_horror_disturbing: "review",
            animal_harm: "disallow",
          },
          civility_policy: {
            group_directed_demeaning_language: "review",
            targeted_insults: "review",
            targeted_harassment: "disallow",
            threatening_language: "disallow",
          },
          openai_moderation_settings: {
            scan_titles: true,
            scan_post_bodies: false,
            scan_captions: true,
            scan_link_preview_text: false,
            scan_images: true,
          },
        }),
      },
      ctx.env,
    ))
    expect(safetyUpdate.status).toBe(200)
    const updatedCommunity = await json(safetyUpdate) as {
      adult_content_policy: {
        artistic_nudity: string
        explicit_nudity: string
      }
      civility_policy: {
        threatening_language: string
      }
      openai_moderation_settings: {
        scan_post_bodies: boolean
        scan_images: boolean
      } | null
    }
    expect(updatedCommunity.adult_content_policy.artistic_nudity).toBe("allow")
    expect(updatedCommunity.adult_content_policy.explicit_nudity).toBe("disallow")
    expect(updatedCommunity.civility_policy.threatening_language).toBe("disallow")
    expect(updatedCommunity.openai_moderation_settings?.scan_post_bodies).toBe(false)
    expect(updatedCommunity.openai_moderation_settings?.scan_images).toBe(true)

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      adult_content_policy: {
        fetish_content: string
      }
      graphic_content_policy: {
        gore: string
      }
      openai_moderation_settings: {
        scan_link_preview_text: boolean
      } | null
    }
    expect(fetchedBody.adult_content_policy.fetish_content).toBe("review")
    expect(fetchedBody.graphic_content_policy.gore).toBe("review")
    expect(fetchedBody.openai_moderation_settings?.scan_link_preview_text).toBe(false)
  })

  test("community owner can persist membership gates settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Club",
      default_age_gate_policy: "18_plus",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gates`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: true,
          anonymous_identity_scope: "thread_stable",
          gate_rules: [
            {
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "F" },
                },
              ],
            },
          ],
        }),
      },
      ctx.env,
    ))
    expect(gatesUpdate.status).toBe(200)
    const updatedCommunity = await json(gatesUpdate) as {
      membership_mode: string
      default_age_gate_policy?: string | null
      allow_anonymous_identity: boolean
      anonymous_identity_scope?: string | null
      gate_rules?: Array<{
        gate_type: string
        proof_requirements?: Array<{
          config?: Record<string, unknown> | null
        }> | null
      }> | null
    }
    expect(updatedCommunity.membership_mode).toBe("gated")
    expect(updatedCommunity.default_age_gate_policy).toBe("18_plus")
    expect(updatedCommunity.allow_anonymous_identity).toBe(true)
    expect(updatedCommunity.anonymous_identity_scope).toBe("thread_stable")
    expect(updatedCommunity.gate_rules?.[0]?.gate_type).toBe("gender")
    expect(updatedCommunity.gate_rules?.[0]?.proof_requirements?.[0]?.config?.required_value).toBe("F")

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      membership_mode: string
      gate_rules?: Array<{
        gate_type: string
      }> | null
    }
    expect(fetchedBody.membership_mode).toBe("gated")
    expect(fetchedBody.gate_rules?.[0]?.gate_type).toBe("gender")
  })

  test("community owner preserves gate_rule_id across gates updates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-preserve-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Preserve Club",
      default_age_gate_policy: "18_plus",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const firstUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gates`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_rules: [
            {
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "F" },
                },
              ],
            },
          ],
        }),
      },
      ctx.env,
    ))
    expect(firstUpdate.status).toBe(200)
    const firstUpdateBody = await json(firstUpdate) as {
      gate_rules?: Array<{
        gate_rule_id: string
        gate_type: string
      }> | null
    }
    const originalGateRuleId = firstUpdateBody.gate_rules?.[0]?.gate_rule_id
    expect(typeof originalGateRuleId).toBe("string")

    const secondUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gates`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_rules: [
            {
              gate_rule_id: originalGateRuleId,
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "M" },
                },
              ],
            },
          ],
        }),
      },
      ctx.env,
    ))
    expect(secondUpdate.status).toBe(200)
    const secondUpdateBody = await json(secondUpdate) as {
      gate_rules?: Array<{
        gate_rule_id: string
        gate_type: string
        proof_requirements?: Array<{
          config?: Record<string, unknown> | null
        }> | null
      }> | null
    }
    expect(secondUpdateBody.gate_rules?.[0]?.gate_rule_id).toBe(originalGateRuleId)
    expect(secondUpdateBody.gate_rules?.[0]?.proof_requirements?.[0]?.config?.required_value).toBe("M")
  })

  test("community gates update rejects duplicate or blank gate_rule_id payloads", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-invalid-id-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Invalid Id Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const duplicateIds = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gates`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_rules: [
            {
              gate_rule_id: "grl_duplicate",
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "F" },
                },
              ],
            },
            {
              gate_rule_id: "grl_duplicate",
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "nationality",
              proof_requirements: [
                {
                  proof_type: "nationality",
                  accepted_providers: ["self"],
                  config: { required_value: "US" },
                },
              ],
            },
          ],
        }),
      },
      ctx.env,
    ))
    expect(duplicateIds.status).toBe(400)

    const blankId = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gates`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_rules: [
            {
              gate_rule_id: "   ",
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "F" },
                },
              ],
            },
          ],
        }),
      },
      ctx.env,
    ))
    expect(blankId.status).toBe(400)
  })

  test("community gates update rejects duplicate same-type identity gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-duplicate-type-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Duplicate Type Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const duplicateGenderGates = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/gates`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_rules: [
            {
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "F" },
                },
              ],
            },
            {
              scope: "membership",
              gate_family: "identity_proof",
              gate_type: "gender",
              proof_requirements: [
                {
                  proof_type: "gender",
                  accepted_providers: ["self"],
                  config: { required_value: "M" },
                },
              ],
            },
          ],
        }),
      },
      ctx.env,
    ))
    expect(duplicateGenderGates.status).toBe(403)
  })

  test("community owner can persist agent moderation settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-agent-policy-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Agents Club",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const agentUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          agent_posting_policy: "allow",
          agent_posting_scope: "top_level_and_replies",
          agent_daily_post_cap: 5,
          agent_daily_reply_cap: 20,
          human_verification_lane: "very",
          accepted_agent_ownership_providers: ["clawkey"],
        }),
      },
      ctx.env,
    ))
    expect(agentUpdate.status).toBe(200)
    const updatedCommunity = await json(agentUpdate) as {
      agent_posting_policy: string
      agent_posting_scope: string
      agent_daily_post_cap: number | null
      agent_daily_reply_cap: number | null
      human_verification_lane: string
      human_verification_lane_origin: string
      accepted_agent_ownership_providers: string[]
      accepted_agent_ownership_providers_origin: string
    }
    expect(updatedCommunity.agent_posting_policy).toBe("allow")
    expect(updatedCommunity.agent_posting_scope).toBe("top_level_and_replies")
    expect(updatedCommunity.agent_daily_post_cap).toBe(5)
    expect(updatedCommunity.agent_daily_reply_cap).toBe(20)
    expect(updatedCommunity.human_verification_lane).toBe("very")
    expect(updatedCommunity.human_verification_lane_origin).toBe("explicit")
    expect(updatedCommunity.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(updatedCommunity.accepted_agent_ownership_providers_origin).toBe("explicit")

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      agent_posting_policy: string
      agent_posting_scope: string
      agent_daily_post_cap: number | null
      agent_daily_reply_cap: number | null
      human_verification_lane: string
      human_verification_lane_origin: string
      accepted_agent_ownership_providers: string[]
      accepted_agent_ownership_providers_origin: string
    }
    expect(fetchedBody.agent_posting_policy).toBe("allow")
    expect(fetchedBody.agent_posting_scope).toBe("top_level_and_replies")
    expect(fetchedBody.agent_daily_post_cap).toBe(5)
    expect(fetchedBody.agent_daily_reply_cap).toBe(20)
    expect(fetchedBody.human_verification_lane).toBe("very")
    expect(fetchedBody.human_verification_lane_origin).toBe("explicit")
    expect(fetchedBody.accepted_agent_ownership_providers).toEqual(["clawkey"])
    expect(fetchedBody.accepted_agent_ownership_providers_origin).toBe("explicit")
  })

  test("community owner can persist profile fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-profile-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Old Name",
      description: "Old description",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        community_id: string
      }
    }

    const profileUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          display_name: "New Name",
          description: "New description",
          avatar_ref: "media://community-avatar",
          banner_ref: "media://community-banner",
        }),
      },
      ctx.env,
    ))
    expect(profileUpdate.status).toBe(200)
    const updatedCommunity = await json(profileUpdate) as {
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
    }
    expect(updatedCommunity.display_name).toBe("New Name")
    expect(updatedCommunity.description).toBe("New description")
    expect(updatedCommunity.avatar_ref).toBe("media://community-avatar")
    expect(updatedCommunity.banner_ref).toBe("media://community-banner")

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedCommunity.status).toBe(200)
    const fetchedBody = await json(fetchedCommunity) as {
      display_name: string
      description: string | null
      avatar_ref: string | null
      banner_ref: string | null
    }
    expect(fetchedBody.display_name).toBe("New Name")
    expect(fetchedBody.description).toBe("New description")
    expect(fetchedBody.avatar_ref).toBe("media://community-avatar")
    expect(fetchedBody.banner_ref).toBe("media://community-banner")
  })
})
