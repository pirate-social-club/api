import { getAddress } from "ethers"

import type { Env } from "../../env"
import { badRequestError, conflictError, eligibilityFailed, notFoundError } from "../errors"
import { parseExpectedEvmAddress } from "../evm-signer"
import { getControlPlaneClient, isPostgresControlPlaneUrl } from "../runtime-deps"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import { withTransaction } from "../transactions"
import {
  findActiveAuthProviderLink,
  initializePrimaryWalletIfNeeded,
  reconcileWalletAttachments,
} from "../auth/auth-db-user-queries"
import { hasActiveUniqueHumanNullifier, resolveRewardIdentityProvider } from "../verification/unique-human-eligibility"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
} from "../communities/bookings/operator-signing-coordinator-do"
import {
  assertDistinctBookingAndRewardsSignerDomains,
  assertRewardsCampaignAndSettlementChainsMatch,
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../communities/bookings/booking-chain-config"
import type { RewardCashoutResponse, RewardPayoutStatus, UpstreamIdentity } from "../../types"

const DEFAULT_CONFIRM_POLL_MS = [500, 1000, 2000, 2000, 2000, 3000]
const DEFAULT_REWARDS_MIN_CASHOUT_CENTS = 100
const MAX_RECONCILE_ATTEMPTS = 3
const DEFAULT_PAYOUT_RECONCILE_LIMIT = 50
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9:_-]{8,160}$/

export interface RewardSettlementCoordinator {
  settle(req: OperatorSettleRequest): Promise<OperatorSettleResult>
  confirm(req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult>
  reconcile(req: OperatorSettleRequest): Promise<OperatorSettleResult>
}

let rewardsCoordinatorForTests: RewardSettlementCoordinator | null = null
let rewardsConfirmPollPlanForTests: number[] | null = null

export function setRewardSettlementCoordinatorForTests(coordinator: RewardSettlementCoordinator | null): void {
  rewardsCoordinatorForTests = coordinator
}

export function setRewardSettlementConfirmPollPlanForTests(delaysMs: number[] | null): void {
  rewardsConfirmPollPlanForTests = delaysMs
}

interface RewardPayoutEffect {
  rewardPayoutEffectId: string
  userId: string
  amountCents: number
  recipientAddress: string
  idempotencyKey: string
  status: RewardPayoutStatus
  settlementRef: string | null
  failureReason: string | null
  attemptCount: number
  coordinatorRef: string | null
  coordinatorState: string | null
}

interface ReservedCashout {
  effect: RewardPayoutEffect
  availableBalanceCents: number
}

type RewardEventBalance = {
  rewardEventId: string
  rewardCampaignId: string | null
  availableCents: number
}

type RewardPayoutAllocation = {
  rewardEventId: string
  rewardCampaignId: string | null
  amountCents: number
}

export interface RewardPayoutReconciliationSummary {
  enabled: boolean
  scanned: number
  confirmed: number
  failed: number
  pending: number
  errors: number
}

function normalizeIdempotencyKey(raw: unknown): string {
  const key = typeof raw === "string" ? raw.trim() : ""
  if (!IDEMPOTENCY_KEY_RE.test(key)) {
    throw badRequestError("A valid rewards cashout idempotency_key is required")
  }
  return key
}

function normalizeAmountCents(raw: unknown): number {
  const amount = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw badRequestError("Rewards cashout amount_cents must be a positive integer")
  }
  return amount
}

