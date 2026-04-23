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

describe("community settings gates routes", () => {
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

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE community_id = ?1 AND action = 'community.gates_updated'
      `,
      args: [communityCreateBody.community.community_id],
    })
    expect(auditRows.rows).toHaveLength(1)
    expect(auditRows.rows[0]?.actor_type).toBe("user")
    expect(auditRows.rows[0]?.actor_id).toBe(session.userId)
    expect(auditRows.rows[0]?.target_type).toBe("community")
    expect(auditRows.rows[0]?.target_id).toBe(communityCreateBody.community.community_id)
    const auditMetadata = JSON.parse(String(auditRows.rows[0]?.metadata_json)) as {
      previous_access: {
        membership_mode: string
        default_age_gate_policy: string | null
      }
      next_access: {
        membership_mode: string
        default_age_gate_policy: string
        allow_anonymous_identity: boolean
        anonymous_identity_scope: string | null
      }
      previous_gate_rules: unknown[]
      next_gate_rules: Array<{
        gate_type: string
        proof_requirements?: Array<{
          config?: Record<string, unknown> | null
        }> | null
      }>
    }
    expect(auditMetadata.previous_access.membership_mode).toBe("open")
    expect(auditMetadata.previous_access.default_age_gate_policy).toBe("18_plus")
    expect(auditMetadata.next_access).toEqual({
      membership_mode: "gated",
      default_age_gate_policy: "18_plus",
      allow_anonymous_identity: true,
      anonymous_identity_scope: "thread_stable",
    })
    expect(auditMetadata.previous_gate_rules).toEqual([])
    expect(auditMetadata.next_gate_rules[0]?.gate_type).toBe("gender")
    expect(auditMetadata.next_gate_rules[0]?.proof_requirements?.[0]?.config?.required_value).toBe("F")

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

  test("community gates update rejects changing a normal community to 18_plus", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-late-adult-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Late Adult Gate Club",
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
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_rules: [],
        }),
      },
      ctx.env,
    ))
    expect(gatesUpdate.status).toBe(403)
    const body = await json(gatesUpdate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("18_plus can only be set during community creation")
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
