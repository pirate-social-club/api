import { describe, expect, it } from "bun:test"

import {
  parseRehearsalManifest,
  worstCaseVictimLossAtomic,
  RehearsalManifestError,
} from "./manifest"

const STAGING_PKP = "0x6a1c1a6c780e9f2eb23e564c04b6316864468c46"
const PROD_PKP = "0x00000000000000000000000000000000000000aa"

const valid = () => ({
  capturedAt: "2026-07-26T12:00:00.000Z",
  capturedBy: "rewards-rehearsal-operator",
  lit: {
    usageKeyExecuteInGroups: ["grp_rewards_staging"],
    stagingGroupId: "grp_rewards_staging",
    stagingGroupPkpAddresses: [STAGING_PKP],
    stagingGroupActionCids: ["QmStagingRehearsalActionCid"],
    knownProductionPkpAddresses: [PROD_PKP],
  },
  vault: {
    address: "0x000000000000000000000000000000000000beef",
    bytecodeHash: `0x${"ab".repeat(32)}`,
    chainId: 84532,
    policyVersion: 1n,
    epochDurationSeconds: 86_400n,
    maxPayoutAtomic: 10_000n,
    payoutEpochCapAtomic: 50_000n,
    maxRefundAtomic: 10_000n,
    refundEpochCapAtomic: 50_000n,
  },
  balances: {
    settlementOperatorAddress: STAGING_PKP,
    vaultUsdcAtomic: 100_000n,
    signerEthWei: 1_000_000_000_000_000n,
  },
  rehearsalCeilings: {
    maxVaultUsdcAtomic: 1_000_000n,
    maxSignerEthWei: 5_000_000_000_000_000n,
    maxEpochCapAtomic: 100_000n,
  },
  killSwitches: {
    reserveRefillDisableProcedure: "flip PIRATE_REWARDS_RESERVE_REFILL_ENABLED=0",
    fundingQuoteDisableProcedure: "flip PIRATE_REWARDS_FUNDING_ADMISSION=0",
    vaultPauseProcedure: "Safe tx: setPauseState(true,true)",
    operatorRotationProcedure: "Safe tx: setSettlementOperator(<fresh>)",
  },
})

const withLit = (patch: Record<string, unknown>) => ({
  ...valid(),
  lit: { ...valid().lit, ...patch },
})

describe("parseRehearsalManifest", () => {
  it("accepts a fully captured staging manifest", () => {
    const manifest = parseRehearsalManifest(valid())
    expect(manifest.vault.chainId).toBe(84532)
    expect(manifest.lit.usageKeyExecuteInGroups).toEqual(["grp_rewards_staging"])
  })

  it.each(["0", "*"])("rejects the wildcard group %p", (wildcard) => {
    expect(() =>
      parseRehearsalManifest(withLit({ usageKeyExecuteInGroups: [wildcard] })),
    ).toThrow(/wildcard/u)
  })

  it("rejects an empty group entry before it can be read as a wildcard", () => {
    // Caught as a malformed entry rather than as a wildcard. Either way it must
    // never parse; this pins that the blank case is rejected, not the message.
    expect(() => parseRehearsalManifest(withLit({ usageKeyExecuteInGroups: [""] }))).toThrow(
      RehearsalManifestError,
    )
  })

  it("rejects a wildcard even when the staging group is also present", () => {
    expect(() =>
      parseRehearsalManifest(
        withLit({ usageKeyExecuteInGroups: ["grp_rewards_staging", "0"] }),
      ),
    ).toThrow(/wildcard/u)
  })

  it("rejects a key scoped to any group beyond staging", () => {
    expect(() =>
      parseRehearsalManifest(
        withLit({ usageKeyExecuteInGroups: ["grp_rewards_staging", "grp_other"] }),
      ),
    ).toThrow(/must be exactly/u)
  })

  it("rejects a staging group containing a production PKP", () => {
    expect(() =>
      parseRehearsalManifest(
        withLit({ stagingGroupPkpAddresses: [STAGING_PKP, PROD_PKP] }),
      ),
    ).toThrow(/production-capable PKPs/u)
  })

  it("rejects an empty production list, since it cannot prove a check happened", () => {
    expect(() => parseRehearsalManifest(withLit({ knownProductionPkpAddresses: [] }))).toThrow(
      /cannot prove a check was performed/u,
    )
  })

  it("rejects any chain other than Base Sepolia", () => {
    const manifest = valid()
    expect(() =>
      parseRehearsalManifest({ ...manifest, vault: { ...manifest.vault, chainId: 8453 } }),
    ).toThrow(/Base Sepolia/u)
  })

  it("rejects caps above the rehearsal ceiling", () => {
    const manifest = valid()
    expect(() =>
      parseRehearsalManifest({
        ...manifest,
        vault: { ...manifest.vault, payoutEpochCapAtomic: 200_000n },
      }),
    ).toThrow(/caps must be tiny/u)
  })

  it("rejects balances above the rehearsal ceiling", () => {
    const manifest = valid()
    expect(() =>
      parseRehearsalManifest({
        ...manifest,
        balances: { ...manifest.balances, vaultUsdcAtomic: 9_000_000n },
      }),
    ).toThrow(/exceeds the rehearsal ceiling/u)
  })

  it("rejects a per-transfer limit above its own epoch cap", () => {
    const manifest = valid()
    expect(() =>
      parseRehearsalManifest({
        ...manifest,
        vault: { ...manifest.vault, maxRefundAtomic: 60_000n },
      }),
    ).toThrow(/exceeds vault.refundEpochCapAtomic/u)
  })

  it.each([
    "reserveRefillDisableProcedure",
    "fundingQuoteDisableProcedure",
    "vaultPauseProcedure",
    "operatorRotationProcedure",
  ])("requires a written %s before the drill", (field) => {
    const manifest = valid()
    expect(() =>
      parseRehearsalManifest({
        ...manifest,
        killSwitches: { ...manifest.killSwitches, [field]: "" },
      }),
    ).toThrow(new RegExp(field, "u"))
  })

  it.each(["lit", "vault", "balances", "rehearsalCeilings", "killSwitches"])(
    "refuses when the %s section is missing entirely",
    (section) => {
      const manifest = valid() as Record<string, unknown>
      delete manifest[section]
      expect(() => parseRehearsalManifest(manifest)).toThrow(RehearsalManifestError)
    },
  )

  it("refuses a numeric value supplied as a number rather than a bigint", () => {
    const manifest = valid()
    expect(() =>
      parseRehearsalManifest({
        ...manifest,
        vault: { ...manifest.vault, policyVersion: 1 as unknown as bigint },
      }),
    ).toThrow(/must be supplied as a bigint/u)
  })
})

