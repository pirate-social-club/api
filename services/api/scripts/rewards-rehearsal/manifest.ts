/**
 * Staging manifest for the Base Sepolia adversarial rehearsal.
 *
 * The rehearsal deliberately submits attacker-style arbitrary Lit code using a
 * real scoped usage key. That is safe only if the topology is exactly what we
 * believe it is, so this module refuses to produce a manifest unless every
 * value is supplied explicitly and passes every check.
 *
 * There are no defaults and no optional fields on purpose. A missing value is
 * an error, never an assumption — an omitted `executeInGroups` must not be
 * read as "probably fine".
 *
 * Nothing here executes anything. Parsing a manifest is necessary but not
 * sufficient to run the drill; see `preflight.ts`, which additionally proves
 * the live chain matches what was captured here.
 */

/** Base Sepolia. The rehearsal action must target this chain and no other. */
export const REHEARSAL_CHAIN_ID = 84532

/**
 * The Lit wildcard group. A usage key scoped to `[0]` can execute in every
 * group, which would let attacker-style code reach identities outside staging.
 * Its presence is disqualifying regardless of what else is in the list.
 */
const WILDCARD_GROUP_IDS = new Set(["0", "*", ""])

export type RehearsalManifest = {
  capturedAt: string
  capturedBy: string
  lit: {
    /** Exact `execute_in_groups` value read back from the usage key. */
    usageKeyExecuteInGroups: string[]
    stagingGroupId: string
    /** Every PKP in the staging group. */
    stagingGroupPkpAddresses: string[]
    /** Every action CID registered to the staging group. */
    stagingGroupActionCids: string[]
    /**
     * Known production-capable PKPs. The staging group must be disjoint from
     * these. Supplying an empty list is rejected: "we checked and there are
     * none" and "we did not check" must not look identical.
     */
    knownProductionPkpAddresses: string[]
  }
  vault: {
    address: string
    /** keccak256 of the deployed runtime bytecode. */
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
  /** Ceilings proving the rehearsal is deliberately tiny. */
  rehearsalCeilings: {
    maxVaultUsdcAtomic: bigint
    maxSignerEthWei: bigint
    maxEpochCapAtomic: bigint
  }
  killSwitches: {
    reserveRefillDisableProcedure: string
    fundingQuoteDisableProcedure: string
    vaultPauseProcedure: string
    operatorRotationProcedure: string
  }
}

export class RehearsalManifestError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u
const HASH_RE = /^0x[0-9a-fA-F]{64}$/u

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
  return raw.toLowerCase()
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

/**
 * Validates a captured staging manifest. Throws on the first violation rather
 * than accumulating, so a partially-captured manifest can never be acted on.
 */
export function parseRehearsalManifest(raw: unknown): RehearsalManifest {
  if (typeof raw !== "object" || raw === null) fail("manifest must be an object")
  const input = raw as Record<string, Record<string, unknown> | unknown>

  const capturedAt = requireNonEmptyString((input as { capturedAt?: unknown }).capturedAt, "capturedAt")
  if (Number.isNaN(Date.parse(capturedAt))) fail("capturedAt must be an ISO-8601 timestamp")
  const capturedBy = requireNonEmptyString((input as { capturedBy?: unknown }).capturedBy, "capturedBy")

  const lit = (input.lit ?? fail("lit section is missing")) as Record<string, unknown>
  const vault = (input.vault ?? fail("vault section is missing")) as Record<string, unknown>
  const balances = (input.balances ?? fail("balances section is missing")) as Record<string, unknown>
  const ceilings = (input.rehearsalCeilings
    ?? fail("rehearsalCeilings section is missing")) as Record<string, unknown>
  const killSwitches = (input.killSwitches
    ?? fail("killSwitches section is missing")) as Record<string, unknown>

  // --- Gate 1: usage-key scope proves no wildcard and nothing beyond staging.
  const executeInGroups = requireStringArray(lit.usageKeyExecuteInGroups, "lit.usageKeyExecuteInGroups")
  const stagingGroupId = requireNonEmptyString(lit.stagingGroupId, "lit.stagingGroupId")
  for (const group of executeInGroups) {
    if (WILDCARD_GROUP_IDS.has(group.trim())) {
      fail(`lit.usageKeyExecuteInGroups contains the wildcard "${group}"; the key can reach every group`)
    }
  }
  if (executeInGroups.length !== 1 || executeInGroups[0] !== stagingGroupId) {
    fail(
      "lit.usageKeyExecuteInGroups must be exactly [stagingGroupId];"
        + ` captured ${JSON.stringify(executeInGroups)}`,
    )
  }

  // --- Gate 2: staging group holds no production-capable identity.
  const groupPkps = requireStringArray(lit.stagingGroupPkpAddresses, "lit.stagingGroupPkpAddresses")
    .map((entry, index) => requireAddress(entry, `lit.stagingGroupPkpAddresses[${index}]`))
  const productionPkps = requireStringArray(
    lit.knownProductionPkpAddresses,
    "lit.knownProductionPkpAddresses",
  ).map((entry, index) => requireAddress(entry, `lit.knownProductionPkpAddresses[${index}]`))
  const overlap = groupPkps.filter((pkp) => productionPkps.includes(pkp))
  if (overlap.length > 0) {
    fail(`staging group contains production-capable PKPs: ${overlap.join(", ")}`)
  }
  const actionCids = requireStringArray(lit.stagingGroupActionCids, "lit.stagingGroupActionCids")

  // --- Gate 3: vault identity, chain, and deliberately tiny policy.
  const chainId = vault.chainId
  if (chainId !== REHEARSAL_CHAIN_ID) {
    fail(`vault.chainId must be Base Sepolia ${REHEARSAL_CHAIN_ID}; captured ${String(chainId)}`)
  }
  const vaultAddress = requireAddress(vault.address, "vault.address")
  const bytecodeHash = requireNonEmptyString(vault.bytecodeHash, "vault.bytecodeHash")
  if (!HASH_RE.test(bytecodeHash)) fail("vault.bytecodeHash is not a 32-byte hash")

  const maxEpochCap = requirePositiveBigInt(ceilings.maxEpochCapAtomic, "rehearsalCeilings.maxEpochCapAtomic")
  const maxVaultUsdc = requirePositiveBigInt(ceilings.maxVaultUsdcAtomic, "rehearsalCeilings.maxVaultUsdcAtomic")
  const maxSignerEth = requirePositiveBigInt(ceilings.maxSignerEthWei, "rehearsalCeilings.maxSignerEthWei")

  const payoutEpochCap = requirePositiveBigInt(vault.payoutEpochCapAtomic, "vault.payoutEpochCapAtomic")
  const refundEpochCap = requirePositiveBigInt(vault.refundEpochCapAtomic, "vault.refundEpochCapAtomic")
  const maxPayout = requirePositiveBigInt(vault.maxPayoutAtomic, "vault.maxPayoutAtomic")
  const maxRefund = requirePositiveBigInt(vault.maxRefundAtomic, "vault.maxRefundAtomic")
  for (const [label, value] of [
    ["vault.payoutEpochCapAtomic", payoutEpochCap],
    ["vault.refundEpochCapAtomic", refundEpochCap],
  ] as const) {
    if (value > maxEpochCap) {
      fail(`${label} (${value}) exceeds the rehearsal ceiling (${maxEpochCap}); caps must be tiny`)
    }
  }
  if (maxPayout > payoutEpochCap) fail("vault.maxPayoutAtomic exceeds vault.payoutEpochCapAtomic")
  if (maxRefund > refundEpochCap) fail("vault.maxRefundAtomic exceeds vault.refundEpochCapAtomic")

  // --- Gate 4: balances are minimal.
  const vaultUsdc = requirePositiveBigInt(balances.vaultUsdcAtomic, "balances.vaultUsdcAtomic")
  const signerEth = requirePositiveBigInt(balances.signerEthWei, "balances.signerEthWei")
  if (vaultUsdc > maxVaultUsdc) {
    fail(`balances.vaultUsdcAtomic (${vaultUsdc}) exceeds the rehearsal ceiling (${maxVaultUsdc})`)
  }
  if (signerEth > maxSignerEth) {
    fail(`balances.signerEthWei (${signerEth}) exceeds the rehearsal ceiling (${maxSignerEth})`)
  }

  // --- Gate 5: every containment lever has a written procedure before we attack.
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
  }

  return {
    capturedAt,
    capturedBy,
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
    rehearsalCeilings: {
      maxVaultUsdcAtomic: maxVaultUsdc,
      maxSignerEthWei: maxSignerEth,
      maxEpochCapAtomic: maxEpochCap,
    },
    killSwitches: containment,
  }
}

