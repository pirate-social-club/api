import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import rewards, {
  createRewardBackendFlipReadinessHandler,
  createRewardCampaignRecoveryHandler,
  createRewardEpochCapRehearsalSnapshotHandler,
  createRewardLifecycleRehearsalHandler,
  createRewardRefundPolicyReadinessHandler,
  createRewardRehearsalHandler,
  createRewardSettlementResolutionHandler,
  createRewardSolvencyReadinessHandler,
} from "./rewards"
import type { Env } from "../env"
import type { Client } from "../lib/sql-client"
import type { RewardLifecycleSnapshot } from "../lib/rewards/reward-lifecycle-harness"
import type { RewardCampaignReconciliationSummary } from "../lib/rewards/reward-campaign-reconciler"
import {
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
  REWARD_REHEARSAL_EXECUTE_SCOPE,
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

function rehearsalApp(input: {
  environment: string
  scope: typeof BOOKING_SETTLEMENT_RESOLVE_SCOPE | typeof REWARD_REHEARSAL_EXECUTE_SCOPE
  invoked?: (scenario: string) => void
}) {
  const app = withErrors(new Hono<{ Bindings: Env }>())
  app.post("/operator/reward_settlements/rehearsal", createRewardRehearsalHandler({
    authenticate: async () => ({
      authType: "operator_credential",
      operatorCredentialId: "opc_test",
      operatorActorId: "rehearsal-operator",
      scopes: [input.scope],
    }),
    enqueue: async ({ scenario }) => {
      input.invoked?.(scenario)
      return {
        idempotencyKey: `["reward_payout","rehearsal:${scenario}"]`,
        state: "reserving",
        payoutEffectId: null,
        transactionHash: null,
      }
    },
    snapshot: async () => ({ userId: "usr_test", amountCentsEach: 50, rows: [] }),
  }))
  return {
    app,
    env: { ENVIRONMENT: input.environment } as Env,
  }
}

describe("reward settlement rehearsal route", () => {
  test("is absent outside staging before authentication or execution", async () => {
    let invoked = false
    const fixture = rehearsalApp({
      environment: "production",
      scope: REWARD_REHEARSAL_EXECUTE_SCOPE,
      invoked: () => { invoked = true },
    })
    const response = await fixture.app.request("/operator/reward_settlements/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "replay" }),
    }, fixture.env)
    expect(response.status).toBe(404)
    expect(invoked).toBe(false)
  })

  test("requires the dedicated operator scope", async () => {
    const fixture = rehearsalApp({
      environment: "staging",
      scope: BOOKING_SETTLEMENT_RESOLVE_SCOPE,
    })
    const response = await fixture.app.request("/operator/reward_settlements/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "replay" }),
    }, fixture.env)
    expect(response.status).toBe(403)
  })

  test("accepts only one scenario enum and returns private no-store evidence", async () => {
    const seen: string[] = []
    const fixture = rehearsalApp({
      environment: "staging",
      scope: REWARD_REHEARSAL_EXECUTE_SCOPE,
      invoked: (scenario) => seen.push(scenario),
    })
    const extra = await fixture.app.request("/operator/reward_settlements/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "replay", amount: 1 }),
    }, fixture.env)
    expect(extra.status).toBe(400)

    const response = await fixture.app.request("/operator/reward_settlements/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "eoa_first_payout" }),
    }, fixture.env)
    expect(response.status).toBe(202)
    expect(response.headers.get("cache-control")).toBe("private, no-store")

    const refund = await fixture.app.request("/operator/reward_settlements/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "refund_while_payouts_paused" }),
    }, fixture.env)
    expect(refund.status).toBe(202)
    expect(refund.headers.get("cache-control")).toBe("private, no-store")
    const epochCap = await fixture.app.request("/operator/reward_settlements/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scenario: "epoch_cap_defer" }),
    }, fixture.env)
    expect(epochCap.status).toBe(202)
    expect(seen).toEqual(["eoa_first_payout", "refund_while_payouts_paused", "epoch_cap_defer"])
  })

  test("exposes the fixed epoch-cap snapshot only in staging with private no-store", async () => {
    const app = withErrors(new Hono<{ Bindings: Env }>())
    app.get("/operator/reward_settlements/rehearsal/epoch-cap", createRewardEpochCapRehearsalSnapshotHandler({
      authenticate: async () => ({
        authType: "operator_credential",
        operatorCredentialId: "opc_test",
        operatorActorId: "rehearsal-operator",
        scopes: [REWARD_REHEARSAL_EXECUTE_SCOPE],
      }),
      enqueue: async () => {
        throw new Error("not used")
      },
      snapshot: async () => ({
        userId: "usr_test",
        amountCentsEach: 50,
        rows: [],
      }),
    }))
    const staging = await app.request(
      "/operator/reward_settlements/rehearsal/epoch-cap",
      {},
      { ENVIRONMENT: "staging" } as Env,
    )
    expect(staging.status).toBe(200)
    expect(staging.headers.get("cache-control")).toBe("private, no-store")
    expect(await staging.json()).toEqual({ userId: "usr_test", amountCentsEach: 50, rows: [] })

    const production = await app.request(
      "/operator/reward_settlements/rehearsal/epoch-cap",
      {},
      { ENVIRONMENT: "production" } as Env,
    )
    expect(production.status).toBe(404)
  })
})

