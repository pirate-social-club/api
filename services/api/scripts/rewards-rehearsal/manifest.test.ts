import { describe, expect, it } from "bun:test"

import {
  PINNED_STAGING_ACTION_CID,
  PINNED_STAGING_GROUP_ID,
  PINNED_STAGING_PKP_ADDRESS,
  parseRehearsalManifest,
  worstCaseVictimLossAtomic,
  RehearsalManifestError,
  type ReviewedStagingPins,
} from "./manifest"

const STAGING_PKP = PINNED_STAGING_PKP_ADDRESS
const PROD_PKP = "0x00000000000000000000000000000000000000aa"
const GROUP = "1"
const ACTION_CID = "QmReviewedStagingRewardVaultAction"

const NOW = new Date("2026-07-26T12:00:00.000Z")
const PINS: ReviewedStagingPins = {
  groupId: GROUP,
  pkpAddress: STAGING_PKP,
  actionCid: ACTION_CID,
}

const valid = () => ({
  attestation: {
    capturedAt: "2026-07-26T11:30:00.000Z",
    capturedBy: "rehearsal-operator",
    approvedBy: "independent-approver",
    evidenceReference: "https://dashboard.chipotle.litprotocol.com/ capture 2026-07-26",
    evidenceSha256: "a".repeat(64),
  },
  lit: {
    usageKeyExecuteInGroups: [GROUP],
    stagingGroupId: GROUP,
    stagingGroupPkpAddresses: [STAGING_PKP],
    stagingGroupActionCids: [ACTION_CID],
    knownProductionPkpAddresses: [PROD_PKP],
  },
  vault: {
    address: "0x000000000000000000000000000000000000beef",
    bytecodeHash: `0x${"ab".repeat(32)}`,
    ownerSafeAddress: "0x1cd289b6b232e1378d606ba550019e553685ad4c",
    usdcAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
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
  killSwitches: {
    reserveRefillDisableProcedure: "flip PIRATE_REWARDS_RESERVE_REFILL_ENABLED=0",
    fundingQuoteDisableProcedure: "flip PIRATE_REWARDS_FUNDING_ADMISSION=0",
    vaultPauseProcedure: "Safe tx nonce n: setPauseState(true,true)",
    operatorRotationProcedure: "Safe tx nonce n+1: setSettlementOperator(<fresh>)",
    offChainKillSwitchDryRunEvidence: "dry-run 2026-07-26: both flags observed to reject live traffic",
  },
})

const parse = (raw: unknown, pins: ReviewedStagingPins = PINS) =>
  parseRehearsalManifest(raw, { now: NOW, pins })

const withSection = (section: string, patch: Record<string, unknown>) => {
  const base = valid() as Record<string, Record<string, unknown>>
  return { ...base, [section]: { ...base[section], ...patch } }
}

describe("parseRehearsalManifest", () => {
  it("accepts a fully captured, independently attested manifest", () => {
    const manifest = parse(valid())
    expect(manifest.vault.chainId).toBe(84532)
    expect(manifest.lit.usageKeyExecuteInGroups).toEqual([GROUP])
  })

  describe("pins are source-controlled, never manifest-supplied", () => {
    it("refuses while the staging group ID is unpinned", () => {
      expect(() => parse(valid(), { ...PINS, groupId: null })).toThrow(/not pinned/u)
    })

    it("pins the captured staging group", () => {
      expect(PINNED_STAGING_GROUP_ID).toBe("1")
    })

    it("ships with NO action CID pinned, so the drill cannot yet run", () => {
      // The group currently permits the [0] CID wildcard. Until a reviewed CID
      // is registered and the wildcard replaced, no manifest may be produced.
      expect(PINNED_STAGING_ACTION_CID).toBeNull()
    })

    it("refuses while the action CID is unpinned", () => {
      expect(() => parse(valid(), { ...PINS, actionCid: null })).toThrow(
        /reviewed staging action CID is not pinned/u,
      )
    })

    it("refuses a captured group that disagrees with the pin", () => {
      expect(() => parse(withSection("lit", { stagingGroupId: "7", usageKeyExecuteInGroups: ["7"] })))
        .toThrow(/does not match the reviewed pin/u)
    })

    it("refuses a group PKP set that disagrees with the pin", () => {
      expect(() => parse(withSection("lit", { stagingGroupPkpAddresses: [PROD_PKP] }))).toThrow(
        /exactly the pinned staging PKP/u,
      )
    })

    it("refuses a manifest that tries to supply its own ceilings", () => {
      expect(() => parse({ ...valid(), rehearsalCeilings: { maxVaultUsdcAtomic: 1n } })).toThrow(
        /must not be manifest-supplied/u,
      )
    })
  })

  describe("attestation", () => {
    it("refuses a stale capture", () => {
      expect(() => parse(withSection("attestation", { capturedAt: "2026-07-24T11:30:00.000Z" })))
        .toThrow(/must be fresh/u)
    })

    it("refuses a capture timestamped in the future", () => {
      expect(() => parse(withSection("attestation", { capturedAt: "2026-07-27T00:00:00.000Z" })))
        .toThrow(/in the future/u)
    })

    it("refuses self-approval", () => {
      expect(() => parse(withSection("attestation", { approvedBy: "rehearsal-operator" }))).toThrow(
        /independent party/u,
      )
    })

    it.each(["2026-07-26 11:30:00", "26 July 2026", "2026-07-26T11:30:00+02:00"])(
      "refuses non-canonical timestamp %p",
      (capturedAt) => {
        expect(() => parse(withSection("attestation", { capturedAt }))).toThrow(/canonical UTC/u)
      },
    )

    it.each(["", "not-a-hash", "A".repeat(64)])("refuses evidence hash %p", (evidenceSha256) => {
      expect(() => parse(withSection("attestation", { evidenceSha256 }))).toThrow(
        RehearsalManifestError,
      )
    })
  })

  describe("usage-key scope", () => {
    it.each(["0", "*"])("rejects the wildcard group %p", (wildcard) => {
      expect(() => parse(withSection("lit", { usageKeyExecuteInGroups: [wildcard] }))).toThrow(
        /wildcard/u,
      )
    })

    it("rejects a wildcard even when the pinned group is also present", () => {
      expect(() => parse(withSection("lit", { usageKeyExecuteInGroups: [GROUP, "0"] }))).toThrow(
        /wildcard/u,
      )
    })

    it("rejects any group beyond the pinned one", () => {
      expect(() => parse(withSection("lit", { usageKeyExecuteInGroups: [GROUP, "7"] })))
        .toThrow(/must be exactly the pinned staging group/u)
    })

    it("normalizes the API's numeric group id to the pinned string", () => {
      // The Lit API returns can_execute_in_groups: [1]; the pin is "1".
      const manifest = parse(
        withSection("lit", { usageKeyExecuteInGroups: [1], stagingGroupId: 1 }),
      )
      expect(manifest.lit.usageKeyExecuteInGroups).toEqual(["1"])
    })

    it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 2])(
      "rejects the unsafe numeric group id %p rather than coercing it",
      (groupId) => {
        expect(() => parse(withSection("lit", { usageKeyExecuteInGroups: [groupId] }))).toThrow(
          /safe non-negative integer group id/u,
        )
      },
    )

    it("rejects an empty group entry", () => {
      expect(() => parse(withSection("lit", { usageKeyExecuteInGroups: [""] }))).toThrow(
        RehearsalManifestError,
      )
    })
  })

  describe("action CID scoping", () => {
    it.each(["0", "*"])("rejects the CID wildcard %p", (wildcard) => {
      expect(() => parse(withSection("lit", { stagingGroupActionCids: [wildcard] }))).toThrow(
        /permits every action/u,
      )
    })

    it("rejects a wildcard alongside the reviewed CID", () => {
      expect(() =>
        parse(withSection("lit", { stagingGroupActionCids: [ACTION_CID, "0"] })),
      ).toThrow(/permits every action/u)
    })

    it("rejects any CID beyond the reviewed one", () => {
      expect(() =>
        parse(withSection("lit", { stagingGroupActionCids: [ACTION_CID, "QmOther"] })),
      ).toThrow(/exactly the reviewed action CID/u)
    })

    it("rejects a CID that disagrees with the pin", () => {
      expect(() => parse(withSection("lit", { stagingGroupActionCids: ["QmOther"] }))).toThrow(
        /exactly the reviewed action CID/u,
      )
    })
  })

  describe("group membership", () => {
    it("rejects an empty production list, since it cannot prove a check happened", () => {
      expect(() => parse(withSection("lit", { knownProductionPkpAddresses: [] }))).toThrow(
        /cannot prove a check was performed/u,
      )
    })
  })

  describe("chain, policy and balances", () => {
    it("rejects any chain other than Base Sepolia", () => {
      expect(() => parse(withSection("vault", { chainId: 8453 }))).toThrow(/Base Sepolia/u)
    })

    it("rejects caps above the source-controlled ceiling", () => {
      expect(() => parse(withSection("vault", { payoutEpochCapAtomic: 9_000_000n }))).toThrow(
        /source-controlled rehearsal ceiling/u,
      )
    })

    it("rejects balances above the source-controlled ceiling", () => {
      expect(() => parse(withSection("balances", { vaultUsdcAtomic: 9_000_000n }))).toThrow(
        /source-controlled rehearsal ceiling/u,
      )
    })

    it("rejects a per-transfer limit above its own epoch cap", () => {
      expect(() => parse(withSection("vault", { maxRefundAtomic: 60_000n }))).toThrow(
        /exceeds vault.refundEpochCapAtomic/u,
      )
    })

    it.each(["address"])("rejects the zero vault %s", (field) => {
      expect(() =>
        parse(withSection("vault", { [field]: "0x0000000000000000000000000000000000000000" })),
      ).toThrow(/must not be the zero address/u)
    })

    it("rejects a zero settlement operator", () => {
      expect(() =>
        parse(
          withSection("balances", {
            settlementOperatorAddress: "0x0000000000000000000000000000000000000000",
          }),
        ),
      ).toThrow(/must not be the zero address/u)
    })

    it("refuses a numeric value supplied as a number rather than a bigint", () => {
      expect(() => parse(withSection("vault", { policyVersion: 1 as unknown as bigint }))).toThrow(
        /must be supplied as a bigint/u,
      )
    })
  })

  describe("containment levers", () => {
    it.each([
      "reserveRefillDisableProcedure",
      "fundingQuoteDisableProcedure",
      "vaultPauseProcedure",
      "operatorRotationProcedure",
      "offChainKillSwitchDryRunEvidence",
    ])("requires %s before the drill", (field) => {
      expect(() => parse(withSection("killSwitches", { [field]: "" }))).toThrow(
        new RegExp(field, "u"),
      )
    })
  })

  it.each(["attestation", "lit", "vault", "balances", "killSwitches"])(
    "refuses when the %s section is missing entirely",
    (section) => {
      const manifest = valid() as Record<string, unknown>
      delete manifest[section]
      expect(() => parse(manifest)).toThrow(RehearsalManifestError)
    },
  )
})