/**
 * Worst-case victim loss for a containment window.
 *
 * Gross movement is not the same as victim loss: an attacker topping up the
 * vault inflates the former but not the latter, so only inflows that were not
 * attacker-funded count. Containment can also straddle an epoch rollover, so
 * the number of capacity buckets is `ceil(W / D) + 1` unless exact vault
 * timing proves fewer.
 */
export function worstCaseVictimLossAtomic(input: {
  vaultBalanceAtAttackStartAtomic: bigint
  /** Reserve refills plus new legitimate funding received before pause. */
  victimFundInflowsBeforePauseAtomic: bigint
  payoutEpochCapAtomic: bigint
  refundEpochCapAtomic: bigint
  containmentWindowSeconds: bigint
  epochDurationSeconds: bigint
  /** Supply only when exact vault timing proves a smaller number. */
  provenEpochsTouched?: bigint
}): { lossAtomic: bigint; epochsTouched: bigint } {
  if (input.epochDurationSeconds <= 0n) {
    throw new RehearsalManifestError("epochDurationSeconds must be positive")
  }
  if (input.containmentWindowSeconds < 0n) {
    throw new RehearsalManifestError("containmentWindowSeconds must not be negative")
  }
  const ceilWindows =
    (input.containmentWindowSeconds + input.epochDurationSeconds - 1n) / input.epochDurationSeconds
  const epochsTouched = input.provenEpochsTouched ?? ceilWindows + 1n
  if (epochsTouched <= 0n) throw new RehearsalManifestError("epochsTouched must be positive")

  const reachable =
    input.vaultBalanceAtAttackStartAtomic + input.victimFundInflowsBeforePauseAtomic
  const capacity = epochsTouched * (input.payoutEpochCapAtomic + input.refundEpochCapAtomic)
  return { lossAtomic: reachable < capacity ? reachable : capacity, epochsTouched }
}