function parseConfiguredCents(raw: string | undefined, fallback: number): number {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) return fallback
  const parsed = Number(trimmed)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function rewardPayoutsEnabled(env: Pick<Env, "REWARDS_PAYOUTS_ENABLED">): boolean {
  return String(env.REWARDS_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true"
}

function normalizeRecipientAddress(raw: string): string {
  const parsed = parseExpectedEvmAddress(raw)
  if (!parsed) throw conflictError("Rewards cashout requires an active EVM wallet")
  return getAddress(parsed)
}

function decodePayoutEffect(row: QueryResultRow): RewardPayoutEffect {
  const status = requiredString(row, "status")
  if (status !== "submitted" && status !== "confirmed" && status !== "failed") {
    throw new Error(`unexpected_reward_payout_status:${status}`)
  }
  return {
    rewardPayoutEffectId: requiredString(row, "reward_payout_effect_id"),
    userId: requiredString(row, "user_id"),
    amountCents: requiredNumber(row, "amount_cents"),
    recipientAddress: requiredString(row, "recipient_address"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    status,
    settlementRef: stringOrNull(rowValue(row, "settlement_ref")),
    failureReason: stringOrNull(rowValue(row, "failure_reason")),
    attemptCount: requiredNumber(row, "attempt_count"),
    coordinatorRef: stringOrNull(rowValue(row, "coordinator_ref")),
    coordinatorState: stringOrNull(rowValue(row, "coordinator_state")),
  }
}

const PAYOUT_COLUMNS = `
  reward_payout_effect_id, user_id, amount_cents, recipient_address, idempotency_key,
  status, settlement_ref, failure_reason, attempt_count, coordinator_ref, coordinator_state
`

async function getPayoutByUserIdAndIdempotencyKey(
  exec: Pick<Client | Transaction, "execute">,
  userId: string,
  idempotencyKey: string,
): Promise<RewardPayoutEffect | null> {
  const result = await exec.execute({
    sql: `
      SELECT ${PAYOUT_COLUMNS}
      FROM reward_payout_effects
      WHERE user_id = ?1 AND idempotency_key = ?2
      LIMIT 1
    `,
    args: [userId, idempotencyKey],
  })
  return result.rows[0] ? decodePayoutEffect(result.rows[0]) : null
}

async function getPayoutByUserIdAndEffectId(
  exec: Pick<Client | Transaction, "execute">,
  userId: string,
  effectId: string,
): Promise<RewardPayoutEffect | null> {
  const result = await exec.execute({
    sql: `
      SELECT ${PAYOUT_COLUMNS}
      FROM reward_payout_effects
      WHERE user_id = ?1 AND reward_payout_effect_id = ?2
      LIMIT 1
    `,
    args: [userId, effectId],
  })
  return result.rows[0] ? decodePayoutEffect(result.rows[0]) : null
}

async function getSubmittedPayoutForUser(
  exec: Pick<Client | Transaction, "execute">,
  userId: string,
): Promise<RewardPayoutEffect | null> {
  const result = await exec.execute({
    sql: `
      SELECT ${PAYOUT_COLUMNS}
      FROM reward_payout_effects
      WHERE user_id = ?1 AND status = 'submitted'
      ORDER BY updated_at DESC, reward_payout_effect_id DESC
      LIMIT 1
    `,
    args: [userId],
  })
  return result.rows[0] ? decodePayoutEffect(result.rows[0]) : null
}

async function resolveCashoutRecipient(exec: Pick<Client | Transaction, "execute">, userId: string): Promise<string> {
  const result = await exec.execute({
    sql: `
      SELECT wa.wallet_address_display
      FROM wallet_attachments wa
      JOIN users u ON u.user_id = wa.user_id
      WHERE wa.user_id = ?1
        AND wa.status = 'active'
        AND wa.chain_namespace IN ('eip155', 'eip155:1')
      ORDER BY
        CASE
          WHEN wa.wallet_attachment_id = u.primary_wallet_attachment_id THEN 0
          WHEN wa.attachment_kind = 'embedded' THEN 1
          WHEN wa.is_primary = 1 THEN 2
          ELSE 3
        END,
        wa.attached_at ASC,
        wa.wallet_attachment_id ASC
      LIMIT 1
    `,
    args: [userId],
  })
  const address = stringOrNull(rowValue(result.rows[0], "wallet_address_display"))
  if (!address) throw conflictError("Rewards cashout requires an active EVM wallet")
  return normalizeRecipientAddress(address)
}

async function reconcileCashoutWalletIdentity(input: {
  tx: Transaction
  userId: string
  walletIdentity: UpstreamIdentity | null | undefined
  nowUtc: string
}): Promise<void> {
  if (!input.walletIdentity) return
  if (input.walletIdentity.provider !== "privy") {
    throw conflictError("Rewards claim wallet proof provider is not supported")
  }
  const link = await findActiveAuthProviderLink(
    input.tx,
    input.walletIdentity.provider,
    input.walletIdentity.providerSubject,
  )
  if (!link || link.user_id !== input.userId) {
    throw conflictError("Rewards claim wallet proof does not match this account")
  }
  await reconcileWalletAttachments(input.tx, {
    userId: input.userId,
    identity: input.walletIdentity,
    updatedAt: input.nowUtc,
  })
  await initializePrimaryWalletIfNeeded(input.tx, {
    userId: input.userId,
    identity: input.walletIdentity,
    updatedAt: input.nowUtc,
  })
}

async function currentBalanceCents(exec: Pick<Client | Transaction, "execute">, userId: string): Promise<number> {
  const result = await exec.execute({
    sql: `
      SELECT
        COALESCE((SELECT SUM(amount_cents) FROM reward_events WHERE user_id = ?1), 0)
        - COALESCE((SELECT SUM(amount_cents) FROM reward_payout_effects WHERE user_id = ?1 AND status IN ('submitted', 'confirmed')), 0)
        AS balance_cents
    `,
    args: [userId],
  })
  return Math.max(0, Number(rowValue(result.rows[0], "balance_cents") ?? 0))
}

export function planRewardPayoutAllocations(
  events: ReadonlyArray<RewardEventBalance>,
  amountCents: number,
): RewardPayoutAllocation[] {
  let remaining = amountCents
  const allocations: RewardPayoutAllocation[] = []
  for (const event of events) {
    if (remaining <= 0) break
    const available = Math.max(0, Math.trunc(event.availableCents))
    if (available === 0) continue
    const allocated = Math.min(available, remaining)
    allocations.push({
      rewardEventId: event.rewardEventId,
      rewardCampaignId: event.rewardCampaignId,
      amountCents: allocated,
    })
    remaining -= allocated
  }
  if (remaining !== 0) {
    throw conflictError("Rewards cashout allocation does not match the available balance")
  }
  return allocations
}

async function reservePayoutAllocations(input: {
  tx: Transaction
  effectId: string
  userId: string
  amountCents: number
  nowUtc: string
}): Promise<void> {
  const result = await input.tx.execute({
    sql: `
      SELECT
        event.reward_event_id,
        event.reward_campaign_id,
        event.amount_cents - COALESCE(SUM(
          CASE WHEN allocation.status IN ('submitted', 'confirmed') THEN allocation.amount_cents ELSE 0 END
        ), 0) AS available_cents
      FROM reward_events event
      LEFT JOIN reward_payout_allocations allocation
        ON allocation.reward_event_id = event.reward_event_id
      WHERE event.user_id = ?1
      GROUP BY event.reward_event_id, event.reward_campaign_id, event.amount_cents, event.created_at
      HAVING event.amount_cents - COALESCE(SUM(
        CASE WHEN allocation.status IN ('submitted', 'confirmed') THEN allocation.amount_cents ELSE 0 END
      ), 0) > 0
      ORDER BY event.created_at ASC, event.reward_event_id ASC
    `,
    args: [input.userId],
  })
  const allocations = planRewardPayoutAllocations(
    result.rows.map((row) => ({
      rewardEventId: requiredString(row, "reward_event_id"),
      rewardCampaignId: stringOrNull(rowValue(row, "reward_campaign_id")),
      availableCents: requiredNumber(row, "available_cents"),
    })),
    input.amountCents,
  )
  for (const allocation of allocations) {
    await input.tx.execute({
      sql: `
        INSERT INTO reward_payout_allocations (
          reward_payout_allocation_id, reward_payout_effect_id, reward_event_id,
          reward_campaign_id, amount_cents, status, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, 'submitted', ?6, ?6)
      `,
      args: [
        `rpa_${crypto.randomUUID().replace(/-/g, "")}`,
        input.effectId,
        allocation.rewardEventId,
        allocation.rewardCampaignId,
        allocation.amountCents,
        input.nowUtc,
      ],
    })
  }
}

async function ensurePayoutAllocations(input: {
  env: Env
  client: Client
  effect: RewardPayoutEffect
  nowUtc: string
}): Promise<void> {
  await withTransaction(input.client, "write", async (tx) => {
    await lockUserForCashout({ env: input.env, tx, userId: input.effect.userId })
    const existing = await tx.execute({
      sql: `
        SELECT 1
        FROM reward_payout_allocations
        WHERE reward_payout_effect_id = ?1
        LIMIT 1
      `,
      args: [input.effect.rewardPayoutEffectId],
    })
    if (existing.rows[0]) return
    await reservePayoutAllocations({
      tx,
      effectId: input.effect.rewardPayoutEffectId,
      userId: input.effect.userId,
      amountCents: input.effect.amountCents,
      nowUtc: input.nowUtc,
    })
  })
}

async function lockUserForCashout(input: { env: Env; tx: Transaction; userId: string }): Promise<void> {
  const sql = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL || ""))
    ? "SELECT user_id FROM users WHERE user_id = ?1 FOR UPDATE"
    : "SELECT user_id FROM users WHERE user_id = ?1"
  const result = await input.tx.execute({ sql, args: [input.userId] })
  if (!result.rows[0]) throw conflictError("Rewards cashout user was not found")
}

