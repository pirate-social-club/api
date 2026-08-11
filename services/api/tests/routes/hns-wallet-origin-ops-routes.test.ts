import { afterEach, describe, expect, test } from "bun:test"

import { app } from "../../src/index"
import type { HnsWalletOriginAuthoritySnapshot } from "../../src/lib/hns-wallet-origin-authority-do"
import {
  HNS_WALLET_ORIGIN_AUTHORITY_VERSION_CONFLICT,
  sameHnsWalletOriginAuthorityDecision,
} from "../../src/lib/hns-wallet-origin-authority-do"
import { createRouteTestContext, json } from "../helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

function projection() {
  const snapshots: HnsWalletOriginAuthoritySnapshot[] = []
  return {
    binding: {
      getByName: () => ({
        applySnapshot: async (snapshot: HnsWalletOriginAuthoritySnapshot) => {
          snapshots.push(snapshot)
          return snapshot
        },
        readSnapshot: async (rootLabel: string) => [...snapshots]
          .reverse()
          .find((snapshot: HnsWalletOriginAuthoritySnapshot) => (
            snapshot.originHostname === `app.${rootLabel}`
          )) ?? null,
      }),
    },
    snapshots,
  }
}

async function insertRootState(
  ctx: Awaited<ReturnType<typeof createRouteTestContext>>,
  rootLabel: string,
  activated: number,
  hardDenied = 0,
) {
  const now = "2026-08-10T00:00:00.000Z"
  await ctx.client.execute({
    sql: `
      INSERT INTO hns_root_delegation_state (
        normalized_root_label, rollover_state, canonical_routing_eligible,
        routing_hard_denied, state_changed_at, created_at, updated_at
      ) VALUES (?1, 'none', ?2, ?3, ?4, ?4, ?4)
    `,
    args: [rootLabel, activated, hardDenied, now],
  })
}

