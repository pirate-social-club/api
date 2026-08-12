import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import {
  fitsPayoutCapacity,
  orderSongHeads,
  payoutWaitSeconds,
  readFreshPayoutCapacity,
  type RewardPayoutCandidate,
} from "./reward-payout-fairness"

const base: RewardPayoutCandidate = {
  effectId: "rpe_a",
  amountCents: 100,
  createdAt: "2026-07-26T10:00:00.000Z",
  communityId: "community_a",
  postId: "post_a",
  lastSelectedAt: null,
}

describe("reward payout fairness", () => {
  test("keeps only each song head and rotates least-recently selected songs first", () => {
    expect(orderSongHeads([
      { ...base, effectId: "rpe_a2", createdAt: "2026-07-26T10:01:00.000Z" },
      { ...base, effectId: "rpe_a1" },
      {
        ...base,
        effectId: "rpe_b",
        communityId: "community_b",
        postId: "post_b",
        lastSelectedAt: "2026-07-26T09:00:00.000Z",
      },
      {
        ...base,
        effectId: "rpe_c",
        communityId: "community_c",
        postId: "post_c",
        lastSelectedAt: "2026-07-26T09:30:00.000Z",
      },
    ]).map((candidate) => candidate.effectId)).toEqual(["rpe_a1", "rpe_b", "rpe_c"])
  })

  test("treats legacy effects as independent heads", () => {
    expect(orderSongHeads([
      { ...base, effectId: "legacy_1", communityId: null, postId: null },
      { ...base, effectId: "legacy_2", communityId: null, postId: null },
    ])).toHaveLength(2)
  })

  test("uses exact cents-to-USDC atomic capacity", () => {
    expect(fitsPayoutCapacity(base, 1_000_000n)).toBe(true)
    expect(fitsPayoutCapacity(base, 999_999n)).toBe(false)
  })

  test("computes a non-negative wait", () => {
    expect(payoutWaitSeconds(base, Date.parse("2026-07-26T10:01:30.000Z"))).toBe(90)
    expect(payoutWaitSeconds(base, Date.parse("2026-07-26T09:00:00.000Z"))).toBe(0)
  })
})

describe("reward payout capacity freshness", () => {
  const env = {
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
    REWARDS_CAMPAIGN_CHAIN_ID: "84532",
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
    REWARDS_CAPACITY_MAX_OBSERVATION_AGE_SECONDS: "300",
  } as Env

  function clientWith(row: Record<string, unknown> | undefined): Client {
    return {
      execute: async () => ({ rows: row ? [row] : [], columns: [] }),
    } as unknown as Client
  }

  test("returns remaining capacity from a fresh observation", async () => {
    const capacity = await readFreshPayoutCapacity({
      env,
      client: clientWith({
        current_epoch: "7",
        epoch_duration_seconds: "3600",
        chain_id: "84532",
        vault_address: "0x2000000000000000000000000000000000000002",
        payout_epoch_cap_atomic: "5000000",
        payout_spent_atomic: "1250000",
        observed_at: new Date(7 * 3_600_000).toISOString(),
      }),
      nowMs: 7 * 3_600_000 + 299_000,
    })
    expect(capacity).toEqual({
      currentEpoch: 7n,
      remainingAtomic: 3_750_000n,
      observedAt: new Date(7 * 3_600_000).toISOString(),
    })
  })

  test("fails closed on missing, stale, future, and invalid observations", async () => {
    await expect(readFreshPayoutCapacity({ env, client: clientWith(undefined), nowMs: 0 }))
      .rejects.toThrow("missing")
    await expect(readFreshPayoutCapacity({
      env,
      client: clientWith({
        current_epoch: "7",
        epoch_duration_seconds: "3600",
        chain_id: "84532",
        vault_address: "0x2000000000000000000000000000000000000002",
        payout_epoch_cap_atomic: "5",
        payout_spent_atomic: "1",
        observed_at: new Date(7 * 3_600_000).toISOString(),
      }),
      nowMs: 7 * 3_600_000 + 301_000,
    })).rejects.toThrow("stale")
    await expect(readFreshPayoutCapacity({
      env,
      client: clientWith({
        current_epoch: "7",
        epoch_duration_seconds: "3600",
        chain_id: "84532",
        vault_address: "0x2000000000000000000000000000000000000002",
        payout_epoch_cap_atomic: "5",
        payout_spent_atomic: "1",
        observed_at: new Date(7 * 3_600_000 + 60_000).toISOString(),
      }),
      nowMs: 7 * 3_600_000,
    })).rejects.toThrow("stale")
    await expect(readFreshPayoutCapacity({
      env,
      client: clientWith({
        current_epoch: "7",
        epoch_duration_seconds: "3600",
        chain_id: "84532",
        vault_address: "0x2000000000000000000000000000000000000002",
        payout_epoch_cap_atomic: "5",
        payout_spent_atomic: "6",
        observed_at: new Date(7 * 3_600_000).toISOString(),
      }),
      nowMs: 7 * 3_600_000 + 1_000,
    })).rejects.toThrow("invalid")
  })

  test("does not impose vault-capacity admission in local mode", async () => {
    expect(await readFreshPayoutCapacity({
      env: { PIRATE_REWARDS_SETTLEMENT_BACKEND: "local" } as Env,
      client: clientWith(undefined),
      nowMs: 0,
    })).toBeNull()
  })

  test("rejects an invalid freshness configuration instead of silently widening it", async () => {
    await expect(readFreshPayoutCapacity({
      env: { ...env, REWARDS_CAPACITY_MAX_OBSERVATION_AGE_SECONDS: "invalid" } as Env,
      client: clientWith({
        current_epoch: "7",
        epoch_duration_seconds: "3600",
        chain_id: "84532",
        vault_address: "0x2000000000000000000000000000000000000002",
        payout_epoch_cap_atomic: "5",
        payout_spent_atomic: "1",
        observed_at: new Date(7 * 3_600_000).toISOString(),
      }),
      nowMs: 7 * 3_600_000,
    })).rejects.toThrow("configuration is invalid")
  })
})
