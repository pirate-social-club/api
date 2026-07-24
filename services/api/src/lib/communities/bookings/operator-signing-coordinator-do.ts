import { DurableObject } from "cloudflare:workers"

import type { Env } from "../../../env"
import { badRequestError, conflictError } from "../../errors"

const SIGNING_CLAIM_TTL_MS = 60_000
const BROADCAST_RECONCILE_DELAY_MS = 15_000
const RETRY_BASE_DELAY_MS = 5_000
const RETRY_MAX_DELAY_MS = 5 * 60_000
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export type OperatorKind = "booking" | "rewards"
export type OperatorEffectKind = "booking_payout" | "booking_refund" | "reward_cashout" | "reward_funding_refund"

export function operatorSigningCoordinatorName(operatorAddress: string, chainId: number, operatorKind: OperatorKind = "booking"): string {
  const a = String(operatorAddress || "").trim()
  if (!EVM_ADDRESS_RE.test(a)) throw badRequestError("Operator signer address is invalid")
  // Lowercase (not EIP-55 checksum) so the DO name needs no ethers dependency; deterministic per wallet.
  // v1 became unreachable in staging before it ever produced a transaction hash.
  // A versioned name gives rewards a clean coordinator instance; nonce allocation
  // remains safe because every instance samples the chain pending nonce first.
  const prefix = operatorKind === "rewards" ? "rewards-operator-signer-v2" : "booking-operator-signer"
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
}

export type OperatorSettleState =
  | "reserving"
  | "prepared"
  | "broadcast"
  | "confirmed"
  | "failed_preparation"
  | "reconciliation_required"
  | "replaced"
  | "failed_onchain"

export interface OperatorSettleResult {
  idempotencyKey: string
  txHash: string | null
  nonce: number | null
  state: OperatorSettleState
}

