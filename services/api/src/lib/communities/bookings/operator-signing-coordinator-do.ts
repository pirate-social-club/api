import { DurableObject } from "cloudflare:workers"

import type { Env } from "../../../env"
import { badRequestError, conflictError } from "../../errors"

const SIGNING_CLAIM_TTL_MS = 60_000
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

export type OperatorKind = "booking" | "rewards"
export type OperatorEffectKind = "booking_payout" | "booking_refund" | "reward_cashout"

export function operatorSigningCoordinatorName(operatorAddress: string, chainId: number, operatorKind: OperatorKind = "booking"): string {
  const a = String(operatorAddress || "").trim()
  if (!EVM_ADDRESS_RE.test(a)) throw badRequestError("Operator signer address is invalid")
  // Lowercase (not EIP-55 checksum) so the DO name needs no ethers dependency; deterministic per wallet.
  const prefix = operatorKind === "rewards" ? "rewards-operator-signer" : "booking-operator-signer"
  return `${prefix}:${a.toLowerCase()}:${chainId}`
}

// The DO derives the canonical key itself — a caller cannot supply a colliding key.
export interface OperatorSettleRequest {
  operatorKind?: OperatorKind
  communityId?: string
  bookingId?: string
  userId?: string
  payoutEffectId?: string
  idempotencyKey?: string
  effectKind: OperatorEffectKind
  amountCents: number
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

export interface GasParams { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; gasLimit: bigint }
export type TxLiveness = "success" | "failed" | "pending" | "absent"
export interface ChainPrimitives {
  pendingNonce: (env: Env, operatorKind?: OperatorKind) => Promise<number>
  latestNonce: (env: Env, operatorKind?: OperatorKind) => Promise<number>
  gasParams: (env: Env, operatorKind?: OperatorKind) => Promise<GasParams>
  signVerifiedTransfer: (env: Env, input: { to: string; amountCents: number; nonce: number; gas: GasParams; operatorKind?: OperatorKind }) => Promise<{ signedTx: string; txHash: string }>
  broadcast: (env: Env, input: { signedTx: string; operatorKind?: OperatorKind }) => Promise<void>
  txLiveness: (env: Env, txHash: string, operatorKind?: OperatorKind) => Promise<TxLiveness>
}

function normalizeRecipient(raw: string): string {
  const a = String(raw || "").trim()
  if (!EVM_ADDRESS_RE.test(a)) throw badRequestError("Booking settlement recipient address is invalid")
  // Lowercase for the DO's own storage/comparison (no ethers); the real signer re-checksums for the tx.
  return a.toLowerCase()
}
function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e) }
function requestOperatorKind(req: OperatorSettleRequest): OperatorKind {
  return req.operatorKind ?? (req.effectKind === "reward_cashout" ? "rewards" : "booking")
}
function canonicalFields(req: OperatorSettleRequest): { communityId: string; bookingId: string; effectKind: OperatorEffectKind } {
  const kind = requestOperatorKind(req)
  if (kind === "rewards") {
    if (req.effectKind !== "reward_cashout" || !req.userId || !req.payoutEffectId || !req.idempotencyKey) {
      throw badRequestError("Rewards settlement request is missing user/payout/idempotency data")
    }
    return { communityId: req.userId, bookingId: req.payoutEffectId, effectKind: req.effectKind }
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
  recipient_address: string
  signed_tx: string | null
  tx_hash: string | null
  nonce: number | null
  state: OperatorSettleState
  version: number
  claim_token: string | null
  claim_expires_at: number | null
}

export class OperatorSigningCoordinatorDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS nonce_state (id INTEGER PRIMARY KEY CHECK (id = 1), next_nonce INTEGER NOT NULL)")
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS effects (
        idempotency_key TEXT PRIMARY KEY,
        community_id TEXT NOT NULL, booking_id TEXT NOT NULL, effect_kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL, recipient_address TEXT NOT NULL,
        signed_tx TEXT, tx_hash TEXT, nonce INTEGER, state TEXT NOT NULL,
        version INTEGER NOT NULL, claim_token TEXT, claim_expires_at INTEGER,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      )`)
    })
  }

  async settle(req: OperatorSettleRequest): Promise<OperatorSettleResult> {
    const key = this.deriveKey(req)
    const recipient = normalizeRecipient(req.recipientAddress)
    if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) throw badRequestError("Booking settlement amount must be positive")

    let row = this.read(key)
    if (row) this.assertImmutable(row, req, recipient)
    if (!row) {
      const chainPending = await chain().pendingNonce(this.env, requestOperatorKind(req)) // RPC OUTSIDE the atomic reservation
      row = this.reserveOrGet(key, req, recipient, chainPending)
    }
    if (row.state === "reserving" || row.state === "failed_preparation") row = await this.signClaimedRow(row, req, recipient)
    if (row.state === "prepared") row = await this.broadcastRow(row)
    return this.result(row)
  }

  async confirm(req: OperatorSettleRequest, txHash: string): Promise<OperatorSettleResult> {
    const key = this.deriveKey(req)
    const row = this.read(key)
    if (!row) throw conflictError("Operator settlement effect not found")
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    if (row.tx_hash !== txHash) throw conflictError("Operator settlement confirmation hash mismatch")
    if (row.state === "confirmed" || row.state === "failed_onchain" || row.state === "replaced") return this.result(row)
    const liveness = await chain().txLiveness(this.env, txHash, requestOperatorKind(req))
    if (liveness === "success") return this.result(this.cas(key, row.version, { state: "confirmed" }) ?? this.read(key)!)
    if (liveness === "failed") return this.result(this.cas(key, row.version, { state: "failed_onchain" }) ?? this.read(key)!)
    // pending/absent: not confirmable yet — return the current chain state (no exception); the
    // caller keeps polling, or a later reconcile() resolves it. Pending is NOT an error.
    return this.result(row)
  }

  async reconcile(req: OperatorSettleRequest): Promise<OperatorSettleResult> {
    const key = this.deriveKey(req)
    const row = this.read(key)
    if (!row) throw conflictError("Operator settlement effect not found")
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    if (row.state === "confirmed" || row.state === "replaced" || row.state === "failed_onchain") return this.result(row)
    if (row.state === "reserving" || row.state === "failed_preparation") {
      const signed = await this.signClaimedRow(row, req, normalizeRecipient(req.recipientAddress))
      return this.result(signed.state === "prepared" ? await this.broadcastRow(signed) : signed)
    }
    if (row.state === "prepared") return this.result(await this.broadcastRow(row))
    // broadcast / reconciliation_required
    if (!row.tx_hash || row.nonce == null || !row.signed_tx) throw new Error("broadcast effect missing tx fields")
    const liveness = await chain().txLiveness(this.env, row.tx_hash, requestOperatorKind(req))
    if (liveness === "success") return this.result(this.cas(key, row.version, { state: "confirmed" }) ?? this.read(key)!)
    if (liveness === "failed") return this.result(this.cas(key, row.version, { state: "failed_onchain" }) ?? this.read(key)!)
    if (liveness === "pending") return this.result(row.state === "reconciliation_required" ? (this.cas(key, row.version, { state: "broadcast" }) ?? this.read(key)!) : row)
    // absent: a different tx consumed our nonce (replaced) vs dropped-from-mempool (rebroadcast).
    const latest = await chain().latestNonce(this.env, requestOperatorKind(req))
    if (latest > row.nonce) return this.result(this.cas(key, row.version, { state: "replaced" }) ?? this.read(key)!)
    await chain().broadcast(this.env, { signedTx: row.signed_tx, operatorKind: requestOperatorKind(req) })
    return this.result(this.cas(key, row.version, { state: "broadcast" }) ?? this.read(key)!)
  }

  lookup(req: OperatorSettleRequest): OperatorSettleResult | null {
    const row = this.read(this.deriveKey(req))
    if (!row) return null
    this.assertImmutable(row, req, normalizeRecipient(req.recipientAddress))
    return this.result(row)
  }

  // --- internals -------------------------------------------------------------------------------

  /** Atomic: recheck-or-insert the effect AND bump next_nonce, so only the inserting caller allocates. */
  private reserveOrGet(key: string, req: OperatorSettleRequest, recipient: string, chainPending: number): EffectRow {
    const fields = canonicalFields(req)
    return this.ctx.storage.transactionSync(() => {
      const existing = this.read(key)
      if (existing) return existing
      this.ctx.storage.sql.exec("INSERT INTO nonce_state (id, next_nonce) VALUES (1, ?1) ON CONFLICT(id) DO UPDATE SET next_nonce = MAX(next_nonce, ?1)", chainPending)
      const nonce = Number(this.ctx.storage.sql.exec<{ n: number }>("UPDATE nonce_state SET next_nonce = next_nonce + 1 WHERE id = 1 RETURNING (next_nonce - 1) AS n").toArray()[0].n)
      const now = Date.now()
      this.ctx.storage.sql.exec(
        `INSERT INTO effects (idempotency_key, community_id, booking_id, effect_kind, amount_cents, recipient_address, signed_tx, tx_hash, nonce, state, version, claim_token, claim_expires_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, 'reserving', 1, NULL, NULL, ?8, ?8)`,
        key, fields.communityId, fields.bookingId, fields.effectKind, req.amountCents, recipient, nonce, now,
      )
      return this.read(key)!
    })
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
      const gas = await chain().gasParams(this.env, operatorKind)
      const signed = await chain().signVerifiedTransfer(this.env, { to: recipient, amountCents: req.amountCents, nonce: claimedRow.nonce!, gas, operatorKind })
      // CAS guarded by version AND our claim token — a stolen/expired claim cannot overwrite.
      const updated = this.casClaimed(row.idempotency_key, claimedRow.version, token, { signed_tx: signed.signedTx, tx_hash: signed.txHash, state: "prepared", claim_token: null, claim_expires_at: null })
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
      await chain().broadcast(this.env, { signedTx: row.signed_tx, operatorKind: row.effect_kind === "reward_cashout" ? "rewards" : "booking" })
      return this.cas(row.idempotency_key, fromVersion, { state: "broadcast" }) ?? this.read(row.idempotency_key)!
    } catch (error) {
      const msg = errMsg(error).toLowerCase()
      const nonceConsumed = msg.includes("already known") || msg.includes("known transaction") || msg.includes("nonce too low") || msg.includes("already imported")
      if (!nonceConsumed) return this.read(row.idempotency_key)! // transient: stays 'prepared'
      const liveness = await chain().txLiveness(this.env, row.tx_hash, row.effect_kind === "reward_cashout" ? "rewards" : "booking")
      const next: OperatorSettleState = liveness === "success" || liveness === "pending" ? "broadcast" : (liveness === "failed" ? "failed_onchain" : "reconciliation_required")
      return this.cas(row.idempotency_key, fromVersion, { state: next }) ?? this.read(row.idempotency_key)!
    }
  }

  private deriveKey(req: OperatorSettleRequest): string {
    const operatorKind = requestOperatorKind(req)
    if (operatorKind === "rewards") {
      canonicalFields(req)
      return JSON.stringify(["reward_payout", req.idempotencyKey])
    }
    // Unambiguous encoding — a colon (or any char) inside an id cannot collide another effect.
    canonicalFields(req)
    return JSON.stringify(["booking_settlement", req.communityId, req.bookingId, req.effectKind])
  }

  private assertImmutable(existing: EffectRow, req: OperatorSettleRequest, recipient: string): void {
    const fields = canonicalFields(req)
    if (
      existing.community_id !== fields.communityId || existing.booking_id !== fields.bookingId ||
      existing.effect_kind !== fields.effectKind || existing.amount_cents !== req.amountCents ||
      existing.recipient_address !== recipient
    ) {
      throw conflictError("Operator settlement idempotency key reused with different effect data")
    }
  }

  /** Expected-state CAS on version; returns the new row or null if the row changed concurrently. */
  private cas(key: string, fromVersion: number, fields: Partial<Pick<EffectRow, "signed_tx" | "tx_hash" | "state" | "claim_token" | "claim_expires_at">>): EffectRow | null {
    return this.casInternal(key, fromVersion, null, fields)
  }
  private casClaimed(key: string, fromVersion: number, claimToken: string, fields: Partial<Pick<EffectRow, "signed_tx" | "tx_hash" | "state" | "claim_token" | "claim_expires_at">>): EffectRow | null {
    return this.casInternal(key, fromVersion, claimToken, fields)
  }
  private casInternal(key: string, fromVersion: number, claimToken: string | null, fields: Partial<Pick<EffectRow, "signed_tx" | "tx_hash" | "state" | "claim_token" | "claim_expires_at">>): EffectRow | null {
    const cur = this.read(key)
    if (!cur) return null
    const next: EffectRow = { ...cur, ...fields }
    const matched = this.ctx.storage.sql.exec(
      `UPDATE effects SET signed_tx = ?2, tx_hash = ?3, state = ?4, claim_token = ?5, claim_expires_at = ?6, version = version + 1, updated_at = ?7
       WHERE idempotency_key = ?1 AND version = ?8${claimToken == null ? "" : " AND claim_token = ?9"}
       RETURNING idempotency_key`,
      ...(claimToken == null
        ? [key, next.signed_tx, next.tx_hash, next.state, next.claim_token, next.claim_expires_at, Date.now(), fromVersion]
        : [key, next.signed_tx, next.tx_hash, next.state, next.claim_token, next.claim_expires_at, Date.now(), fromVersion, claimToken]),
    ).toArray()
    return matched.length === 1 ? this.read(key) : null
  }

  private read(key: string): EffectRow | null {
    const r = this.ctx.storage.sql.exec<Record<string, string | number | null>>("SELECT * FROM effects WHERE idempotency_key = ?1", key).toArray()[0]
    if (!r) return null
    return {
      idempotency_key: String(r.idempotency_key), community_id: String(r.community_id), booking_id: String(r.booking_id),
      effect_kind: String(r.effect_kind), amount_cents: Number(r.amount_cents), recipient_address: String(r.recipient_address),
      signed_tx: r.signed_tx == null ? null : String(r.signed_tx), tx_hash: r.tx_hash == null ? null : String(r.tx_hash),
      nonce: r.nonce == null ? null : Number(r.nonce), state: String(r.state) as OperatorSettleState, version: Number(r.version),
      claim_token: r.claim_token == null ? null : String(r.claim_token), claim_expires_at: r.claim_expires_at == null ? null : Number(r.claim_expires_at),
    }
  }

  private result(row: EffectRow): OperatorSettleResult {
    return { idempotencyKey: row.idempotency_key, txHash: row.tx_hash, nonce: row.nonce, state: row.state }
  }
}