describe("worstCaseVictimLossAtomic", () => {
  const base = {
    vaultBalanceAtAttackStartAtomic: 1_000_000n,
    victimFundInflowsBeforePauseAtomic: 0n,
    payoutEpochCapAtomic: 50_000n,
    refundEpochCapAtomic: 50_000n,
    epochDurationSeconds: 86_400n,
  }

  it("counts a sub-epoch window as two buckets, since it can straddle a rollover", () => {
    const result = worstCaseVictimLossAtomic({ ...base, containmentWindowSeconds: 600n })
    expect(result.epochsTouched).toBe(2n)
    expect(result.lossAtomic).toBe(200_000n)
  })

  it("adds a bucket for each further epoch the window spans", () => {
    // 1.5 days -> ceil(1.5) + 1 = 3
    const result = worstCaseVictimLossAtomic({ ...base, containmentWindowSeconds: 129_600n })
    expect(result.epochsTouched).toBe(3n)
  })

  it("counts refund capacity as attacker budget alongside payout capacity", () => {
    const withoutRefund = worstCaseVictimLossAtomic({
      ...base,
      refundEpochCapAtomic: 0n,
      containmentWindowSeconds: 600n,
    })
    expect(withoutRefund.lossAtomic).toBe(100_000n)
  })

  it("includes victim inflows received before pause", () => {
    const result = worstCaseVictimLossAtomic({
      ...base,
      vaultBalanceAtAttackStartAtomic: 120_000n,
      victimFundInflowsBeforePauseAtomic: 60_000n,
      containmentWindowSeconds: 600n,
    })
    // reachable 180_000 < capacity 200_000
    expect(result.lossAtomic).toBe(180_000n)
  })

  it("is bounded by reachable funds, not by capacity alone", () => {
    const result = worstCaseVictimLossAtomic({
      ...base,
      vaultBalanceAtAttackStartAtomic: 5_000n,
      containmentWindowSeconds: 600n,
    })
    expect(result.lossAtomic).toBe(5_000n)
  })

  it("accepts a proven smaller bucket count when vault timing establishes one", () => {
    const result = worstCaseVictimLossAtomic({
      ...base,
      containmentWindowSeconds: 600n,
      provenEpochsTouched: 1n,
    })
    expect(result.epochsTouched).toBe(1n)
    expect(result.lossAtomic).toBe(100_000n)
  })

  it("rejects a non-positive epoch duration", () => {
    expect(() =>
      worstCaseVictimLossAtomic({ ...base, epochDurationSeconds: 0n, containmentWindowSeconds: 1n }),
    ).toThrow(RehearsalManifestError)
  })
})