function lifecycleRehearsalApp(input: {
  environment: string
  snapshots: RewardLifecycleSnapshot[]
  reconcile?: () => Promise<RewardCampaignReconciliationSummary>
}) {
  const app = withErrors(new Hono<{ Bindings: Env }>())
  let snapshotIndex = 0
  let reconcileCount = 0
  const repository = {
    listActiveCommunities: async () => [],
    close: async () => undefined,
  }
  app.post("/operator/reward_campaigns/rehearsal", createRewardLifecycleRehearsalHandler({
    authenticate: async () => ({
      authType: "operator_credential",
      operatorCredentialId: "opc_test",
      operatorActorId: "rehearsal-operator",
      scopes: [REWARD_REHEARSAL_EXECUTE_SCOPE],
    }),
    getClient: (() => ({} as Client)) as typeof import("../lib/runtime-deps").getControlPlaneClient,
    getCommunityRepository: (() => repository) as unknown as typeof import("../lib/communities/db-community-repository").getCommunityRepository,
    reconcile: async () => {
      reconcileCount += 1
      return input.reconcile?.() ?? ({ enabled: true, scanned_communities: 1 } as RewardCampaignReconciliationSummary)
    },
    readSnapshot: async () => input.snapshots[Math.min(snapshotIndex++, input.snapshots.length - 1)] as RewardLifecycleSnapshot,
  }))
  return { app, env: { ENVIRONMENT: input.environment } as Env, get reconcileCount() { return reconcileCount } }
}

const lifecycleSnapshot: RewardLifecycleSnapshot = {
  campaign: { status: "active", fundedCents: 100, reservedCents: 0, creditedCents: 40, paidCents: 0 },
  qualificationEvents: 1,
  reservations: 1,
  rewardEvents: 1,
  pendingQualifications: 0,
  payoutEffects: 0,
}

describe("reward lifecycle rehearsal route", () => {
  test("is absent outside staging", async () => {
    const fixture = lifecycleRehearsalApp({ environment: "production", snapshots: [lifecycleSnapshot] })
    const response = await fixture.app.request("/operator/reward_campaigns/rehearsal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ campaign_id: "rcp_test", user_id: "usr_test" }),
    }, fixture.env)
    expect(response.status).toBe(404)
    expect(fixture.reconcileCount).toBe(0)
  })

  test("runs the replay pass and returns the stable ledger snapshots", async () => {
    const fixture = lifecycleRehearsalApp({
      environment: "staging",
      snapshots: [lifecycleSnapshot, lifecycleSnapshot, lifecycleSnapshot, lifecycleSnapshot],
    })
    const response = await fixture.app.request("/operator/reward_campaigns/rehearsal", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Operator test.secret",
      },
      body: JSON.stringify({ campaign_id: "rcp_test", user_id: "usr_test", passes: 1 }),
    }, fixture.env)
    expect(response.status).toBe(200)
    expect(fixture.reconcileCount).toBe(2)
    expect(await response.json()).toMatchObject({
      campaign_id: "rcp_test",
      user_id: "usr_test",
      before: lifecycleSnapshot,
      after_pass: lifecycleSnapshot,
      replay: lifecycleSnapshot,
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
