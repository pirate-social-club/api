import { DurableObject } from "cloudflare:workers"
import {
  encodeAbiParameters,
  getAddress,
  isHex,
  keccak256,
  parseAbiParameters,
  parseTransaction,
  recoverTransactionAddress,
  size,
  type Address,
  type Hex,
  type TransactionSerialized,
} from "viem"

import type { Env } from "../../env"
import { badRequestError, conflictError } from "../errors"
import {
  deriveStorySettlementCallIdentity,
  type StorySettlementCallIdentityInput,
  type StorySettlementEffectKind,
  type StorySettlementStepKind,
} from "./story-settlement-call-identity"
import {
  isTerminalStorySettlementStepState,
  transitionStorySettlementStep,
  type StorySettlementReceiptEvidence,
  type StorySettlementStepSnapshot,
  type StorySettlementStepState,
  type StorySettlementStepTransition,
} from "./story-settlement-step-state-machine"

const SIGNING_LEASE_MS = 60_000
const RECONCILE_DELAY_MS = 15_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
const PLAN_REF_PARAMS = parseAbiParameters(
  "uint16 schemaVersion, uint256 chainId, address signerAddress, string communityId, string quoteId, string purchaseId, string feePolicyVersion, string finalityPolicyVersion, bytes32[] callIdentities",
)
const REPAIR_REF_PARAMS = parseAbiParameters(
  "string domain, bytes32 planRef, bytes32 stepRef, uint256 nonce, string reasonCode, string authorizationRef",
)

export type StorySettlementCoordinatorStepInput = Omit<
  StorySettlementCallIdentityInput,
  "chainId" | "signerAddress" | "communityId" | "quoteId" | "purchaseId"
> & { callIdentity: Hex }

export interface StorySettlementPlanRequest {
  chainId: number
  signerAddress: string
  communityId: string
  quoteId: string
  purchaseId: string
  feePolicyVersion: string
  finalityPolicyVersion: string
  steps: StorySettlementCoordinatorStepInput[]
}

export interface StorySettlementPlanResult {
  planRef: Hex
  state: "pending" | "confirmed" | "failed" | "abandoning" | "abandoned"
  version: number
  steps: StorySettlementStepResult[]
}

export interface StorySettlementStepResult {
  stepRef: Hex
  callIdentity: Hex
  ordinal: number
  state: StorySettlementStepState
  version: number
  nonce: number | null
  transactionHash: Hex | null
  receipt: StorySettlementReceiptEvidence | null
  attemptCount: number
  repairState: RepairState | null
  lastErrorCode: string | null
}

export interface AbandonedNonceRepairRequest {
  planRef: Hex
  stepRef: Hex
  expectedVersion: number
  reasonCode: "operator_cancelled" | "terminal_configuration" | "rights_hold"
  authorizationRef: string
}

type StoryFaultPoint =
  | "after_nonce_reserved"
  | "after_signed_before_persist"
  | "after_prepared_persisted"
  | "after_broadcast_before_persist"
  | "after_receipt_before_persist"

export type StoryTransactionObservation =
  | { kind: "absent" }
  | { kind: "pending" }
  | { kind: "mined"; status: "success" | "reverted"; blockNumber: bigint; blockHash: Hex; final: boolean }

export interface StorySettlementGasParameters {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  gasLimit: bigint
}

export interface StorySettlementChainPrimitives {
  nativeBalance(env: Env, input: SignerDomain): Promise<bigint>
  wipBalance(env: Env, input: SignerDomain): Promise<bigint>
  pendingNonce(env: Env, input: SignerDomain): Promise<number>
  latestNonce(env: Env, input: SignerDomain): Promise<number>
  gasParameters(env: Env, input: SignerDomain & {
    feePolicyVersion: string
    target: Address
    value: bigint
    calldata: Hex
  }): Promise<StorySettlementGasParameters>
  signTransaction(env: Env, input: SignerDomain & {
    nonce: number
    target: Address
    value: bigint
    calldata: Hex
    gas: StorySettlementGasParameters
  }): Promise<Hex>
  broadcastExactTransaction(env: Env, input: SignerDomain & { signedTransaction: Hex }): Promise<void>
  observeTransaction(env: Env, input: SignerDomain & {
    transactionHash: Hex
    finalityPolicyVersion: string
  }): Promise<StoryTransactionObservation>
  fault?(point: StoryFaultPoint): Promise<void> | void
}

export interface StorySettlementCoordinatorHealth {
  chainId: number
  signerAddress: Address
  pendingPlans: number
  oldestBacklogAgeMs: number
  reconciliationRequiredSteps: number
  oldestReconciliationAgeMs: number
  replacedSteps: number
  latestNonce: number
  pendingNonce: number
  nextAllocatedNonce: number | null
  nonceGap: boolean
  nativeBalanceWei: string
  nativeRequiredWei: string
  wipBalanceWei: string
  wipObligationWei: string
  surplusWipWei: string
}

interface SignerDomain { chainId: number; signerAddress: Address }
type PlanState = StorySettlementPlanResult["state"]
type RepairState = "requested" | "prepared" | "broadcast" | "confirmed" | "reverted" | "replaced" | "reconciliation_required"

interface StepRow {
  step_ref: Hex
  plan_ref: Hex
  call_identity: Hex
  effect_kind: StorySettlementEffectKind
  effect_key: string
  step_kind: StorySettlementStepKind
  ordinal: number
  target: Address
  native_value: string
  calldata: Hex
  identity_json: string
  state: StorySettlementStepState
  version: number
  nonce: number | null
  max_fee_per_gas: string | null
  max_priority_fee_per_gas: string | null
  gas_limit: string | null
  signed_transaction: Hex | null
  transaction_hash: Hex | null
  receipt_status: "success" | "reverted" | null
  block_number: string | null
  block_hash: Hex | null
  claim_token: string | null
  claim_expires_at: number | null
  attempt_count: number
  next_attempt_at: number | null
  last_error_code: string | null
  repair_state: RepairState | null
  repair_reason_code: string | null
  repair_authorization_ref: string | null
  repair_ref: Hex | null
  repair_signed_transaction: Hex | null
  repair_transaction_hash: Hex | null
  repair_receipt_status: "success" | "reverted" | null
  repair_block_number: string | null
  repair_block_hash: Hex | null
}

interface PlanRow {
  plan_ref: Hex
  chain_id: number
  signer_address: Address
  community_id: string
  quote_id: string
  purchase_id: string
  fee_policy_version: string
  finality_policy_version: string
  state: PlanState
  version: number
}

