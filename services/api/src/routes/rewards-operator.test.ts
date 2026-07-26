import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import rewards, {
  createRewardBackendFlipReadinessHandler,
  createRewardCampaignRecoveryHandler,
  createRewardRefundPolicyReadinessHandler,
  createRewardSettlementResolutionHandler,
  createRewardSolvencyReadinessHandler,
} from "./rewards"
import type { Env } from "../env"
import type { Client } from "../lib/sql-client"
import {
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
  REWARD_SETTLEMENT_READ_SCOPE,
  REWARD_SETTLEMENT_RESOLVE_SCOPE,
} from "../lib/operator-credential-auth"

function withErrors(app: Hono<{ Bindings: Env }>): Hono<{ Bindings: Env }> {
  app.onError((error, c) => {
    const status = (error as unknown as { status?: unknown }).status
    return c.json({ error: "rejected" }, (typeof status === "number" ? status : 500) as 401)
  })
  return app
}

function productionApp(): Hono<{ Bindings: Env }> {
  const app = withErrors(new Hono<{ Bindings: Env }>())
  app.route("/", rewards)
  return app
}

function recoveryApp(input: { scope: typeof BOOKING_SETTLEMENT_RESOLVE_SCOPE | typeof REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE; recover: (value: Record<string, unknown>) => Promise<{ campaign_id: string; status: string }>; alert?: (campaignId: string, incidentId: string) => void }) {
  const app = withErrors(new Hono<{ Bindings: Env }>())
  app.post("/operator/reward_campaigns/:campaignId/incidents/:incidentId/recover", createRewardCampaignRecoveryHandler({
    authenticate: async () => ({ authType: "operator_credential", operatorCredentialId: "opc_test", operatorActorId: "reward-operator", scopes: [input.scope] }),
    getClient: (() => ({} as Client)) as typeof import("../lib/runtime-deps").getControlPlaneClient,
    recover: async (value) => input.recover(value as unknown as Record<string, unknown>),
    alertRecovery: async (_env, campaignId, incidentId) => { input.alert?.(campaignId, incidentId); return true },
  }))
  return app
}

const request = () => new Request(
  "http://localhost/operator/reward_campaigns/rcp_test/incidents/rci_test/recover",
  { method: "POST", headers: { "content-type": "application/json", authorization: "Operator test.secret" }, body: JSON.stringify({ incident_version: 3, resolution_note: "resolved" }) },
)

describe("reward campaign incident recovery route", () => {
  test("rejects a request without an operator credential before touching recovery state", async () => {
    const response = await productionApp().request(
      "/operator/reward_campaigns/rcp_test/incidents/rci_test/recover",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ incident_version: 1, resolution_note: "resolved" }) },
      {} as Env,
    )
    expect(response.status).toBe(401)
  })

  test("rejects an operator that lacks the reward recovery scope", async () => {
    let recovered = false
    const response = await recoveryApp({
      scope: BOOKING_SETTLEMENT_RESOLVE_SCOPE,
      recover: async () => { recovered = true; return { campaign_id: "rcp_test", status: "active" } },
    }).fetch(request(), {} as Env)
    expect(response.status).toBe(403)
    expect(recovered).toBe(false)
  })

  test("reaches recovery with the dedicated scope and returns the restored campaign", async () => {
    let received: Record<string, unknown> | null = null
    let alerted: [string, string] | null = null
    const response = await recoveryApp({
      scope: REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
      recover: async (value) => { received = value; return { campaign_id: String(value.campaignId), status: "active" } },
      alert: (campaignId, incidentId) => { alerted = [campaignId, incidentId] },
    }).fetch(request(), {} as Env)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ campaign_id: "rcp_test", status: "active" })
    expect(received).toMatchObject({ campaignId: "rcp_test", incidentId: "rci_test", incidentVersion: 3, resolutionNote: "resolved", operatorActorId: "reward-operator" })
    expect(alerted).toEqual(["rcp_test", "rci_test"])
  })
})

