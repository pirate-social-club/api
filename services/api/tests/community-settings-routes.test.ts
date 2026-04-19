import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
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
})