function assertReplayMatches(input: { effect: RewardPayoutEffect; userId: string; amountCents: number }): void {
  if (
    input.effect.userId !== input.userId ||
    input.effect.amountCents !== input.amountCents
  ) {
    throw conflictError("Rewards cashout idempotency key reused with different payout data")
  }
}

async function reserveCashoutEffect(input: {
  env: Env
  client: Client
  userId: string
  amountCents: number
  idempotencyKey: string
  nowUtc: string
  walletIdentity?: UpstreamIdentity | null
}): Promise<ReservedCashout> {
  return await withTransaction(input.client, "write", async (tx) => {
    await lockUserForCashout({ env: input.env, tx, userId: input.userId })
    const existing = await getPayoutByUserIdAndIdempotencyKey(tx, input.userId, input.idempotencyKey)
    if (existing) {
      assertReplayMatches({ effect: existing, userId: input.userId, amountCents: input.amountCents })
      return { effect: existing, availableBalanceCents: await currentBalanceCents(tx, input.userId) }
    }

    const submitted = await getSubmittedPayoutForUser(tx, input.userId)
    if (submitted) {
      if (submitted.amountCents !== input.amountCents) {
        throw conflictError("A different rewards cashout is already in progress")
      }
      return { effect: submitted, availableBalanceCents: await currentBalanceCents(tx, input.userId) }
    }

    if (!(await hasActiveUniqueHumanNullifier(tx, input.userId, resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER)))) {
      throw eligibilityFailed("Verify you are a unique human before cashing out rewards", {
        verification_state: "unverified",
      })
    }
    await reconcileCashoutWalletIdentity({
      tx,
      userId: input.userId,
      walletIdentity: input.walletIdentity,
      nowUtc: input.nowUtc,
    })
    const recipientAddress = await resolveCashoutRecipient(tx, input.userId)
    const balanceCents = await currentBalanceCents(tx, input.userId)
    if (balanceCents < input.amountCents) {
      throw eligibilityFailed("Rewards cashout amount exceeds available balance", {
        balance_cents: balanceCents,
      })
    }

    const effectId = `rpe_${crypto.randomUUID().replace(/-/g, "")}`
    const inserted = await tx.execute({
      sql: `
        INSERT INTO reward_payout_effects (
          reward_payout_effect_id, user_id, amount_cents, recipient_address, idempotency_key,
          status, settlement_ref, failure_reason, attempt_count, signed_tx, broadcast_nonce,
          coordinator_ref, coordinator_state, submitted_at, confirmed_at, failed_at, created_at, updated_at
        )
        VALUES (
          ?1, ?2, ?3, ?4, ?5,
          'submitted', NULL, NULL, 0, NULL, NULL,
          NULL, NULL, ?6, NULL, NULL, ?6, ?6
        )
        RETURNING ${PAYOUT_COLUMNS}
      `,
      args: [effectId, input.userId, input.amountCents, recipientAddress, input.idempotencyKey, input.nowUtc],
    })
    await reservePayoutAllocations({
      tx,
      effectId,
      userId: input.userId,
      amountCents: input.amountCents,
      nowUtc: input.nowUtc,
    })
    return { effect: decodePayoutEffect(inserted.rows[0]), availableBalanceCents: balanceCents - input.amountCents }
  })
}