function settlementResolutionApp(scope: typeof BOOKING_SETTLEMENT_RESOLVE_SCOPE | typeof REWARD_SETTLEMENT_RESOLVE_SCOPE, resolve: (value: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  const app = withErrors(new Hono<{ Bindings: Env }>())
  app.post("/operator/reward_settlements/:effectId/resolve", createRewardSettlementResolutionHandler({
    authenticate: async () => ({
      authType: "operator_credential",
      operatorCredentialId: "opc_test",
      operatorActorId: "reward-operator",
      scopes: [scope],
    }),
    getClient: (() => ({} as Client)) as typeof import("../lib/runtime-deps").getControlPlaneClient,
    resolveSettlement: async (value) => resolve(value as unknown as Record<string, unknown>) as never,
  }))
  return app
}

const settlementResolutionRequest = () => new Request(
  "http://localhost/operator/reward_settlements/rpe_test/resolve",
  {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Operator test.secret" },
    body: JSON.stringify({
      effect_kind: "cashout",
      expected_tx_hash: `0x${"11".repeat(32)}`,
      resolution: "confirmed",
      reason: "Receipt and RewardPaid event independently verified.",
    }),
  },
)

describe("reward settlement manual resolution route", () => {
  test("requires the dedicated settlement resolution scope", async () => {
    let called = false
    const response = await settlementResolutionApp(
      BOOKING_SETTLEMENT_RESOLVE_SCOPE,
      async () => { called = true; return {} },
    ).fetch(settlementResolutionRequest(), {} as Env)
    expect(response.status).toBe(403)
    expect(called).toBe(false)
  })

  test("passes an authenticated, explicit resolution to the service", async () => {
    let received: Record<string, unknown> | null = null
    const response = await settlementResolutionApp(
      REWARD_SETTLEMENT_RESOLVE_SCOPE,
      async (value) => {
        received = value
        return { state: "confirmed", txHash: value.expectedTxHash }
      },
    ).fetch(settlementResolutionRequest(), {} as Env)
    expect(response.status).toBe(200)
    expect(received).toMatchObject({
      effectKind: "cashout",
      effectId: "rpe_test",
      resolution: "confirmed",
      operatorActorId: "reward-operator",
    })
  })
})

type RewardReadinessPath =
  | "/operator/reward_pools/refund_policy_readiness"
  | "/operator/reward_settlements/backend_flip_readiness"
  | "/operator/reward_settlements/solvency_readiness"

function readinessApp(
  scope: typeof REWARD_SETTLEMENT_READ_SCOPE | typeof REWARD_SETTLEMENT_RESOLVE_SCOPE,
  called: () => void,
) {
  const app = withErrors(new Hono<{ Bindings: Env }>())
  const services = {
    authenticate: async () => ({
      authType: "operator_credential" as const,
      operatorCredentialId: "opc_test",
      operatorActorId: "reward-observer",
      scopes: [scope],
    }),
    getClient: (() => ({} as Client)) as typeof import("../lib/runtime-deps").getControlPlaneClient,
    getRefundPolicyReadiness: async () => {
      called()
      return { ready: true } as never
    },
    getBackendFlipReadiness: async () => {
      called()
      return { ready: true } as never
    },
    getSolvencyReadiness: async () => {
      called()
      return { ready: true } as never
    },
  }
  app.get(
    "/operator/reward_pools/refund_policy_readiness",
    createRewardRefundPolicyReadinessHandler(services),
  )
  app.get(
    "/operator/reward_settlements/backend_flip_readiness",
    createRewardBackendFlipReadinessHandler(services),
  )
  app.get(
    "/operator/reward_settlements/solvency_readiness",
    createRewardSolvencyReadinessHandler(services),
  )
  return app
}

describe("reward settlement readiness routes", () => {
  const paths: RewardReadinessPath[] = [
    "/operator/reward_pools/refund_policy_readiness",
    "/operator/reward_settlements/backend_flip_readiness",
    "/operator/reward_settlements/solvency_readiness",
  ]

  for (const path of paths) {
    test(`${path} rejects the manual-resolution scope`, async () => {
      let calls = 0
      const response = await readinessApp(REWARD_SETTLEMENT_RESOLVE_SCOPE, () => {
        calls += 1
      }).request(path, { headers: { authorization: "Operator test.secret" } }, {} as Env)
      expect(response.status).toBe(403)
      expect(calls).toBe(0)
    })

    test(`${path} accepts only the read scope`, async () => {
      let calls = 0
      const response = await readinessApp(REWARD_SETTLEMENT_READ_SCOPE, () => {
        calls += 1
      }).request(path, { headers: { authorization: "Operator test.secret" } }, {} as Env)
      expect(response.status).toBe(200)
      expect(calls).toBe(1)
    })
  }
})
