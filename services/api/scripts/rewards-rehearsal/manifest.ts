/**
 * Staging manifest for the Base Sepolia adversarial rehearsal.
 *
 * The rehearsal deliberately submits attacker-style arbitrary Lit code using a
 * real scoped usage key. That is safe only if the topology is exactly what we
 * believe it is, so this module refuses to produce a manifest unless every
 * value is supplied explicitly and passes every check.
 *
 * Two structural rules make this a safety gate rather than a consistency check:
 *
 *   1. The limits a manifest is judged against live HERE, in source, not in the
 *      manifest. A capture cannot declare its own ceiling and pass.
 *   2. The expected staging identities are pinned HERE too. The manifest proves
 *      it matches the pin; it does not get to define the pin.
 *
 * There are no defaults and no optional fields on purpose. A missing value is
 * an error, never an assumption.
 *
 * Nothing here executes anything. A parsed manifest is necessary but not
 * sufficient to run the drill; the on-chain preflight must additionally prove
 * the live chain matches what was captured.
 */

/** Base Sepolia. The rehearsal action must target this chain and no other. */
export const REHEARSAL_CHAIN_ID = 84532

/**
 * Source-controlled ceilings. Deliberately NOT manifest-supplied: a capture
 * that could declare its own ceiling would always pass.
 *
 * USDC is 6-decimal, so 5_000_000n is $5.
 */
export const REHEARSAL_LIMITS = {
  maxVaultUsdcAtomic: 5_000_000n,
  maxSignerEthWei: 5_000_000_000_000_000n,
  maxEpochCapAtomic: 2_000_000n,
} as const

/**
 * Reviewed pins for the staging topology.
 *
 * `groupId` is intentionally null: it is still PENDING CAPTURE in the
 * credential ledger, and until a reviewed value is committed here the drill
 * cannot run. That is the intended blocker, expressed in code rather than
 * relying on someone remembering.
 */
export const PINNED_STAGING_GROUP_ID: string | null = null
export const PINNED_STAGING_PKP_ADDRESS = "0x6a1c1a6c780e9f2eb23e564c04b6316864468c46"

/** A capture older than this is refused; topology drifts. */
export const MAX_CAPTURE_AGE_SECONDS = 24 * 60 * 60

/**
 * The Lit wildcard group. A usage key scoped to `[0]` can execute in every
 * group. Its presence is disqualifying regardless of what else is listed.
 */
const WILDCARD_GROUP_IDS = new Set(["0", "*"])

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export type RehearsalManifest = {
  attestation: {
    capturedAt: string
    capturedBy: string
    approvedBy: string
    evidenceReference: string
    evidenceSha256: string
  }
  lit: {
    usageKeyExecuteInGroups: string[]
    stagingGroupId: string
    stagingGroupPkpAddresses: string[]
    stagingGroupActionCids: string[]
    knownProductionPkpAddresses: string[]
  }
  vault: {
    address: string
    bytecodeHash: string
    chainId: number
    policyVersion: bigint
    epochDurationSeconds: bigint
    maxPayoutAtomic: bigint
    payoutEpochCapAtomic: bigint
    maxRefundAtomic: bigint
    refundEpochCapAtomic: bigint
  }
  balances: {
    settlementOperatorAddress: string
    vaultUsdcAtomic: bigint
    signerEthWei: bigint
  }
  killSwitches: {
    reserveRefillDisableProcedure: string
    fundingQuoteDisableProcedure: string
    vaultPauseProcedure: string
    operatorRotationProcedure: string
    /** Proof the two off-chain switches actually change live behavior. */
    offChainKillSwitchDryRunEvidence: string
  }
}

export class RehearsalManifestError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u
const HASH_RE = /^0x[0-9a-fA-F]{64}$/u
const SHA256_RE = /^[0-9a-f]{64}$/u
/** Canonical UTC only. `Date.parse` accepts far too much to be a gate. */
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u

