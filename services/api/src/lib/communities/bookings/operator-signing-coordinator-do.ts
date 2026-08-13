import { DurableObject } from "cloudflare:workers"

import type { Env } from "../../../env"
import type { RewardVaultReceiptDecision } from "../../rewards/reward-vault-receipt-decision"
import { badRequestError, conflictError } from "../../errors"
import { captureScheduledWarning } from "../../ops-alerts/scheduled"
import { resolveRewardsSettlementBackend } from "../../rewards/reward-vault-lit-config"

const SIGNING_CLAIM_TTL_MS = 60_000
const BROADCAST_RECONCILE_DELAY_MS = 15_000
const RETRY_BASE_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const MAX_UNSENT_PREPARATION_ATTEMPTS = 6
const BROADCAST_FAILURE_ALERT_ATTEMPT = 3
const BROADCAST_LIVENESS_POLL_DELAYS_MS = [0, 250, 750] as const
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/
const OPERATION_ID_RE = /^0x[0-9a-f]{64}$/

export type OperatorKind = "booking" | "checkout" | "rewards"
export type OperatorEffectKind =
  | "booking_payout"
  | "booking_refund"
  | "handle_claim_refund"
  | "reward_cashout"
  | "reward_funding_refund"
export type RewardRehearsalScenario =
  | "eoa_first_payout"
  | "replay"
  | "over_limit"
  | "deadline_expired"
  | "stale_policy"
  | "refund_while_payouts_paused"

export function operatorSigningCoordinatorName(operatorAddress: string, chainId: number, operatorKind: OperatorKind = "booking"): string {
  const a = String(operatorAddress || "").trim()
  if (!EVM_ADDRESS_RE.test(a)) throw badRequestError("Operator signer address is invalid")
  // Lowercase (not EIP-55 checksum) so the DO name needs no ethers dependency; deterministic per wallet.
  // v1 became unreachable in staging before it ever produced a transaction hash.
  // A versioned name gives each wallet domain one coordinator instance. Distinct
  // instances MUST NOT share an address on the same chain: their local nonce
  // journals are disjoint even though each samples the chain pending nonce.
  const prefix = operatorKind === "rewards"
    ? "rewards-operator-signer-v2"
    : operatorKind === "checkout"
      ? "checkout-operator-signer-v1"
      : "booking-operator-signer"
  return `${prefix}:${a.toLowerCase()}:${chainId}`
}

// The DO derives the canonical key itself — a caller cannot supply a colliding key.
export interface OperatorSettleRequest {
  operatorKind?: OperatorKind
  communityId?: string
  bookingId?: string
  userId?: string
  payoutEffectId?: string
  fundingEffectId?: string
  idempotencyKey?: string
  effectKind: OperatorEffectKind
  amountCents?: number
  amountAtomic?: string
  recipientAddress: string
  /** Server-derived staging fixture only; never caller-selected transaction data. */
  rehearsalScenario?: RewardRehearsalScenario
}

export type OperatorSettleState =
  | "reserving"
  | "prepared"
  | "broadcast"
  | "confirmed"
  | "failed_preparation"
  | "preparation_parked"
  | "capacity_deferred"
  | "reconciliation_required"
  | "replaced"
  | "failed_onchain"

export type PreparationFailureStage =
  | "config_resolution"
  | "rpc_nonce_fetch"
  | "broadcast"
  | "lit_request_dispatch"
  | "lit_response"
  | "transaction_verification"
  | "other"

export type PreparationTransportCategory =
  | "certificate"
  | "tls"
  | "dns"
  | "connection_reset"
  | "connection_refused"
  | "connection_lost"
  | "redirect"
  | "timeout"
  | "fetch_failed"
  | "unclassified"

export type PreparationLitErrorToken =
  | "unauthorized_action"
  | "action_fetch_failed"
  | "invalid_params"
  | "timeout"
  | "other_json_error"
  | "other_json_message"
  | "other_json_nested_error"
  | "other_json_unknown"
  | "other_plain_text"
  | "other"
  | "request_invalid"
  | "vault_address_invalid"
  | "vault_address_mismatch"
  | "signer_address_invalid"
  | "signer_address_mismatch"
  | "chain_id_mismatch"
  | "policy_version_mismatch"
  | "method_not_permitted"
  | "operation_id_invalid"
  | "amount_invalid"
  | "deadline_invalid"
  | "deadline_out_of_policy"
  | "nonce_invalid"
  | "gas_policy_missing"
  | "max_fee_per_gas_invalid"
  | "max_priority_fee_per_gas_invalid"
  | "gas_limit_invalid"
  | "gas_policy_exceeded"
  | "pkp_signer_mismatch"

export interface PreparationFailureDiagnostic {
  stage: PreparationFailureStage
  transportCategory: PreparationTransportCategory | null
  httpStatus: number | null
  litErrorToken: PreparationLitErrorToken | null
  latencyMs: number
  classifiedAt: number
}

export interface SettlementFailureDiagnostic {
  selector: string
  errorName: string | null
  transactionHash: string
  blockHash: string
  classifiedAt: string
}

export class OperatorPreparationError extends Error {
  constructor(
    readonly stage: PreparationFailureStage,
    readonly diagnosticCause: unknown,
    readonly latencyMs: number,
  ) {
    super("Operator settlement preparation failed")
    this.name = "OperatorPreparationError"
  }
}

export interface OperatorSettleResult {
  idempotencyKey: string
  /** Present on real coordinator results; optional for legacy RPC/test adapters. */
  operationId?: string | null
  txHash: string | null
  nonce: number | null
  state: OperatorSettleState
  /** Durable retry count; optional for legacy RPC/test adapters. */
  attemptCount?: number
  preparationFailure?: PreparationFailureDiagnostic | null
  settlementFailure?: SettlementFailureDiagnostic | null
  manualResolution?: {
    resolution: "confirmed" | "failed_onchain" | "failed_prebroadcast" | "failed_nonce_invalidated"
    reason: string
    operatorActorId: string
    resolvedAt: number
  } | null
}

interface GasParams { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint }
export type TxLiveness = "success" | "failed" | "pending" | "absent"
/**
 * Maps a durable effect row to the settlement-decision input.
 *
 * Exported and pure so the field bindings are directly testable. The one that
 * matters: the effect id is `booking_id`, which holds
 * `canonicalFields(req).bookingId` from signing (the rpe_/rcf_ id whose keccak
 * is the operation id). It is NOT `idempotency_key`, which is a JSON envelope
 * like ["reward_payout", …] that requestFromRow parses. Deriving the operation
 * id from the wrong column fails every byte-exact verification and silently
 * voids the manual-resolution double-pay guard, while every self-consistent
 * fixture keeps passing.
 */
export function rewardVaultDecisionInputFromRow(row: {
  effect_kind: string
  booking_id: string
  idempotency_key: string
  recipient_address: string
  amount_cents: number
  amount_atomic: string | null
  nonce: number
  signed_tx: string
  tx_hash: string
}): {
  txHash: string
  effectKind: "reward_cashout" | "reward_funding_refund"
  effectId: string
  recipient: string
  nonce: number
  signedTx: string
  amountCents?: number
  amountAtomic?: string
} {
  return {
    txHash: row.tx_hash,
    effectKind: row.effect_kind as "reward_cashout" | "reward_funding_refund",
    effectId: row.booking_id,
    recipient: row.recipient_address,
    nonce: row.nonce,
    signedTx: row.signed_tx,
    // Cashouts are cents and convert with the SAME transferAmount used at
    // signing; wrong-amount custody refunds are natively atomic.
    amountCents: row.effect_kind === "reward_cashout" ? row.amount_cents : undefined,
    amountAtomic: row.effect_kind === "reward_funding_refund"
      ? row.amount_atomic ?? undefined
      : undefined,
  }
}

export function assertManualRewardResolutionEvidence(input: {
  resolution: "confirmed" | "failed_onchain"
  liveness: TxLiveness
  /**
   * The SAME decision the automated path uses. Absent only when the backend is
   * not lit_vault or no receipt exists yet.
   */
  decision?: RewardVaultReceiptDecision
}): void {
  if (input.resolution === "confirmed" && input.liveness !== "success") {
    throw conflictError("Cannot manually confirm rewards settlement without a successful receipt")
  }
  const disposition = input.decision?.disposition
  // Proven-settlement and deferral checks come BEFORE the generic liveness
  // check so the most dangerous condition reports the most specific reason: an
  // operator failing a provably paid effect should be told it was paid, not
  // that the receipt was not failed.
  if (input.resolution === "failed_onchain" && disposition === "confirmed") {
    throw conflictError("Cannot fail rewards settlement after its vault transfer event matched")
  }
  // A deferral is a LIVE claim: the operation id was never consumed, so
  // disposing it as failed and re-cashing-out is the double-pay this guard
  // exists to prevent. A deferral is also a SUCCESSFUL receipt, so the liveness
  // check above cannot catch either direction.
  if (input.resolution === "failed_onchain" && disposition === "capacity_deferred") {
    throw conflictError(
      "Cannot fail rewards settlement that the vault deferred for epoch capacity",
    )
  }
  if (input.resolution === "confirmed" && disposition === "capacity_deferred") {
    throw conflictError(
      "Cannot manually confirm rewards settlement that the vault deferred for epoch capacity",
    )
  }
  if (input.resolution === "failed_onchain" && input.liveness !== "failed") {
    throw conflictError("Cannot manually fail rewards settlement without a failed receipt")
  }
}