describe("worstCaseVictimLossAtomic", () => {
  const base = {
    vaultBalanceAtAttackStartAtomic: 1_000_000n,
    victimFundInflowsBeforePauseAtomic: 0n,
    payoutEpochCapAtomic: 50_000n,
    refundEpochCapAtomic: 50_000n,
    epochDurationSeconds: 86_400n,
  }
  const conservative = (containmentWindowSeconds: bigint) =>
    ({ kind: "conservative", containmentWindowSeconds }) as const

  it("counts a sub-epoch window as two buckets, since it can straddle a rollover", () => {
    const result = worstCaseVictimLossAtomic({ ...base, window: conservative(600n) })
    expect(result.epochsTouched).toBe(2n)
    expect(result.lossAtomic).toBe(200_000n)
  })

  it("adds a bucket for each further epoch the window spans", () => {
    const result = worstCaseVictimLossAtomic({ ...base, window: conservative(129_600n) })
    expect(result.epochsTouched).toBe(3n)
  })

  describe("measured windows are derived, never asserted", () => {
    it("uses the vault's own epoch indexing when it does not cross a boundary", () => {
      // Both inside epoch 1: 86_400 <= t < 172_800
      const result = worstCaseVictimLossAtomic({
        ...base,
        window: {
          kind: "measured",
          attackStartedAtSeconds: 90_000n,
          pauseConfirmedAtSeconds: 90_600n,
        },
      })
      expect(result.epochsTouched).toBe(1n)
      expect(result.lossAtomic).toBe(100_000n)
    })

    it("counts two buckets for a short window that straddles a rollover", () => {
      const result = worstCaseVictimLossAtomic({
        ...base,
        window: {
          kind: "measured",
          attackStartedAtSeconds: 172_500n,
          pauseConfirmedAtSeconds: 172_900n,
        },
      })
      expect(result.epochsTouched).toBe(2n)
    })

    it("rejects a pause that precedes the attack", () => {
      expect(() =>
        worstCaseVictimLossAtomic({
          ...base,
          window: {
            kind: "measured",
            attackStartedAtSeconds: 200n,
            pauseConfirmedAtSeconds: 100n,
          },
        }),
      ).toThrow(RehearsalManifestError)
    })
  })

  it("counts refund capacity as attacker budget alongside payout capacity", () => {
    const result = worstCaseVictimLossAtomic({
      ...base,
      refundEpochCapAtomic: 10_000n,
      window: conservative(600n),
    })
    expect(result.lossAtomic).toBe(120_000n)
  })

  it("includes victim inflows received before pause", () => {
    const result = worstCaseVictimLossAtomic({
      ...base,
      vaultBalanceAtAttackStartAtomic: 120_000n,
      victimFundInflowsBeforePauseAtomic: 60_000n,
      window: conservative(600n),
    })
    expect(result.lossAtomic).toBe(180_000n)
  })

  it("is bounded by reachable funds, not capacity alone", () => {
    const result = worstCaseVictimLossAtomic({
      ...base,
      vaultBalanceAtAttackStartAtomic: 5_000n,
      window: conservative(600n),
    })
    expect(result.lossAtomic).toBe(5_000n)
  })

  it.each([
    ["epochDurationSeconds", { epochDurationSeconds: 0n }],
    ["payoutEpochCapAtomic", { payoutEpochCapAtomic: 0n }],
    ["refundEpochCapAtomic", { refundEpochCapAtomic: 0n }],
    ["vaultBalanceAtAttackStartAtomic", { vaultBalanceAtAttackStartAtomic: -1n }],
    ["victimFundInflowsBeforePauseAtomic", { victimFundInflowsBeforePauseAtomic: -1n }],
  ])("rejects invalid %s", (_field, patch) => {
    expect(() =>
      worstCaseVictimLossAtomic({ ...base, ...patch, window: conservative(600n) }),
    ).toThrow(RehearsalManifestError)
  })
})