function fail(message: string): never {
  throw new RehearsalManifestError(`rehearsal manifest rejected: ${message}`)
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string; supply it explicitly`)
  }
  return value
}

function requireAddress(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field)
  if (!ADDRESS_RE.test(raw)) fail(`${field} is not a 20-byte address`)
  const normalized = raw.toLowerCase()
  if (normalized === ZERO_ADDRESS) fail(`${field} must not be the zero address`)
  return normalized
}

function requirePositiveBigInt(value: unknown, field: string): bigint {
  if (typeof value !== "bigint") fail(`${field} must be supplied as a bigint`)
  if (value <= 0n) fail(`${field} must be positive`)
  return value
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} must be a non-empty array; an empty list cannot prove a check was performed`)
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`))
}

function requireUtcTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field)
  if (!UTC_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    fail(`${field} must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS[.mmm]Z)`)
  }
  return raw
}

/**
 * Reviewed staging pins the manifest is judged against.
 *
 * Passed in rather than read from module scope so the parser stays pure and
 * testable. The ONLY production source is {@link PINNED_STAGING_GROUP_ID} and
 * {@link PINNED_STAGING_PKP_ADDRESS}; the executable entrypoint must pass those
 * and nothing else. A manifest can never supply its own pins.
 */
export type ReviewedStagingPins = {
  groupId: string | null
  pkpAddress: string
}

export function parseRehearsalManifest(
  raw: unknown,
  options: { now: Date; pins: ReviewedStagingPins },
): RehearsalManifest {
  if (typeof raw !== "object" || raw === null) fail("manifest must be an object")
  const input = raw as Record<string, unknown>

  const attestation = (input.attestation ?? fail("attestation section is missing")) as Record<string, unknown>
  const lit = (input.lit ?? fail("lit section is missing")) as Record<string, unknown>
  const vault = (input.vault ?? fail("vault section is missing")) as Record<string, unknown>
  const balances = (input.balances ?? fail("balances section is missing")) as Record<string, unknown>
  const killSwitches = (input.killSwitches ?? fail("killSwitches section is missing")) as Record<string, unknown>

  if ("rehearsalCeilings" in input) {
    fail("rehearsalCeilings must not be manifest-supplied; limits are source-controlled")
  }

  // --- Gate 0: independently attested, fresh capture.
  const capturedAt = requireUtcTimestamp(attestation.capturedAt, "attestation.capturedAt")
  const ageSeconds = (options.now.getTime() - Date.parse(capturedAt)) / 1000
  if (ageSeconds < 0) fail("attestation.capturedAt is in the future")
  if (ageSeconds > MAX_CAPTURE_AGE_SECONDS) {
    fail(`attestation.capturedAt is ${Math.floor(ageSeconds)}s old; topology capture must be fresh`)
  }
  const capturedBy = requireNonEmptyString(attestation.capturedBy, "attestation.capturedBy")
  const approvedBy = requireNonEmptyString(attestation.approvedBy, "attestation.approvedBy")
  if (capturedBy.trim() === approvedBy.trim()) {
    fail("attestation.approvedBy must be an independent party, not attestation.capturedBy")
  }
  const evidenceReference = requireNonEmptyString(
    attestation.evidenceReference,
    "attestation.evidenceReference",
  )
  const evidenceSha256 = requireNonEmptyString(attestation.evidenceSha256, "attestation.evidenceSha256")
  if (!SHA256_RE.test(evidenceSha256)) {
    fail("attestation.evidenceSha256 must be 64 lowercase hex characters")
  }

  // --- Gate 1: usage-key scope matches the reviewed pin, with no wildcard.
  if (options.pins.groupId === null) {
    fail(
      "the reviewed staging group ID is not pinned; commit it before any attacker-style execution",
    )
  }
  const pinnedGroupId = options.pins.groupId
  const pinnedPkpAddress = requireAddress(options.pins.pkpAddress, "pins.pkpAddress")
  const executeInGroups = requireStringArray(lit.usageKeyExecuteInGroups, "lit.usageKeyExecuteInGroups")
  const stagingGroupId = requireNonEmptyString(lit.stagingGroupId, "lit.stagingGroupId")
  if (stagingGroupId !== pinnedGroupId) {
    fail("lit.stagingGroupId does not match the reviewed pin")
  }
  for (const group of executeInGroups) {
    if (WILDCARD_GROUP_IDS.has(group.trim())) {
      fail(`lit.usageKeyExecuteInGroups contains the wildcard "${group}"; the key can reach every group`)
    }
  }
  if (executeInGroups.length !== 1 || executeInGroups[0] !== pinnedGroupId) {
    fail(
      "lit.usageKeyExecuteInGroups must be exactly the pinned staging group;"
        + ` captured ${JSON.stringify(executeInGroups)}`,
    )
  }

  // --- Gate 2: group membership matches the pin and holds no production identity.
  const groupPkps = requireStringArray(lit.stagingGroupPkpAddresses, "lit.stagingGroupPkpAddresses")
    .map((entry, index) => requireAddress(entry, `lit.stagingGroupPkpAddresses[${index}]`))
  if (groupPkps.length !== 1 || groupPkps[0] !== pinnedPkpAddress) {
    fail("lit.stagingGroupPkpAddresses must be exactly the pinned staging PKP")
  }
  const productionPkps = requireStringArray(
    lit.knownProductionPkpAddresses,
    "lit.knownProductionPkpAddresses",
  ).map((entry, index) => requireAddress(entry, `lit.knownProductionPkpAddresses[${index}]`))
  const overlap = groupPkps.filter((pkp) => productionPkps.includes(pkp))
  if (overlap.length > 0) {
    fail(`staging group contains production-capable PKPs: ${overlap.join(", ")}`)
  }
  const actionCids = requireStringArray(lit.stagingGroupActionCids, "lit.stagingGroupActionCids")

  // --- Gate 3: vault identity, chain, and source-controlled tiny policy.
  if (vault.chainId !== REHEARSAL_CHAIN_ID) {
    fail(`vault.chainId must be Base Sepolia ${REHEARSAL_CHAIN_ID}; captured ${String(vault.chainId)}`)
  }
  const vaultAddress = requireAddress(vault.address, "vault.address")
  const bytecodeHash = requireNonEmptyString(vault.bytecodeHash, "vault.bytecodeHash")
  if (!HASH_RE.test(bytecodeHash)) fail("vault.bytecodeHash is not a 32-byte hash")

  const payoutEpochCap = requirePositiveBigInt(vault.payoutEpochCapAtomic, "vault.payoutEpochCapAtomic")
  const refundEpochCap = requirePositiveBigInt(vault.refundEpochCapAtomic, "vault.refundEpochCapAtomic")
  const maxPayout = requirePositiveBigInt(vault.maxPayoutAtomic, "vault.maxPayoutAtomic")
  const maxRefund = requirePositiveBigInt(vault.maxRefundAtomic, "vault.maxRefundAtomic")
  for (const [label, value] of [
    ["vault.payoutEpochCapAtomic", payoutEpochCap],
    ["vault.refundEpochCapAtomic", refundEpochCap],
  ] as const) {
    if (value > REHEARSAL_LIMITS.maxEpochCapAtomic) {
      fail(
        `${label} (${value}) exceeds the source-controlled rehearsal ceiling`
          + ` (${REHEARSAL_LIMITS.maxEpochCapAtomic}); caps must be tiny`,
      )
    }
  }
  if (maxPayout > payoutEpochCap) fail("vault.maxPayoutAtomic exceeds vault.payoutEpochCapAtomic")
  if (maxRefund > refundEpochCap) fail("vault.maxRefundAtomic exceeds vault.refundEpochCapAtomic")

  // --- Gate 4: balances are minimal, against source-controlled ceilings.
  const vaultUsdc = requirePositiveBigInt(balances.vaultUsdcAtomic, "balances.vaultUsdcAtomic")
  const signerEth = requirePositiveBigInt(balances.signerEthWei, "balances.signerEthWei")
  if (vaultUsdc > REHEARSAL_LIMITS.maxVaultUsdcAtomic) {
    fail(`balances.vaultUsdcAtomic (${vaultUsdc}) exceeds the source-controlled rehearsal ceiling`)
  }
  if (signerEth > REHEARSAL_LIMITS.maxSignerEthWei) {
    fail(`balances.signerEthWei (${signerEth}) exceeds the source-controlled rehearsal ceiling`)
  }

  // --- Gate 5: containment levers documented AND proven to work.
  const containment = {
    reserveRefillDisableProcedure: requireNonEmptyString(
      killSwitches.reserveRefillDisableProcedure,
      "killSwitches.reserveRefillDisableProcedure",
    ),
    fundingQuoteDisableProcedure: requireNonEmptyString(
      killSwitches.fundingQuoteDisableProcedure,
      "killSwitches.fundingQuoteDisableProcedure",
    ),
    vaultPauseProcedure: requireNonEmptyString(
      killSwitches.vaultPauseProcedure,
      "killSwitches.vaultPauseProcedure",
    ),
    operatorRotationProcedure: requireNonEmptyString(
      killSwitches.operatorRotationProcedure,
      "killSwitches.operatorRotationProcedure",
    ),
    offChainKillSwitchDryRunEvidence: requireNonEmptyString(
      killSwitches.offChainKillSwitchDryRunEvidence,
      "killSwitches.offChainKillSwitchDryRunEvidence",
    ),
  }

  return {
    attestation: { capturedAt, capturedBy, approvedBy, evidenceReference, evidenceSha256 },
    lit: {
      usageKeyExecuteInGroups: executeInGroups,
      stagingGroupId,
      stagingGroupPkpAddresses: groupPkps,
      stagingGroupActionCids: actionCids,
      knownProductionPkpAddresses: productionPkps,
    },
    vault: {
      address: vaultAddress,
      bytecodeHash: bytecodeHash.toLowerCase(),
      chainId: REHEARSAL_CHAIN_ID,
      policyVersion: requirePositiveBigInt(vault.policyVersion, "vault.policyVersion"),
      epochDurationSeconds: requirePositiveBigInt(
        vault.epochDurationSeconds,
        "vault.epochDurationSeconds",
      ),
      maxPayoutAtomic: maxPayout,
      payoutEpochCapAtomic: payoutEpochCap,
      maxRefundAtomic: maxRefund,
      refundEpochCapAtomic: refundEpochCap,
    },
    balances: {
      settlementOperatorAddress: requireAddress(
        balances.settlementOperatorAddress,
        "balances.settlementOperatorAddress",
      ),
      vaultUsdcAtomic: vaultUsdc,
      signerEthWei: signerEth,
    },
    killSwitches: containment,
  }
}

/**
 * Containment window, expressed either as measured on-chain fact or as the
 * conservative bound. There is no way to assert a smaller bucket count without
 * supplying the timestamps that prove it.
 */
export type ContainmentWindow =
  | { kind: "measured"; attackStartedAtSeconds: bigint; pauseConfirmedAtSeconds: bigint }
  | { kind: "conservative"; containmentWindowSeconds: bigint }

function requireNonNegative(value: bigint, field: string): bigint {
  if (typeof value !== "bigint") fail(`${field} must be supplied as a bigint`)
  if (value < 0n) fail(`${field} must not be negative`)
  return value
}

/**
 * Worst-case victim loss for a containment window.
 *
 * Gross movement is not victim loss: an attacker topping up the vault inflates
 * the former but not the latter, so only non-attacker inflows count.
 *
 * Epoch buckets are derived, never asserted. A measured window uses the exact
 * epoch indices the vault itself would compute; anything else falls back to
 * `ceil(W / D) + 1`, because a sub-epoch incident straddling a rollover still
 * touches two buckets.
 */
export function worstCaseVictimLossAtomic(input: {
  vaultBalanceAtAttackStartAtomic: bigint
  victimFundInflowsBeforePauseAtomic: bigint
  payoutEpochCapAtomic: bigint
  refundEpochCapAtomic: bigint
  epochDurationSeconds: bigint
  window: ContainmentWindow
}): { lossAtomic: bigint; epochsTouched: bigint } {
  const epochDuration = requirePositiveBigInt(input.epochDurationSeconds, "epochDurationSeconds")
  const balance = requireNonNegative(
    input.vaultBalanceAtAttackStartAtomic,
    "vaultBalanceAtAttackStartAtomic",
  )
  const inflows = requireNonNegative(
    input.victimFundInflowsBeforePauseAtomic,
    "victimFundInflowsBeforePauseAtomic",
  )
  const payoutCap = requirePositiveBigInt(input.payoutEpochCapAtomic, "payoutEpochCapAtomic")
  const refundCap = requirePositiveBigInt(input.refundEpochCapAtomic, "refundEpochCapAtomic")

  let epochsTouched: bigint
  if (input.window.kind === "measured") {
    const started = requireNonNegative(input.window.attackStartedAtSeconds, "attackStartedAtSeconds")
    const paused = requireNonNegative(input.window.pauseConfirmedAtSeconds, "pauseConfirmedAtSeconds")
    if (paused < started) fail("pauseConfirmedAtSeconds precedes attackStartedAtSeconds")
    // Exactly how the vault indexes epochs: block.timestamp / epochDuration.
    epochsTouched = paused / epochDuration - started / epochDuration + 1n
  } else {
    const windowSeconds = requireNonNegative(
      input.window.containmentWindowSeconds,
      "containmentWindowSeconds",
    )
    epochsTouched = (windowSeconds + epochDuration - 1n) / epochDuration + 1n
  }

  const reachable = balance + inflows
  const capacity = epochsTouched * (payoutCap + refundCap)
  return { lossAtomic: reachable < capacity ? reachable : capacity, epochsTouched }
}