interface GasParams { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint }
type TxLiveness = "success" | "failed" | "pending" | "absent"
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
  }) => Promise<{ signedTx: string; txHash: string }>
  broadcast: (env: Env, input: { signedTx: string; operatorKind?: OperatorKind }) => Promise<void>
  txLiveness: (env: Env, txHash: string, operatorKind?: OperatorKind) => Promise<TxLiveness>
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
function requestOperatorKind(req: OperatorSettleRequest): OperatorKind {
  return req.operatorKind ?? (req.effectKind === "reward_cashout" || req.effectKind === "reward_funding_refund" ? "rewards" : "booking")
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
}

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
    })
  }

  async settle(req: OperatorSettleRequest): Promise<OperatorSettleResult> {
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
      if (current && !this.isTerminal(current)) this.recordRetry(current, error)
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
           created_at, updated_at, attempt_count, next_attempt_at, last_error
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, 'reserving', 1, NULL, NULL, ?8, ?8, 0, NULL, NULL)`,
        key, fields.communityId, fields.bookingId, fields.effectKind, req.amountCents ?? 0, normalizeAtomicAmount(req.amountAtomic), recipient, now,
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
      this.ctx.storage.sql.exec(
        "INSERT INTO nonce_state (id, next_nonce) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET next_nonce = MAX(next_nonce, ?1)",
        chainPending,
      )
      const nonce = Number(this.ctx.storage.sql.exec<{ n: number }>(
        "UPDATE nonce_state SET next_nonce = next_nonce + 1 WHERE id = 1 RETURNING (next_nonce - 1) AS n",
      ).one().n)
      return this.cas(current.idempotency_key, current.version, { nonce, state: "reserving", next_attempt_at: null, last_error: null }) ?? this.read(current.idempotency_key)!
    })
  }

  private async advance(input: EffectRow): Promise<EffectRow> {
    let row = input
    if (row.state === "reserving" || row.state === "failed_preparation") {
      row = await this.reserveNonce(row)
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
    if (liveness === "success") return this.cas(row.idempotency_key, row.version, { state: "confirmed", next_attempt_at: null, last_error: null }) ?? this.read(row.idempotency_key)!
    if (liveness === "failed") return this.cas(row.idempotency_key, row.version, { state: "failed_onchain", next_attempt_at: null, last_error: null }) ?? this.read(row.idempotency_key)!
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
    return row.effect_kind === "reward_cashout" || row.effect_kind === "reward_funding_refund" ? "rewards" : "booking"
  }

  private assertAmount(req: OperatorSettleRequest): void {
    if (req.effectKind === "reward_funding_refund") {
      if (req.amountCents != null || normalizeAtomicAmount(req.amountAtomic) == null) {
        throw badRequestError("Reward funding refund requires only an atomic amount")
      }
      return
    }
    if (!Number.isInteger(req.amountCents) || Number(req.amountCents) <= 0 || req.amountAtomic != null) {
      throw badRequestError("Operator settlement requires only a positive cents amount")
    }
  }

  private nextActive(): EffectRow | null {
    const raw = this.ctx.storage.sql.exec<Record<string, string | number | null>>(
      `SELECT * FROM effects
       WHERE state NOT IN ('confirmed', 'replaced', 'failed_onchain')
       ORDER BY created_at ASC, idempotency_key ASC
       LIMIT 1`,
    ).toArray()[0]
    return raw ? this.decode(raw) : null
  }

  private isTerminal(row: EffectRow): boolean {
    return row.state === "confirmed" || row.state === "replaced" || row.state === "failed_onchain"
  }

  private retryDelay(attemptCount: number): number {
    return Math.min(RETRY_BASE_DELAY_MS * (2 ** Math.min(attemptCount, 6)), RETRY_MAX_DELAY_MS)
  }

  /** Explicit convergence requests may wake a delayed operation; ordinary settle polling may not. */
  private expedite(row: EffectRow): EffectRow {
    return this.cas(row.idempotency_key, row.version, { next_attempt_at: Date.now() }) ?? this.read(row.idempotency_key)!
  }

  private recordRetry(row: EffectRow, error: unknown): EffectRow {
    const attemptCount = row.attempt_count + 1
    return this.cas(row.idempotency_key, row.version, {
      attempt_count: attemptCount,
      next_attempt_at: Date.now() + this.retryDelay(attemptCount),
      last_error: errMsg(error).slice(0, 1_000),
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
      const gas = await chain().gasParams(this.env, operatorKind)
      const signed = await chain().signVerifiedTransfer(this.env, {
        to: recipient,
        amountCents: req.amountCents,
        amountAtomic: req.amountAtomic,
        nonce: claimedRow.nonce!,
        gas,
        operatorKind,
        effectKind: req.effectKind,
        effectId,
      })
      // CAS guarded by version AND our claim token — a stolen/expired claim cannot overwrite.
      const updated = this.casClaimed(row.idempotency_key, claimedRow.version, token, {
        signed_tx: signed.signedTx,
        tx_hash: signed.txHash,
        state: "prepared",
        claim_token: null,
        claim_expires_at: null,
        next_attempt_at: null,
        last_error: null,
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
      if (!nonceConsumed) throw error // alarm records bounded backoff; signed transaction stays prepared
      const liveness = await chain().txLiveness(this.env, row.tx_hash, this.operatorKind(row))
      const next: OperatorSettleState = liveness === "success" || liveness === "pending" ? "broadcast" : (liveness === "failed" ? "failed_onchain" : "reconciliation_required")
      return this.cas(row.idempotency_key, fromVersion, {
        state: next,
        next_attempt_at: next === "failed_onchain" ? null : Date.now() + BROADCAST_RECONCILE_DELAY_MS,
      }) ?? this.read(row.idempotency_key)!
    }
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
      existing.recipient_address !== recipient
    ) {
      throw conflictError("Operator settlement idempotency key reused with different effect data")
    }
  }

  /** Expected-state CAS on version; returns the new row or null if the row changed concurrently. */
  private cas(key: string, fromVersion: number, fields: Partial<Pick<EffectRow, "signed_tx" | "tx_hash" | "nonce" | "state" | "claim_token" | "claim_expires_at" | "attempt_count" | "next_attempt_at" | "last_error">>): EffectRow | null {
    return this.casInternal(key, fromVersion, null, fields)
  }
  private casClaimed(key: string, fromVersion: number, claimToken: string, fields: Partial<Pick<EffectRow, "signed_tx" | "tx_hash" | "nonce" | "state" | "claim_token" | "claim_expires_at" | "attempt_count" | "next_attempt_at" | "last_error">>): EffectRow | null {
    return this.casInternal(key, fromVersion, claimToken, fields)
  }
  private casInternal(key: string, fromVersion: number, claimToken: string | null, fields: Partial<Pick<EffectRow, "signed_tx" | "tx_hash" | "nonce" | "state" | "claim_token" | "claim_expires_at" | "attempt_count" | "next_attempt_at" | "last_error">>): EffectRow | null {
    const cur = this.read(key)
    if (!cur) return null
    const next: EffectRow = { ...cur, ...fields }
    const matched = this.ctx.storage.sql.exec(
      `UPDATE effects SET
         signed_tx = ?2, tx_hash = ?3, nonce = ?4, state = ?5, claim_token = ?6,
         claim_expires_at = ?7, attempt_count = ?8, next_attempt_at = ?9, last_error = ?10,
         version = version + 1, updated_at = ?11
       WHERE idempotency_key = ?1 AND version = ?12${claimToken == null ? "" : " AND claim_token = ?13"}
       RETURNING idempotency_key`,
      ...(claimToken == null
        ? [key, next.signed_tx, next.tx_hash, next.nonce, next.state, next.claim_token, next.claim_expires_at, next.attempt_count, next.next_attempt_at, next.last_error, Date.now(), fromVersion]
        : [key, next.signed_tx, next.tx_hash, next.nonce, next.state, next.claim_token, next.claim_expires_at, next.attempt_count, next.next_attempt_at, next.last_error, Date.now(), fromVersion, claimToken]),
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
      signed_tx: r.signed_tx == null ? null : String(r.signed_tx), tx_hash: r.tx_hash == null ? null : String(r.tx_hash),
      nonce: r.nonce == null ? null : Number(r.nonce), state: String(r.state) as OperatorSettleState, version: Number(r.version),
      claim_token: r.claim_token == null ? null : String(r.claim_token), claim_expires_at: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
      attempt_count: Number(r.attempt_count ?? 0), next_attempt_at: r.next_attempt_at == null ? null : Number(r.next_attempt_at),
      last_error: r.last_error == null ? null : String(r.last_error),
    }
  }

  private result(row: EffectRow): OperatorSettleResult {
    return { idempotencyKey: row.idempotency_key, txHash: row.tx_hash, nonce: row.nonce, state: row.state }
  }
}
