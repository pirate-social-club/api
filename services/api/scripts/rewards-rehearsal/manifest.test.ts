import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { id } from "ethers"

import {
  createEvidenceFileResolver,
  PINNED_STAGING_ACTION_CID_HASH,
  PINNED_STAGING_ACTION_SOURCE_CID,
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
const ACTION_CID_HASH = `0x${"7c".repeat(32)}`
const ACTION_SOURCE_CID = "QmReviewedStagingRewardVaultAction"

const NOW = new Date("2026-07-26T12:00:00.000Z")
const PINS: ReviewedStagingPins = {
  groupId: GROUP,
  pkpAddress: STAGING_PKP,
  actionCidHash: ACTION_CID_HASH,
  actionSourceCid: ACTION_SOURCE_CID,
}

/**
 * Stub archive. Digests are fixed strings rather than real sha256 values
 * because the parser only ever compares the manifest's claim against whatever
 * the resolver reports — computing a genuine digest here would test node's
 * crypto, not the gate.
 */
const CAPTURE_SHA = "a".repeat(64)
const RESERVE_REFILL_SHA = "d".repeat(64)
const FUNDING_QUOTE_SHA = "e".repeat(64)
const ARCHIVE: Record<string, { sha256: string; byteLength: number }> = {
  "capture-2026-07-26.md": { sha256: CAPTURE_SHA, byteLength: 4096 },
  "dry-run-reserve-refill.md": { sha256: RESERVE_REFILL_SHA, byteLength: 2048 },
  "dry-run-funding-quote.md": { sha256: FUNDING_QUOTE_SHA, byteLength: 2048 },
  // Present, and its digest MATCHES what the reserve-refill fixture claims, so
  // pointing at it changes size and nothing else. A stub with a mismatched
  // digest would be rejected either way and would prove nothing about size.
  "stub.md": { sha256: RESERVE_REFILL_SHA, byteLength: 3 },
}
const EVIDENCE = { resolve: (path: string) => ARCHIVE[path] ?? null }

const dryRun = (switchName: "reserveRefill" | "fundingQuote") =>
  switchName === "reserveRefill"
    ? {
        switchName,
        performedAt: "2026-07-26T10:00:00.000Z",
        evidenceFile: "dry-run-reserve-refill.md",
        evidenceSha256: RESERVE_REFILL_SHA,
        observedBefore: "reserve refill job topped the float up by 1_000_000 atomic",
        observedAfter: "reserve refill job logged disabled_by_flag and moved no funds",
      }
    : {
        switchName,
        performedAt: "2026-07-26T10:20:00.000Z",
        evidenceFile: "dry-run-funding-quote.md",
        evidenceSha256: FUNDING_QUOTE_SHA,
        observedBefore: "POST /funding/quote returned 200 with a quote id",
        observedAfter: "POST /funding/quote returned 503 funding_admission_disabled",
      }

const valid = () => ({
  attestation: {
    capturedAt: "2026-07-26T11:30:00.000Z",
    capturedBy: "rehearsal-operator",
    approvedBy: "independent-approver",
    evidenceReference: "capture-2026-07-26.md",
    evidenceSha256: CAPTURE_SHA,
  },
  lit: {
    usageKeyExecuteInGroups: [GROUP],
    stagingGroupId: GROUP,
    stagingGroupPkpAddresses: [STAGING_PKP],
    stagingGroupActionCidHashes: [ACTION_CID_HASH],
    stagingActionSourceCid: ACTION_SOURCE_CID,
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
    offChainKillSwitchDryRuns: [dryRun("reserveRefill"), dryRun("fundingQuote")],
  },
})

const parse = (raw: unknown, pins: ReviewedStagingPins = PINS) =>
  parseRehearsalManifest(raw, { now: NOW, pins, evidence: EVIDENCE })

const withSection = (section: string, patch: Record<string, unknown>) => {
  const base = valid() as Record<string, Record<string, unknown>>
  return { ...base, [section]: { ...base[section], ...patch } }
}

/**
 * Mutates exactly ONE field of ONE dry run, leaving the other switch's entry
 * untouched. A negative fixture that differs in several fields at once proves
 * only that something was rejected, not which check fired.
 */
const withDryRun = (
  switchName: "reserveRefill" | "fundingQuote",
  patch: Record<string, unknown>,
) =>
  withSection("killSwitches", {
    offChainKillSwitchDryRuns: (["reserveRefill", "fundingQuote"] as const).map((name) =>
      name === switchName ? { ...dryRun(name), ...patch } : dryRun(name),
    ),
  })

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

    it("pins the registered action's CID hash", () => {
      // Registered 2026-07-27 against the deployed Sepolia vault, replacing the
      // group's [0] wildcard. Equal to keccak256 of the raw CID string, which
      // is how Lit derives hashed_cid — asserted below rather than asserted
      // here as a bare literal.
      expect(PINNED_STAGING_ACTION_CID_HASH).toBe(
        "0x7abda558406d7d34e805e2cd4cb45872cfd9abf70793ab9c0afdc0a27565a6d3",
      )
    })

    it("pins a CID hash that is keccak256 of the pinned raw CID", () => {
      // The two pins must describe ONE action. Deriving rather than comparing
      // two literals means a future edit to either cannot silently desync them.
      expect(PINNED_STAGING_ACTION_CID_HASH).toBe(id(PINNED_STAGING_ACTION_SOURCE_CID as string))
    })

    it("pins the raw IPFS CID the executor is configured with", () => {
      expect(PINNED_STAGING_ACTION_SOURCE_CID).toBe(
        "QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7",
      )
    })

    it("refuses while the raw source CID is unpinned", () => {
      expect(() => parse(valid(), { ...PINS, actionSourceCid: null })).toThrow(
        /action source CID is not pinned/u,
      )
    })

    it("refuses a source CID that disagrees with its pin", () => {
      // The correct hash with an unrelated source CID is misleading evidence
      // and could diverge from the executor's configuration.
      expect(() => parse(withSection("lit", { stagingActionSourceCid: "QmSomethingElse" }))).toThrow(
        /does not match the reviewed source-CID pin/u,
      )
    })

    it("refuses while the action CID hash is unpinned", () => {
      expect(() => parse(valid(), { ...PINS, actionCidHash: null })).toThrow(
        /action CID hash is not pinned/u,
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

  describe("action CID-hash scoping", () => {
    it.each(["0", "*"])("rejects the CID wildcard %p", (wildcard) => {
      expect(() => parse(withSection("lit", { stagingGroupActionCidHashes: [wildcard] }))).toThrow(
        /permits every action/u,
      )
    })

    it("rejects a wildcard alongside the reviewed hash", () => {
      expect(() =>
        parse(withSection("lit", { stagingGroupActionCidHashes: [ACTION_CID_HASH, "0"] })),
      ).toThrow(/permits every action/u)
    })

    it("rejects any hash beyond the reviewed one", () => {
      expect(() =>
        parse(
          withSection("lit", {
            stagingGroupActionCidHashes: [ACTION_CID_HASH, `0x${"ab".repeat(32)}`],
          }),
        ),
      ).toThrow(/exactly the reviewed action CID hash/u)
    })

    it("rejects a raw IPFS CID where a bytes32 hash is required", () => {
      // The group stores cidHashesPermitted, not raw CIDs; conflating them
      // would silently compare two different identifier spaces.
      expect(() =>
        parse(withSection("lit", { stagingGroupActionCidHashes: [ACTION_SOURCE_CID] })),
      ).toThrow(/must be a 32-byte hash/u)
    })

    it("normalizes hash case before comparing", () => {
      const manifest = parse(
        withSection("lit", { stagingGroupActionCidHashes: [ACTION_CID_HASH.toUpperCase().replace("0X", "0x")] }),
      )
      expect(manifest.lit.stagingGroupActionCidHashes).toEqual([ACTION_CID_HASH])
    })

    it("records the raw source CID alongside its hash for traceability", () => {
      const manifest = parse(valid())
      expect(manifest.lit.stagingActionSourceCid).toBe(ACTION_SOURCE_CID)
      expect(manifest.lit.stagingGroupActionCidHashes).toEqual([ACTION_CID_HASH])
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
    ])("requires %s before the drill", (field) => {
      expect(() => parse(withSection("killSwitches", { [field]: "" }))).toThrow(
        new RegExp(field, "u"),
      )
    })
  })

  describe("off-chain kill-switch dry runs", () => {
    // The defect this section exists for: the field it replaced was checked
    // only for non-emptiness, so the literal string "NOT PERFORMED" passed.
    it("refuses prose in place of archived dry runs", () => {
      expect(() =>
        parse(withSection("killSwitches", { offChainKillSwitchDryRuns: "NOT PERFORMED" })),
      ).toThrow(/must be an array/u)
    })

    it("refuses when one switch was never exercised", () => {
      expect(() =>
        parse(withSection("killSwitches", { offChainKillSwitchDryRuns: [dryRun("reserveRefill")] })),
      ).toThrow(/missing an entry for: fundingQuote/u)
    })

    it("refuses two runs of the same switch dressed up as full coverage", () => {
      expect(() =>
        parse(
          withSection("killSwitches", {
            offChainKillSwitchDryRuns: [dryRun("reserveRefill"), dryRun("reserveRefill")],
          }),
        ),
      ).toThrow(/more than one entry for a switch/u)
    })

    it("refuses an unknown switch name", () => {
      expect(() =>
        parse(
          withSection("killSwitches", {
            offChainKillSwitchDryRuns: [
              { ...dryRun("reserveRefill"), switchName: "vaultPause" },
              dryRun("fundingQuote"),
            ],
          }),
        ),
      ).toThrow(/switchName must be one of/u)
    })

    it("refuses evidence that is not in the archive", () => {
      expect(() => parse(withDryRun("reserveRefill", { evidenceFile: "missing.md" }))).toThrow(
        /not in the evidence archive/u,
      )
    })

    it("refuses an evidence file too small to record anything", () => {
      expect(() => parse(withDryRun("reserveRefill", { evidenceFile: "stub.md" }))).toThrow(
        /records nothing/u,
      )
    })

    it("refuses a digest that does not match the archived bytes", () => {
      expect(() => parse(withDryRun("reserveRefill", { evidenceSha256: "b".repeat(64) }))).toThrow(
        /digest does not match the archived bytes/u,
      )
    })

    it.each(["/etc/passwd", "../outside.md", "nested/../../outside.md"])(
      "refuses the escaping path %s",
      (evidenceFile) => {
        expect(() => parse(withDryRun("reserveRefill", { evidenceFile }))).toThrow(
          /archive-relative|relative path segments/u,
        )
      },
    )

    it("refuses a stale dry run", () => {
      expect(() =>
        parse(withDryRun("reserveRefill", { performedAt: "2026-07-01T00:00:00.000Z" })),
      ).toThrow(/only describes the deployment it ran against/u)
    })

    it("refuses a dry run performed after the capture it is attested by", () => {
      expect(() =>
        parse(withDryRun("reserveRefill", { performedAt: "2026-07-26T11:45:00.000Z" })),
      ).toThrow(/performed after attestation.capturedAt/u)
    })

    // The check with the most teeth: a switch that was flipped and changed
    // nothing observable is a FAILED dry run, however carefully it is written up.
    it("refuses identical before and after observations", () => {
      expect(() =>
        parse(
          withDryRun("reserveRefill", {
            observedBefore: "refill request accepted",
            observedAfter: "refill request accepted",
          }),
        ),
      ).toThrow(/changed no observable behavior/u)
    })

    it("accepts one verified dry run per switch", () => {
      const parsed = parse(valid())
      expect(parsed.killSwitches.offChainKillSwitchDryRuns.map((run) => run.switchName)).toEqual([
        "reserveRefill",
        "fundingQuote",
      ])
    })
  })

  describe("attestation evidence", () => {
    it("refuses a capture whose evidence file is not archived", () => {
      expect(() =>
        parse(withSection("attestation", { evidenceReference: "missing.md" })),
      ).toThrow(/not in the evidence archive/u)
    })

    it("refuses a capture whose digest does not match the archived bytes", () => {
      expect(() =>
        parse(withSection("attestation", { evidenceSha256: "c".repeat(64) })),
      ).toThrow(/digest does not match the archived bytes/u)
    })

    it("refuses a URL where an archived path is required", () => {
      expect(() =>
        parse(withSection("attestation", { evidenceReference: "/dashboard/capture.png" })),
      ).toThrow(/archive-relative/u)
    })
  })

  // Exercised against a real directory because this is the resolver production
  // uses, and its containment check is the last line of defence if
  // requireArchivePath is ever loosened.
  describe("createEvidenceFileResolver", () => {
    const root = mkdtempSync(join(tmpdir(), "rehearsal-evidence-"))
    const body = "dry run output\n".repeat(8)
    writeFileSync(join(root, "run.md"), body)
    mkdirSync(join(root, "nested"))
    writeFileSync(join(root, "..", "outside.md"), body)
    const resolver = createEvidenceFileResolver(root)

    it("reports the real digest and byte length", () => {
      expect(resolver.resolve("run.md")).toEqual({
        sha256: createHash("sha256").update(body).digest("hex"),
        byteLength: Buffer.byteLength(body),
      })
    })

    it("returns null for an absent file", () => {
      expect(resolver.resolve("absent.md")).toBeNull()
    })

    it("returns null for a directory", () => {
      expect(resolver.resolve("nested")).toBeNull()
    })

    it("refuses to read outside the archive root", () => {
      expect(resolver.resolve("../outside.md")).toBeNull()
    })

    it("refuses an absolute path outside the archive root", () => {
      expect(resolver.resolve(join(root, "..", "outside.md"))).toBeNull()
    })

    // The file genuinely exists and is readable, so only the prefix check can
    // reject it. A non-existent sibling would return null either way.
    it("does not treat a sibling directory with the same prefix as inside", () => {
      const sibling = `${root}-sibling`
      mkdirSync(sibling, { recursive: true })
      writeFileSync(join(sibling, "run.md"), body)
      expect(resolver.resolve(join(sibling, "run.md"))).toBeNull()
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