function realRewardsCoordinator(env: Env): RewardSettlementCoordinator {
  assertDistinctBookingAndRewardsSignerDomains(env)
  const ns = env.OPERATOR_SIGNING_COORDINATOR as DurableObjectNamespace<OperatorSigningCoordinatorDO> | undefined
  if (!ns) throw badRequestError("OPERATOR_SIGNING_COORDINATOR binding is not configured")
  const stub = ns.getByName(operatorSigningCoordinatorName(
    resolveRewardsSettlementOperatorAddress(env),
    resolveRewardsSettlementChainId(env),
    "rewards",
  ))
  return {
    settle: (req) => stub.settle(req),
    confirm: (req, txHash) => stub.confirm(req, txHash),
    reconcile: (req) => stub.reconcile(req),
  }
}

function rewardsCoordinator(env: Env): RewardSettlementCoordinator {
  return rewardsCoordinatorForTests ?? realRewardsCoordinator(env)
}

function coordinatorRequest(effect: RewardPayoutEffect): OperatorSettleRequest {
  return {
    operatorKind: "rewards",
    effectKind: "reward_cashout",
    userId: effect.userId,
    payoutEffectId: effect.rewardPayoutEffectId,
    idempotencyKey: `user:${effect.userId}:reward_payout:${effect.idempotencyKey}`,
    amountCents: effect.amountCents,
    recipientAddress: effect.recipientAddress,
  }
}

