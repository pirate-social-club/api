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
 * Nothing here executes anything, and nothing here touches the network. The
 * parser is pure; the only I/O is reading archived evidence files, which the
 * parser reaches solely through an injected resolver so tests never need a
 * filesystem. A parsed manifest is necessary but not sufficient to run the
 * drill; the on-chain preflight must additionally prove the live chain matches
 * what was captured.
 */

import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { resolve as resolvePath } from "node:path"

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
 * These values were captured from the registered staging group and committed
 * together. Returning either pin to null intentionally blocks execution.
 */
export const PINNED_STAGING_GROUP_ID: string | null = "1"
export const PINNED_STAGING_PKP_ADDRESS = "0x6a1c1a6c780e9f2eb23e564c04b6316864468c46"

/**
 * The HASH of the reviewed action CID the staging group must permit — and
 * permit ALONE.
 *
 * The group stores `cidHashesPermitted` (bytes32), not raw IPFS CIDs. The raw
 * CID is pinned separately in the production executor configuration; the
 * manifest records both so their relationship is auditable.
 *
 * The former `[0]` CID wildcard was replaced by this single reviewed hash.
 */
export const PINNED_STAGING_ACTION_CID_HASH: string | null =
  "0x7abda558406d7d34e805e2cd4cb45872cfd9abf70793ab9c0afdc0a27565a6d3"

/**
 * The raw IPFS CID of the reviewed action — the identifier the production
 * executor is configured with.
 *
 * Pinned alongside the hash so the two cannot diverge: a manifest carrying the
 * correct permitted hash but an unrelated source CID would produce misleading
 * evidence and could disagree with the executor's configuration. Commit both
 * from the SAME action-registration record.
 */
export const PINNED_STAGING_ACTION_SOURCE_CID: string | null =
  "QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7"

/** A capture older than this is refused; topology drifts. */
export const MAX_CAPTURE_AGE_SECONDS = 24 * 60 * 60

/**
 * A kill-switch dry run older than this is refused.
 *
 * Longer than the capture window because a dry run costs real live traffic and
 * cannot be repeated hourly, but still bounded: a dry run proves how the switch
 * behaved against the deployment it ran against, and says nothing about a
 * deployment shipped afterwards.
 */
export const MAX_DRY_RUN_AGE_SECONDS = 7 * 24 * 60 * 60

/** The two off-chain switches. Each must be exercised or explicitly excluded. */
export const OFF_CHAIN_KILL_SWITCHES = ["reserveRefill", "fundingQuote"] as const
export type OffChainKillSwitchName = (typeof OFF_CHAIN_KILL_SWITCHES)[number]
export const EXCLUDED_SWITCH_CONTAINMENT_IMPACT =
  "victim_inflows_before_pause_is_not_controlled" as const

/**
 * The Lit wildcard group. A usage key scoped to `[0]` can execute in every
 * group. Its presence is disqualifying regardless of what else is listed.
 */
const WILDCARD_SENTINELS = new Set(["0", "*"])

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

export type RehearsalManifest = {
  attestation: {
    capturedAt: string
    capturedBy: string
    approvedBy: string
    deploymentGitSha: string
    evidenceReference: string
    evidenceSha256: string
  }
  lit: {
    usageKeyExecuteInGroups: string[]
    stagingGroupId: string
    stagingGroupPkpAddresses: string[]
    /** bytes32 hashes as stored by the group. */
    stagingGroupActionCidHashes: string[]
    /** The raw IPFS CID those hashes correspond to, recorded for traceability. */
    stagingActionSourceCid: string
    knownProductionPkpAddresses: string[]
  }
  vault: {
    address: string
    bytecodeHash: string
    /** The staging administration Safe expected to own the vault. */
    ownerSafeAddress: string
    /** The USDC token the vault is immutably bound to. */
    usdcAddress: string
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
    /**
     * Proof each off-chain switch actually changes live behavior — one entry
     * per exercised switch.
     */
    offChainKillSwitchDryRuns: OffChainKillSwitchDryRun[]
    /**
     * Explicitly excluded switches. This does not claim the switch exists or
     * works; it narrows the containment claim in a machine-readable way.
     */
    offChainKillSwitchExclusions: OffChainKillSwitchExclusion[]
  }
}

export type OffChainKillSwitchObservation = {
  controlState: "enabled" | "disabled"
  outcome: "allowed" | "blocked"
  /** Request id, transaction hash, or archived probe id joining to the evidence file. */
  evidenceId: string
}

