import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"

import type { Env } from "../../../env"
import { conflictError, badRequestError } from "../../errors"
import { parseExpectedEvmAddress } from "../../evm-signer"
import { normalizeDirectSignerPrivateKey } from "../../story/story-direct-signer"
import { openCommunityWriteClient } from "../community-read-access"
import {
  beginBookingSettlementEffectAttempt,
  confirmBookingSettlementEffect,
  failBookingSettlementEffect,
  recordBookingSettlementEffectBroadcast,
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

type BroadcastOperatorUsdcTransfer = (env: Env, input: {
  to: string
  amountCents: number
}) => Promise<{ txRef: string }>

type WaitForOperatorUsdcTransfer = (env: Env, input: {
  txRef: string
}) => Promise<void>

let broadcastOperatorUsdcTransferForTests: BroadcastOperatorUsdcTransfer | null = null
let waitForOperatorUsdcTransferForTests: WaitForOperatorUsdcTransfer | null = null

export function setBookingOperatorUsdcTransferForTests(input: {
  broadcast: BroadcastOperatorUsdcTransfer
  wait?: WaitForOperatorUsdcTransfer
} | null): void {
  broadcastOperatorUsdcTransferForTests = input?.broadcast ?? null
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

async function broadcastOperatorUsdcTransfer(env: Env, input: {
  to: string
  amountCents: number
}): Promise<{ txRef: string }> {
  if (broadcastOperatorUsdcTransferForTests) return broadcastOperatorUsdcTransferForTests(env, input)

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

  const tx = await usdc.transfer(to, amount)
  const txRef = String(tx.hash || "")
  if (!txRef) throw badRequestError("booking_settlement_missing_tx_hash")
  return { txRef }
}

async function waitForOperatorUsdcTransfer(env: Env, input: {
  txRef: string
}): Promise<void> {
  if (waitForOperatorUsdcTransferForTests) return waitForOperatorUsdcTransferForTests(env, input)

  const config = resolveOperatorTransferConfig(env)
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  const receipt = await provider.waitForTransaction(input.txRef, 1, config.txWaitTimeoutMs)
  if (!receipt || receipt.status !== 1) throw badRequestError("booking_settlement_transfer_failed")
}

function effectKind(effect: BookingOperatorEffect): BookingSettlementEffectKind {
  return effect.kind === "refund" ? "booking_refund" : "booking_payout"
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  if (row.status === "submitted" && row.settlement_ref) {
    await waitForOperatorUsdcTransfer(ctx.env, { txRef: row.settlement_ref })
    const confirmed = await withCommunityWrite(ctx, async (client) => confirmBookingSettlementEffect({
      client,
      idempotencyKey: effect.idempotencyKey,
      settlementRef: row.settlement_ref!,
      now: ctx.nowUtc,
    }))
    return { txRef: confirmed.settlement_ref! }
  }

  if (begun.action === "existing_submitted" && !row.settlement_ref) {
    throw conflictError("Booking settlement effect has an unresolved submitted attempt")
  }

  let txRef: string
  try {
    txRef = (await broadcastOperatorUsdcTransfer(ctx.env, {
      to: recipientAddress,
      amountCents: effect.amountCents,
    })).txRef
  } catch (error) {
    await withCommunityWrite(ctx, async (client) => failBookingSettlementEffect({
      client,
      idempotencyKey: effect.idempotencyKey,
      failureReason: errorMessage(error),
      now: ctx.nowUtc,
    }))
    throw error
  }

  await withCommunityWrite(ctx, async (client) => recordBookingSettlementEffectBroadcast({
    client,
    idempotencyKey: effect.idempotencyKey,
    settlementRef: txRef,
    now: ctx.nowUtc,
  }))

  try {
    await waitForOperatorUsdcTransfer(ctx.env, { txRef })
  } catch (error) {
    // A tx hash is already durably recorded. Do not mark failed and do not retry with a second
    // transfer; a later call will re-check this tx and confirm it, or surface the same failure.
    throw error
  }

  const confirmed = await withCommunityWrite(ctx, async (client) => confirmBookingSettlementEffect({
    client,
    idempotencyKey: effect.idempotencyKey,
    settlementRef: txRef,
    now: ctx.nowUtc,
  }))
  return { txRef: confirmed.settlement_ref! }
}