export const REWARD_PAYOUT_COORDINATOR_MIRROR_SQL = `
  UPDATE reward_payout_effects
  SET coordinator_ref = COALESCE(coordinator_ref, ?2),
      coordinator_state = ?3,
      settlement_ref = COALESCE(CAST(?4 AS TEXT), settlement_ref),
      broadcast_nonce = COALESCE(CAST(?5 AS INTEGER), broadcast_nonce),
      updated_at = ?6
  WHERE idempotency_key = ?1
    AND user_id = ?7
    AND status != 'confirmed'
    AND (coordinator_ref IS NULL OR coordinator_ref = ?2)
    AND (CAST(?4 AS TEXT) IS NULL OR settlement_ref IS NULL OR settlement_ref = CAST(?4 AS TEXT))
  RETURNING ${PAYOUT_COLUMNS}
`

async function updateCoordinatorMirror(input: {
  client: Client
  effect: RewardPayoutEffect
  result: OperatorSettleResult
  nowUtc: string
}): Promise<RewardPayoutEffect> {
  const updated = await input.client.execute({
    sql: REWARD_PAYOUT_COORDINATOR_MIRROR_SQL,
    args: [input.effect.idempotencyKey, input.result.idempotencyKey, input.result.state, input.result.txHash, input.result.nonce, input.nowUtc, input.effect.userId],
  })
  if (!updated.rows[0]) throw conflictError("Rewards payout coordinator mirror failed")
  return decodePayoutEffect(updated.rows[0])
}

