import { afterEach, describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import type { Env } from "../env"
import storySettlementOps, { setStorySettlementOpsDependenciesForTests } from "./story-settlement-ops"

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const ADDRESS = new Wallet(PRIVATE_KEY).address
const PLAN_REF = `0x${"11".repeat(32)}`
const STEP_REF = `0x${"22".repeat(32)}`

function actor(scope: "story:settlement:repair" | "story:settlement:fee-replace" = "story:settlement:repair") {
  return {
    authType: "operator_credential" as const,
    operatorCredentialId: "opc_story_ops",
    operatorActorId: "svc_story_ops",
    scopes: [scope],
  }
}

afterEach(() => setStorySettlementOpsDependenciesForTests({}))

describe("Story settlement operator routes", () => {
  test("reads one coordinator plan without mutating it", async () => {
    let inspectedPlanRef: string | null = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor() })
    const env = {
      ENVIRONMENT: "staging",
      STORY_CHAIN_ID: "1315",
      STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
      STORY_COORDINATOR_SIGNER_ADDRESS: ADDRESS,
      STORY_SETTLEMENT_WALLET_COORDINATOR: {
        getByName: () => ({
          lookup: async (planRef: string) => {
            inspectedPlanRef = planRef
            return {
              planRef: PLAN_REF,
              state: "pending",
              version: 7,
              steps: [{ receipt: { blockNumber: 123n } }],
            }
          },
        }),
      },
    } as unknown as Env
    const response = await storySettlementOps.request("/plan-inspections", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({ plan_ref: PLAN_REF, authorization_ref: "CANARY-DIAGNOSTIC-1" }),
    }, env)
    expect(response.status).toBe(200)
    expect(inspectedPlanRef).toBe(PLAN_REF)
    expect(await response.json()).toMatchObject({
      plan: { planRef: PLAN_REF, state: "pending", version: 7, steps: [{ receipt: { blockNumber: "123" } }] },
    })
  })

  test("submits a fenced abandoned-nonce repair with durable operator identity", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor() })
    const env = {
      ENVIRONMENT: "staging",
      STORY_CHAIN_ID: "1315",
      STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
      STORY_COORDINATOR_SIGNER_ADDRESS: ADDRESS,
      STORY_SETTLEMENT_WALLET_COORDINATOR: {
        getByName: () => ({
          requestAbandonedNonceRepair: async (input: Record<string, unknown>) => {
            request = input
            return { planRef: PLAN_REF, state: "abandoning", version: 4, steps: [] }
          },
        }),
      },
    } as unknown as Env
    const response = await storySettlementOps.request("/nonce-repairs", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        plan_ref: PLAN_REF,
        step_ref: STEP_REF,
        expected_version: 3,
        reason_code: "rights_hold",
        authorization_ref: "INC-2026-0716",
      }),
    }, env)
    expect(response.status).toBe(202)
    expect(request).toEqual({
      planRef: PLAN_REF,
      stepRef: STEP_REF,
      expectedVersion: 3,
      reasonCode: "rights_hold",
      authorizationRef: "operator:opc_story_ops:INC-2026-0716",
    })
  })

  test("uses an independent scope and decimal fee fields for replacement", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor("story:settlement:fee-replace") })
    const env = {
      STORY_CHAIN_ID: "1315",
      STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
      STORY_COORDINATOR_SIGNER_ADDRESS: ADDRESS,
      STORY_SETTLEMENT_WALLET_COORDINATOR: {
        getByName: () => ({
          requestFeeReplacement: async (input: Record<string, unknown>) => {
            request = input
            return {
              planRef: PLAN_REF,
              stepRef: STEP_REF,
              candidateRef: `0x${"33".repeat(32)}`,
              generation: 1,
              transactionHash: `0x${"44".repeat(32)}`,
              state: "prepared",
            }
          },
        }),
      },
    } as unknown as Env
    const response = await storySettlementOps.request("/fee-replacements", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        plan_ref: PLAN_REF,
        step_ref: STEP_REF,
        expected_version: 3,
        expected_active_candidate_hash: `0x${"55".repeat(32)}`,
        max_fee_per_gas: "110",
        max_priority_fee_per_gas: "11",
        authorization_ref: "INC-FEE-REPLACE-1",
      }),
    }, env)
    expect(response.status).toBe(202)
    expect(request).toEqual({
      planRef: PLAN_REF,
      stepRef: STEP_REF,
      expectedVersion: 3,
      expectedActiveCandidateHash: `0x${"55".repeat(32)}`,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 11n,
      operatorCredentialId: "opc_story_ops",
      operatorActorId: "svc_story_ops",
      authorizationRef: "operator:opc_story_ops:INC-FEE-REPLACE-1",
    })

    request = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor() })
    const forbidden = await storySettlementOps.request("/fee-replacements", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        plan_ref: PLAN_REF,
        step_ref: STEP_REF,
        expected_version: 3,
        expected_active_candidate_hash: `0x${"55".repeat(32)}`,
        max_fee_per_gas: "110",
        max_priority_fee_per_gas: "11",
        authorization_ref: "INC-FEE-REPLACE-1",
      }),
    }, env)
    // This isolated router has no production error mapper, so the typed 403 is
    // surfaced as 500 by Hono's test request helper. The important boundary is
    // that the repair-only credential never reaches the coordinator method.
    expect(forbidden.status).toBe(500)
    expect(request).toBeNull()
  })

  test("arms a scoped one-shot staging nonce-repair drill", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor() })
    const env = {
      ENVIRONMENT: "staging",
      STORY_CHAIN_ID: "1315",
      STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
      STORY_COORDINATOR_SIGNER_ADDRESS: ADDRESS,
      STORY_SETTLEMENT_WALLET_COORDINATOR: {
        getByName: () => ({
          armNonceRepairDrill: async (input: Record<string, unknown>) => {
            request = input
            return { armRef: PLAN_REF, communityId: "community_drill" }
          },
        }),
      },
    } as unknown as Env
    const response = await storySettlementOps.request("/nonce-repair-drills", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        community_id: "community_drill",
        authorization_ref: "CANARY-NONCE-DRILL-1",
      }),
    }, env)
    expect(response.status).toBe(202)
    expect(request).toEqual({
      communityId: "community_drill",
      authorizationRef: "operator:opc_story_ops:CANARY-NONCE-DRILL-1",
    })
    expect(await response.json()).toEqual({
      drill: { armRef: PLAN_REF, communityId: "community_drill" },
    })
  })

  test("retargets only the expected unconsumed staging drill arm", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor() })
    const env = {
      ENVIRONMENT: "staging",
      STORY_CHAIN_ID: "1315",
      STORY_COORDINATOR_SIGNER_PRIVATE_KEY: PRIVATE_KEY,
      STORY_COORDINATOR_SIGNER_ADDRESS: ADDRESS,
      STORY_SETTLEMENT_WALLET_COORDINATOR: {
        getByName: () => ({
          retargetNonceRepairDrill: async (input: Record<string, unknown>) => {
            request = input
            return { armRef: PLAN_REF, communityId: "community_ready", retargetRef: STEP_REF }
          },
        }),
      },
    } as unknown as Env
    const response = await storySettlementOps.request(`/nonce-repair-drills/${PLAN_REF}/retargets`, {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        community_id: "community_ready",
        authorization_ref: "CANARY-NONCE-RETARGET-1",
      }),
    }, env)
    expect(response.status).toBe(202)
    expect(request).toEqual({
      armRef: PLAN_REF,
      communityId: "community_ready",
      authorizationRef: "operator:opc_story_ops:CANARY-NONCE-RETARGET-1",
    })
    expect(await response.json()).toEqual({
      drill: { armRef: PLAN_REF, communityId: "community_ready", retargetRef: STEP_REF },
    })
  })

  test("synthetic alert is staging-only and reports sink delivery", async () => {
    const captured: string[] = []
    setStorySettlementOpsDependenciesForTests({
      authenticate: async () => actor(),
      captureAlert: async (_env, _title, task) => {
        captured.push(task)
        return {
          delivered: true,
          deduplicated: false,
          evidenceRecorded: true,
          deliveryAttemptId: "oad_synthetic",
          sink: "email",
        }
      },
    })
    const init = {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({ authorization_ref: "CANARY-1" }),
    }
    const staging = await storySettlementOps.request("/alerts/synthetic", init, { ENVIRONMENT: "staging" } as Env)
    expect(staging.status).toBe(202)
    expect(captured).toEqual(["story_settlement_coordinator_synthetic:CANARY-1"])
    expect(await staging.json()).toMatchObject({
      delivered: true,
      evidenceRecorded: true,
      deliveryAttemptId: "oad_synthetic",
      proven: true,
    })
    const production = await storySettlementOps.request("/alerts/synthetic", init, { ENVIRONMENT: "production" } as Env)
    expect(production.status).toBe(403)
  })

  test("synthetic alert is not proven when durable evidence cannot be recorded", async () => {
    setStorySettlementOpsDependenciesForTests({
      authenticate: async () => actor(),
      captureAlert: async () => ({
        delivered: true,
        deduplicated: false,
        evidenceRecorded: false,
        deliveryAttemptId: null,
        sink: "email",
      }),
    })
    const response = await storySettlementOps.request("/alerts/synthetic", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({ authorization_ref: "CANARY-NO-EVIDENCE" }),
    }, { ENVIRONMENT: "staging" } as Env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ delivered: true, evidenceRecorded: false, proven: false })
  })

  test("runs one scoped purchase reconciliation under the repair credential", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({
      authenticate: async () => actor(),
      reconcilePurchase: async (input) => { request = input as unknown as Record<string, unknown>; return "pending" },
    })
    const response = await storySettlementOps.request("/purchase-reconciliations", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        community_id: "cmt_canary",
        quote_id: "qte_canary",
        authorization_ref: "CANARY-RECOVERY-1",
      }),
    }, {} as Env)
    expect(response.status).toBe(202)
    expect(request).toMatchObject({ communityId: "cmt_canary", quoteId: "qte_canary" })
  })

  test("requeues one operator-funding-blocked publish under the repair credential", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({
      authenticate: async () => actor(),
      recoverOperatorBlockedPublish: async (input) => {
        request = input as unknown as Record<string, unknown>
        return { outcome: "requeued", jobId: "cjb_recovery", postId: input.postId }
      },
    })
    const response = await storySettlementOps.request("/operator-blocked-publish-recoveries", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        community_id: "cmt_canary",
        post_id: "pst_blocked",
        authorization_ref: "CANARY-TOPUP-1",
      }),
    }, {} as Env)
    expect(response.status).toBe(202)
    expect(request).toMatchObject({ communityId: "cmt_canary", postId: "pst_blocked" })
    expect(await response.json()).toEqual({
      result: { outcome: "requeued", jobId: "cjb_recovery", postId: "pst_blocked" },
    })
  })

  test("confirms a registration no-broadcast outcome under the scoped repair credential", async () => {
    let request: Record<string, unknown> | null = null
    setStorySettlementOpsDependenciesForTests({
      authenticate: async () => actor(),
      confirmRegistrationNoBroadcast: async (input) => {
        request = input as unknown as Record<string, unknown>
        return {
          operationId: input.operationId,
          status: "failed_prebroadcast",
          errorCode: "ops_confirmed_no_broadcast:staging drill evidence",
        }
      },
    })
    const response = await storySettlementOps.request("/registration-effect-no-broadcast-confirmations", {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({
        community_id: "cmt_canary",
        asset_id: "ast_canary",
        operation_id: "op_canary",
        authorization_ref: "DRILL-2026-0717",
        reason: "Verified no broadcast in signer history and provider traces",
      }),
    }, {} as Env)
    expect(response.status).toBe(200)
    expect(request).toMatchObject({
      communityId: "cmt_canary",
      assetId: "ast_canary",
      operationId: "op_canary",
      actorId: "svc_story_ops",
    })
    expect(await response.json()).toMatchObject({
      effect: { operationId: "op_canary", status: "failed_prebroadcast" },
      next_action: "recycle the owning finalize job",
    })
  })
})
