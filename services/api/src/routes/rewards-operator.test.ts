import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import rewards, { createRewardCampaignRecoveryHandler } from "./rewards"
import type { Env } from "../env"
import type { Client } from "../lib/sql-client"
import { BOOKING_SETTLEMENT_RESOLVE_SCOPE, REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE } from "../lib/operator-credential-auth"

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