async function markPayoutConfirmed(input: { client: Client; effect: RewardPayoutEffect; txHash: string; nowUtc: string }): Promise<RewardPayoutEffect> {
  return await withTransaction(input.client, "write", async (tx) => {
    const updated = await tx.execute({
      sql: `
        UPDATE reward_payout_effects
        SET status = 'confirmed',
            settlement_ref = ?2,
            failure_reason = NULL,
            confirmed_at = ?3,
            failed_at = NULL,
            updated_at = ?3
        WHERE idempotency_key = ?1
          AND user_id = ?4
          AND status = 'submitted'
          AND (settlement_ref IS NULL OR settlement_ref = ?2)
        RETURNING ${PAYOUT_COLUMNS}
      `,
      args: [input.effect.idempotencyKey, input.txHash, input.nowUtc, input.effect.userId],
    })
    if (!updated.rows[0]) {
      const current = await getPayoutByUserIdAndIdempotencyKey(tx, input.effect.userId, input.effect.idempotencyKey)
      if (current) return current
      throw conflictError("Rewards payout confirmation transaction reference mismatch")
    }

    const allocations = await tx.execute({
      sql: `
        UPDATE reward_payout_allocations
        SET status = 'confirmed', confirmed_at = ?2, updated_at = ?2
        WHERE reward_payout_effect_id = ?1 AND status = 'submitted'
        RETURNING reward_campaign_id, amount_cents
      `,
      args: [input.effect.rewardPayoutEffectId, input.nowUtc],
    })
    for (const allocation of allocations.rows) {
      const campaignId = stringOrNull(rowValue(allocation, "reward_campaign_id"))
      if (!campaignId) continue
      await tx.execute({
        sql: `
          UPDATE reward_campaigns
          SET paid_cents = paid_cents + ?2, updated_at = ?3
          WHERE reward_campaign_id = ?1
        `,
        args: [campaignId, requiredNumber(allocation, "amount_cents"), input.nowUtc],
      })
    }
    return decodePayoutEffect(updated.rows[0])
  })
}

async function markPayoutFailed(input: { client: Client; effect: RewardPayoutEffect; reason: string; nowUtc: string }): Promise<RewardPayoutEffect> {
  return await withTransaction(input.client, "write", async (tx) => {
    const updated = await tx.execute({
      sql: `
        UPDATE reward_payout_effects
        SET status = 'failed',
            failure_reason = ?2,
            failed_at = ?3,
            updated_at = ?3
        WHERE idempotency_key = ?1
          AND user_id = ?4
          AND status = 'submitted'
        RETURNING ${PAYOUT_COLUMNS}
      `,
      args: [input.effect.idempotencyKey, input.reason, input.nowUtc, input.effect.userId],
    })
    if (!updated.rows[0]) {
      const current = await getPayoutByUserIdAndIdempotencyKey(tx, input.effect.userId, input.effect.idempotencyKey)
      if (current) return current
      throw conflictError("Rewards payout effect not found")
    }
    await tx.execute({
      sql: `
        UPDATE reward_payout_allocations
        SET status = 'released', released_at = ?2, updated_at = ?2
        WHERE reward_payout_effect_id = ?1 AND status = 'submitted'
      `,
      args: [input.effect.rewardPayoutEffectId, input.nowUtc],
    })
    return decodePayoutEffect(updated.rows[0])
  })
}