/**
 * A single archived dry run of one off-chain kill switch.
 *
 * Structured rather than free text because the previous free-text field
 * accepted the literal string "NOT PERFORMED": any non-empty prose passed.
 * The fields bind an archived record and machine-shaped before/after probes to
 * the exact Worker build that was exercised.
 */
export type OffChainKillSwitchDryRun = {
  switchName: OffChainKillSwitchName
  performedAt: string
  /** Exact Worker build exercised by the dry run. */
  deploymentGitSha: string
  /** Archive-relative path to the run's recorded output. */
  evidenceFile: string
  /** sha256 of that file's bytes, verified by the resolver. */
  evidenceSha256: string
  /** Machine-shaped observations with the switch enabled, then disabled. */
  observedBefore: OffChainKillSwitchObservation
  observedAfter: OffChainKillSwitchObservation
}

export type OffChainKillSwitchExclusion = {
  switchName: OffChainKillSwitchName
  reason: string
  approvedBy: string
  containmentImpact: typeof EXCLUDED_SWITCH_CONTAINMENT_IMPACT
}

/**
 * Resolves archived evidence files.
 *
 * Injected rather than imported so the parser stays pure and testable, exactly
 * as the reviewed pins are. The executable entrypoint
 * ({@link loadReviewedRehearsalManifest}) supplies the real filesystem-backed
 * resolver; a manifest can never supply its own.
 *
 * Returning the file's digest rather than a boolean is deliberate: existence
 * alone is satisfied by an empty placeholder, and the manifest already carries
 * a sha256 that until now hashed nothing verifiable.
 */
export type EvidenceFileResolver = {
  resolve(archiveRelativePath: string): { sha256: string; byteLength: number } | null
}

/**
 * An evidence file smaller than this is treated as absent. A dry-run record
 * that fits in a few bytes has not recorded a dry run.
 */
export const MIN_EVIDENCE_FILE_BYTES = 64

export class RehearsalManifestError extends Error {}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/u
const HASH_RE = /^0x[0-9a-fA-F]{64}$/u
const SHA256_RE = /^[0-9a-f]{64}$/u
const GIT_SHA_RE = /^[0-9a-f]{40}$/u
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
  if (
    typeof value !== "bigint"
    && (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value))
  ) {
    fail(`${field} must be supplied as a bigint or canonical positive-integer string`)
  }
  const parsed = typeof value === "bigint" ? value : BigInt(value)
  if (parsed <= 0n) fail(`${field} must be positive`)
  return parsed
}

/**
 * The Lit API returns group IDs as JSON numbers (`[1]`) while pins are strings.
 * Normalizes safe non-negative integers to their canonical decimal form so the
 * comparison is exact rather than accidentally type-sensitive. Floats, negative
 * and unsafe values are rejected rather than coerced.
 */
function normalizeGroupId(value: unknown, field: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail(`${field} must be a safe non-negative integer group id`)
    }
    return String(value)
  }
  return requireNonEmptyString(value, field)
}

function requireGroupIdArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} must be a non-empty array; an empty list cannot prove a check was performed`)
  }
  return value.map((entry, index) => normalizeGroupId(entry, `${field}[${index}]`))
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${field} must be a non-empty array; an empty list cannot prove a check was performed`)
  }
  return value.map((entry, index) => requireNonEmptyString(entry, `${field}[${index}]`))
}

/** Canonical lowercase bytes32, as the group stores CID hashes. */
function requireBytes32(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field)
  if (!HASH_RE.test(raw)) fail(`${field} must be a 32-byte hash (0x + 64 hex)`)
  return raw.toLowerCase()
}

function requireUtcTimestamp(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field)
  if (!UTC_RE.test(raw) || Number.isNaN(Date.parse(raw))) {
    fail(`${field} must be a canonical UTC timestamp (YYYY-MM-DDTHH:MM:SS[.mmm]Z)`)
  }
  return raw
}

function requireSha256(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field)
  if (!SHA256_RE.test(raw)) fail(`${field} must be 64 lowercase hex characters`)
  return raw
}

function requireGitSha(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field)
  if (!GIT_SHA_RE.test(raw)) fail(`${field} must be a 40-character lowercase git SHA`)
  return raw
}

/**
 * Archive-relative path, restricted so evidence cannot be read from outside the
 * archive. A resolver that accepted `../` or an absolute path would let a
 * manifest point at any file on the machine that happens to hash correctly.
 */
