import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setErc721ContractSupportCheckerForTests } from "../../../src/lib/communities/community-token-gates"
import {
  completeAgeOver18Verification,
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

function genderGatePolicy(marker: "F" | "M"): Record<string, unknown> {
  return {
    version: 1,
    expression: {
      op: "gate",
      gate: {
        type: "gender",
        provider: "self",
        allowed: [marker],
      },
    },
  }
}

function erc721GatePolicy(contractAddress = "0x1111111111111111111111111111111111111111"): Record<string, unknown> {
  return {
    version: 1,
    expression: {
      op: "gate",
      gate: {
        type: "erc721_holding",
        chain_namespace: "eip155:1",
        contract_address: contractAddress,
      },
    },
  }
}

function createdCommunityId(body: { community: { id?: string; community_id?: string } }): string {
  return body.community.community_id ?? body.community.id?.replace(/^com_/, "") ?? ""
}

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  setErc721ContractSupportCheckerForTests(null)
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

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Club",
      default_age_gate_policy: "none",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id?: string
        community_id?: string
      }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
          method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: true,
          anonymous_identity_scope: "thread_stable",
          gate_policy: genderGatePolicy("F"),
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
      gate_policy?: {
        expression?: { gate?: { type?: string; allowed?: string[] } }
      } | null
    }
    expect(updatedCommunity.membership_mode).toBe("gated")
    expect(updatedCommunity.default_age_gate_policy).toBe("none")
    expect(updatedCommunity.allow_anonymous_identity).toBe(true)
    expect(updatedCommunity.anonymous_identity_scope).toBe("thread_stable")
    expect(updatedCommunity.gate_policy?.expression?.gate?.type).toBe("gender")
    expect(updatedCommunity.gate_policy?.expression?.gate?.allowed).toEqual(["F"])

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE community_id = ?1 AND action = 'community.gates_updated'
      `,
      args: [communityId],
    })
    expect(auditRows.rows).toHaveLength(1)
    expect(auditRows.rows[0]?.actor_type).toBe("user")
    expect(auditRows.rows[0]?.actor_id).toBe(session.userId)
    expect(auditRows.rows[0]?.target_type).toBe("community")
    expect(auditRows.rows[0]?.target_id).toBe(communityId)
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
      previous_gate_policy: unknown | null
      next_gate_policy: {
        expression?: { gate?: { type?: string; allowed?: string[] } }
      } | null
    }
    expect(auditMetadata.previous_access.membership_mode).toBe("request")
    expect(auditMetadata.previous_access.default_age_gate_policy).toBe("none")
    expect(auditMetadata.next_access).toEqual({
      membership_mode: "gated",
      default_age_gate_policy: "none",
      allow_anonymous_identity: true,
      anonymous_identity_scope: "thread_stable",
    })
    expect(auditMetadata.previous_gate_policy).toBeNull()
    expect(auditMetadata.next_gate_policy?.expression?.gate?.type).toBe("gender")
    expect(auditMetadata.next_gate_policy?.expression?.gate?.allowed).toEqual(["F"])

    const fetchedCommunity = await app.request(
      `http://pirate.test/communities/${communityId}`,
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
      gate_policy?: {
        expression?: { gate?: { type?: string } }
      } | null
    }
    expect(fetchedBody.membership_mode).toBe("gated")
    expect(fetchedBody.gate_policy?.expression?.gate?.type).toBe("gender")
  })

  test("community owner can replace the membership gate policy", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-preserve-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Preserve Club",
      default_age_gate_policy: "none",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id?: string
        community_id?: string
      }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const firstUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("F"),
        }),
      },
      ctx.env,
    ))
    expect(firstUpdate.status).toBe(200)
    const firstUpdateBody = await json(firstUpdate) as {
      gate_policy?: {
        expression?: { gate?: { type?: string; allowed?: string[] } }
      } | null
    }
    expect(firstUpdateBody.gate_policy?.expression?.gate?.type).toBe("gender")
    expect(firstUpdateBody.gate_policy?.expression?.gate?.allowed).toEqual(["F"])

    const secondUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("M"),
        }),
      },
      ctx.env,
    ))
    expect(secondUpdate.status).toBe(200)
    const secondUpdateBody = await json(secondUpdate) as {
      gate_policy?: {
        expression?: { gate?: { type?: string; allowed?: string[] } }
      } | null
    }
    expect(secondUpdateBody.gate_policy?.expression?.gate?.type).toBe("gender")
    expect(secondUpdateBody.gate_policy?.expression?.gate?.allowed).toEqual(["M"])
  })

  test("community gates update rejects changing a normal community to 18_plus", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-late-adult-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Late Adult Gate Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id?: string
        community_id?: string
      }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "18_plus",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: genderGatePolicy("F"),
        }),
      },
      ctx.env,
    ))
    expect(gatesUpdate.status).toBe(403)
    const body = await json(gatesUpdate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("18_plus can only be set during community creation")
  })

  test("community gates update accepts and/or policies and rejects malformed atoms", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-invalid-id-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Invalid Id Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id?: string
        community_id?: string
      }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const andPolicy = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: {
            version: 1,
            expression: {
              op: "and",
              children: [
                { op: "gate", gate: { type: "gender", provider: "self", allowed: ["F"] } },
                { op: "gate", gate: { type: "nationality", provider: "self", allowed: ["US"] } },
              ],
            },
          },
        }),
      },
      ctx.env,
    ))
    expect(andPolicy.status).toBe(200)

    const malformedAtom = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: {
            version: 1,
            expression: {
              op: "gate",
              gate: { type: "gender", provider: "self", allowed: ["X"] },
            },
          },
        }),
      },
      ctx.env,
    ))
    expect(malformedAtom.status).toBe(403)
  })

  test("community gates update rejects ERC-721 contracts that fail ERC-165 validation", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    setErc721ContractSupportCheckerForTests(async () => false)

    const session = await exchangeJwt(ctx.env, "community-gates-erc165-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "ERC165 Gates Club",
      default_age_gate_policy: "none",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id?: string
        community_id?: string
      }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          gate_policy: erc721GatePolicy(),
        }),
      },
      ctx.env,
    ))

    expect(gatesUpdate.status).toBe(403)
    const body = await json(gatesUpdate) as { code: string; message: string }
    expect(body.code).toBe("eligibility_failed")
    expect(body.message).toBe("erc721_holding gate contract must support ERC-721")
  })

  test("community gates update rejects duplicate same-type identity gates", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "community-gates-duplicate-type-user")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)
    await completeAgeOver18Verification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Gates Duplicate Type Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id?: string
        community_id?: string
      }
    }
    const communityId = createdCommunityId(communityCreateBody)

    const duplicateGenderGates = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.accessToken}`,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          anonymous_identity_scope: null,
          gate_policy: {
            version: 1,
            expression: {
              op: "and",
              children: [
                { op: "gate", gate: { type: "gender", provider: "self", allowed: ["F"] } },
                { op: "gate", gate: { type: "gender", provider: "self", allowed: ["M"] } },
              ],
            },
          },
        }),
      },
      ctx.env,
    ))
    expect(duplicateGenderGates.status).toBe(200)
  })
})