async function recordPayoutAttempt(input: { client: Client; effect: RewardPayoutEffect; nowUtc: string }): Promise<RewardPayoutEffect> {
  const updated = await input.client.execute({
    sql: `
      UPDATE reward_payout_effects
      SET attempt_count = attempt_count + 1,
          updated_at = ?3
      WHERE user_id = ?1
        AND idempotency_key = ?2
        AND status = 'submitted'
      RETURNING ${PAYOUT_COLUMNS}
    `,
    args: [input.effect.userId, input.effect.idempotencyKey, input.nowUtc],
  })
  return updated.rows[0] ? decodePayoutEffect(updated.rows[0]) : input.effect
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollConfirm(input: { env: Env; req: OperatorSettleRequest; txHash: string; confirmPollMs?: number[] }): Promise<OperatorSettleResult> {
  const plan = input.confirmPollMs ?? rewardsConfirmPollPlanForTests ?? DEFAULT_CONFIRM_POLL_MS
  let result = await rewardsCoordinator(input.env).confirm(input.req, input.txHash)
  for (let i = 0; result.state === "broadcast" && i < plan.length; i++) {
    await sleep(plan[i])
    result = await rewardsCoordinator(input.env).confirm(input.req, input.txHash)
  }
  return result
}

function serializeCashout(effect: RewardPayoutEffect, balanceCents: number, chainId: number): RewardCashoutResponse {
  return {
    chain_id: chainId,
    payout: {
      id: effect.rewardPayoutEffectId,
      chain_id: chainId,
      amount_cents: effect.amountCents,
      recipient_address: effect.recipientAddress,
      status: effect.status,
      settlement_ref: effect.settlementRef,
      failure_reason: effect.failureReason,
    },
    balance_cents: balanceCents,
  }
}

async function advanceSubmittedPayout(input: {
  env: Env
  client: Client
  effect: RewardPayoutEffect
  nowUtc: string
  confirmPollMs?: number[]
}): Promise<RewardPayoutEffect> {
  await ensurePayoutAllocations({
    env: input.env,
    client: input.client,
    effect: input.effect,
    nowUtc: input.nowUtc,
  })
  const attempted = await recordPayoutAttempt({
    client: input.client,
    effect: input.effect,
    nowUtc: input.nowUtc,
  })
  const req = coordinatorRequest(attempted)
  let settled = await rewardsCoordinator(input.env).settle(req)
  for (let i = 0; (settled.state === "prepared" || settled.state === "reconciliation_required") && i < MAX_RECONCILE_ATTEMPTS; i++) {
    settled = await rewardsCoordinator(input.env).reconcile(req)
  }
  let effect = await updateCoordinatorMirror({
    client: input.client,
    effect: attempted,
    result: settled,
    nowUtc: input.nowUtc,
  })

  if (settled.state === "confirmed" && settled.txHash) {
    return await markPayoutConfirmed({
      client: input.client,
      effect,
      txHash: settled.txHash,
      nowUtc: input.nowUtc,
    })
  }
  if (settled.state === "replaced" || settled.state === "failed_onchain") {
    return await markPayoutFailed({
      client: input.client,
      effect,
      reason: settled.state,
      nowUtc: input.nowUtc,
    })
  }
  if (!settled.txHash || settled.state === "reserving" || settled.state === "failed_preparation") {
    return effect
  }

  const confirmed = await pollConfirm({
    env: input.env,
    req,
    txHash: settled.txHash,
    confirmPollMs: input.confirmPollMs,
  })
  effect = await updateCoordinatorMirror({
    client: input.client,
    effect,
    result: confirmed,
    nowUtc: input.nowUtc,
  })
  if (confirmed.state === "confirmed") {
    return await markPayoutConfirmed({
      client: input.client,
      effect,
      txHash: confirmed.txHash ?? settled.txHash,
      nowUtc: input.nowUtc,
    })
  }
  if (confirmed.state === "replaced" || confirmed.state === "failed_onchain") {
    return await markPayoutFailed({
      client: input.client,
      effect,
      reason: confirmed.state,
      nowUtc: input.nowUtc,
    })
  }
  return effect
}

export async function cashOutRewards(input: {
  env: Env
  userId: string
  amountCents: unknown
  idempotencyKey: unknown
  walletIdentity?: UpstreamIdentity | null
  client?: Client
  nowUtc?: string
  confirmPollMs?: number[]
}): Promise<RewardCashoutResponse> {
  const client = input.client ?? getControlPlaneClient(input.env)
  const amountCents = normalizeAmountCents(input.amountCents)
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey)
  const nowUtc = input.nowUtc ?? new Date().toISOString()
  const minCashoutCents = parseConfiguredCents(input.env.REWARDS_MIN_CASHOUT_CENTS, DEFAULT_REWARDS_MIN_CASHOUT_CENTS)
  assertRewardsCampaignAndSettlementChainsMatch(input.env)
  const chainId = resolveRewardsSettlementChainId(input.env)
  if (!rewardPayoutsEnabled(input.env)) {
    throw eligibilityFailed("Rewards cashout is not enabled")
  }
  if (amountCents < minCashoutCents) {
    throw eligibilityFailed("Rewards cashout amount is below the minimum", {
      min_cents: minCashoutCents,
    })
  }

  const reserved = await reserveCashoutEffect({
    env: input.env,
    client,
    userId: input.userId,
    amountCents,
    idempotencyKey,
    nowUtc,
    walletIdentity: input.walletIdentity,
  })
  if (reserved.effect.status === "confirmed" || reserved.effect.status === "failed") {
    return serializeCashout(reserved.effect, await currentBalanceCents(client, input.userId), chainId)
  }

  const effect = await advanceSubmittedPayout({
    env: input.env,
    client,
    effect: reserved.effect,
    nowUtc,
    confirmPollMs: input.confirmPollMs,
  })

  return serializeCashout(effect, await currentBalanceCents(client, input.userId), chainId)
}

