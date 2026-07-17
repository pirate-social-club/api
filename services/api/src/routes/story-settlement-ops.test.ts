import { afterEach, describe, expect, test } from "bun:test"
import { Wallet } from "ethers"

import type { Env } from "../env"
import storySettlementOps, { setStorySettlementOpsDependenciesForTests } from "./story-settlement-ops"

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const ADDRESS = new Wallet(PRIVATE_KEY).address
const PLAN_REF = `0x${"11".repeat(32)}`
const STEP_REF = `0x${"22".repeat(32)}`

function actor() {
  return {
    authType: "operator_credential" as const,
    operatorCredentialId: "opc_story_ops",
    operatorActorId: "svc_story_ops",
    scopes: ["story:settlement:repair" as const],
  }
}

afterEach(() => setStorySettlementOpsDependenciesForTests({}))

describe("Story settlement operator routes", () => {
  test("reads one coordinator plan without mutating it", async () => {
    let inspectedPlanRef: string | null = null
    setStorySettlementOpsDependenciesForTests({ authenticate: async () => actor() })
    const env = {
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

  test("synthetic alert is staging-only and reports sink delivery", async () => {
    const captured: string[] = []
    setStorySettlementOpsDependenciesForTests({
      authenticate: async () => actor(),
      captureAlert: async (_env, _title, task) => { captured.push(task); return true },
    })
    const init = {
      method: "POST",
      headers: { authorization: "Operator ignored", "content-type": "application/json" },
      body: JSON.stringify({ authorization_ref: "CANARY-1" }),
    }
    const staging = await storySettlementOps.request("/alerts/synthetic", init, { ENVIRONMENT: "staging" } as Env)
    expect(staging.status).toBe(202)
    expect(captured).toEqual(["story_settlement_coordinator_synthetic:CANARY-1"])
    const production = await storySettlementOps.request("/alerts/synthetic", init, { ENVIRONMENT: "production" } as Env)
    expect(production.status).toBe(403)
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
})