function requireArchivePath(value: unknown, field: string): string {
  const raw = requireNonEmptyString(value, field).trim()
  if (raw.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(raw)) {
    fail(`${field} must be archive-relative, not absolute`)
  }
  if (raw.split(/[\\/]/u).some((segment) => segment === ".." || segment === ".")) {
    fail(`${field} must not contain relative path segments`)
  }
  return raw
}

/**
 * Binds a claimed digest to bytes that actually exist.
 *
 * Existence, size and digest are all checked here rather than split across
 * caller and resolver, so there is exactly one place where "we have evidence"
 * is decided.
 */
function requireVerifiedEvidenceFile(
  resolver: EvidenceFileResolver,
  path: string,
  sha256: string,
  field: string,
): void {
  const resolved = resolver.resolve(path)
  if (resolved === null) fail(`${field} references ${path}, which is not in the evidence archive`)
  if (resolved.byteLength < MIN_EVIDENCE_FILE_BYTES) {
    fail(
      `${field} references ${path}, which is ${resolved.byteLength} bytes;`
        + ` an evidence file under ${MIN_EVIDENCE_FILE_BYTES} bytes records nothing`,
    )
  }
  if (resolved.sha256 !== sha256) {
    fail(`${field} digest does not match the archived bytes of ${path}`)
  }
}

function parseDryRun(
  raw: unknown,
  field: string,
  options: { now: Date; evidence: EvidenceFileResolver; deploymentGitSha: string },
): OffChainKillSwitchDryRun {
  if (typeof raw !== "object" || raw === null) fail(`${field} must be an object`)
  const input = raw as Record<string, unknown>

  const switchName = requireNonEmptyString(input.switchName, `${field}.switchName`)
  if (!OFF_CHAIN_KILL_SWITCHES.includes(switchName as OffChainKillSwitchName)) {
    fail(`${field}.switchName must be one of ${OFF_CHAIN_KILL_SWITCHES.join(", ")}`)
  }

  const performedAt = requireUtcTimestamp(input.performedAt, `${field}.performedAt`)
  const ageSeconds = (options.now.getTime() - Date.parse(performedAt)) / 1000
  if (ageSeconds < 0) fail(`${field}.performedAt is in the future`)
  if (ageSeconds > MAX_DRY_RUN_AGE_SECONDS) {
    fail(
      `${field}.performedAt is ${Math.floor(ageSeconds)}s old; a dry run only describes the`
        + " deployment it ran against",
    )
  }

  const deploymentGitSha = requireGitSha(input.deploymentGitSha, `${field}.deploymentGitSha`)
  if (deploymentGitSha !== options.deploymentGitSha) {
    fail(`${field}.deploymentGitSha does not match the attested deployment`)
  }

  const evidenceFile = requireArchivePath(input.evidenceFile, `${field}.evidenceFile`)
  const evidenceSha256 = requireSha256(input.evidenceSha256, `${field}.evidenceSha256`)
  requireVerifiedEvidenceFile(options.evidence, evidenceFile, evidenceSha256, field)

  const parseObservation = (
    value: unknown,
    observationField: string,
    expected: { controlState: "enabled" | "disabled"; outcome: "allowed" | "blocked" },
  ): OffChainKillSwitchObservation => {
    if (typeof value !== "object" || value === null) fail(`${observationField} must be an object`)
    const observation = value as Record<string, unknown>
    if (observation.controlState !== expected.controlState) {
      fail(`${observationField}.controlState must be ${expected.controlState}`)
    }
    if (observation.outcome !== expected.outcome) {
      fail(`${observationField}.outcome must be ${expected.outcome}`)
    }
    return {
      controlState: expected.controlState,
      outcome: expected.outcome,
      evidenceId: requireNonEmptyString(observation.evidenceId, `${observationField}.evidenceId`),
    }
  }
  const observedBefore = parseObservation(input.observedBefore, `${field}.observedBefore`, {
    controlState: "enabled",
    outcome: "allowed",
  })
  const observedAfter = parseObservation(input.observedAfter, `${field}.observedAfter`, {
    controlState: "disabled",
    outcome: "blocked",
  })
  if (observedBefore.evidenceId === observedAfter.evidenceId) {
    fail(`${field} must reference distinct before and after probe evidence`)
  }

  return {
    switchName: switchName as OffChainKillSwitchName,
    performedAt,
    deploymentGitSha,
    evidenceFile,
    evidenceSha256,
    observedBefore,
    observedAfter,
  }
}