export function assertManualRewardNoBroadcastEvidence(input: {
  liveness: TxLiveness
  pendingNonce: number
  expectedNonce: number
}): void {
  if (input.liveness !== "absent" || input.pendingNonce !== input.expectedNonce) {
    throw conflictError("Cannot fail rewards settlement without absent transaction and unchanged pending nonce")
  }
}

export function assertManualRewardInvalidatedBroadcastEvidence(input: {
  liveness: TxLiveness
  latestNonce: number
  pendingNonce: number
  expectedNonce: number
}): void {
  if (
    input.liveness !== "absent"
    || input.latestNonce <= input.expectedNonce
    || input.pendingNonce <= input.expectedNonce
  ) {
    throw conflictError(
      "Cannot fail ambiguous rewards settlement before its nonce is mined by a replacement transaction",
    )
  }
}
export interface ChainPrimitives {
  pendingNonce: (env: Env, operatorKind?: OperatorKind) => Promise<number>
  latestNonce: (env: Env, operatorKind?: OperatorKind) => Promise<number>
  gasParams: (env: Env, operatorKind?: OperatorKind) => Promise<GasParams>
  signVerifiedTransfer: (env: Env, input: {
    to: string
    amountCents?: number
    amountAtomic?: string
    nonce: number
    gas: GasParams
    operatorKind?: OperatorKind
    effectKind: OperatorEffectKind
    effectId: string
    rehearsalScenario?: RewardRehearsalScenario
  }) => Promise<{ signedTx: string; txHash: string; operationId?: string | null }>
  broadcast: (env: Env, input: { signedTx: string; operatorKind?: OperatorKind }) => Promise<void>
  txLiveness: (env: Env, txHash: string, operatorKind?: OperatorKind) => Promise<TxLiveness>
  rewardVaultFailureEvidence?: (env: Env, input: {
    signedTx: string
    txHash: string
    effectKind: Extract<OperatorEffectKind, "reward_cashout" | "reward_funding_refund">
    effectId: string
    recipient: string
    amountCents?: number
    amountAtomic?: string
  }) => Promise<{
    disposition: "capacity_deferred" | "reconciliation_required"
    reason: string
    retryAfterMs: number | null
    compactEvidence: SettlementFailureDiagnostic | null
  }>
  rewardVaultDecision?: (env: Env, input: {
    txHash: string
    effectKind: Extract<OperatorEffectKind, "reward_cashout" | "reward_funding_refund">
    effectId: string
    recipient: string
    nonce: number
    signedTx: string
    amountCents?: number
    amountAtomic?: string
  }) => Promise<RewardVaultReceiptDecision>
}

function normalizeRecipient(raw: string): string {
  const a = String(raw || "").trim()
  if (!EVM_ADDRESS_RE.test(a)) throw badRequestError("Booking settlement recipient address is invalid")
  // Lowercase for the DO's own storage/comparison (no ethers); the real signer re-checksums for the tx.
  return a.toLowerCase()
}
function normalizeAtomicAmount(raw: string | undefined): string | null {
  if (raw == null) return null
  try {
    const amount = BigInt(raw)
    if (amount <= 0n || amount.toString() !== raw) throw new Error("invalid")
    return amount.toString()
  } catch {
    throw badRequestError("Operator settlement atomic amount must be a positive canonical integer")
  }
}
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
function boundedPreparationDiagnostic(error: unknown, classifiedAt: number): PreparationFailureDiagnostic {
  const wrapped = error instanceof OperatorPreparationError ? error : null
  const cause = wrapped?.diagnosticCause ?? error
  const record = cause && typeof cause === "object" ? cause as Record<string, unknown> : {}
  const transportCategories = new Set<PreparationTransportCategory>([
    "certificate", "tls", "dns", "connection_reset", "connection_refused",
    "connection_lost", "redirect", "timeout", "fetch_failed", "unclassified",
  ])
  const litTokens = new Set<PreparationLitErrorToken>([
    "unauthorized_action", "action_fetch_failed", "invalid_params", "timeout",
    "other_json_error", "other_json_message", "other_json_nested_error",
    "other_json_unknown", "other_plain_text", "other",
    "request_invalid", "vault_address_invalid", "vault_address_mismatch",
    "signer_address_invalid", "signer_address_mismatch", "chain_id_mismatch",
    "policy_version_mismatch", "method_not_permitted", "operation_id_invalid",
    "amount_invalid", "deadline_invalid", "deadline_out_of_policy",
    "nonce_invalid", "gas_policy_missing", "max_fee_per_gas_invalid",
    "max_priority_fee_per_gas_invalid", "gas_limit_invalid",
    "gas_policy_exceeded", "pkp_signer_mismatch",
  ])
  const transport = typeof record.transportCategory === "string"
    && transportCategories.has(record.transportCategory as PreparationTransportCategory)
    ? record.transportCategory as PreparationTransportCategory
    : null
  const token = typeof record.litErrorToken === "string"
    && litTokens.has(record.litErrorToken as PreparationLitErrorToken)
    ? record.litErrorToken as PreparationLitErrorToken
    : null
  const status = typeof record.status === "number"
    && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599
    ? record.status
    : null
  return {
    stage: wrapped?.stage ?? "other",
    transportCategory: transport,
    httpStatus: status,
    litErrorToken: token,
    latencyMs: Math.max(0, Math.min(wrapped?.latencyMs ?? 0, 300_000)),
    classifiedAt,
  }
}

const DETERMINISTIC_LIT_PREPARATION_TOKENS = new Set<PreparationLitErrorToken>([
  "unauthorized_action",
  "invalid_params",
  "request_invalid",
  "vault_address_invalid",
  "vault_address_mismatch",
  "signer_address_invalid",
  "signer_address_mismatch",
  "chain_id_mismatch",
  "policy_version_mismatch",
  "method_not_permitted",
  "operation_id_invalid",
  "amount_invalid",
  "deadline_invalid",
  "deadline_out_of_policy",
  "nonce_invalid",
  "gas_policy_missing",
  "max_fee_per_gas_invalid",
  "max_priority_fee_per_gas_invalid",
  "gas_limit_invalid",
  "gas_policy_exceeded",
  "pkp_signer_mismatch",
])

function shouldParkUnsentPreparation(
  row: Pick<EffectRow, "signed_tx" | "tx_hash">,
  diagnostic: PreparationFailureDiagnostic,
  attemptCount: number,
): boolean {
  if (row.signed_tx != null || row.tx_hash != null) return false
  if (attemptCount >= MAX_UNSENT_PREPARATION_ATTEMPTS) return true
  if (diagnostic.stage === "config_resolution" || diagnostic.stage === "transaction_verification") {
    return true
  }
  if (diagnostic.httpStatus === 402) return true
  if (
    diagnostic.httpStatus != null
    && diagnostic.httpStatus >= 400
    && diagnostic.httpStatus < 500
    && ![408, 409, 425, 429].includes(diagnostic.httpStatus)
  ) {
    return true
  }
  return diagnostic.litErrorToken != null
    && DETERMINISTIC_LIT_PREPARATION_TOKENS.has(diagnostic.litErrorToken)
}
function requestOperatorKind(req: OperatorSettleRequest): OperatorKind {
  return req.operatorKind ?? (
    req.effectKind === "reward_cashout" || req.effectKind === "reward_funding_refund"
      ? "rewards"
      : req.effectKind === "handle_claim_refund"
        ? "checkout"
        : "booking"
  )
}
function canonicalFields(req: OperatorSettleRequest): { communityId: string; bookingId: string; effectKind: OperatorEffectKind } {
  const kind = requestOperatorKind(req)
  if (kind === "rewards") {
    if (req.effectKind === "reward_cashout" && req.userId && req.payoutEffectId && req.idempotencyKey) {
      return { communityId: req.userId, bookingId: req.payoutEffectId, effectKind: req.effectKind }
    }
    if (req.effectKind === "reward_funding_refund" && req.fundingEffectId && req.idempotencyKey) {
      return { communityId: "reward_funding", bookingId: req.fundingEffectId, effectKind: req.effectKind }
    }
    throw badRequestError("Rewards settlement request is missing effect identity or idempotency data")
  }
  if (kind === "checkout") {
    if (req.effectKind !== "handle_claim_refund" || !req.fundingEffectId || !req.idempotencyKey) {
      throw badRequestError("Checkout refund request is missing intent identity or idempotency data")
    }
    return { communityId: "community_handle_claim", bookingId: req.fundingEffectId, effectKind: req.effectKind }
  }
  if (!req.communityId || !req.bookingId || (req.effectKind !== "booking_payout" && req.effectKind !== "booking_refund")) {
    throw badRequestError("Operator settlement request is missing community/booking/effect kind")
  }
  return { communityId: req.communityId, bookingId: req.bookingId, effectKind: req.effectKind }
}

