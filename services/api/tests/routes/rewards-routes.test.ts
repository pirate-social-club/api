import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import {
  reconcileSubmittedRewardPayouts,
  setRewardSettlementConfirmPollPlanForTests,
  setRewardSettlementCoordinatorForTests,
} from "../../src/lib/rewards/reward-cashout-service"
import { setPrivyAccessProofVerifierForTests } from "../../src/lib/auth/privy-auth"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setRewardSettlementCoordinatorForTests(null)
  setRewardSettlementConfirmPollPlanForTests(null)
  setPrivyAccessProofVerifierForTests(null)
})

afterEach(async () => {
  setRewardSettlementCoordinatorForTests(null)
  setRewardSettlementConfirmPollPlanForTests(null)
  setPrivyAccessProofVerifierForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function authHeaders(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` }
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

describe("rewards routes", () => {
  async function createRewardsCommunity(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, now: string): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, description, membership_mode,
          status, provisioning_state, transfer_state, created_at, updated_at
        )
        VALUES ('cmt_rewards_route', ?1, 'Rewards Test', NULL, 'open', 'active', 'active', 'none', ?2, ?2)
        ON CONFLICT (community_id) DO NOTHING
      `,
      args: [userId, now],
    })
  }

  async function addWallet(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, now: string, address = "0x1000000000000000000000000000000000000001"): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized,
          wallet_address_display, source_provider, source_subject, attachment_kind,
          is_primary, status, attached_at, detached_at, created_at, updated_at
        )
        VALUES (
          'wal_rewards_' || ?1, ?1, 'eip155', lower(?2),
          ?2, 'privy', 'did:privy:rewards', 'embedded',
          1, 'active', ?3, NULL, ?3, ?3
        )
      `,
      args: [userId, address, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET primary_wallet_attachment_id = 'wal_rewards_' || ?1 WHERE user_id = ?1",
      args: [userId],
    })
  }

  async function addNullifier(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, now: string): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO identity_nullifiers (
          identity_nullifier_id, user_id, provider, mechanism, nullifier_hash, status,
          first_seen_at, created_at, updated_at
        )
        VALUES ('idn_rewards_' || ?1, ?1, 'self', 'zk-nullifier', 'reward-nullifier-' || ?1, 'active', ?2, ?2, ?2)
        ON CONFLICT (identity_nullifier_id) DO UPDATE
        SET status = 'active', updated_at = excluded.updated_at
      `,
      args: [userId, now],
    })
    await ctx.client.execute({
      sql: "UPDATE users SET verification_capabilities_json = ?2 WHERE user_id = ?1",
      args: [userId, JSON.stringify({
        unique_human: {
          state: "verified",
          provider: "self",
          proof_type: "unique_human",
          mechanism: "session_complete",
          verified_at: Math.floor(Date.parse(now) / 1000),
        },
      })],
    })
  }

  async function linkPrivySubject(
    ctx: Awaited<ReturnType<typeof createRouteTestContext>>,
    userId: string,
    subject: string,
    now: string,
  ): Promise<void> {
    await ctx.client.execute({
      sql: `
        INSERT INTO auth_provider_links (
          auth_provider_link_id, user_id, provider, provider_subject, provider_user_ref,
          status, linked_at, revoked_at, created_at, updated_at
        )
        VALUES ('apl_rewards_' || ?1 || '_' || ?2, ?1, 'privy', ?3, ?3, 'active', ?4, NULL, ?4, ?4)
      `,
      args: [userId, subject.replace(/[^a-zA-Z0-9_-]/g, "_"), subject, now],
    })
  }

  async function addRewardEvent(ctx: Awaited<ReturnType<typeof createRouteTestContext>>, userId: string, amountCents: number, now: string): Promise<void> {
    await createRewardsCommunity(ctx, userId, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES (
          'rew_cashout_' || ?1 || '_' || ?2, ?1, 'cmt_rewards_route', 'pst_reward_song_cashout',
          ?3, 'study_streak_day', ?2, 'song_engagement_reconciler', ?4
        )
      `,
      args: [userId, amountCents, todayUtc(), now],
    })
  }

  test("GET /me/rewards returns ledger balance, today earnings, recent events, and nullifier gate state", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_READS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-route-user")
    const otherSession = await exchangeJwt(ctx.env, "reward-route-other-user")
    const now = "2026-07-09T12:00:00.000Z"
    const today = todayUtc()

    await createRewardsCommunity(ctx, session.userId, now)

    await ctx.client.execute({
      sql: `
        INSERT INTO reward_user_days (user_id, activity_date, credited_cents, updated_at)
        VALUES (?1, ?2, 30, ?3)
      `,
      args: [session.userId, today, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES
          ('rew_route_day', ?1, 'cmt_rewards_route', 'pst_reward_song', ?2, 'study_streak_day', 30, 'song_engagement_reconciler', ?3),
          ('rew_route_milestone', ?1, 'cmt_rewards_route', 'pst_reward_song', ?2, 'study_streak_milestone_7', 50, 'song_engagement_reconciler', ?3),
          ('rew_route_other', ?4, 'cmt_rewards_route', 'pst_reward_song', ?2, 'study_streak_day', 10, 'song_engagement_reconciler', ?3)
      `,
      args: [session.userId, today, now, otherSession.userId],
    })

    const unverified = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(unverified.status).toBe(200)
    const unverifiedBody = await json(unverified) as {
      balance_cents: number
      today_earned_cents: number
      recent_events: Array<{ id: string; amount_cents: number; reward_kind: string }>
      cashout: { eligible: boolean; min_cents: number; verification_state: string }
    }
    expect(unverifiedBody.balance_cents).toBe(80)
    expect(unverifiedBody.today_earned_cents).toBe(30)
    expect(unverifiedBody.recent_events.map((event) => event.id).sort()).toEqual(["rew_route_day", "rew_route_milestone"])
    expect(unverifiedBody.cashout).toEqual({
      eligible: false,
      min_cents: 100,
      verification_state: "unverified",
    })

    await addNullifier(ctx, session.userId, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_events (
          reward_event_id, user_id, community_id, post_id, activity_date,
          reward_kind, amount_cents, source, created_at
        )
        VALUES ('rew_route_cashout_ready', ?1, 'cmt_rewards_route', 'pst_reward_song_2', ?2, 'study_streak_day', 20, 'song_engagement_reconciler', ?3)
      `,
      args: [session.userId, today, now],
    })
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address,
          idempotency_key, status, submitted_at, created_at, updated_at
        )
        VALUES (
          'rpe_route_pending', ?1, 10, '0x1000000000000000000000000000000000000001',
          'reward-cashout:route-pending', 'submitted', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })

    const verified = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(verified.status).toBe(200)
    const verifiedBody = await json(verified) as {
      balance_cents: number
      cashout: { eligible: boolean; min_cents: number; verification_state: string }
    }
    expect(verifiedBody.balance_cents).toBe(90)
    expect(verifiedBody.cashout).toEqual({
      eligible: false,
      min_cents: 100,
      verification_state: "verified",
    })

    ctx.env.REWARDS_IDENTITY_PROVIDER = "very"
    const wrongIdentityNamespace = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect((await json(wrongIdentityNamespace) as { cashout: { verification_state: string } }).cashout.verification_state).toBe("unverified")
  })

  test("GET /me/rewards requires authentication", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request("http://pirate.test/me/rewards", {}, ctx.env)
    expect(response.status).toBe(401)
  })

  test("reward reads and payouts fail closed when their independent flags are not true", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-disabled-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 12, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }),
    })

    await addWallet(ctx, session.userId, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const summary = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(summary.status).toBe(200)
    expect(await json(summary)).toEqual({
      balance_cents: 0,
      today_earned_cents: 0,
      recent_events: [],
      cashout: {
        eligible: false,
        min_cents: 100,
        verification_state: "unverified",
      },
    })

    const cashout = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-disabled" }),
      },
      ctx.env,
    )
    expect(cashout.status).toBe(403)
    expect(settleCount).toBe(0)
  })

  test("POST /me/rewards/cashouts gates on nullifier, balance, and idempotently confirms a payout", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    setRewardSettlementConfirmPollPlanForTests([])
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 12, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardtx", nonce: 12, state: "broadcast" }),
    })

    await addWallet(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const unverified = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(unverified.status).toBe(403)
    expect(settleCount).toBe(0)

    await addNullifier(ctx, session.userId, "2025-01-01T12:00:00.000Z")
    const expiredVerification = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-expired-human" }),
      },
      ctx.env,
    )
    expect(expiredVerification.status).toBe(403)
    expect(settleCount).toBe(0)

    await addNullifier(ctx, session.userId, now)
    const belowMinimum = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 99, idempotency_key: "reward-cashout-test-below-min" }),
      },
      ctx.env,
    )
    expect(belowMinimum.status).toBe(403)
    expect(settleCount).toBe(0)

    const tooMuch = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 200, idempotency_key: "reward-cashout-test-too-much" }),
      },
      ctx.env,
    )
    expect(tooMuch.status).toBe(403)
    expect(settleCount).toBe(0)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const body = await json(response) as {
      payout: { id: string; amount_cents: number; status: string; settlement_ref: string | null; recipient_address: string }
      balance_cents: number
    }
    expect(body.payout.amount_cents).toBe(100)
    expect(body.payout.status).toBe("confirmed")
    expect(body.payout.settlement_ref).toBe("0xrewardtx")
    expect(body.payout.recipient_address).toBe("0x1000000000000000000000000000000000000001")
    expect(body.balance_cents).toBe(50)
    expect(settleCount).toBe(1)

    const statusResponse = await app.request(
      `http://pirate.test/me/rewards/cashouts/${body.payout.id}`,
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(statusResponse.status).toBe(200)
    expect(await json(statusResponse)).toEqual(body)

    await ctx.client.execute({
      sql: "UPDATE wallet_attachments SET wallet_address_display = ?2 WHERE user_id = ?1 AND status = 'active'",
      args: [session.userId, "0x3000000000000000000000000000000000000003"],
    })
    await ctx.client.execute({
      sql: "DELETE FROM identity_nullifiers WHERE user_id = ?1",
      args: [session.userId],
    })

    const replay = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(replay.status).toBe(202)
    expect(settleCount).toBe(1)
    const replayBody = await json(replay) as { balance_cents: number; payout: { recipient_address: string; status: string } }
    expect(replayBody.balance_cents).toBe(50)
    expect(replayBody.payout.status).toBe("confirmed")
    expect(replayBody.payout.recipient_address).toBe("0x1000000000000000000000000000000000000001")

    const otherSession = await exchangeJwt(ctx.env, "reward-cashout-other-user")
    await addWallet(ctx, otherSession.userId, now, "0x2000000000000000000000000000000000000002")
    await addNullifier(ctx, otherSession.userId, now)
    await addRewardEvent(ctx, otherSession.userId, 150, now)
    const sameKeyOtherUser = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(otherSession.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-test-1" }),
      },
      ctx.env,
    )
    expect(sameKeyOtherUser.status).toBe(202)
    expect(settleCount).toBe(2)

    const otherUserCannotReadCashout = await app.request(
      `http://pirate.test/me/rewards/cashouts/${body.payout.id}`,
      { headers: authHeaders(otherSession.accessToken) },
      ctx.env,
    )
    expect(otherUserCannotReadCashout.status).toBe(404)
  })

  test("POST /me/rewards/cashouts can attach a verified Privy wallet at claim time", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-attach-user")
    const now = "2026-07-09T12:00:00.000Z"
    const privySubject = "did:privy:reward-cashout-attach"
    const walletAddress = "0x3000000000000000000000000000000000000003"
    let settleCount = 0
    setRewardSettlementConfirmPollPlanForTests([])
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardattach", nonce: 14, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 14, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardattach", nonce: 14, state: "broadcast" }),
    })
    setPrivyAccessProofVerifierForTests(async ({ accessToken, walletAddress: selectedWalletAddress }) => {
      expect(accessToken).toBe("privy-reward-attach-token")
      expect(selectedWalletAddress).toBe(walletAddress)
      return {
        provider: "privy",
        providerSubject: privySubject,
        providerUserRef: privySubject,
        walletAddresses: [walletAddress.toLowerCase()],
        selectedWalletAddress: walletAddress.toLowerCase(),
        wallets: [
          {
            chainNamespace: "eip155:1",
            walletAddress,
            walletAddressNormalized: walletAddress.toLowerCase(),
            attachmentKind: "embedded",
          },
        ],
        selectedWallet: {
          chainNamespace: "eip155:1",
          walletAddress,
          walletAddressNormalized: walletAddress.toLowerCase(),
          attachmentKind: "embedded",
        },
      }
    })

    await linkPrivySubject(ctx, session.userId, privySubject, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          amount_cents: 100,
          idempotency_key: "reward-cashout-attach-wallet",
          wallet_proof: {
            type: "privy_access_token",
            privy_access_token: "privy-reward-attach-token",
            wallet_address: walletAddress,
          },
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const body = await json(response) as {
      payout: { recipient_address: string; status: string; settlement_ref: string | null }
      balance_cents: number
    }
    expect(body.payout).toMatchObject({
      recipient_address: walletAddress,
      status: "confirmed",
      settlement_ref: "0xrewardattach",
    })
    expect(body.balance_cents).toBe(50)
    expect(settleCount).toBe(1)

    const attached = await ctx.client.execute({
      sql: `
        SELECT chain_namespace, wallet_address_display, attachment_kind, is_primary
        FROM wallet_attachments
        WHERE user_id = ?1
      `,
      args: [session.userId],
    })
    expect(attached.rows).toEqual([
      {
        chain_namespace: "eip155:1",
        wallet_address_display: walletAddress,
        attachment_kind: "embedded",
        is_primary: 1,
      },
    ])
  })

  test("POST /me/rewards/cashouts rejects a claim-time wallet proof linked to another account", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-cashout-proof-user")
    const otherSession = await exchangeJwt(ctx.env, "reward-cashout-proof-other")
    const now = "2026-07-09T12:00:00.000Z"
    const privySubject = "did:privy:reward-cashout-other"
    const walletAddress = "0x4000000000000000000000000000000000000004"
    let settleCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardproof", nonce: 15, state: "broadcast" }
      },
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 15, state: "confirmed" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardproof", nonce: 15, state: "broadcast" }),
    })
    setPrivyAccessProofVerifierForTests(async () => ({
      provider: "privy",
      providerSubject: privySubject,
      providerUserRef: privySubject,
      walletAddresses: [walletAddress.toLowerCase()],
      selectedWalletAddress: walletAddress.toLowerCase(),
      wallets: [
        {
          chainNamespace: "eip155:1",
          walletAddress,
          walletAddressNormalized: walletAddress.toLowerCase(),
          attachmentKind: "embedded",
        },
      ],
      selectedWallet: {
        chainNamespace: "eip155:1",
        walletAddress,
        walletAddressNormalized: walletAddress.toLowerCase(),
        attachmentKind: "embedded",
      },
    }))

    await linkPrivySubject(ctx, otherSession.userId, privySubject, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({
          amount_cents: 100,
          idempotency_key: "reward-cashout-wrong-wallet-proof",
          wallet_proof: {
            type: "privy_access_token",
            privy_access_token: "privy-reward-other-token",
            wallet_address: walletAddress,
          },
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(409)
    expect(settleCount).toBe(0)

    const attached = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM wallet_attachments WHERE user_id = ?1",
      args: [session.userId],
    })
    expect(attached.rows[0]?.count).toBe(0)
  })

  test("submitted reward payouts are reconciled without creating a new payout effect", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-payout-reconcile-user")
    const now = "2026-07-09T12:00:00.000Z"
    let settleCount = 0
    let confirmCount = 0
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => {
        settleCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardreconcile", nonce: 9, state: "broadcast" }
      },
      confirm: async (req, txHash) => {
        confirmCount += 1
        return { idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: 9, state: "confirmed" }
      },
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: "0xrewardreconcile", nonce: 9, state: "broadcast" }),
    })

    await addRewardEvent(ctx, session.userId, 150, now)
    await ctx.client.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address,
          idempotency_key, status, submitted_at, created_at, updated_at
        )
        VALUES (
          'rpe_route_reconcile', ?1, 100, '0x1000000000000000000000000000000000000001',
          'reward-cashout-reconcile', 'submitted', ?2, ?2, ?2
        )
      `,
      args: [session.userId, now],
    })

    const summary = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(summary).toEqual({
      enabled: true,
      scanned: 1,
      confirmed: 1,
      failed: 0,
      pending: 0,
      errors: 0,
    })
    expect(settleCount).toBe(1)
    expect(confirmCount).toBe(1)

    const rows = await ctx.client.execute({
      sql: "SELECT status, settlement_ref FROM reward_payout_effects WHERE idempotency_key = 'reward-cashout-reconcile'",
    })
    expect(rows.rows).toEqual([{ status: "confirmed", settlement_ref: "0xrewardreconcile" }])

    const countRows = await ctx.client.execute({
      sql: "SELECT COUNT(*) AS count FROM reward_payout_effects WHERE user_id = ?1",
      args: [session.userId],
    })
    expect(Number(countRows.rows[0]?.count ?? 0)).toBe(1)
  })

  test("failed preparation payouts eventually fail and release reserved balance", async () => {
    const ctx = await createRouteTestContext({
      REWARDS_READS_ENABLED: "true",
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_IDENTITY_PROVIDER: "self",
      REWARDS_MIN_CASHOUT_CENTS: "100",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "reward-payout-prep-failure-user")
    const now = "2026-07-09T12:00:00.000Z"
    setRewardSettlementCoordinatorForTests({
      settle: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: null, nonce: null, state: "failed_preparation" }),
      confirm: async (req, txHash) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash, nonce: null, state: "failed_preparation" }),
      reconcile: async (req) => ({ idempotencyKey: JSON.stringify(["reward_payout", req.idempotencyKey]), txHash: null, nonce: null, state: "failed_preparation" }),
    })

    await addWallet(ctx, session.userId, now)
    await addNullifier(ctx, session.userId, now)
    await addRewardEvent(ctx, session.userId, 150, now)

    const response = await app.request(
      "http://pirate.test/me/rewards/cashouts",
      {
        method: "POST",
        headers: { ...authHeaders(session.accessToken), "content-type": "application/json" },
        body: JSON.stringify({ amount_cents: 100, idempotency_key: "reward-cashout-prep-fails" }),
      },
      ctx.env,
    )
    expect(response.status).toBe(202)
    const first = await json(response) as { balance_cents: number; payout: { status: string } }
    expect(first.payout.status).toBe("submitted")
    expect(first.balance_cents).toBe(50)

    const firstRetry = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(firstRetry.pending).toBe(1)
    expect(firstRetry.failed).toBe(0)

    const secondRetry = await reconcileSubmittedRewardPayouts({
      env: ctx.env,
      client: ctx.client,
      nowUtc: now,
      limit: 10,
      confirmPollMs: [],
    })
    expect(secondRetry.pending).toBe(0)
    expect(secondRetry.failed).toBe(1)

    const rows = await ctx.client.execute({
      sql: "SELECT status, failure_reason, attempt_count FROM reward_payout_effects WHERE user_id = ?1 AND idempotency_key = ?2",
      args: [session.userId, "reward-cashout-prep-fails"],
    })
    expect(rows.rows).toEqual([{ status: "failed", failure_reason: "failed_preparation", attempt_count: 3 }])

    const summary = await app.request(
      "http://pirate.test/me/rewards",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    const summaryBody = await json(summary) as { balance_cents: number }
    expect(summaryBody.balance_cents).toBe(150)
  })
})