/**
 * Parses the switches that were actually exercised.
 *
 * A single shared record — which is what the previous free-text field was —
 * cannot distinguish "both switches were exercised" from "one was, and the
 * prose says both".
 */
function parseDryRuns(
  raw: unknown,
  options: {
    now: Date
    evidence: EvidenceFileResolver
    capturedAt: string
    deploymentGitSha: string
  },
): OffChainKillSwitchDryRun[] {
  if (!Array.isArray(raw)) {
    fail("killSwitches.offChainKillSwitchDryRuns must be an array with one entry per off-chain switch")
  }
  const runs = raw.map((entry, index) =>
    parseDryRun(entry, `killSwitches.offChainKillSwitchDryRuns[${index}]`, options),
  )

  const capturedAtMs = Date.parse(options.capturedAt)
  for (const run of runs) {
    // The approver signs off on evidence that already exists; a dry run dated
    // after the capture was not part of what was attested.
    if (Date.parse(run.performedAt) > capturedAtMs) {
      fail(
        `killSwitches.offChainKillSwitchDryRuns entry for ${run.switchName} was performed after`
          + " attestation.capturedAt; it cannot be part of the attested capture",
      )
    }
  }

  const seen = new Set(runs.map((run) => run.switchName))
  if (seen.size !== runs.length) {
    fail("killSwitches.offChainKillSwitchDryRuns contains more than one entry for a switch")
  }
  return runs
}

function parseExclusions(raw: unknown, approvedBy: string): OffChainKillSwitchExclusion[] {
  if (!Array.isArray(raw)) fail("killSwitches.offChainKillSwitchExclusions must be an array")
  const exclusions = raw.map((entry, index): OffChainKillSwitchExclusion => {
    const field = `killSwitches.offChainKillSwitchExclusions[${index}]`
    if (typeof entry !== "object" || entry === null) fail(`${field} must be an object`)
    const input = entry as Record<string, unknown>
    const switchName = requireNonEmptyString(input.switchName, `${field}.switchName`)
    if (!OFF_CHAIN_KILL_SWITCHES.includes(switchName as OffChainKillSwitchName)) {
      fail(`${field}.switchName must be one of ${OFF_CHAIN_KILL_SWITCHES.join(", ")}`)
    }
    const exclusionApprover = requireNonEmptyString(input.approvedBy, `${field}.approvedBy`)
    if (exclusionApprover !== approvedBy) {
      fail(`${field}.approvedBy must match attestation.approvedBy`)
    }
    if (input.containmentImpact !== EXCLUDED_SWITCH_CONTAINMENT_IMPACT) {
      fail(`${field}.containmentImpact must explicitly state ${EXCLUDED_SWITCH_CONTAINMENT_IMPACT}`)
    }
    return {
      switchName: switchName as OffChainKillSwitchName,
      reason: requireNonEmptyString(input.reason, `${field}.reason`),
      approvedBy: exclusionApprover,
      containmentImpact: EXCLUDED_SWITCH_CONTAINMENT_IMPACT,
    }
  })
  if (new Set(exclusions.map((entry) => entry.switchName)).size !== exclusions.length) {
    fail("killSwitches.offChainKillSwitchExclusions contains more than one entry for a switch")
  }
  return exclusions
}

/**
 * Reviewed staging pins the manifest is judged against.
 *
 * Passed in rather than read from module scope so the parser stays pure and
 * testable. The ONLY production sources are the four source-controlled pins —
 * {@link PINNED_STAGING_GROUP_ID}, {@link PINNED_STAGING_PKP_ADDRESS},
 * {@link PINNED_STAGING_ACTION_CID_HASH} and
 * {@link PINNED_STAGING_ACTION_SOURCE_CID}. The executable entrypoint
 * ({@link loadReviewedRehearsalManifest}) must pass those and nothing else.
 *
 * Every one of them is part of the trust boundary: the group and PKP bound
 * WHERE the key may execute and WITH WHICH signing identity, and the two action
 * pins bound WHAT may execute and prove the executor's raw CID and the group's
 * permitted hash describe one reviewed action. A manifest can never supply its
 * own pins.
 */
export type ReviewedStagingPins = {
  groupId: string | null
  pkpAddress: string
  actionCidHash: string | null
  actionSourceCid: string | null
}