export async function getRewardCashoutForUser(input: {
  env: Env
  userId: string
  cashoutId: string
  client?: Client
}): Promise<RewardCashoutResponse> {
  const cashoutId = String(input.cashoutId ?? "").trim()
  if (!cashoutId) throw notFoundError("Rewards cashout not found")
  const client = input.client ?? getControlPlaneClient(input.env)
  const effect = await getPayoutByUserIdAndEffectId(client, input.userId, cashoutId)
  if (!effect) throw notFoundError("Rewards cashout not found")
  assertRewardsCampaignAndSettlementChainsMatch(input.env)
  const chainId = resolveRewardsSettlementChainId(input.env)
  return serializeCashout(effect, await currentBalanceCents(client, input.userId), chainId)
}

export async function reconcileSubmittedRewardPayouts(input: {
  env: Env
  client?: Client
  nowUtc?: string
  limit?: number
  confirmPollMs?: number[]
}): Promise<RewardPayoutReconciliationSummary> {
  const summary: RewardPayoutReconciliationSummary = {
    enabled: rewardPayoutsEnabled(input.env),
    scanned: 0,
    confirmed: 0,
    failed: 0,
    pending: 0,
    errors: 0,
  }
  if (!summary.enabled) return summary

  const client = input.client ?? getControlPlaneClient(input.env)
  const nowUtc = input.nowUtc ?? new Date().toISOString()
  const limit = Math.max(1, Math.min(250, Math.trunc(input.limit ?? DEFAULT_PAYOUT_RECONCILE_LIMIT)))
  const rows = await client.execute({
    sql: `
      SELECT ${PAYOUT_COLUMNS}
      FROM reward_payout_effects
      WHERE status = 'submitted'
      ORDER BY updated_at ASC, reward_payout_effect_id ASC
      LIMIT ?1
    `,
    args: [limit],
  })

  for (const row of rows.rows) {
    summary.scanned += 1
    const effect = decodePayoutEffect(row)
    try {
      const advanced = await advanceSubmittedPayout({
        env: input.env,
        client,
        effect,
        nowUtc,
        confirmPollMs: input.confirmPollMs ?? [],
      })
      if (advanced.status === "confirmed") {
        summary.confirmed += 1
      } else if (advanced.status === "failed") {
        summary.failed += 1
      } else {
        summary.pending += 1
      }
    } catch (error) {
      summary.errors += 1
      console.error("[rewards] payout reconciliation failed", {
        reward_payout_effect_id: effect.rewardPayoutEffectId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return summary
}
