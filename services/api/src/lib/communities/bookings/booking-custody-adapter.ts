import { Contract, JsonRpcProvider, Transaction, Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { conflictError, badRequestError } from "../../errors"
import { parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"
import { openCommunityWriteClient } from "../community-read-access"
import {
  beginBookingSettlementEffectAttempt,
  confirmBookingSettlementEffect,
  failBookingSettlementEffect,
  recordBookingSettlementEffectSubmission,
  type BookingSettlementEffectKind,
} from "./booking-settlement-effects"
import {
  resolvePirateCheckoutRpcUrl,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutTxWaitTimeoutMs,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../commerce/checkout-config"

type CommunityRepository = Parameters<typeof openCommunityWriteClient>[1]

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
] as const

export interface BookingOperatorEffect {
  kind: "payout" | "refund"
  toUserId: string
  recipientAddress: string
  amountCents: number
  bookingId: string
  idempotencyKey: string
}

interface BookingOperatorEffectContext {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  nowUtc: string
}

// Durable submission seams. prepare SIGNS the transfer without sending and returns the raw signed
// tx + its hash + nonce; broadcast SENDS a raw signed tx (idempotent — a re-broadcast of the same
// nonce is a no-op on chain); wait blocks on confirmation. Split so the signed tx can be persisted
// BEFORE it is ever broadcast.
type PrepareOperatorUsdcTransfer = (env: Env, input: { to: string; amountCents: number }) => Promise<{ signedTx: string; txRef: string; nonce: number }>
type BroadcastSignedOperatorUsdcTransfer = (env: Env, input: { signedTx: string; expectedTxRef: string }) => Promise<void>
type WaitForOperatorUsdcTransfer = (env: Env, input: { txRef: string }) => Promise<void>

// The operator wallet has ONE nonce sequence shared by every settlement effect. Serialize the
// sign→record→broadcast critical section so concurrent effects receive sequential nonces and never
// collide on the same nonce. This is an in-process (per-isolate) guard; cross-isolate
// serialization is enforced by settling only from the single serial cron lease (see D4).
let operatorSigningLock: Promise<unknown> = Promise.resolve()
function withOperatorSigningLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = operatorSigningLock.then(fn, fn)
  operatorSigningLock = run.then(() => undefined, () => undefined)
  return run
}

let prepareOperatorUsdcTransferForTests: PrepareOperatorUsdcTransfer | null = null
let broadcastSignedOperatorUsdcTransferForTests: BroadcastSignedOperatorUsdcTransfer | null = null
let waitForOperatorUsdcTransferForTests: WaitForOperatorUsdcTransfer | null = null

export function setBookingOperatorUsdcTransferForTests(input: {
  prepare?: PrepareOperatorUsdcTransfer
  broadcast?: BroadcastSignedOperatorUsdcTransfer
  wait?: WaitForOperatorUsdcTransfer
} | null): void {
  prepareOperatorUsdcTransferForTests = input?.prepare ?? null
  broadcastSignedOperatorUsdcTransferForTests = input?.broadcast ?? null
  waitForOperatorUsdcTransferForTests = input?.wait ?? null
}

function normalizeRecipientAddress(raw: string): string {
  const address = parseExpectedEvmAddress(raw)
  if (!address) throw badRequestError("Booking settlement recipient address is invalid")
  return getAddress(address)
}

function resolveOperatorTransferConfig(env: Env): {
  privateKey: string
  rpcUrl: string
  chainId: number
  usdcTokenAddress: string
  txWaitTimeoutMs: number
} {
  const privateKey = normalizeDirectSignerPrivateKey(String(env.PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY || "").trim())
  if (!privateKey) throw badRequestError("PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY is invalid")
  return {
    privateKey,
    rpcUrl: resolvePirateCheckoutRpcUrl(env),
    chainId: resolvePirateCheckoutSourceChainId(env),
    usdcTokenAddress: resolvePirateCheckoutUsdcTokenAddress(env),
    txWaitTimeoutMs: resolvePirateCheckoutTxWaitTimeoutMs(env),
  }
}

function usdcCentsToAtomic(amountCents: number): bigint {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw badRequestError("Booking settlement amount must be positive")
  }
  return BigInt(amountCents) * 10_000n
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Sign the USDC transfer WITHOUT broadcasting. Returns the raw signed tx, its deterministic hash,
// and the nonce so the submission can be persisted before the transfer ever goes out.
async function prepareOperatorUsdcTransfer(env: Env, input: { to: string; amountCents: number }): Promise<{ signedTx: string; txRef: string; nonce: number }> {
  if (prepareOperatorUsdcTransferForTests) return prepareOperatorUsdcTransferForTests(env, input)

  const config = resolveOperatorTransferConfig(env)
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  const signer = new Wallet(config.privateKey, provider)
  const usdc = new Contract(config.usdcTokenAddress, ERC20_ABI, signer)
  const to = normalizeRecipientAddress(input.to)
  const amount = usdcCentsToAtomic(input.amountCents)

  const decimals = Number(await usdc.decimals())
  if (decimals !== 6) throw badRequestError("Booking settlement token must be USDC with 6 decimals")
  const balance = await usdc.balanceOf(signer.address) as bigint
  if (balance < amount) throw badRequestError("Booking settlement operator has insufficient USDC")

  const data = usdc.interface.encodeFunctionData("transfer", [to, amount])
  const populated = await signer.populateTransaction({ to: config.usdcTokenAddress, data })
  // signTransaction rejects an explicit `from`; the nonce/gas/chainId are already populated.
  delete (populated as { from?: unknown }).from
  const signedTx = await signer.signTransaction(populated)
  const txRef = Transaction.from(signedTx).hash
  if (!txRef) throw badRequestError("booking_settlement_missing_tx_hash")
  if (populated.nonce == null) throw badRequestError("booking_settlement_missing_nonce")
  return { signedTx, txRef, nonce: Number(populated.nonce) }
}

// Broadcast a raw signed tx. On "already known"/"nonce too low" we do NOT assume success — that
// could mean a DIFFERENT transaction consumed this nonce. Verify the EXACT expected hash exists on
// chain; only then is it our (idempotent) transaction. Otherwise the nonce was replaced and this
// payout would strand, so surface a conflict for reconciliation.
async function broadcastSignedOperatorUsdcTransfer(env: Env, input: { signedTx: string; expectedTxRef: string }): Promise<void> {
  if (broadcastSignedOperatorUsdcTransferForTests) return broadcastSignedOperatorUsdcTransferForTests(env, input)

  const config = resolveOperatorTransferConfig(env)
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  try {
    await provider.broadcastTransaction(input.signedTx)
  } catch (error) {
    const msg = errorMessage(error).toLowerCase()
    const nonceConsumed = msg.includes("already known") || msg.includes("known transaction") || msg.includes("nonce too low") || msg.includes("already imported")
    if (!nonceConsumed) throw error
    // The nonce is gone — confirm it was consumed by OUR transaction, not a replacement.
    const existing = await provider.getTransaction(input.expectedTxRef)
    if (!existing) {
      throw conflictError("Booking settlement nonce was replaced by another transaction (reconciliation required)")
    }
  }
}

async function waitForOperatorUsdcTransfer(env: Env, input: { txRef: string }): Promise<void> {
  if (waitForOperatorUsdcTransferForTests) return waitForOperatorUsdcTransferForTests(env, input)

  const config = resolveOperatorTransferConfig(env)
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  const receipt = await provider.waitForTransaction(input.txRef, 1, config.txWaitTimeoutMs)
  if (!receipt || receipt.status !== 1) throw badRequestError("booking_settlement_transfer_failed")
}

function effectKind(effect: BookingOperatorEffect): BookingSettlementEffectKind {
  return effect.kind === "refund" ? "booking_refund" : "booking_payout"
}

async function withCommunityWrite<T>(
  ctx: BookingOperatorEffectContext,
  fn: (client: Awaited<ReturnType<typeof openCommunityWriteClient>>["client"]) => Promise<T>,
): Promise<T> {
  const handle = await openCommunityWriteClient(ctx.env, ctx.communityRepository, ctx.communityId)
  try {
    return await fn(handle.client)
  } finally {
    await handle.close()
  }
}

export async function executeBookingOperatorEffect(
  ctx: BookingOperatorEffectContext,
  effect: BookingOperatorEffect,
): Promise<{ txRef: string }> {
  if (effect.amountCents <= 0) throw badRequestError("Booking settlement amount must be positive")
  const recipientAddress = normalizeRecipientAddress(effect.recipientAddress)

  const begun = await withCommunityWrite(ctx, async (client) => beginBookingSettlementEffectAttempt({
    client,
    communityId: ctx.communityId,
    bookingId: effect.bookingId,
    effectKind: effectKind(effect),
    idempotencyKey: effect.idempotencyKey,
    amountCents: effect.amountCents,
    recipientAddress,
    now: ctx.nowUtc,
  }))

  const row = begun.row

  if (row.status === "confirmed") {
    if (!row.settlement_ref) throw new Error("confirmed_booking_settlement_effect_missing_ref")
    return { txRef: row.settlement_ref }
  }

  // Recovery: a prior attempt already SIGNED and durably recorded the tx (crash in the broadcast
  // window). Re-broadcast the identical signed tx (idempotent by nonce), wait, and confirm — money
  // moves at most once.
  if (row.status === "submitted" && row.signed_tx && row.settlement_ref) {
    await broadcastSignedOperatorUsdcTransfer(ctx.env, { signedTx: row.signed_tx, expectedTxRef: row.settlement_ref })
    await waitForOperatorUsdcTransfer(ctx.env, { txRef: row.settlement_ref })
    const confirmed = await withCommunityWrite(ctx, async (client) => confirmBookingSettlementEffect({
      client, idempotencyKey: effect.idempotencyKey, settlementRef: row.settlement_ref!, now: ctx.nowUtc,
    }))
    return { txRef: confirmed.settlement_ref! }
  }

  // Another worker owns an in-flight attempt that has not signed yet (no signed_tx ⇒ nothing was
  // broadcast). Back off rather than starting a competing transfer.
  if (begun.action === "existing_submitted" && !row.signed_tx) {
    throw conflictError("Booking settlement effect has an unresolved submitted attempt")
  }

  // We own a fresh attempt. Serialize sign→record→broadcast under the operator signing lock so
  // concurrent effects allocate sequential nonces (no two share a nonce). SIGN first (no money moves
  // yet); a pre-sign failure is safe to mark failed because nothing was broadcast. The signed tx +
  // hash + nonce are persisted BEFORE broadcasting, so after that point we never mark failed and any
  // retry recovers via the recorded signed tx.
  const prepared = await withOperatorSigningLock(async () => {
    let p: { signedTx: string; txRef: string; nonce: number }
    try {
      p = await prepareOperatorUsdcTransfer(ctx.env, { to: recipientAddress, amountCents: effect.amountCents })
    } catch (error) {
      await withCommunityWrite(ctx, async (client) => failBookingSettlementEffect({
        client, idempotencyKey: effect.idempotencyKey, failureReason: errorMessage(error), now: ctx.nowUtc,
      }))
      throw error
    }
    await withCommunityWrite(ctx, async (client) => recordBookingSettlementEffectSubmission({
      client, idempotencyKey: effect.idempotencyKey, settlementRef: p.txRef,
      signedTx: p.signedTx, nonce: p.nonce, now: ctx.nowUtc,
    }))
    await broadcastSignedOperatorUsdcTransfer(ctx.env, { signedTx: p.signedTx, expectedTxRef: p.txRef })
    return p
  })

  await waitForOperatorUsdcTransfer(ctx.env, { txRef: prepared.txRef })

  const confirmed = await withCommunityWrite(ctx, async (client) => confirmBookingSettlementEffect({
    client, idempotencyKey: effect.idempotencyKey, settlementRef: prepared.txRef, now: ctx.nowUtc,
  }))
  return { txRef: confirmed.settlement_ref! }
}