let registeredChain: StorySettlementChainPrimitives | null = null
let testChain: StorySettlementChainPrimitives | null = null

export function registerStorySettlementChainPrimitives(primitives: StorySettlementChainPrimitives): void {
  registeredChain = primitives
}

export function setStorySettlementChainPrimitivesForTests(primitives: StorySettlementChainPrimitives | null): void {
  testChain = primitives
}

function chain(): StorySettlementChainPrimitives {
  const primitives = testChain ?? registeredChain
  if (!primitives) throw badRequestError("Story settlement chain primitives are not configured")
  return primitives
}

function exactId(name: string, value: string): string {
  if (!value || value !== value.trim()) throw badRequestError(`${name}_missing_or_noncanonical`)
  return value
}

function boundedErrorCode(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  if (message.startsWith("fault:")) return "fault_injected"
  if (message.includes("timeout")) return "chain_rpc_timeout"
  if (message.includes("nonce")) return "chain_nonce_error"
  if (message.includes("gas")) return "gas_policy_error"
  if (message.includes("sign")) return "transaction_signing_error"
  if (message.includes("provider") || message.includes("rpc")) return "chain_rpc_unavailable"
  return "coordinator_operation_failed"
}

function assertBytes32(name: string, value: Hex): void {
  if (!isHex(value, { strict: true }) || size(value) !== 32) throw badRequestError(`${name}_must_be_bytes32`)
}

function assertNonce(nonce: number): void {
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error("nonce_must_be_non_negative_safe_integer")
}

function signerDomain(chainId: number, signerAddress: string): SignerDomain {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw badRequestError("chain_id_must_be_positive")
  return { chainId, signerAddress: getAddress(signerAddress) }
}

export function storySettlementCoordinatorName(chainId: number, signerAddress: string): string {
  const domain = signerDomain(chainId, signerAddress)
  return `story-settlement-signer:${domain.chainId}:${domain.signerAddress.toLowerCase()}`
}

export function deriveStorySettlementPlanRef(request: StorySettlementPlanRequest): Hex {
  return derivePlanRef(request, request.steps.map((step) => step.callIdentity))
}

function derivePlanRef(request: StorySettlementPlanRequest, callIdentities: Hex[]): Hex {
  return keccak256(encodeAbiParameters(PLAN_REF_PARAMS, [
    1,
    BigInt(request.chainId),
    getAddress(request.signerAddress),
    exactId("community_id", request.communityId),
    exactId("quote_id", request.quoteId),
    exactId("purchase_id", request.purchaseId),
    exactId("fee_policy_version", request.feePolicyVersion),
    exactId("finality_policy_version", request.finalityPolicyVersion),
    callIdentities,
  ]))
}

function stepRef(planRef: Hex, ordinal: number, callIdentity: Hex): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters("bytes32 planRef, uint32 ordinal, bytes32 callIdentity"), [
    planRef,
    ordinal,
    callIdentity,
  ]))
}

export class StorySettlementWalletCoordinatorDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS _sql_schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)")
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS plans (
        plan_ref TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, signer_address TEXT NOT NULL,
        community_id TEXT NOT NULL, quote_id TEXT NOT NULL, purchase_id TEXT NOT NULL,
        fee_policy_version TEXT NOT NULL, finality_policy_version TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(community_id, quote_id, purchase_id)
      )`)
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS steps (
        step_ref TEXT PRIMARY KEY, plan_ref TEXT NOT NULL, call_identity TEXT NOT NULL UNIQUE,
        effect_kind TEXT NOT NULL, effect_key TEXT NOT NULL, step_kind TEXT NOT NULL,
        ordinal INTEGER NOT NULL, target TEXT NOT NULL, native_value TEXT NOT NULL,
        calldata TEXT NOT NULL, identity_json TEXT NOT NULL,
        state TEXT NOT NULL, version INTEGER NOT NULL, nonce INTEGER UNIQUE,
        max_fee_per_gas TEXT, max_priority_fee_per_gas TEXT, gas_limit TEXT,
        signed_transaction TEXT, transaction_hash TEXT,
        receipt_status TEXT, block_number TEXT, block_hash TEXT,
        claim_token TEXT, claim_expires_at INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER, last_error_code TEXT,
        repair_state TEXT, repair_reason_code TEXT, repair_authorization_ref TEXT, repair_ref TEXT UNIQUE,
        repair_signed_transaction TEXT, repair_transaction_hash TEXT,
        repair_receipt_status TEXT, repair_block_number TEXT, repair_block_hash TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(plan_ref, ordinal), FOREIGN KEY(plan_ref) REFERENCES plans(plan_ref)
      )`)
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS nonce_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_nonce INTEGER NOT NULL)")
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS signer_domain (id INTEGER PRIMARY KEY CHECK (id = 1), chain_id INTEGER NOT NULL, signer_address TEXT NOT NULL)")
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations (id, applied_at) VALUES (1, ?1)", Date.now())
    })
  }

  async admit(request: StorySettlementPlanRequest): Promise<StorySettlementPlanResult> {
    const normalized = this.validateRequest(request)
    const existing = this.readPlan(normalized.planRef)
    if (existing) {
      this.assertPlanImmutable(existing, request, normalized.steps)
      return this.result(existing)
    }
    const existingPurchase = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT plan_ref FROM plans WHERE community_id=?1 AND quote_id=?2 AND purchase_id=?3 LIMIT 1",
      request.communityId, request.quoteId, request.purchaseId,
    ).toArray()[0]
    if (existingPurchase) throw conflictError("Story settlement purchase already has a different immutable plan")
    this.ctx.storage.transactionSync(() => {
      const now = Date.now()
      const domain = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
        "SELECT chain_id,signer_address FROM signer_domain WHERE id=1",
      ).toArray()[0]
      if (domain && (Number(domain.chain_id) !== request.chainId || String(domain.signer_address) !== normalized.signerAddress)) {
        throw conflictError("Story settlement coordinator signer domain mismatch")
      }
      if (!domain) {
        this.ctx.storage.sql.exec(
          "INSERT INTO signer_domain (id,chain_id,signer_address) VALUES (1,?1,?2)",
          request.chainId, normalized.signerAddress,
        )
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO plans (plan_ref, chain_id, signer_address, community_id, quote_id, purchase_id,
         fee_policy_version, finality_policy_version, state, version, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 1, ?9, ?9)`,
        normalized.planRef, request.chainId, normalized.signerAddress, request.communityId, request.quoteId,
        request.purchaseId, request.feePolicyVersion, request.finalityPolicyVersion, now,
      )
      for (const step of normalized.steps) {
        this.ctx.storage.sql.exec(
          `INSERT INTO steps (
             step_ref, plan_ref, call_identity, effect_kind, effect_key, step_kind, ordinal,
             target, native_value, calldata, identity_json, state, version, nonce,
             max_fee_per_gas, max_priority_fee_per_gas, gas_limit,
             signed_transaction, transaction_hash, receipt_status, block_number, block_hash,
             claim_token, claim_expires_at, attempt_count, next_attempt_at, last_error_code,
             repair_state, repair_reason_code, repair_authorization_ref, repair_ref, repair_signed_transaction, repair_transaction_hash,
             repair_receipt_status, repair_block_number, repair_block_hash,
             created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'planned', 1, NULL,
             NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
             NULL, NULL, NULL, NULL, ?12, ?12)`,
          step.stepRef, normalized.planRef, step.callIdentity, step.effectKind, step.effectKey, step.stepKind,
          step.ordinal, step.target, step.nativeValue.toString(), step.calldata, step.identityJson, now,
        )
      }
    })
    await this.ensureAlarm(Date.now())
    return this.result(this.readPlan(normalized.planRef)!)
  }

  lookup(planRef: Hex): StorySettlementPlanResult | null {
    assertBytes32("plan_ref", planRef)
    const plan = this.readPlan(planRef)
    return plan ? this.result(plan) : null
  }

  async health(): Promise<StorySettlementCoordinatorHealth | null> {
    const domainRow = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT chain_id, signer_address FROM signer_domain WHERE id=1",
    ).toArray()[0]
    if (!domainRow) return null
    const domain = signerDomain(Number(domainRow.chain_id), String(domainRow.signer_address))
    const now = Date.now()
    const planStats = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest
       FROM plans WHERE state IN ('pending','abandoning')`,
    ).toArray()[0]!
    const reconciliationStats = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT COUNT(*) AS count, MIN(updated_at) AS oldest
       FROM steps WHERE state='reconciliation_required' OR repair_state='reconciliation_required'`,
    ).toArray()[0]!
    const replacedStats = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT COUNT(*) AS count FROM steps WHERE state='replaced' OR repair_state='replaced'",
    ).toArray()[0]!
    const nonceState = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT next_nonce FROM nonce_state WHERE id=1",
    ).toArray()[0]
    const nonceRows = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT nonce FROM steps WHERE nonce IS NOT NULL AND state NOT IN ('confirmed','reverted','replaced')",
    ).toArray()
    const allSteps = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT steps.plan_ref,steps.step_kind,steps.state,steps.native_value,steps.identity_json,plans.state AS plan_state
       FROM steps JOIN plans ON plans.plan_ref=steps.plan_ref`,
    ).toArray()

    const [latestNonce, pendingNonce, nativeBalance, wipBalance] = await Promise.all([
      chain().latestNonce(this.env, domain),
      chain().pendingNonce(this.env, domain),
      chain().nativeBalance(this.env, domain),
      chain().wipBalance(this.env, domain),
    ])
    const nextAllocatedNonce = nonceState ? Number(nonceState.next_nonce) : null
    const ownedNonces = new Set(nonceRows.map((row) => Number(row.nonce)))
    let nonceGap = pendingNonce > (nextAllocatedNonce ?? pendingNonce)
    if (nextAllocatedNonce != null) {
      for (let nonce = latestNonce; nonce < nextAllocatedNonce; nonce += 1) {
        if (!ownedNonces.has(nonce)) { nonceGap = true; break }
      }
    }

    const gasLimitCap = BigInt(String(this.env.STORY_COORDINATOR_GAS_LIMIT_MAX || "0"))
    const maxFeeCap = BigInt(String(this.env.STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI || "0"))
    let nativeRequired = 0n
    let remainingSteps = 0n
    const wrappedPlans = new Set<string>()
    for (const row of allSteps) {
      const state = String(row.state) as StorySettlementStepState
      const planActive = row.plan_state === "pending" || row.plan_state === "abandoning"
      if (planActive && !isTerminalStorySettlementStepState(state)) {
        remainingSteps += 1n
        if (String(row.step_kind) === "wip_wrap") nativeRequired += BigInt(String(row.native_value))
      }
      if (planActive && String(row.step_kind) === "wip_wrap" && state === "confirmed") {
        wrappedPlans.add(String(row.plan_ref))
      }
    }
    nativeRequired += remainingSteps * gasLimitCap * maxFeeCap
    let wipObligation = 0n
    for (const row of allSteps) {
      if (String(row.step_kind) !== "story_royalty_payment" || !wrappedPlans.has(String(row.plan_ref))) continue
      const state = String(row.state) as StorySettlementStepState
      if (state === "confirmed" || state === "reverted" || state === "replaced") continue
      const identity = JSON.parse(String(row.identity_json)) as { amount?: string | null }
      wipObligation += BigInt(identity.amount ?? "0")
    }
    const surplusWip = wipBalance > wipObligation ? wipBalance - wipObligation : 0n
    const oldestBacklog = planStats.oldest == null ? now : Number(planStats.oldest)
    const oldestReconciliation = reconciliationStats.oldest == null ? now : Number(reconciliationStats.oldest)
    return {
      chainId: domain.chainId,
      signerAddress: domain.signerAddress,
      pendingPlans: Number(planStats.count),
      oldestBacklogAgeMs: planStats.oldest == null ? 0 : Math.max(0, now - oldestBacklog),
      reconciliationRequiredSteps: Number(reconciliationStats.count),
      oldestReconciliationAgeMs: reconciliationStats.oldest == null ? 0 : Math.max(0, now - oldestReconciliation),
      replacedSteps: Number(replacedStats.count),
      latestNonce,
      pendingNonce,
      nextAllocatedNonce,
      nonceGap,
      nativeBalanceWei: nativeBalance.toString(),
      nativeRequiredWei: nativeRequired.toString(),
      wipBalanceWei: wipBalance.toString(),
      wipObligationWei: wipObligation.toString(),
      surplusWipWei: surplusWip.toString(),
    }
  }

  async reconcile(planRef: Hex): Promise<StorySettlementPlanResult> {
    assertBytes32("plan_ref", planRef)
    const plan = this.readPlan(planRef)
    if (!plan) throw conflictError("Story settlement plan not found")
    this.ctx.storage.sql.exec(
      "UPDATE steps SET next_attempt_at=?2, updated_at=?2 WHERE plan_ref=?1 AND state NOT IN ('confirmed','reverted','replaced')",
      planRef, Date.now(),
    )
    await this.ensureAlarm(Date.now())
    return this.result(this.readPlan(planRef)!)
  }

  async requestAbandonedNonceRepair(request: AbandonedNonceRepairRequest): Promise<StorySettlementPlanResult> {
    assertBytes32("plan_ref", request.planRef)
    assertBytes32("step_ref", request.stepRef)
    const step = this.readStep(request.stepRef)
    if (!step || step.plan_ref !== request.planRef) throw conflictError("Story settlement step not found")
    if (step.version !== request.expectedVersion) throw conflictError("Story settlement step version conflict")
    if (step.nonce == null || step.signed_transaction || step.transaction_hash) {
      throw conflictError("Only a reserved unsigned nonce can be repaired")
    }
    if (step.state !== "reserving" && step.state !== "failed_prebroadcast") {
      throw conflictError("Story settlement step is not abandoned-prebroadcast")
    }
    const repairRef = keccak256(encodeAbiParameters(REPAIR_REF_PARAMS, [
      "story-settlement-abandoned-nonce-v1", request.planRef, request.stepRef, BigInt(step.nonce), request.reasonCode,
      exactId("authorization_ref", request.authorizationRef),
    ]))
    this.ctx.storage.transactionSync(() => {
      let current = this.readStep(request.stepRef)
      if (!current || current.version !== request.expectedVersion) throw conflictError("Story settlement step version conflict")
      if (current.state === "reserving") {
        const next = this.transition(current, { expectedVersion: current.version, to: "failed_prebroadcast" })
        current = this.writeTransition(current, next)
      }
      this.ctx.storage.sql.exec(
        `UPDATE steps SET repair_state='requested', repair_reason_code=?2, repair_authorization_ref=?3, repair_ref=?4,
         version=?5, state=?6, next_attempt_at=?7, updated_at=?7 WHERE step_ref=?1 AND version=?8`,
        request.stepRef, request.reasonCode, request.authorizationRef, repairRef,
        current.version + 1, current.state, Date.now(), current.version,
      )
      this.ctx.storage.sql.exec(
        "UPDATE plans SET state='abandoning', version=version+1, updated_at=?2 WHERE plan_ref=?1",
        request.planRef, Date.now(),
      )
    })
    await this.ensureAlarm(Date.now())
    return this.result(this.readPlan(request.planRef)!)
  }

  async alarm(): Promise<void> {
    const repair = this.nextRepair()
    if (repair) {
      const runnableAt = Math.max(repair.next_attempt_at ?? Date.now(), repair.claim_expires_at ?? 0)
      if (runnableAt > Date.now()) {
        await this.ctx.storage.setAlarm(runnableAt)
        return
      }
      try { await this.advanceRepair(repair) } catch (error) { this.recordRetry(repair, error) }
      await this.scheduleNext()
      return
    }
    const step = this.nextRunnableStep()
    if (!step) {
      await this.ctx.storage.deleteAlarm()
      return
    }
    const runnableAt = Math.max(step.next_attempt_at ?? Date.now(), step.claim_expires_at ?? 0)
    if (runnableAt > Date.now()) {
      await this.ctx.storage.setAlarm(runnableAt)
      return
    }
    try { await this.advanceStep(step) } catch (error) { this.recordRetry(step, error) }
    await this.scheduleNext()
  }

  private validateRequest(request: StorySettlementPlanRequest): {
    planRef: Hex
    signerAddress: Address
    steps: Array<StorySettlementCoordinatorStepInput & { stepRef: Hex; identityJson: string }>
  } {
    const domain = signerDomain(request.chainId, request.signerAddress)
    exactId("community_id", request.communityId)
    exactId("quote_id", request.quoteId)
    exactId("purchase_id", request.purchaseId)
    exactId("fee_policy_version", request.feePolicyVersion)
    exactId("finality_policy_version", request.finalityPolicyVersion)
    if (!request.steps.length) throw badRequestError("story_settlement_plan_requires_steps")
    const sorted = [...request.steps].sort((a, b) => a.ordinal - b.ordinal)
    if (sorted.some((step, index) => step.ordinal !== index)) throw badRequestError("story_settlement_step_ordinals_must_be_contiguous")
    const identities = sorted.map((step) => {
      assertBytes32("call_identity", step.callIdentity)
      const identity = deriveStorySettlementCallIdentity({
        ...step,
        chainId: request.chainId,
        signerAddress: domain.signerAddress,
        communityId: request.communityId,
        quoteId: request.quoteId,
        purchaseId: request.purchaseId,
      })
      if (identity !== step.callIdentity) throw conflictError("Story settlement call identity mismatch")
      return identity
    })
    const planRef = derivePlanRef(request, identities)
    return {
      planRef,
      signerAddress: domain.signerAddress,
      steps: sorted.map((step, index) => ({
        ...step,
        target: getAddress(step.target),
        stepRef: stepRef(planRef, index, identities[index]!),
        identityJson: JSON.stringify({ ...step, nativeValue: step.nativeValue.toString(), amount: step.amount?.toString() ?? null }),
      })),
    }
  }

  private assertPlanImmutable(
    plan: PlanRow,
    request: StorySettlementPlanRequest,
    steps: Array<StorySettlementCoordinatorStepInput & { stepRef: Hex; identityJson: string }>,
  ): void {
    if (plan.chain_id !== request.chainId || plan.signer_address !== getAddress(request.signerAddress)
      || plan.community_id !== request.communityId || plan.quote_id !== request.quoteId || plan.purchase_id !== request.purchaseId
      || plan.fee_policy_version !== request.feePolicyVersion || plan.finality_policy_version !== request.finalityPolicyVersion) {
      throw conflictError("Story settlement plan identity reused with different data")
    }
    const stored = this.readSteps(plan.plan_ref)
    if (stored.length !== steps.length || stored.some((row, i) => row.call_identity !== steps[i]!.callIdentity)) {
      throw conflictError("Story settlement plan identity reused with different calls")
    }
  }

  private async advanceStep(input: StepRow): Promise<void> {
    let step = input
    if (step.state === "planned") step = await this.reserveNonce(step)
    if (step.state === "failed_prebroadcast") {
      step = this.writeTransition(step, this.transition(step, {
        expectedVersion: step.version,
        to: "reserving",
        nonce: step.nonce!,
      }), { last_error_code: null })
    }
    if (step.state === "reserving") step = await this.signStep(step)
    if (step.state === "prepared") await this.broadcastStep(step)
    else if (["broadcast", "mined", "reconciliation_required"].includes(step.state)) await this.reconcileStep(step)
  }

  private async reserveNonce(step: StepRow): Promise<StepRow> {
    if (this.hasUnresolvedRepair()) throw new Error("unresolved_abandoned_nonce_repair")
    const plan = this.readPlan(step.plan_ref)!
    const domain = this.domain(plan)
    const [pendingNonce, gas] = await Promise.all([
      chain().pendingNonce(this.env, domain),
      chain().gasParameters(this.env, {
        ...domain,
        feePolicyVersion: plan.fee_policy_version,
        target: step.target,
        value: BigInt(step.native_value),
        calldata: step.calldata,
      }),
    ])
    assertNonce(pendingNonce)
    this.assertGas(gas)
    const reserved = this.ctx.storage.transactionSync(() => {
      const current = this.readStep(step.step_ref)!
      if (current.state !== "planned") return current
      this.ctx.storage.sql.exec(
        "INSERT INTO nonce_state (id,next_nonce) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET next_nonce=MAX(next_nonce,?1)",
        pendingNonce,
      )
      const nonce = Number(this.ctx.storage.sql.exec<{ nonce: number }>(
        "UPDATE nonce_state SET next_nonce=next_nonce+1 WHERE id=1 RETURNING next_nonce-1 AS nonce",
      ).one().nonce)
      const next = this.transition(current, { expectedVersion: current.version, to: "reserving", nonce })
      return this.writeTransition(current, next, {
        max_fee_per_gas: gas.maxFeePerGas.toString(),
        max_priority_fee_per_gas: gas.maxPriorityFeePerGas.toString(),
        gas_limit: gas.gasLimit.toString(),
      })
    })
    await chain().fault?.("after_nonce_reserved")
    return reserved
  }

  private async signStep(step: StepRow): Promise<StepRow> {
    if (step.nonce == null) throw new Error("reserved_step_missing_nonce")
    if (!step.max_fee_per_gas || !step.max_priority_fee_per_gas || !step.gas_limit) {
      throw new Error("reserved_step_missing_gas_policy")
    }
    const claimed = this.claim(step)
    if (!claimed) return this.readStep(step.step_ref)!
    const plan = this.readPlan(step.plan_ref)!
    try {
      const signedTransaction = await chain().signTransaction(this.env, {
        ...this.domain(plan), nonce: step.nonce, target: step.target,
        value: BigInt(step.native_value), calldata: step.calldata,
        gas: {
          maxFeePerGas: BigInt(step.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(step.max_priority_fee_per_gas),
          gasLimit: BigInt(step.gas_limit),
        },
      })
      if (!isHex(signedTransaction, { strict: true }) || size(signedTransaction) === 0) throw new Error("signer_returned_invalid_transaction_bytes")
      await this.assertSignedTransaction(signedTransaction, {
        ...this.domain(plan),
        nonce: step.nonce,
        target: step.target,
        value: BigInt(step.native_value),
        calldata: step.calldata,
        gas: {
          maxFeePerGas: BigInt(step.max_fee_per_gas),
          maxPriorityFeePerGas: BigInt(step.max_priority_fee_per_gas),
          gasLimit: BigInt(step.gas_limit),
        },
      })
      const transactionHash = keccak256(signedTransaction)
      await chain().fault?.("after_signed_before_persist")
      const current = this.readStep(step.step_ref)!
      if (current.claim_token !== claimed.token || current.version !== claimed.version) return current
      const next = this.transition(current, {
        expectedVersion: current.version,
        to: "prepared",
        nonce: current.nonce!,
        signedTransactionStored: true,
        transactionHash,
      })
      const written = this.writeTransition(current, next, {
        signed_transaction: signedTransaction,
        claim_token: null,
        claim_expires_at: null,
      })
      await chain().fault?.("after_prepared_persisted")
      return written
    } catch (error) {
      const current = this.readStep(step.step_ref)
      if (current?.claim_token === claimed.token && !current.signed_transaction) {
        const next = this.transition(current, { expectedVersion: current.version, to: "failed_prebroadcast" })
        this.writeTransition(current, next, { claim_token: null, claim_expires_at: null, last_error_code: boundedErrorCode(error) })
      }
      throw error
    }
  }

  private async broadcastStep(step: StepRow): Promise<void> {
    if (!step.signed_transaction || !step.transaction_hash) throw new Error("prepared_step_missing_signed_evidence")
    const plan = this.readPlan(step.plan_ref)!
    await chain().broadcastExactTransaction(this.env, { ...this.domain(plan), signedTransaction: step.signed_transaction })
    await chain().fault?.("after_broadcast_before_persist")
    const current = this.readStep(step.step_ref)!
    if (current.state !== "prepared") return
    const next = this.transition(current, { expectedVersion: current.version, to: "broadcast" })
    this.writeTransition(current, next, { next_attempt_at: Date.now() + RECONCILE_DELAY_MS, last_error_code: null })
  }

  private async reconcileStep(step: StepRow): Promise<void> {
    if (!step.transaction_hash || !step.signed_transaction || step.nonce == null) throw new Error("journaled_step_missing_chain_evidence")
    const plan = this.readPlan(step.plan_ref)!
    const domain = this.domain(plan)
    const observation = await chain().observeTransaction(this.env, {
      ...domain,
      transactionHash: step.transaction_hash,
      finalityPolicyVersion: plan.finality_policy_version,
    })
    await chain().fault?.("after_receipt_before_persist")
    const current = this.readStep(step.step_ref)!
    if (observation.kind === "pending") {
      if (current.state === "mined") this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to: "broadcast" }))
      else if (current.state === "broadcast") this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to: "broadcast" }), { next_attempt_at: Date.now() + RECONCILE_DELAY_MS })
      else if (current.state === "reconciliation_required") {
        this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to: "broadcast" }), { next_attempt_at: Date.now() + RECONCILE_DELAY_MS })
      }
      return
    }
    if (observation.kind === "absent") {
      const latestNonce = await chain().latestNonce(this.env, domain)
      if (latestNonce > step.nonce) {
        const to = current.state === "mined" ? "reconciliation_required" : "replaced"
        this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to }), {
          last_error_code: current.state === "mined"
            ? "pre_finality_reorg_nonce_consumed"
            : current.last_error_code === "pre_finality_reorg_nonce_consumed"
              ? current.last_error_code
              : "nonce_consumed_by_other_transaction",
        })
        this.refreshPlan(plan.plan_ref)
        return
      }
      await chain().broadcastExactTransaction(this.env, { ...domain, signedTransaction: step.signed_transaction })
      const targetState = current.state === "mined" ? "broadcast" : current.state === "reconciliation_required" ? "broadcast" : "broadcast"
      this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to: targetState }), { next_attempt_at: Date.now() + RECONCILE_DELAY_MS })
      return
    }
    const receipt = { status: observation.status, blockNumber: observation.blockNumber, blockHash: observation.blockHash } as const
    if (current.receipt_status && (
      current.receipt_status !== receipt.status
      || current.block_number !== receipt.blockNumber.toString()
      || current.block_hash !== receipt.blockHash
    )) {
      console.error(JSON.stringify({ message: "story settlement reorg observation", planRef: plan.plan_ref, stepRef: step.step_ref, code: "mined_block_identity_changed" }))
      if (current.state === "reconciliation_required") {
        this.ctx.storage.sql.exec(
          "UPDATE steps SET last_error_code='mined_block_identity_changed', next_attempt_at=?2, updated_at=?3 WHERE step_ref=?1",
          current.step_ref, Date.now() + RECONCILE_DELAY_MS, Date.now(),
        )
        return
      }
      const next = this.transition(current, { expectedVersion: current.version, to: "reconciliation_required" })
      this.writeTransition(current, next, { last_error_code: "mined_block_identity_changed" })
      return
    }
    if (observation.status === "reverted") {
      this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to: "reverted", receipt }), { last_error_code: "transaction_reverted" })
      this.refreshPlan(plan.plan_ref)
      return
    }
    if (current.state === "mined" && observation.final) {
      this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to: "confirmed", receipt }), { next_attempt_at: null, last_error_code: null })
      this.refreshPlan(plan.plan_ref)
      return
    }
    const to = current.state === "mined" ? "mined" : "mined"
    this.writeTransition(current, this.transition(current, { expectedVersion: current.version, to, receipt }), { next_attempt_at: Date.now() + RECONCILE_DELAY_MS })
  }

  private async advanceRepair(step: StepRow): Promise<void> {
    const plan = this.readPlan(step.plan_ref)!
    const domain = this.domain(plan)
    if (step.nonce == null || !step.repair_ref) throw new Error("repair_missing_reserved_nonce")
    if (step.repair_state === "requested") {
      const gas = await chain().gasParameters(this.env, {
        ...domain,
        feePolicyVersion: plan.fee_policy_version,
        target: domain.signerAddress,
        value: 0n,
        calldata: "0x",
      })
      this.assertGas(gas)
      const signed = await chain().signTransaction(this.env, {
        ...domain, nonce: step.nonce, target: domain.signerAddress, value: 0n, calldata: "0x", gas,
      })
      if (!isHex(signed, { strict: true }) || size(signed) === 0) throw new Error("repair_signer_returned_invalid_transaction_bytes")
      await this.assertSignedTransaction(signed, {
        ...domain, nonce: step.nonce, target: domain.signerAddress, value: 0n, calldata: "0x", gas,
      })
      const hash = keccak256(signed)
      this.ctx.storage.sql.exec(
        `UPDATE steps SET repair_state='prepared', repair_signed_transaction=?2,
         repair_transaction_hash=?3, version=version+1, updated_at=?4 WHERE step_ref=?1 AND repair_state='requested'`,
        step.step_ref, signed, hash, Date.now(),
      )
      this.touchPlan(step.plan_ref)
      return
    }
    if (step.repair_state === "prepared") {
      await chain().broadcastExactTransaction(this.env, { ...domain, signedTransaction: step.repair_signed_transaction! })
      this.ctx.storage.sql.exec(
        "UPDATE steps SET repair_state='broadcast', version=version+1, next_attempt_at=?2, updated_at=?3 WHERE step_ref=?1 AND repair_state='prepared'",
        step.step_ref, Date.now() + RECONCILE_DELAY_MS, Date.now(),
      )
      this.touchPlan(step.plan_ref)
      return
    }
    const observation = await chain().observeTransaction(this.env, {
      ...domain,
      transactionHash: step.repair_transaction_hash!,
      finalityPolicyVersion: plan.finality_policy_version,
    })
    if (observation.kind === "mined") {
      if (step.repair_block_hash && (
        step.repair_receipt_status !== observation.status
        || step.repair_block_number !== observation.blockNumber.toString()
        || step.repair_block_hash !== observation.blockHash
      )) {
        console.error(JSON.stringify({
          message: "story settlement nonce-repair reorg observation",
          planRef: plan.plan_ref,
          stepRef: step.step_ref,
          code: "repair_mined_block_identity_changed",
        }))
        this.ctx.storage.sql.exec(
          `UPDATE steps SET repair_state='reconciliation_required',
           last_error_code='repair_mined_block_identity_changed', version=version+1,
           next_attempt_at=?2, updated_at=?3 WHERE step_ref=?1`,
          step.step_ref, Date.now() + RECONCILE_DELAY_MS, Date.now(),
        )
        this.touchPlan(step.plan_ref)
        return
      }
      const state: RepairState = observation.status === "reverted" ? "reverted" : observation.final ? "confirmed" : "broadcast"
      this.ctx.storage.sql.exec(
        `UPDATE steps SET repair_state=?2, repair_receipt_status=?3, repair_block_number=?4,
         repair_block_hash=?5, version=version+1, next_attempt_at=?6, updated_at=?7 WHERE step_ref=?1`,
        step.step_ref, state, observation.status, observation.blockNumber.toString(), observation.blockHash,
        state === "broadcast" ? Date.now() + RECONCILE_DELAY_MS : null, Date.now(),
      )
      if (state === "confirmed") {
        this.ctx.storage.sql.exec("UPDATE plans SET state='abandoned', version=version+1, updated_at=?2 WHERE plan_ref=?1", plan.plan_ref, Date.now())
      } else this.touchPlan(step.plan_ref)
      return
    }
    if (observation.kind === "pending") return
    const latestNonce = await chain().latestNonce(this.env, domain)
    if (latestNonce > step.nonce) {
      this.ctx.storage.sql.exec("UPDATE steps SET repair_state='replaced', version=version+1, updated_at=?2 WHERE step_ref=?1", step.step_ref, Date.now())
      this.touchPlan(step.plan_ref)
      return
    }
    await chain().broadcastExactTransaction(this.env, { ...domain, signedTransaction: step.repair_signed_transaction! })
  }

  private claim(step: StepRow): { token: string; version: number } | null {
    const now = Date.now()
    const token = crypto.randomUUID()
    const rows = this.ctx.storage.sql.exec(
      `UPDATE steps SET claim_token=?2, claim_expires_at=?3, version=version+1, updated_at=?4
       WHERE step_ref=?1 AND state IN ('reserving','failed_prebroadcast')
         AND signed_transaction IS NULL AND (claim_token IS NULL OR claim_expires_at<=?4)
       RETURNING version`,
      step.step_ref, token, now + SIGNING_LEASE_MS, now,
    ).toArray() as Array<{ version: number }>
    if (rows.length !== 1) return null
    this.touchPlan(step.plan_ref)
    return { token, version: Number(rows[0]!.version) }
  }

  private transition(step: StepRow, transition: StorySettlementStepTransition): StorySettlementStepSnapshot {
    return transitionStorySettlementStep(this.snapshot(step), transition)
  }

  private writeTransition(current: StepRow, next: StorySettlementStepSnapshot, extra: Partial<StepRow> = {}): StepRow {
    const receipt = next.receipt
    const signedTransaction = extra.signed_transaction ?? current.signed_transaction
    if (next.signedTransactionStored && !signedTransaction) throw new Error("signed_transaction_bytes_must_be_durable")
    if (signedTransaction && next.transactionHash !== keccak256(signedTransaction)) {
      throw new Error("transaction_hash_does_not_match_signed_bytes")
    }
    const changed = this.ctx.storage.sql.exec(
      `UPDATE steps SET state=?2, version=?3, nonce=?4, max_fee_per_gas=?5,
       max_priority_fee_per_gas=?6, gas_limit=?7, signed_transaction=?8,
       transaction_hash=?9, receipt_status=?10, block_number=?11, block_hash=?12,
       claim_token=?13, claim_expires_at=?14, next_attempt_at=?15, last_error_code=?16, updated_at=?17
       WHERE step_ref=?1 AND version=?18 RETURNING step_ref`,
      current.step_ref, next.state, next.version, next.nonce,
      extra.max_fee_per_gas === undefined ? current.max_fee_per_gas : extra.max_fee_per_gas,
      extra.max_priority_fee_per_gas === undefined ? current.max_priority_fee_per_gas : extra.max_priority_fee_per_gas,
      extra.gas_limit === undefined ? current.gas_limit : extra.gas_limit,
      signedTransaction, next.transactionHash,
      receipt?.status ?? null, receipt?.blockNumber.toString() ?? null, receipt?.blockHash ?? null,
      extra.claim_token === undefined ? current.claim_token : extra.claim_token,
      extra.claim_expires_at === undefined ? current.claim_expires_at : extra.claim_expires_at,
      extra.next_attempt_at === undefined ? current.next_attempt_at : extra.next_attempt_at,
      extra.last_error_code === undefined ? current.last_error_code : extra.last_error_code,
      Date.now(), current.version,
    ).toArray()
    if (changed.length !== 1) throw conflictError("Story settlement step version conflict")
    this.touchPlan(current.plan_ref)
    return this.readStep(current.step_ref)!
  }

  private recordRetry(step: StepRow, error: unknown): void {
    const current = this.readStep(step.step_ref)
    if (!current || isTerminalStorySettlementStepState(current.state)) return
    const attempts = current.attempt_count + 1
    const delay = Math.min(RETRY_BASE_MS * (2 ** Math.min(attempts, 6)), RETRY_MAX_MS)
    this.ctx.storage.sql.exec(
      "UPDATE steps SET attempt_count=?2, next_attempt_at=?3, last_error_code=?4, version=version+1, updated_at=?5 WHERE step_ref=?1",
      step.step_ref, attempts, Date.now() + delay, boundedErrorCode(error), Date.now(),
    )
    this.touchPlan(step.plan_ref)
  }

  private nextRepair(): StepRow | null {
    const row = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT * FROM steps WHERE repair_state IN ('requested','prepared','broadcast','reconciliation_required')
       ORDER BY updated_at ASC LIMIT 1`,
    ).toArray()[0]
    return row ? this.decodeStep(row) : null
  }

  private hasUnresolvedRepair(): boolean {
    return this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM steps WHERE repair_state IN ('requested','prepared','broadcast','reconciliation_required')",
    ).one().count > 0
  }

  private nextRunnableStep(): StepRow | null {
    const row = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT s.* FROM steps s JOIN plans p ON p.plan_ref=s.plan_ref
       WHERE p.state='pending' AND s.state NOT IN ('confirmed','reverted','replaced')
         AND NOT EXISTS (
           SELECT 1 FROM steps prior WHERE prior.plan_ref=s.plan_ref AND prior.ordinal<s.ordinal AND prior.state!='confirmed'
         )
       ORDER BY p.created_at ASC, s.ordinal ASC LIMIT 1`,
    ).toArray()[0]
    return row ? this.decodeStep(row) : null
  }

  private refreshPlan(planRef: Hex): void {
    const steps = this.readSteps(planRef)
    const state: PlanState = steps.every((step) => step.state === "confirmed")
      ? "confirmed"
      : steps.some((step) => step.state === "reverted" || step.state === "replaced") ? "failed" : "pending"
    this.ctx.storage.sql.exec(
      "UPDATE plans SET state=?2, version=version+1, updated_at=?3 WHERE plan_ref=?1 AND state!=?2",
      planRef, state, Date.now(),
    )
  }

  private touchPlan(planRef: Hex): void {
    this.ctx.storage.sql.exec(
      "UPDATE plans SET version=version+1,updated_at=?2 WHERE plan_ref=?1",
      planRef, Date.now(),
    )
  }

  private async scheduleNext(): Promise<void> {
    const next = this.nextRepair() ?? this.nextRunnableStep()
    if (!next) { await this.ctx.storage.deleteAlarm(); return }
    // An alarm handler may still observe its just-fired timestamp through getAlarm(). Always
    // replace it here; ensureAlarm() is reserved for RPC-side wakeups.
    await this.ctx.storage.setAlarm(Math.max(next.next_attempt_at ?? Date.now(), next.claim_expires_at ?? 0))
  }

  private async ensureAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current == null || current > at) await this.ctx.storage.setAlarm(at)
  }

  private domain(plan: PlanRow): SignerDomain {
    return { chainId: plan.chain_id, signerAddress: plan.signer_address }
  }

  private assertGas(gas: StorySettlementGasParameters): void {
    if (gas.maxFeePerGas <= 0n || gas.maxPriorityFeePerGas < 0n || gas.gasLimit <= 0n) {
      throw new Error("story_settlement_gas_parameters_invalid")
    }
    if (gas.maxPriorityFeePerGas > gas.maxFeePerGas) {
      throw new Error("story_settlement_priority_fee_exceeds_max_fee")
    }
  }

  private async assertSignedTransaction(
    signedTransaction: Hex,
    expected: SignerDomain & {
      nonce: number
      target: Address
      value: bigint
      calldata: Hex
      gas: StorySettlementGasParameters
    },
  ): Promise<void> {
    const parsed = parseTransaction(signedTransaction)
    const recoveredSigner = await recoverTransactionAddress({ serializedTransaction: signedTransaction as TransactionSerialized })
    if (getAddress(recoveredSigner) !== expected.signerAddress) throw new Error("signed_transaction_signer_mismatch")
    if (parsed.chainId !== expected.chainId) throw new Error("signed_transaction_chain_mismatch")
    if (parsed.nonce !== expected.nonce) throw new Error("signed_transaction_nonce_mismatch")
    if (!parsed.to || getAddress(parsed.to) !== expected.target) throw new Error("signed_transaction_target_mismatch")
    if ((parsed.value ?? 0n) !== expected.value) throw new Error("signed_transaction_value_mismatch")
    if ((parsed.data ?? "0x") !== expected.calldata) throw new Error("signed_transaction_calldata_mismatch")
    if (parsed.gas !== expected.gas.gasLimit) throw new Error("signed_transaction_gas_limit_mismatch")
    if (parsed.maxFeePerGas !== expected.gas.maxFeePerGas) throw new Error("signed_transaction_max_fee_mismatch")
    if (parsed.maxPriorityFeePerGas !== expected.gas.maxPriorityFeePerGas) {
      throw new Error("signed_transaction_priority_fee_mismatch")
    }
  }

  private readPlan(planRef: Hex): PlanRow | null {
    const row = this.ctx.storage.sql.exec<Record<string, string | number | null>>("SELECT * FROM plans WHERE plan_ref=?1", planRef).toArray()[0]
    return row ? {
      plan_ref: String(row.plan_ref) as Hex,
      chain_id: Number(row.chain_id),
      signer_address: getAddress(String(row.signer_address)),
      community_id: String(row.community_id),
      quote_id: String(row.quote_id),
      purchase_id: String(row.purchase_id),
      fee_policy_version: String(row.fee_policy_version),
      finality_policy_version: String(row.finality_policy_version),
      state: String(row.state) as PlanState,
      version: Number(row.version),
    } : null
  }

  private readStep(stepRefValue: Hex): StepRow | null {
    const row = this.ctx.storage.sql.exec<Record<string, string | number | null>>("SELECT * FROM steps WHERE step_ref=?1", stepRefValue).toArray()[0]
    return row ? this.decodeStep(row) : null
  }

  private readSteps(planRef: Hex): StepRow[] {
    return this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      "SELECT * FROM steps WHERE plan_ref=?1 ORDER BY ordinal",
      planRef,
    ).toArray().map((row) => this.decodeStep(row))
  }

  private decodeStep(row: Record<string, string | number | null>): StepRow {
    return {
      step_ref: String(row.step_ref) as Hex,
      plan_ref: String(row.plan_ref) as Hex,
      call_identity: String(row.call_identity) as Hex,
      effect_kind: String(row.effect_kind) as StorySettlementEffectKind,
      effect_key: String(row.effect_key),
      step_kind: String(row.step_kind) as StorySettlementStepKind,
      ordinal: Number(row.ordinal), target: getAddress(String(row.target)), native_value: String(row.native_value),
      calldata: String(row.calldata) as Hex, identity_json: String(row.identity_json),
      state: String(row.state) as StorySettlementStepState, version: Number(row.version),
      nonce: row.nonce == null ? null : Number(row.nonce),
      max_fee_per_gas: row.max_fee_per_gas == null ? null : String(row.max_fee_per_gas),
      max_priority_fee_per_gas: row.max_priority_fee_per_gas == null ? null : String(row.max_priority_fee_per_gas),
      gas_limit: row.gas_limit == null ? null : String(row.gas_limit),
      signed_transaction: row.signed_transaction == null ? null : String(row.signed_transaction) as Hex,
      transaction_hash: row.transaction_hash == null ? null : String(row.transaction_hash) as Hex,
      receipt_status: row.receipt_status == null ? null : String(row.receipt_status) as "success" | "reverted",
      block_number: row.block_number == null ? null : String(row.block_number),
      block_hash: row.block_hash == null ? null : String(row.block_hash) as Hex,
      claim_token: row.claim_token == null ? null : String(row.claim_token),
      claim_expires_at: row.claim_expires_at == null ? null : Number(row.claim_expires_at),
      attempt_count: Number(row.attempt_count), next_attempt_at: row.next_attempt_at == null ? null : Number(row.next_attempt_at),
      last_error_code: row.last_error_code == null ? null : String(row.last_error_code),
      repair_state: row.repair_state == null ? null : String(row.repair_state) as RepairState,
      repair_reason_code: row.repair_reason_code == null ? null : String(row.repair_reason_code),
      repair_authorization_ref: row.repair_authorization_ref == null ? null : String(row.repair_authorization_ref),
      repair_ref: row.repair_ref == null ? null : String(row.repair_ref) as Hex,
      repair_signed_transaction: row.repair_signed_transaction == null ? null : String(row.repair_signed_transaction) as Hex,
      repair_transaction_hash: row.repair_transaction_hash == null ? null : String(row.repair_transaction_hash) as Hex,
      repair_receipt_status: row.repair_receipt_status == null ? null : String(row.repair_receipt_status) as "success" | "reverted",
      repair_block_number: row.repair_block_number == null ? null : String(row.repair_block_number),
      repair_block_hash: row.repair_block_hash == null ? null : String(row.repair_block_hash) as Hex,
    }
  }

  private snapshot(step: StepRow): StorySettlementStepSnapshot {
    return {
      state: step.state,
      version: step.version,
      nonce: step.nonce,
      signedTransactionStored: step.signed_transaction != null,
      transactionHash: step.transaction_hash,
      receipt: step.receipt_status && step.block_number && step.block_hash
        ? { status: step.receipt_status, blockNumber: BigInt(step.block_number), blockHash: step.block_hash }
        : null,
    }
  }

  private result(plan: PlanRow): StorySettlementPlanResult {
    return {
      planRef: plan.plan_ref,
      state: plan.state,
      version: plan.version,
      steps: this.readSteps(plan.plan_ref).map((step) => ({
        stepRef: step.step_ref,
        callIdentity: step.call_identity,
        ordinal: step.ordinal,
        state: step.state,
        version: step.version,
        nonce: step.nonce,
        transactionHash: step.transaction_hash,
        receipt: this.snapshot(step).receipt,
        attemptCount: step.attempt_count,
        repairState: step.repair_state,
        lastErrorCode: step.last_error_code,
      })),
    }
  }
}