function adminRequest(path: string, body: Record<string, unknown>) {
  return new Request(`http://pirate.test${path}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "x-admin-token": "admin-test-token",
    },
    method: "POST",
  })
}

describe("HNS wallet origin operator routes", () => {
  test("registers only an activated root and publishes its durable projection", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "new-root", 1)

    const response = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/new-root/registrations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Privy dashboard origin confirmed",
        registration_reference: "privy-dashboard:app.new-root",
      },
    ), undefined, ctx.env)

    expect(response.status).toBe(200)
    expect((await json(response) as { authority: { effective: boolean } }).authority.effective).toBe(true)
    expect(projected.snapshots).toHaveLength(1)
    expect(projected.snapshots[0]).toMatchObject({
      authorityVersion: 1,
      effective: true,
      originHostname: "app.new-root",
      reasonCode: "enabled",
    })
    const corsResponse = await app.request(new Request("http://pirate.test/health", {
      headers: { origin: "https://app.new-root" },
    }), undefined, ctx.env)
    expect(corsResponse.headers.get("access-control-allow-origin")).toBe("https://app.new-root")
  })

  test("does not make verifier freshness part of registration", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    // Deliberately no parent observation row: durable activation is the input.
    await insertRootState(ctx, "stable-root", 1)

    const response = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/stable-root/registrations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Privy dashboard origin confirmed",
        registration_reference: "privy-dashboard:app.stable-root",
      },
    ), undefined, ctx.env)

    expect(response.status).toBe(200)
    expect(projected.snapshots[0]?.effective).toBe(true)
  })

  test("rejects an unactivated or hard-denied root", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "inactive-root", 0)
    await insertRootState(ctx, "denied-root", 1, 1)

    for (const [root, expectedStatus] of [["inactive-root", 403], ["denied-root", 409]] as const) {
      const response = await app.request(adminRequest(
        `/admin/ops/hns-wallet-origins/${root}/registrations`,
        {
          operator_actor_id: "workspace_operator",
          reason: "Privy dashboard origin confirmed",
          registration_reference: `privy-dashboard:app.${root}`,
        },
      ), undefined, ctx.env)
      expect(response.status).toBe(expectedStatus)
    }
    expect(projected.snapshots).toHaveLength(0)
  })

  test("rejects a root that cannot be registered as a browser origin before persistence", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "unsupported_root", 1)

    const response = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/unsupported_root/registrations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Privy dashboard origin confirmed",
        registration_reference: "privy-dashboard:app.unsupported_root",
      },
    ), undefined, ctx.env)

    expect(response.status).toBe(409)
    expect(projected.snapshots).toHaveLength(0)
    const persisted = await ctx.client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM hns_wallet_origin_authority
        WHERE normalized_root_label = 'unsupported_root'
      `,
      args: [],
    })
    expect(Number(persisted.rows[0]?.count)).toBe(0)
  })

  test("withdraws the request-time projection when registration is revoked", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "revoked-root", 1)
    await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/revoked-root/registrations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Privy dashboard origin confirmed",
        registration_reference: "privy-dashboard:app.revoked-root",
      },
    ), undefined, ctx.env)

    const response = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/revoked-root/revocations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Operator withdrew wallet access",
      },
    ), undefined, ctx.env)

    expect(response.status).toBe(200)
    expect(projected.snapshots.at(-1)).toMatchObject({
      authorityVersion: 2,
      effective: false,
      reasonCode: "revoked",
    })

    const replay = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/revoked-root/revocations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Operator repeated wallet withdrawal",
      },
    ), undefined, ctx.env)

    expect(replay.status).toBe(200)
    expect((await json(replay) as { authority: { authorityVersion: number } }).authority.authorityVersion).toBe(2)
  })

  test("treats equal-version target decisions with different timestamps as idempotent", () => {
    const current: HnsWalletOriginAuthoritySnapshot = {
      authorityVersion: 2,
      effective: false,
      originHostname: "app.revoked-root",
      reasonCode: "revoked",
      updatedAt: "2026-08-11T00:00:00.000Z",
    }
    expect(sameHnsWalletOriginAuthorityDecision(current, {
      ...current,
      updatedAt: "2026-08-11T00:00:01.000Z",
    })).toBe(true)
    expect(sameHnsWalletOriginAuthorityDecision(current, {
      ...current,
      effective: true,
      reasonCode: "enabled",
    })).toBe(false)
  })

  test("returns a typed conflict when the projection rejects a genuine equal-version conflict", async () => {
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: {
        getByName: () => ({
          applySnapshot: async () => {
            throw new Error(HNS_WALLET_ORIGIN_AUTHORITY_VERSION_CONFLICT)
          },
          readSnapshot: async () => null,
        }),
      } as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "conflict-root", 1)

    const response = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/conflict-root/registrations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Privy dashboard origin confirmed",
        registration_reference: "privy-dashboard:app.conflict-root",
      },
    ), undefined, ctx.env)

    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ code: "conflict", retryable: false })
  })

  test("hard-denies routing and withdraws wallet access in the same operator action", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "compromised-root", 1)
    await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/compromised-root/registrations",
      {
        operator_actor_id: "workspace_operator",
        reason: "Privy dashboard origin confirmed",
        registration_reference: "privy-dashboard:app.compromised-root",
      },
    ), undefined, ctx.env)

    const response = await app.request(adminRequest(
      "/admin/ops/hns-wallet-origins/compromised-root/hard-denials",
      {
        operator_actor_id: "workspace_operator",
        reason: "Definitive delegation compromise",
      },
    ), undefined, ctx.env)

    expect(response.status).toBe(200)
    expect(projected.snapshots.at(-1)).toMatchObject({
      authorityVersion: 2,
      effective: false,
      reasonCode: "hard_denied",
    })
    const state = await ctx.client.execute({
      sql: `
        SELECT canonical_routing_eligible, routing_hard_denied
        FROM hns_root_delegation_state
        WHERE normalized_root_label = 'compromised-root'
      `,
      args: [],
    })
    expect(state.rows[0]).toMatchObject({
      canonical_routing_eligible: 0,
      routing_hard_denied: 1,
    })
    const corsResponse = await app.request(new Request("http://pirate.test/health", {
      headers: { origin: "https://app.compromised-root" },
    }), undefined, ctx.env)
    expect(corsResponse.headers.get("access-control-allow-origin")).toBe(null)
  })

  test("rejects unauthenticated registration before mutation", async () => {
    const projected = projection()
    const ctx = await createRouteTestContext({
      HNS_WALLET_ORIGIN_AUTHORITY: projected.binding as never,
      PIRATE_ADMIN_TOKEN: "admin-test-token",
    })
    cleanup = ctx.cleanup
    await insertRootState(ctx, "new-root", 1)

    const response = await app.request(
      "/admin/ops/hns-wallet-origins/new-root/registrations",
      { method: "POST", body: JSON.stringify({}) },
      ctx.env,
    )
    expect(response.status).toBe(401)
    expect(projected.snapshots).toHaveLength(0)
  })
})