// The ethers-backed chain primitives are REGISTERED by the production worker entry (see
// registerOperatorChainPrimitives) so the DO module has no ethers import — keeping ethers (and its
// `ws` transitive cycle under miniflare) out of test worker bundles. Tests inject via the seam.
let registeredChain: ChainPrimitives | null = null
let chainForTests: ChainPrimitives | null = null
export function registerOperatorChainPrimitives(c: ChainPrimitives): void { registeredChain = c }
export function setOperatorChainPrimitivesForTests(p: ChainPrimitives | null): void { chainForTests = p }
function chain(): ChainPrimitives {
  const c = chainForTests ?? registeredChain
  if (!c) throw badRequestError("Operator chain primitives are not configured")
  return c
}

interface EffectRow {
  idempotency_key: string
  community_id: string
  booking_id: string
  effect_kind: string
  amount_cents: number
  amount_atomic: string | null
  recipient_address: string
  operation_id: string | null
  signed_tx: string | null
  tx_hash: string | null
  nonce: number | null
  state: OperatorSettleState
  version: number
  claim_token: string | null
  claim_expires_at: number | null
  attempt_count: number
  next_attempt_at: number | null
  last_error: string | null
  reconciliation_count: number
  manual_resolution: "confirmed" | "failed_onchain" | "failed_prebroadcast" | "failed_nonce_invalidated" | null
  manual_resolution_reason: string | null
  manual_resolved_by: string | null
  manual_resolved_at: number | null
  preparation_stage: PreparationFailureStage | null
  preparation_transport_category: PreparationTransportCategory | null
  preparation_http_status: number | null
  preparation_lit_error_token: PreparationLitErrorToken | null
  preparation_latency_ms: number | null
  preparation_classified_at: number | null
  rehearsal_scenario: RewardRehearsalScenario | null
  settlement_revert_selector: string | null
  settlement_revert_name: string | null
  settlement_transaction_hash: string | null
  settlement_block_hash: string | null
  settlement_classified_at: string | null
}

type MutableEffectFields = Partial<Omit<
  EffectRow,
  | "idempotency_key"
  | "community_id"
  | "booking_id"
  | "effect_kind"
  | "amount_cents"
  | "amount_atomic"
  | "recipient_address"
  | "version"
  | "rehearsal_scenario"
>>

export class OperatorSigningCoordinatorDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS nonce_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_nonce INTEGER NOT NULL)")
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS effects (
        idempotency_key TEXT PRIMARY KEY,
        community_id TEXT NOT NULL, booking_id TEXT NOT NULL, effect_kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, recipient_address TEXT NOT NULL,
        signed_tx TEXT, tx_hash TEXT, nonce INTEGER, state TEXT NOT NULL,
        version INTEGER NOT NULL, claim_token TEXT, claim_expires_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`)
      const schemaVersion = this.ctx.storage.sql.exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations").one().version
      if (schemaVersion < 1) {
        this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (1, ?1)", Date.now())
      }
      if (schemaVersion < 2) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN next_attempt_at INTEGER")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN last_error TEXT")
          this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (2, ?1)", Date.now())
        })
      }
      if (schemaVersion < 3) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN amount_atomic TEXT")
          this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (3, ?1)", Date.now())
        })
      }
      if (schemaVersion < 4) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN operation_id TEXT")
          this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (4, ?1)", Date.now())
        })
      }
      if (schemaVersion < 5) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN reconciliation_count INTEGER NOT NULL DEFAULT 0")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN manual_resolution TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN manual_resolution_reason TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN manual_resolved_by TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN manual_resolved_at INTEGER")
          this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (5, ?1)", Date.now())
        })
      }
      if (schemaVersion < 6) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN preparation_stage TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN preparation_transport_category TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN preparation_http_status INTEGER")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN preparation_lit_error_token TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN preparation_latency_ms INTEGER")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN preparation_classified_at INTEGER")
          this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (6, ?1)", Date.now())
        })
      }
      if (schemaVersion < 7) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN rehearsal_scenario TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN settlement_revert_selector TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN settlement_revert_name TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN settlement_transaction_hash TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN settlement_block_hash TEXT")
          this.ctx.storage.sql.exec("ALTER TABLE effects ADD COLUMN settlement_classified_at TEXT")
          this.ctx.storage.sql.exec("INSERT INTO _sql_schema_migrations (id, applied_at) VALUES (7, ?1)", Date.now())
        })
      }
    })
  }

  async settle(req: OperatorSettleRequest): Promise<OperatorSettleResult> {
    this.assertRehearsalRequest(req)
    const key = this.deriveKey(req)
    const recipient = normalizeRecipient(req.recipientAddress)
    this.assertAmount(req)

    let row = this.read(key)
    if (row) this.assertImmutable(row, req, recipient)
    if (!row) row = this.enqueueOrGet(key, req, recipient)
    if (!this.isTerminal(row)) await this.ensureAlarm(row.next_attempt_at ?? Date.now())
    return this.result(row)
  }

  async confirm(req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult> {
    const key = this.deriveKey(req)
    const row = this.read(key)
    if (!row) throw conflictError("Operator settlement effect not found")
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    if (row.tx_hash !== txHash) throw conflictError("Operator settlement confirmation hash mismatch")
    const current = this.isTerminal(row) ? row : this.expedite(row)
    if (!this.isTerminal(current)) await this.ensureAlarm(Date.now())
    return this.result(current)
  }

  async reconcile(req: OperatorSettleRequest): Promise<OperatorSettleResult> {
    const key = this.deriveKey(req)
    const row = this.read(key)
    if (!row) throw conflictError("Operator settlement effect not found")
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    const current = this.isTerminal(row) ? row : this.expedite(row)
    if (!this.isTerminal(current)) await this.ensureAlarm(Date.now())
    return this.result(current)
  }

  /** Explicit operator recovery only; ordinary settle/reconcile polling never unparks an effect. */
  async retryParkedPreparation(req: OperatorSettleRequest): Promise<OperatorSettleResult> {
    this.assertRehearsalRequest(req)
    const key = this.deriveKey(req)
    const row = this.read(key)
    if (!row) throw conflictError("Operator settlement effect not found")
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    if (row.state !== "preparation_parked" || row.signed_tx != null || row.tx_hash != null) {
      throw conflictError("Operator settlement effect is not parked before signing")
    }
    const reset = this.cas(row.idempotency_key, row.version, {
      state: "reserving",
      nonce: null,
      claim_token: null,
      claim_expires_at: null,
      attempt_count: 0,
      next_attempt_at: Date.now(),
      last_error: null,
      preparation_stage: null,
      preparation_transport_category: null,
      preparation_http_status: null,
      preparation_lit_error_token: null,
      preparation_latency_ms: null,
      preparation_classified_at: null,
    })
    if (!reset) throw conflictError("Operator settlement effect changed during preparation retry")
    await this.ensureAlarm(Date.now())
    return this.result(reset)
  }

  async alarm(): Promise<void> {
    const row = this.nextActive()
    if (!row) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const now = Date.now()
    const runnableAt = this.runnableAt(row, now)
    if (runnableAt > now) {
      await this.ensureAlarm(runnableAt)
      return
    }
    try {
      await this.advance(row)
    } catch (error) {
      const current = this.read(row.idempotency_key)
      const updated = current && !this.isTerminal(current) ? this.recordRetry(current, error) : current
      const parkedBroadcast = updated?.state === "preparation_parked"
        && updated.preparation_stage === "broadcast"
      if (updated?.state === "preparation_parked" && !parkedBroadcast) {
        await captureScheduledWarning(
          this.env,
          "Operator settlement preparation parked",
          `operator_settlement_preparation_parked:${updated.idempotency_key}`,
          {
            effect: updated.idempotency_key,
            effect_kind: updated.effect_kind,
            attempt_count: updated.attempt_count,
            preparation_stage: updated.preparation_stage,
            preparation_http_status: updated.preparation_http_status,
            preparation_lit_error_token: updated.preparation_lit_error_token,
          },
          { urgency: "high" },
        ).catch((alertError) => {
          console.error(JSON.stringify({
            message: "parked operator preparation alert failed",
            effect: updated.idempotency_key,
            error: errMsg(alertError),
          }))
        })
      }
      if (
        (updated?.state === "prepared" || updated?.state === "preparation_parked")
        && updated.preparation_stage === "broadcast"
        && updated.attempt_count === BROADCAST_FAILURE_ALERT_ATTEMPT
      ) {
        await captureScheduledWarning(
          this.env,
          "Operator settlement broadcast remains unsubmitted",
          `operator_settlement_broadcast_failed:${updated.operation_id ?? updated.idempotency_key}`,
          {
            operation_id: updated.operation_id,
            effect: updated.idempotency_key,
            effect_kind: updated.effect_kind,
            attempt_count: updated.attempt_count,
            preparation_stage: updated.preparation_stage,
            preparation_http_status: updated.preparation_http_status,
            preparation_transport_category: updated.preparation_transport_category,
          },
          { urgency: "high" },
        ).catch((alertError) => {
          console.error(JSON.stringify({
            message: "operator settlement broadcast alert failed",
            effect: updated.idempotency_key,
            error: errMsg(alertError),
          }))
        })
      }
      console.error(JSON.stringify({
        message: "operator chain executor alarm failed",
        effect: row.idempotency_key,
        error: errMsg(error),
      }))
    }
    await this.scheduleNext()
  }

  lookup(req: OperatorSettleRequest): OperatorSettleResult | null {
    const row = this.read(this.deriveKey(req))
    if (!row) return null
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    return this.result(row)
  }

  lookupByKey(idempotencyKey: string): OperatorSettleResult | null {
    const row = this.read(String(idempotencyKey ?? ""))
    return row ? this.result(row) : null
  }

  async resolveRewardReconciliation(input: {
    idempotencyKey: string
    expectedTxHash: string
    resolution: "confirmed" | "failed_onchain"
    reason: string
    operatorActorId: string
  }): Promise<OperatorSettleResult> {
    const row = this.read(String(input.idempotencyKey ?? ""))
    if (!row || this.operatorKind(row) !== "rewards") {
      throw conflictError("Rewards settlement effect not found")
    }
    if (row.state !== "reconciliation_required") {
      throw conflictError("Rewards settlement effect is not awaiting manual reconciliation")
    }
    const expectedTxHash = String(input.expectedTxHash ?? "").trim().toLowerCase()
    if (!/^0x[0-9a-f]{64}$/.test(expectedTxHash) || row.tx_hash?.toLowerCase() !== expectedTxHash) {
      throw conflictError("Rewards settlement manual resolution transaction hash mismatch")
    }
    if (input.resolution !== "confirmed" && input.resolution !== "failed_onchain") {
      throw badRequestError("Rewards settlement manual resolution is invalid")
    }
    const reason = String(input.reason ?? "").trim()
    const operatorActorId = String(input.operatorActorId ?? "").trim()
    if (reason.length < 10 || reason.length > 1_000) {
      throw badRequestError("Rewards settlement manual resolution reason must be 10-1000 characters")
    }
    if (!operatorActorId || operatorActorId.length > 200) {
      throw badRequestError("Rewards settlement manual resolver identity is invalid")
    }
    const liveness = await chain().txLiveness(this.env, expectedTxHash, "rewards")
    // The manual route uses the SAME verifier-first decision as reconciliation,
    // so the human override can never rest on weaker evidence than the
    // automated path it overrides.
    const decision = this.usesRewardVault() ? await this.decideRewardVaultReceipt(row) : undefined
    assertManualRewardResolutionEvidence({
      resolution: input.resolution,
      liveness,
      decision,
    })
    const resolvedAt = Date.now()
    const resolved = this.cas(row.idempotency_key, row.version, {
      state: input.resolution,
      next_attempt_at: null,
      last_error: null,
      manual_resolution: input.resolution,
      manual_resolution_reason: reason,
      manual_resolved_by: operatorActorId,
      manual_resolved_at: resolvedAt,
    })
    if (!resolved) throw conflictError("Rewards settlement effect changed during manual resolution")
    await captureScheduledWarning(
      this.env,
      "Rewards settlement reconciliation manually resolved",
      `reward_settlement_manual_resolution:${row.operation_id ?? row.idempotency_key}`,
      {
        operation_id: row.operation_id,
        tx_hash: row.tx_hash,
        resolution: input.resolution,
        operator_actor_id: operatorActorId,
        reason,
      },
      { urgency: "high" },
    ).catch((error) => {
      console.error(JSON.stringify({
        message: "manual rewards settlement resolution alert failed",
        effect: row.idempotency_key,
        error: errMsg(error),
      }))
    })
    return this.result(resolved)
  }

  async resolveRewardNoBroadcast(input: {
    idempotencyKey: string
    expectedTxHash: string
    expectedNonce: number
    reason: string
    operatorActorId: string
  }): Promise<OperatorSettleResult> {
    const row = this.read(String(input.idempotencyKey ?? ""))
    if (!row || this.operatorKind(row) !== "rewards") {
      throw conflictError("Rewards settlement effect not found")
    }
    if (row.state !== "prepared" || !row.signed_tx || !row.tx_hash || row.nonce == null) {
      throw conflictError("Rewards settlement effect is not awaiting pre-broadcast recovery")
    }
    const expectedTxHash = String(input.expectedTxHash ?? "").trim().toLowerCase()
    if (row.tx_hash.toLowerCase() !== expectedTxHash || row.nonce !== input.expectedNonce) {
      throw conflictError("Rewards pre-broadcast recovery evidence mismatch")
    }
    const reason = String(input.reason ?? "").trim()
    const operatorActorId = String(input.operatorActorId ?? "").trim()
    if (reason.length < 10 || reason.length > 1_000) {
      throw badRequestError("Rewards pre-broadcast recovery reason must be 10-1000 characters")
    }
    if (!operatorActorId || operatorActorId.length > 200) {
      throw badRequestError("Rewards pre-broadcast resolver identity is invalid")
    }
    const [liveness, pendingNonce] = await Promise.all([
      chain().txLiveness(this.env, expectedTxHash, "rewards"),
      chain().pendingNonce(this.env, "rewards"),
    ])
    assertManualRewardNoBroadcastEvidence({ liveness, pendingNonce, expectedNonce: row.nonce })
    const resolvedAt = Date.now()
    const resolved = this.cas(row.idempotency_key, row.version, {
      state: "preparation_parked",
      signed_tx: null,
      // This branch is admitted only while the transaction is absent and the
      // chain pending nonce is still exactly the reserved nonce. Release that
      // reusable tail nonce; retaining it makes reserveNonce skip a safe nonce
      // and creates a gap that blocks every later transaction behind it.
      nonce: null,
      next_attempt_at: null,
      last_error: `operator-confirmed no broadcast: ${reason}`.slice(0, 1_000),
      manual_resolution: "failed_prebroadcast",
      manual_resolution_reason: reason,
      manual_resolved_by: operatorActorId,
      manual_resolved_at: resolvedAt,
    })
    if (!resolved) throw conflictError("Rewards settlement effect changed during pre-broadcast recovery")
    await captureScheduledWarning(
      this.env,
      "Rewards settlement pre-broadcast failure manually resolved",
      `reward_settlement_prebroadcast_resolution:${row.operation_id ?? row.idempotency_key}`,
      {
        operation_id: row.operation_id,
        tx_hash: row.tx_hash,
        nonce: row.nonce,
        resolution: "failed_prebroadcast",
        operator_actor_id: operatorActorId,
        reason,
      },
      { urgency: "high" },
    ).catch((error) => {
      console.error(JSON.stringify({
        message: "manual rewards pre-broadcast resolution alert failed",
        effect: row.idempotency_key,
        error: errMsg(error),
      }))
    })
    return this.result(resolved)
  }

  async resolveRewardInvalidatedBroadcast(input: {
    idempotencyKey: string
    expectedTxHash: string
    expectedNonce: number
    reason: string
    operatorActorId: string
  }): Promise<OperatorSettleResult> {
    const row = this.read(String(input.idempotencyKey ?? ""))
    if (!row || this.operatorKind(row) !== "rewards") {
      throw conflictError("Rewards settlement effect not found")
    }
    if (row.state !== "preparation_parked" || !row.signed_tx || !row.tx_hash || row.nonce == null) {
      throw conflictError("Rewards settlement effect is not parked after an ambiguous broadcast")
    }
    const expectedTxHash = String(input.expectedTxHash ?? "").trim().toLowerCase()
    if (row.tx_hash.toLowerCase() !== expectedTxHash || row.nonce !== input.expectedNonce) {
      throw conflictError("Rewards invalidated-broadcast recovery evidence mismatch")
    }
    const reason = String(input.reason ?? "").trim()
    const operatorActorId = String(input.operatorActorId ?? "").trim()
    if (reason.length < 10 || reason.length > 1_000) {
      throw badRequestError("Rewards invalidated-broadcast recovery reason must be 10-1000 characters")
    }
    if (!operatorActorId || operatorActorId.length > 200) {
      throw badRequestError("Rewards invalidated-broadcast resolver identity is invalid")
    }
    const [liveness, latestNonce, pendingNonce] = await Promise.all([
      chain().txLiveness(this.env, expectedTxHash, "rewards"),
      chain().latestNonce(this.env, "rewards"),
      chain().pendingNonce(this.env, "rewards"),
    ])
    assertManualRewardInvalidatedBroadcastEvidence({
      liveness,
      latestNonce,
      pendingNonce,
      expectedNonce: row.nonce,
    })
    const resolvedAt = Date.now()
    const resolved = this.cas(row.idempotency_key, row.version, {
      signed_tx: null,
      next_attempt_at: null,
      last_error: `operator-confirmed nonce invalidation: ${reason}`.slice(0, 1_000),
      manual_resolution: "failed_nonce_invalidated",
      manual_resolution_reason: reason,
      manual_resolved_by: operatorActorId,
      manual_resolved_at: resolvedAt,
    })
    if (!resolved) throw conflictError("Rewards settlement effect changed during nonce invalidation recovery")
    await captureScheduledWarning(
      this.env,
      "Rewards settlement ambiguous broadcast invalidated on-chain",
      `reward_settlement_nonce_invalidation:${row.operation_id ?? row.idempotency_key}`,
      {
        operation_id: row.operation_id,
        tx_hash: row.tx_hash,
        nonce: row.nonce,
        latest_nonce: latestNonce,
        pending_nonce: pendingNonce,
        resolution: "failed_nonce_invalidated",
        operator_actor_id: operatorActorId,
        reason,
      },
      { urgency: "high" },
    ).catch((error) => {
      console.error(JSON.stringify({
        message: "manual rewards nonce invalidation alert failed",
        effect: row.idempotency_key,
        error: errMsg(error),
      }))
    })
    return this.result(resolved)
  }

  // --- internals -------------------------------------------------------------------------------

  /** Atomic durable inbox insert. RPC callers never allocate a nonce or perform external I/O. */
  private enqueueOrGet(key: string, req: OperatorSettleRequest, recipient: string): EffectRow {
    const fields = canonicalFields(req)
    return this.ctx.storage.transactionSync(() => {
      const existing = this.read(key)
      if (existing) return existing
      const now = Date.now()
      this.ctx.storage.sql.exec(
        `INSERT INTO effects (
           idempotency_key, community_id, booking_id, effect_kind, amount_cents, amount_atomic, recipient_address,
           signed_tx, tx_hash, nonce, state, version, claim_token, claim_expires_at,
           created_at, updated_at, attempt_count, next_attempt_at, last_error, rehearsal_scenario
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, 'reserving', 1, NULL, NULL, ?8, ?8, 0, NULL, NULL, ?9)`,
        key, fields.communityId, fields.bookingId, fields.effectKind, req.amountCents ?? 0,
        normalizeAtomicAmount(req.amountAtomic), recipient, now, req.rehearsalScenario ?? null,
      )
      return this.read(key)!
    })
  }

  /** The alarm owns nonce allocation. The chain pending nonce is sampled before the atomic reservation. */
  private async reserveNonce(row: EffectRow): Promise<EffectRow> {
    if (row.nonce != null) return row
    const operatorKind = this.operatorKind(row)
    const chainPending = await chain().pendingNonce(this.env, operatorKind)
    return this.ctx.storage.transactionSync(() => {
      const current = this.read(row.idempotency_key)
      if (!current || current.nonce != null || (current.state !== "reserving" && current.state !== "failed_preparation")) return current ?? row
      const used = new Set(this.ctx.storage.sql.exec<{ nonce: number }>(
        "SELECT nonce FROM effects WHERE nonce IS NOT NULL AND idempotency_key <> ?1",
        current.idempotency_key,
      ).toArray().map(({ nonce }) => Number(nonce)))
      let nonce = chainPending
      while (used.has(nonce)) nonce += 1
      this.ctx.storage.sql.exec(
        "INSERT INTO nonce_state (id, next_nonce) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET next_nonce = MAX(next_nonce, ?1)",
        nonce + 1,
      )
      return this.cas(current.idempotency_key, current.version, { nonce, state: "reserving", next_attempt_at: null, last_error: null }) ?? this.read(current.idempotency_key)!
    })
  }

  private async advance(input: EffectRow): Promise<EffectRow> {
    let row = input
    if (row.state === "capacity_deferred") {
      row = this.cas(row.idempotency_key, row.version, {
        signed_tx: null,
        tx_hash: null,
        nonce: null,
        state: "reserving",
        next_attempt_at: null,
        last_error: null,
      }) ?? this.read(row.idempotency_key)!
    }
    if (row.state === "reserving" || row.state === "failed_preparation") {
      row = await this.withPreparationStage("rpc_nonce_fetch", () => this.reserveNonce(row))
      if (row.nonce == null) return row
      row = await this.signClaimedRow(row, this.requestFromRow(row), row.recipient_address)
    }
    if (row.state === "prepared") return await this.broadcastRow(row)
    if (row.state === "broadcast" || row.state === "reconciliation_required") return await this.reconcileRow(row)
    return row
  }

  private async reconcileRow(row: EffectRow): Promise<EffectRow> {
    if (!row.tx_hash || row.nonce == null || !row.signed_tx) throw new Error("broadcast effect missing tx fields")
    const operatorKind = this.operatorKind(row)
    const liveness = await chain().txLiveness(this.env, row.tx_hash, operatorKind)
    if (liveness === "success") {
      if (this.operatorKind(row) === "rewards" && this.usesRewardVault()) {
        const decision = await this.decideRewardVaultReceipt(row)
        if (decision.disposition === "capacity_deferred") {
          // Non-terminal. The operation id was never consumed on chain, so the
          // IDENTICAL operation retries once the epoch rolls; effect id,
          // operation id, recipient, amount and policy version all persist
          // unchanged and only the deadline is reminted at signing.
          return this.cas(row.idempotency_key, row.version, {
            state: "capacity_deferred",
            // Derived from the vault's own epoch, never a short timer: each
            // deferred attempt is a SUCCESSFUL on-chain no-op that burns
            // signer ETH.
            next_attempt_at: decision.retryAtMs,
            last_error: `capacity deferred in epoch ${decision.deferredEpoch}: ${decision.reason}`.slice(0, 1_000),
          }) ?? this.read(row.idempotency_key)!
        }
        if (decision.disposition !== "confirmed") {
          const reason = decision.reason
          const reconciliationCount = row.reconciliation_count + 1
          const updated = this.cas(row.idempotency_key, row.version, {
            state: "reconciliation_required",
            next_attempt_at: Date.now() + BROADCAST_RECONCILE_DELAY_MS,
            last_error: `reward vault settlement unresolved: ${reason}`.slice(0, 1_000),
            reconciliation_count: reconciliationCount,
          }) ?? this.read(row.idempotency_key)!
          if (updated.reconciliation_count >= 3) {
            await captureScheduledWarning(
              this.env,
              "Rewards vault settlement remains reconciliation-required",
              `reward_vault_reconciliation_required:${row.operation_id ?? row.idempotency_key}`,
              {
                operation_id: row.operation_id,
                tx_hash: row.tx_hash,
                effect_kind: row.effect_kind,
                reconciliation_count: updated.reconciliation_count,
                reason: updated.last_error,
              },
              { urgency: "high" },
            ).catch((error) => {
              console.error(JSON.stringify({
                message: "rewards vault reconciliation alert failed",
                effect: row.idempotency_key,
                error: errMsg(error),
              }))
            })
          }
          return updated
        }
      }
      if (this.operatorKind(row) === "rewards" && row.operation_id == null) {
        // Legacy direct-transfer rows are pre-vault and excluded from event joins.
        // Seeing one confirm under Lit custody means persistence was bypassed.
        console.warn(JSON.stringify({
          message: "confirmed rewards effect is missing operation ID",
          effect: row.idempotency_key,
        }))
      }
      return this.cas(row.idempotency_key, row.version, {
        state: "confirmed",
        next_attempt_at: null,
        last_error: null,
      }) ?? this.read(row.idempotency_key)!
    }
    if (liveness === "failed") {
      if (operatorKind === "rewards" && this.usesRewardVault()) {
        const observe = chain().rewardVaultFailureEvidence
        if (!observe) {
          return this.cas(row.idempotency_key, row.version, {
            state: "reconciliation_required",
            next_attempt_at: Date.now() + BROADCAST_RECONCILE_DELAY_MS,
            last_error: "rewards vault failure evidence is not configured",
          }) ?? this.read(row.idempotency_key)!
        }
        const request = this.requestFromRow(row)
        const evidence = await observe(this.env, {
          signedTx: row.signed_tx,
          txHash: row.tx_hash,
          effectKind: row.effect_kind as "reward_cashout" | "reward_funding_refund",
          effectId: row.booking_id,
          recipient: row.recipient_address,
          amountCents: request.amountCents,
          amountAtomic: request.amountAtomic,
        })
        const capacityDeferred = evidence.disposition === "capacity_deferred"
          && evidence.retryAfterMs != null
          && Number.isSafeInteger(evidence.retryAfterMs)
          && evidence.retryAfterMs > Date.now()
        return this.cas(row.idempotency_key, row.version, {
          state: capacityDeferred ? "capacity_deferred" : "reconciliation_required",
          next_attempt_at: capacityDeferred
            ? evidence.retryAfterMs
            : Date.now() + BROADCAST_RECONCILE_DELAY_MS,
          last_error: JSON.stringify({
            reason: evidence.reason,
            evidence: evidence.compactEvidence,
          }).slice(0, 1_000),
          settlement_revert_selector: evidence.compactEvidence?.selector ?? null,
          settlement_revert_name: evidence.compactEvidence?.errorName ?? null,
          settlement_transaction_hash: evidence.compactEvidence?.transactionHash ?? null,
          settlement_block_hash: evidence.compactEvidence?.blockHash ?? null,
          settlement_classified_at: evidence.compactEvidence?.classifiedAt ?? null,
        }) ?? this.read(row.idempotency_key)!
      }
      return this.cas(row.idempotency_key, row.version, {
        state: "failed_onchain",
        next_attempt_at: null,
        last_error: null,
      }) ?? this.read(row.idempotency_key)!
    }
    if (liveness === "pending") {
      return this.cas(row.idempotency_key, row.version, {
        state: "broadcast",
        next_attempt_at: Date.now() + BROADCAST_RECONCILE_DELAY_MS,
        last_error: null,
      }) ?? this.read(row.idempotency_key)!
    }
    // Absent: a different transaction consumed our nonce (replaced), or the exact signed
    // transaction dropped from the mempool and is safe to rebroadcast.
    const latest = await chain().latestNonce(this.env, operatorKind)
    if (latest > row.nonce) return this.cas(row.idempotency_key, row.version, { state: "replaced", next_attempt_at: null, last_error: null }) ?? this.read(row.idempotency_key)!
    await chain().broadcast(this.env, { signedTx: row.signed_tx, operatorKind })
    return this.cas(row.idempotency_key, row.version, {
      state: "broadcast",
      next_attempt_at: Date.now() + BROADCAST_RECONCILE_DELAY_MS,
      last_error: null,
    }) ?? this.read(row.idempotency_key)!
  }

  private requestFromRow(row: EffectRow): OperatorSettleRequest {
    if (row.effect_kind === "reward_cashout") {
      const parsed = JSON.parse(row.idempotency_key) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "reward_payout" || typeof parsed[1] !== "string") {
        throw new Error("reward payout effect has invalid durable idempotency key")
      }
      return {
        operatorKind: "rewards",
        userId: row.community_id,
        payoutEffectId: row.booking_id,
        idempotencyKey: parsed[1],
        effectKind: "reward_cashout",
        amountCents: row.amount_cents,
        recipientAddress: row.recipient_address,
        rehearsalScenario: row.rehearsal_scenario ?? undefined,
      }
    }
    if (row.effect_kind === "reward_funding_refund") {
      const parsed = JSON.parse(row.idempotency_key) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "reward_funding_refund" || typeof parsed[1] !== "string") {
        throw new Error("reward funding refund has invalid durable idempotency key")
      }
      if (!row.amount_atomic) throw new Error("reward funding refund is missing atomic amount")
      return {
        operatorKind: "rewards",
        fundingEffectId: row.booking_id,
        idempotencyKey: parsed[1],
        effectKind: "reward_funding_refund",
        amountAtomic: row.amount_atomic,
        recipientAddress: row.recipient_address,
      }
    }
    if (row.effect_kind === "handle_claim_refund") {
      const parsed = JSON.parse(row.idempotency_key) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "handle_claim_refund" || typeof parsed[1] !== "string") {
        throw new Error("handle claim refund has invalid durable idempotency key")
      }
      if (!row.amount_atomic) throw new Error("handle claim refund is missing atomic amount")
      return {
        operatorKind: "checkout",
        fundingEffectId: row.booking_id,
        idempotencyKey: parsed[1],
        effectKind: "handle_claim_refund",
        amountAtomic: row.amount_atomic,
        recipientAddress: row.recipient_address,
      }
    }
    if (row.effect_kind === "booking_refund" && row.amount_atomic != null) {
      return {
        operatorKind: "booking",
        communityId: row.community_id,
        bookingId: row.booking_id,
        effectKind: "booking_refund",
        amountAtomic: row.amount_atomic,
        recipientAddress: row.recipient_address,
      }
    }
    return {
      operatorKind: "booking",
      communityId: row.community_id,
      bookingId: row.booking_id,
      effectKind: row.effect_kind as "booking_payout" | "booking_refund",
      amountCents: row.amount_cents,
      recipientAddress: row.recipient_address,
    }
  }

  private operatorKind(row: EffectRow): OperatorKind {
    return row.effect_kind === "reward_cashout" || row.effect_kind === "reward_funding_refund"
      ? "rewards"
      : row.effect_kind === "handle_claim_refund"
        ? "checkout"
        : "booking"
  }

  private usesRewardVault(): boolean {
    return ["lit_vault", "eoa_vault"].includes(resolveRewardsSettlementBackend(this.env))
  }

  /**
   * The SOLE receipt parser for rewards vault settlement. Verification of the
   * stored signed transaction happens inside the decision, before any receipt
   * evidence is interpreted, for the automated and manual paths alike.
   */
  private async decideRewardVaultReceipt(row: EffectRow): Promise<RewardVaultReceiptDecision> {
    if (!row.tx_hash) throw new Error("reward vault decision requires a transaction hash")
    if (!row.signed_tx || row.nonce == null) {
      return {
        disposition: "reconciliation_required",
        reason: "signed transaction or nonce was not persisted; evidence cannot be verified",
        evidence: null,
      }
    }
    const decide = chain().rewardVaultDecision
    if (!decide) throw new Error("reward vault reconciliation is not configured")
    return decide(this.env, rewardVaultDecisionInputFromRow({
      ...row,
      nonce: row.nonce,
      signed_tx: row.signed_tx,
      tx_hash: row.tx_hash,
    }))
  }

  private assertAmount(req: OperatorSettleRequest): void {
    if (
      req.effectKind === "reward_funding_refund"
      || req.effectKind === "handle_claim_refund"
      || (req.effectKind === "booking_refund" && req.amountAtomic != null)
    ) {
      if (req.amountCents != null || normalizeAtomicAmount(req.amountAtomic) == null) {
        throw badRequestError("Atomic refund requires only an atomic amount")
      }
      return
    }
    if (!Number.isInteger(req.amountCents) || Number(req.amountCents) <= 0 || req.amountAtomic != null) {
      throw badRequestError("Operator settlement requires only a positive cents amount")
    }
  }

  private nextActive(): EffectRow | null {
    const now = Date.now()
    const raw = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT * FROM effects
       WHERE state NOT IN ('confirmed', 'replaced', 'failed_onchain', 'preparation_parked')
       ORDER BY
         CASE
           WHEN (next_attempt_at IS NULL OR next_attempt_at <= ?1)
             AND (claim_token IS NULL OR claim_expires_at IS NULL OR claim_expires_at <= ?1)
           THEN 0
           ELSE 1
         END ASC,
         COALESCE(next_attempt_at, 0) ASC,
         created_at ASC,
         idempotency_key ASC
       LIMIT 1`,
      now,
    ).toArray()[0]
    return raw ? this.decode(raw) : null
  }

  private isTerminal(row: EffectRow): boolean {
    return row.state === "confirmed" || row.state === "replaced"
      || row.state === "failed_onchain" || row.state === "preparation_parked"
  }

  private retryDelay(attemptCount: number): number {
    return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.min(attemptCount, 6)), RETRY_MAX_DELAY_MS)
  }

  private async withPreparationStage<T>(
    stage: PreparationFailureStage,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now()
    try {
      return await operation()
    } catch (error) {
      if (error instanceof OperatorPreparationError) throw error
      throw new OperatorPreparationError(stage, error, Math.max(0, Date.now() - startedAt))
    }
  }

  /** Explicit convergence requests may wake a delayed operation; ordinary settle polling may not. */
  private expedite(row: EffectRow): EffectRow {
    return this.cas(row.idempotency_key, row.version, { next_attempt_at: Date.now() }) ?? this.read(row.idempotency_key)!
  }

  private recordRetry(row: EffectRow, error: unknown): EffectRow {
    const attemptCount = row.attempt_count + 1
    const diagnostic = boundedPreparationDiagnostic(error, Date.now())
    const releaseUnsentNonce = row.signed_tx == null && row.tx_hash == null
    const configuredRewardsBackend = resolveRewardsSettlementBackend(this.env)
    const isLitRewardsPreparation = this.operatorKind(row) === "rewards" && (
      configuredRewardsBackend === "lit_vault"
      || diagnostic.stage === "lit_request_dispatch"
      || diagnostic.stage === "lit_response"
      || diagnostic.litErrorToken != null
    )
    const isRewardsBroadcast = this.operatorKind(row) === "rewards"
      && diagnostic.stage === "broadcast"
      && row.signed_tx != null
      && row.tx_hash != null
      && row.nonce != null
    const park = isRewardsBroadcast
      ? attemptCount >= BROADCAST_FAILURE_ALERT_ATTEMPT
      : isLitRewardsPreparation && shouldParkUnsentPreparation(row, diagnostic, attemptCount)
    return this.cas(row.idempotency_key, row.version, {
      attempt_count: attemptCount,
      state: park ? "preparation_parked" : row.state,
      next_attempt_at: park ? null : Date.now() + this.retryDelay(attemptCount),
      last_error: errMsg(error).slice(0, 1_000),
      nonce: releaseUnsentNonce ? null : row.nonce,
      claim_token: releaseUnsentNonce ? null : row.claim_token,
      claim_expires_at: releaseUnsentNonce ? null : row.claim_expires_at,
      preparation_stage: diagnostic.stage,
      preparation_transport_category: diagnostic.transportCategory,
      preparation_http_status: diagnostic.httpStatus,
      preparation_lit_error_token: diagnostic.litErrorToken,
      preparation_latency_ms: diagnostic.latencyMs,
      preparation_classified_at: diagnostic.classifiedAt,
    }) ?? this.read(row.idempotency_key)!
  }

  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current == null || current > at) await this.ctx.storage.setAlarm(at)
  }

  private async scheduleNext(): Promise<void> {
    const next = this.nextActive()
    if (!next) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const at = this.runnableAt(next, Date.now())
    await this.ctx.storage.setAlarm(at)
  }

  /** A live signing claim is work in progress, not immediately runnable retry work. */
  private runnableAt(row: EffectRow, now: number): number {
    const retryAt = row.next_attempt_at ?? now
    const claimExpiresAt = row.claim_token && row.claim_expires_at != null && row.claim_expires_at > now
      ? row.claim_expires_at
      : now
    return Math.max(now, retryAt, claimExpiresAt)
  }

  /** Claim the row for signing (atomic, with expiry), sign off-lock, then CAS to prepared. */
  private async signClaimedRow(row: EffectRow, req: OperatorSettleRequest, recipient: string): Promise<EffectRow> {
    if (row.nonce == null) throw new Error("cannot sign without a reserved nonce")
    const now = Date.now()
    const token = crypto.randomUUID()
    const claimed = this.ctx.storage.transactionSync(() => {
      const cur = this.read(row.idempotency_key)!
      if (cur.state !== "reserving" && cur.state !== "failed_preparation") return false
      if (cur.claim_token && cur.claim_expires_at && cur.claim_expires_at > now) return false // active claim held
      return this.cas(cur.idempotency_key, cur.version, { claim_token: token, claim_expires_at: now + SIGNING_CLAIM_TTL_MS }) != null
    })
    if (!claimed) return this.read(row.idempotency_key)! // someone else is signing or it advanced

    const claimedRow = this.read(row.idempotency_key)!
    try {
      const operatorKind = requestOperatorKind(req)
      const effectId = canonicalFields(req).bookingId
      const gas = await this.withPreparationStage(
        "rpc_nonce_fetch",
        () => chain().gasParams(this.env, operatorKind),
      )
      const signed = await this.withPreparationStage("transaction_verification", () => chain().signVerifiedTransfer(this.env, {
        to: recipient,
        amountCents: req.amountCents,
        amountAtomic: req.amountAtomic,
        nonce: claimedRow.nonce!,
        gas,
        operatorKind,
        effectKind: req.effectKind,
        effectId,
        rehearsalScenario: req.rehearsalScenario,
      }))
      const operationId = signed.operationId ?? null
      if (operatorKind === "rewards" && (!operationId || !OPERATION_ID_RE.test(operationId))) {
        throw new Error("verified rewards signing result is missing a canonical operation ID")
      }
      if (operatorKind !== "rewards" && operationId != null) {
        throw new Error("non-rewards signing result must not contain a rewards operation ID")
      }
      // CAS guarded by version AND our claim token — a stolen/expired claim cannot overwrite.
      const updated = this.casClaimed(row.idempotency_key, claimedRow.version, token, {
        operation_id: operationId,
        signed_tx: signed.signedTx,
        tx_hash: signed.txHash,
        state: "prepared",
        claim_token: null,
        claim_expires_at: null,
        next_attempt_at: null,
        last_error: null,
        preparation_stage: null,
        preparation_transport_category: null,
        preparation_http_status: null,
        preparation_lit_error_token: null,
        preparation_latency_ms: null,
        preparation_classified_at: null,
      })
      return updated ?? this.read(row.idempotency_key)!
    } catch (error) {
      this.casClaimed(row.idempotency_key, claimedRow.version, token, { state: "failed_preparation", claim_token: null, claim_expires_at: null })
      throw error
    }
  }

  private async broadcastRow(row: EffectRow): Promise<EffectRow> {
    if (!row.signed_tx || !row.tx_hash || row.nonce == null) throw new Error("prepared effect missing signed tx/nonce")
    const fromVersion = row.version
    const startedAt = Date.now()
    try {
      await chain().broadcast(this.env, { signedTx: row.signed_tx, operatorKind: this.operatorKind(row) })
      return this.cas(row.idempotency_key, fromVersion, {
        state: "broadcast",
        next_attempt_at: Date.now() + BROADCAST_RECONCILE_DELAY_MS,
        last_error: null,
      }) ?? this.read(row.idempotency_key)!
    } catch (error) {
      const msg = errMsg(error).toLowerCase()
      const nonceConsumed = msg.includes("already known") || msg.includes("known transaction") || msg.includes("nonce too low") || msg.includes("already imported")
      const liveness = await this.pollBroadcastLiveness(row.tx_hash, this.operatorKind(row))
      if (!nonceConsumed && liveness === "absent") {
        // Persist the failed phase without persisting the provider's raw error,
        // which may contain a credential-bearing RPC URL. The alarm retains the
        // signed transaction and owns the bounded retry schedule.
        throw new OperatorPreparationError("broadcast", error, Math.max(0, Date.now() - startedAt))
      }
      const rewardsVaultFailure = this.operatorKind(row) === "rewards"
        && this.usesRewardVault()
        && liveness === "failed"
      const next: OperatorSettleState = liveness === "success" || liveness === "pending"
        ? "broadcast"
        : (liveness === "failed" && !rewardsVaultFailure ? "failed_onchain" : "reconciliation_required")
      return this.cas(row.idempotency_key, fromVersion, {
        state: next,
        next_attempt_at: next === "failed_onchain" ? null : Date.now() + BROADCAST_RECONCILE_DELAY_MS,
      }) ?? this.read(row.idempotency_key)!
    }
  }

  private async pollBroadcastLiveness(txHash: string, operatorKind: OperatorKind): Promise<TxLiveness> {
    let lastError: unknown = null
    for (const delayMs of BROADCAST_LIVENESS_POLL_DELAYS_MS) {
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs))
      try {
        const liveness = await chain().txLiveness(this.env, txHash, operatorKind)
        if (liveness !== "absent") return liveness
      } catch (error) {
        lastError = error
      }
    }
    if (lastError) {
      console.error(JSON.stringify({
        message: "operator broadcast liveness check failed after send error",
        tx_hash: txHash,
        error: errMsg(lastError),
      }))
    }
    return "absent"
  }

  private deriveKey(req: OperatorSettleRequest): string {
    const operatorKind = requestOperatorKind(req)
    if (operatorKind === "rewards") {
      canonicalFields(req)
      return JSON.stringify([
        req.effectKind === "reward_funding_refund" ? "reward_funding_refund" : "reward_payout",
        req.idempotencyKey,
      ])
    }
    if (operatorKind === "checkout") {
      canonicalFields(req)
      return JSON.stringify(["handle_claim_refund", req.idempotencyKey])
    }
    // Unambiguous encoding — a colon (or any char) inside an id cannot collide another effect.
    canonicalFields(req)
    return JSON.stringify(["booking_settlement", req.communityId, req.bookingId, req.effectKind])
  }

  private assertImmutable(existing: EffectRow, req: OperatorSettleRequest, recipient: string): void {
    const fields = canonicalFields(req)
    if (
      existing.community_id !== fields.communityId || existing.booking_id !== fields.bookingId ||
      existing.effect_kind !== fields.effectKind || existing.amount_cents !== (req.amountCents ?? 0) ||
      existing.amount_atomic !== normalizeAtomicAmount(req.amountAtomic) ||
      existing.recipient_address !== recipient ||
      existing.rehearsal_scenario !== (req.rehearsalScenario ?? null)
    ) {
      throw conflictError("Operator settlement idempotency key reused with different effect data")
    }
  }

  private assertRehearsalRequest(req: OperatorSettleRequest): void {
    if (req.rehearsalScenario == null) return
    if (
      this.env.ENVIRONMENT !== "staging"
      || requestOperatorKind(req) !== "rewards"
      || (
        req.effectKind !== "reward_cashout"
        && !(
          req.effectKind === "reward_funding_refund"
          && req.rehearsalScenario === "refund_while_payouts_paused"
        )
      )
    ) {
      throw badRequestError("Rewards rehearsal fixture is staging-only")
    }
  }

  /** Expected-state CAS on version; returns the new row or null if the row changed concurrently. */
  private cas(key: string, fromVersion: number, fields: MutableEffectFields): EffectRow | null {
    return this.casInternal(key, fromVersion, null, fields)
  }
  private casClaimed(key: string, fromVersion: number, claimToken: string, fields: MutableEffectFields): EffectRow | null {
    return this.casInternal(key, fromVersion, claimToken, fields)
  }
  private casInternal(key: string, fromVersion: number, claimToken: string | null, fields: MutableEffectFields): EffectRow | null {
    const cur = this.read(key)
    if (!cur) return null
    const next: EffectRow = { ...cur, ...fields }
    const matched = this.ctx.storage.sql.exec(
      `UPDATE effects SET
         operation_id = ?2, signed_tx = ?3, tx_hash = ?4, nonce = ?5, state = ?6, claim_token = ?7,
         claim_expires_at = ?8, attempt_count = ?9, next_attempt_at = ?10, last_error = ?11,
         reconciliation_count = ?12, manual_resolution = ?13, manual_resolution_reason = ?14,
         manual_resolved_by = ?15, manual_resolved_at = ?16,
         preparation_stage = ?17, preparation_transport_category = ?18,
         preparation_http_status = ?19, preparation_lit_error_token = ?20,
         preparation_latency_ms = ?21, preparation_classified_at = ?22,
         settlement_revert_selector = ?23, settlement_revert_name = ?24,
         settlement_transaction_hash = ?25, settlement_block_hash = ?26,
         settlement_classified_at = ?27,
         version = version + 1, updated_at = ?28
       WHERE idempotency_key = ?1 AND version = ?29${claimToken == null ? "" : " AND claim_token = ?30"}
       RETURNING idempotency_key`,
      ...(claimToken == null
        ? [key, next.operation_id, next.signed_tx, next.tx_hash, next.nonce, next.state, next.claim_token, next.claim_expires_at, next.attempt_count, next.next_attempt_at, next.last_error, next.reconciliation_count, next.manual_resolution, next.manual_resolution_reason, next.manual_resolved_by, next.manual_resolved_at, next.preparation_stage, next.preparation_transport_category, next.preparation_http_status, next.preparation_lit_error_token, next.preparation_latency_ms, next.preparation_classified_at, next.settlement_revert_selector, next.settlement_revert_name, next.settlement_transaction_hash, next.settlement_block_hash, next.settlement_classified_at, Date.now(), fromVersion]
        : [key, next.operation_id, next.signed_tx, next.tx_hash, next.nonce, next.state, next.claim_token, next.claim_expires_at, next.attempt_count, next.next_attempt_at, next.last_error, next.reconciliation_count, next.manual_resolution, next.manual_resolution_reason, next.manual_resolved_by, next.manual_resolved_at, next.preparation_stage, next.preparation_transport_category, next.preparation_http_status, next.preparation_lit_error_token, next.preparation_latency_ms, next.preparation_classified_at, next.settlement_revert_selector, next.settlement_revert_name, next.settlement_transaction_hash, next.settlement_block_hash, next.settlement_classified_at, Date.now(), fromVersion, claimToken]),
    ).toArray()
    return matched.length === 1 ? this.read(key) : null
  }

  private read(key: string): EffectRow | null {
    const r = this.ctx.storage.sql.exec<Record<string, string | number | null>>("SELECT * FROM effects WHERE idempotency_key = ?1", key).toArray()[0]
    return r ? this.decode(r) : null
  }

  private decode(r: Record<string, string | number | null>): EffectRow {
    return {
      idempotency_key: String(r.idempotency_key), community_id: String(r.community_id), booking_id: String(r.booking_id),
      effect_kind: String(r.effect_kind), amount_cents: Number(r.amount_cents), recipient_address: String(r.recipient_address),
      amount_atomic: r.amount_atomic == null ? null : String(r.amount_atomic),
      operation_id: r.operation_id == null ? null : String(r.operation_id),
      signed_tx: r.signed_tx == null ? null : String(r.signed_tx), tx_hash: r.tx_hash == null ? null : String(r.tx_hash),
      nonce: r.nonce == null ? null : Number(r.nonce), state: String(r.state) as OperatorSettleState, version: Number(r.version),
      claim_token: r.claim_token == null ? null : String(r.claim_token), claim_expires_at: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
      attempt_count: Number(r.attempt_count ?? 0), next_attempt_at: r.next_attempt_at == null ? null : Number(r.next_attempt_at),
      last_error: r.last_error == null ? null : String(r.last_error),
      reconciliation_count: Number(r.reconciliation_count ?? 0),
      manual_resolution: r.manual_resolution == null
        ? null
        : String(r.manual_resolution) as "confirmed" | "failed_onchain" | "failed_prebroadcast" | "failed_nonce_invalidated",
      manual_resolution_reason: r.manual_resolution_reason == null ? null : String(r.manual_resolution_reason),
      manual_resolved_by: r.manual_resolved_by == null ? null : String(r.manual_resolved_by),
      manual_resolved_at: r.manual_resolved_at == null ? null : Number(r.manual_resolved_at),
      preparation_stage: r.preparation_stage == null ? null : String(r.preparation_stage) as PreparationFailureStage,
      preparation_transport_category: r.preparation_transport_category == null
        ? null
        : String(r.preparation_transport_category) as PreparationTransportCategory,
      preparation_http_status: r.preparation_http_status == null ? null : Number(r.preparation_http_status),
      preparation_lit_error_token: r.preparation_lit_error_token == null
        ? null
        : String(r.preparation_lit_error_token) as PreparationLitErrorToken,
      preparation_latency_ms: r.preparation_latency_ms == null ? null : Number(r.preparation_latency_ms),
      preparation_classified_at: r.preparation_classified_at == null ? null : Number(r.preparation_classified_at),
      rehearsal_scenario: r.rehearsal_scenario == null ? null : String(r.rehearsal_scenario) as RewardRehearsalScenario,
      settlement_revert_selector: r.settlement_revert_selector == null ? null : String(r.settlement_revert_selector),
      settlement_revert_name: r.settlement_revert_name == null ? null : String(r.settlement_revert_name),
      settlement_transaction_hash: r.settlement_transaction_hash == null ? null : String(r.settlement_transaction_hash),
      settlement_block_hash: r.settlement_block_hash == null ? null : String(r.settlement_block_hash),
      settlement_classified_at: r.settlement_classified_at == null ? null : String(r.settlement_classified_at),
    }
  }

  private result(row: EffectRow): OperatorSettleResult {
    return {
      idempotencyKey: row.idempotency_key,
      operationId: row.operation_id,
      txHash: row.tx_hash,
      nonce: row.nonce,
      state: row.state,
      attemptCount: row.attempt_count,
      preparationFailure: row.preparation_stage && row.preparation_latency_ms != null
        && row.preparation_classified_at != null
        ? {
            stage: row.preparation_stage,
            transportCategory: row.preparation_transport_category,
            httpStatus: row.preparation_http_status,
            litErrorToken: row.preparation_lit_error_token,
            latencyMs: row.preparation_latency_ms,
            classifiedAt: row.preparation_classified_at,
          }
        : null,
      settlementFailure: row.settlement_revert_selector && row.settlement_transaction_hash
        && row.settlement_block_hash && row.settlement_classified_at
        ? {
            selector: row.settlement_revert_selector,
            errorName: row.settlement_revert_name,
            transactionHash: row.settlement_transaction_hash,
            blockHash: row.settlement_block_hash,
            classifiedAt: row.settlement_classified_at,
          }
        : null,
      manualResolution: row.manual_resolution && row.manual_resolution_reason
        && row.manual_resolved_by && row.manual_resolved_at != null
        ? {
            resolution: row.manual_resolution,
            reason: row.manual_resolution_reason,
            operatorActorId: row.manual_resolved_by,
            resolvedAt: row.manual_resolved_at,
          }
        : null,
    }
  }
}