/**
 * The parser's result. UNTRUSTED: it was validated against whatever pins and
 * clock the caller supplied, which is right for tests and wrong for execution.
 * Nothing that touches the chain or Lit may accept this type.
 */
export type ParsedRehearsalManifest = RehearsalManifest

export function parseRehearsalManifest(
  raw: unknown,
  options: { now: Date; pins: ReviewedStagingPins; evidence: EvidenceFileResolver },
): ParsedRehearsalManifest {
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
  const deploymentGitSha = requireGitSha(
    attestation.deploymentGitSha,
    "attestation.deploymentGitSha",
  )
  if (capturedBy.trim() === approvedBy.trim()) {
    fail("attestation.approvedBy must be an independent party, not attestation.capturedBy")
  }
  // The capture's own evidence gets the same treatment as the dry runs: until
  // now `evidenceSha256` was a well-formed digest of nothing in particular,
  // and `evidenceReference` was any non-empty string.
  const evidenceReference = requireArchivePath(
    attestation.evidenceReference,
    "attestation.evidenceReference",
  )
  const evidenceSha256 = requireSha256(attestation.evidenceSha256, "attestation.evidenceSha256")
  requireVerifiedEvidenceFile(
    options.evidence,
    evidenceReference,
    evidenceSha256,
    "attestation.evidenceReference",
  )

  // --- Gate 1: usage-key scope matches the reviewed pin, with no wildcard.
  if (options.pins.groupId === null) {
    fail(
      "the reviewed staging group ID is not pinned; commit it before any attacker-style execution",
    )
  }
  const pinnedGroupId = options.pins.groupId
  const pinnedPkpAddress = requireAddress(options.pins.pkpAddress, "pins.pkpAddress")
  const executeInGroups = requireGroupIdArray(
    lit.usageKeyExecuteInGroups,
    "lit.usageKeyExecuteInGroups",
  )
  const stagingGroupId = normalizeGroupId(lit.stagingGroupId, "lit.stagingGroupId")
  if (stagingGroupId !== pinnedGroupId) {
    fail("lit.stagingGroupId does not match the reviewed pin")
  }
  for (const group of executeInGroups) {
    if (WILDCARD_SENTINELS.has(group.trim())) {
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
  // A non-empty list is NOT sufficient: the captured wildcard ["0"] is
  // non-empty and permits every action.
  if (options.pins.actionCidHash === null) {
    fail(
      "the reviewed staging action CID hash is not pinned; the action cannot exist until the"
        + " staging vault is deployed, since its address is baked into the action source",
    )
  }
  const pinnedActionCidHash = requireBytes32(options.pins.actionCidHash, "pins.actionCidHash")
  const actionCidHashes = requireStringArray(
    lit.stagingGroupActionCidHashes,
    "lit.stagingGroupActionCidHashes",
  )
  for (const hash of actionCidHashes) {
    if (WILDCARD_SENTINELS.has(hash.trim())) {
      fail(
        `lit.stagingGroupActionCidHashes contains the wildcard "${hash}";`
          + " the group permits every action",
      )
    }
  }
  const normalizedHashes = actionCidHashes.map((hash, index) =>
    requireBytes32(hash, `lit.stagingGroupActionCidHashes[${index}]`),
  )
  if (normalizedHashes.length !== 1 || normalizedHashes[0] !== pinnedActionCidHash) {
    fail(
      "lit.stagingGroupActionCidHashes must be exactly the reviewed action CID hash;"
        + ` captured ${JSON.stringify(normalizedHashes)}`,
    )
  }
  if (options.pins.actionSourceCid === null) {
    fail(
      "the reviewed staging action source CID is not pinned; commit it and its hash from the"
        + " same action-registration record so the two cannot diverge",
    )
  }
  const pinnedSourceCid = requireNonEmptyString(
    options.pins.actionSourceCid,
    "pins.actionSourceCid",
  )
  const stagingActionSourceCid = requireNonEmptyString(
    lit.stagingActionSourceCid,
    "lit.stagingActionSourceCid",
  )
  if (stagingActionSourceCid !== pinnedSourceCid) {
    fail("lit.stagingActionSourceCid does not match the reviewed source-CID pin")
  }

  // --- Gate 3: vault identity, chain, and source-controlled tiny policy.
  if (vault.chainId !== REHEARSAL_CHAIN_ID) {
    fail(`vault.chainId must be Base Sepolia ${REHEARSAL_CHAIN_ID}; captured ${String(vault.chainId)}`)
  }
  const vaultAddress = requireAddress(vault.address, "vault.address")
  const ownerSafeAddress = requireAddress(vault.ownerSafeAddress, "vault.ownerSafeAddress")
  const usdcAddress = requireAddress(vault.usdcAddress, "vault.usdcAddress")
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
  const dryRuns = parseDryRuns(killSwitches.offChainKillSwitchDryRuns, {
    now: options.now,
    evidence: options.evidence,
    capturedAt,
    deploymentGitSha,
  })
  const exclusions = parseExclusions(killSwitches.offChainKillSwitchExclusions, approvedBy)
  const coveredNames = [...dryRuns, ...exclusions].map((entry) => entry.switchName)
  if (new Set(coveredNames).size !== coveredNames.length) {
    fail("an off-chain kill switch cannot be both exercised and excluded")
  }
  const uncovered = OFF_CHAIN_KILL_SWITCHES.filter((name) => !coveredNames.includes(name))
  if (uncovered.length > 0) {
    fail(`off-chain kill-switch coverage is missing: ${uncovered.join(", ")}`)
  }
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
    offChainKillSwitchDryRuns: dryRuns,
    offChainKillSwitchExclusions: exclusions,
  }

  return {
    attestation: {
      capturedAt,
      capturedBy,
      approvedBy,
      deploymentGitSha,
      evidenceReference,
      evidenceSha256,
    },
    lit: {
      usageKeyExecuteInGroups: executeInGroups,
      stagingGroupId,
      stagingGroupPkpAddresses: groupPkps,
      stagingGroupActionCidHashes: normalizedHashes,
      stagingActionSourceCid,
      knownProductionPkpAddresses: productionPkps,
    },
    vault: {
      address: vaultAddress,
      bytecodeHash: bytecodeHash.toLowerCase(),
      ownerSafeAddress,
      usdcAddress,
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

/**
 * Brand owned by this module and deliberately not exported. Without it, an
 * `ExecutableRehearsalManifest` cannot be constructed outside this file except
 * by an explicit unsafe cast, which is greppable and reviewable.
 */
declare const REVIEWED_BRAND: unique symbol

/**
 * A manifest validated against the SOURCE-CONTROLLED pins and limits and the
 * real clock. The on-chain preflight and the drill executor accept only this
 * type, so caller-supplied pins can exercise parsing in tests but cannot reach
 * an executable path.
 */
export type ExecutableRehearsalManifest = RehearsalManifest & {
  readonly [REVIEWED_BRAND]: true
}

/**
 * Filesystem-backed resolver rooted at an evidence archive directory.
 *
 * The root is resolved once and every candidate is checked to be inside it, so
 * a path that escapes the archive is refused even if {@link requireArchivePath}
 * is ever loosened. Absence, directories and unreadable files all resolve to
 * null; the caller decides what that means.
 */
export function createEvidenceFileResolver(archiveRoot: string): EvidenceFileResolver {
  return {
    resolve(archiveRelativePath) {
      const root = resolvePath(archiveRoot)
      const candidate = resolvePath(root, archiveRelativePath)
      if (candidate !== root && !candidate.startsWith(`${root}/`)) return null
      try {
        const stats = statSync(candidate)
        if (!stats.isFile()) return null
        const bytes = readFileSync(candidate)
        return {
          sha256: createHash("sha256").update(bytes).digest("hex"),
          byteLength: bytes.byteLength,
        }
      } catch {
        return null
      }
    },
  }
}

/**
 * The only supported way to obtain an executable manifest. Uses the reviewed
 * pins, the current clock and a real evidence archive; none is caller-supplied
 * except the archive root, which is a location, not a verdict.
 */
export function loadReviewedRehearsalManifest(
  raw: unknown,
  archiveRoot: string,
): ExecutableRehearsalManifest {
  const parsed = parseRehearsalManifest(raw, {
    now: new Date(),
    pins: {
      groupId: PINNED_STAGING_GROUP_ID,
      pkpAddress: PINNED_STAGING_PKP_ADDRESS,
      actionCidHash: PINNED_STAGING_ACTION_CID_HASH,
      actionSourceCid: PINNED_STAGING_ACTION_SOURCE_CID,
    },
    evidence: createEvidenceFileResolver(archiveRoot),
  })
  return parsed as ExecutableRehearsalManifest
}
