import { Contract, JsonRpcProvider, Wallet } from "ethers"
import { SignJWT } from "jose"
import { chmod, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]

type Session = {
  accessToken: string
  userId: string
  walletAttachment: string | null
}

type JsonResult = {
  status: number
  body: unknown
}

export const PAID_BOOKING_SMOKE_USAGE = `Usage:
  bun run smoke:paid-booking -- [options]

Modes:
  quote-only (default): creates a host, availability, hold, and quote without sending funds.
  --claim: sends USDC, confirms the booking, attaches both sessions, and records heartbeats.
  --funding-preflight-only: checks buyer gas, buyer USDC, and settlement-operator gas before creating booking records.

Common options:
  --origin URL                         API origin. Defaults to https://api-staging.pirate.sc.
  --run-id ID                          Stable suffix for smoke users/profile labels.
  --private-key-env NAME               Buyer private key env var. Defaults to PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY.
  --buyer-address ADDRESS              Buyer wallet to inspect for --funding-preflight-only without loading a private key.
  --allow-checkout-operator-buyer      Use PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY if the buyer key env is absent.
  --host-payout-wallet ADDRESS         Override host payout wallet. Defaults to buyer wallet when a buyer key is present.
  --base-price-cents N                 Booking price in cents. Defaults to 100.
  --wait-for-completion                After confirm/attach/heartbeat, wait for slot start and call complete.
  --agora-evidence-file PATH           Write booking id and host/booker Agora credentials to a 0600 JSON file after attach.

Funding preflight options:
  --chain-id 84532
  --token-address 0x036CbD53842c5426634e7929541eC2318f3dCF7e
  --settlement-address 0xbBA024600cba5F375AfdCeC401f7dcCB3D515829
  --amount-atomic 1000000

Prod testnet funding preflight:
  BASE_SEPOLIA_RPC_URL=https://sepolia.base.org bun run smoke:paid-booking -- --funding-preflight-only --origin https://api.pirate.sc --chain-id 84532 --token-address 0x036CbD53842c5426634e7929541eC2318f3dCF7e --settlement-address 0xbBA024600cba5F375AfdCeC401f7dcCB3D515829 --amount-atomic 1000000

Prod testnet address-only funding preflight:
  BASE_SEPOLIA_RPC_URL=https://sepolia.base.org bun run smoke:paid-booking -- --funding-preflight-only --origin https://api.pirate.sc --buyer-address 0x1111111111111111111111111111111111111111 --chain-id 84532 --token-address 0x036CbD53842c5426634e7929541eC2318f3dCF7e --settlement-address 0xbBA024600cba5F375AfdCeC401f7dcCB3D515829 --amount-atomic 1000000

Prod testnet full canary:
  bun run smoke:paid-booking -- --origin https://api.pirate.sc --run-id 20260630-prod-paid-canary --claim --wait-for-completion
`

function arg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? null : null
}

function flag(name: string): boolean {
  return process.argv.includes(name)
}

function env(name: string): string {
  return String(process.env[name] ?? "").trim()
}

export function parsePositiveInt(value: string | null, label: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

export function parsePositiveAtomic(value: string | null, label: string): string {
  const text = String(value ?? "").trim()
  if (!/^[1-9]\d*$/u.test(text)) throw new Error(`${label} must be a positive integer atomic amount`)
  return text
}

export function parseAddress(value: string | null, label: string): string {
  const text = String(value ?? "").trim()
  if (!isProbablyAddress(text)) throw new Error(`${label} must be an EVM address`)
  return text
}

export function isProbablyAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/u.test(value.trim())
}

export function resolveHostPayoutWallet(input: {
  explicitHostPayoutWallet: string | null
  buyerPrivateKey: string
  fallbackAddress: string
}): string {
  const hostPayoutWallet = input.explicitHostPayoutWallet || (input.buyerPrivateKey ? new Wallet(input.buyerPrivateKey).address : input.fallbackAddress)
  if (!isProbablyAddress(hostPayoutWallet)) {
    throw new Error(`Invalid --host-payout-wallet: ${hostPayoutWallet}`)
  }
  return hostPayoutWallet
}

export function validateQuotePaymentFields(payment: Record<string, unknown>): {
  chainId: number
  tokenAddress: string
  recipientAddress: string
  amountAtomic: string
} {
  const chainId = Number(payment.chain_id)
  const tokenAddress = String(payment.token_address ?? "")
  const recipientAddress = String(payment.recipient_address ?? "")
  const amountAtomic = String(payment.amount_atomic ?? "")
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`quote returned invalid chain_id: ${payment.chain_id}`)
  if (!isProbablyAddress(tokenAddress)) throw new Error(`quote returned invalid token_address: ${tokenAddress}`)
  if (!isProbablyAddress(recipientAddress)) throw new Error(`quote returned invalid recipient_address: ${recipientAddress}`)
  if (!/^[1-9]\d*$/u.test(amountAtomic)) throw new Error(`quote returned invalid amount_atomic: ${amountAtomic}`)
  return { chainId, tokenAddress, recipientAddress, amountAtomic }
}

export function validateFundingReadiness(input: {
  buyerAddress: string
  settlementAddress: string
  buyerNativeWei: bigint
  buyerTokenAtomic: bigint
  settlementNativeWei: bigint
  requiredTokenAtomic: bigint
}): void {
  const failures: string[] = []
  if (input.buyerNativeWei <= 0n) {
    failures.push(`buyer ${input.buyerAddress} has no native gas balance`)
  }
  if (input.buyerTokenAtomic < input.requiredTokenAtomic) {
    failures.push(`buyer ${input.buyerAddress} has ${input.buyerTokenAtomic.toString()} token atomic, needs ${input.requiredTokenAtomic.toString()}`)
  }
  if (input.settlementNativeWei <= 0n) {
    failures.push(`settlement operator ${input.settlementAddress} has no native gas balance for payout/refund settlement`)
  }
  if (failures.length > 0) {
    throw new Error(`paid booking canary funding preflight failed: ${failures.join("; ")}`)
  }
}

export function resolveFundingPreflightBuyerAddress(input: {
  explicitBuyerAddress: string | null
  buyerPrivateKey: string
  privateKeyEnv: string
}): string {
  const explicitBuyerAddress = input.explicitBuyerAddress ? parseAddress(input.explicitBuyerAddress, "--buyer-address") : null
  const derivedBuyerAddress = input.buyerPrivateKey ? new Wallet(input.buyerPrivateKey).address : null
  if (explicitBuyerAddress && derivedBuyerAddress && explicitBuyerAddress.toLowerCase() !== derivedBuyerAddress.toLowerCase()) {
    throw new Error(`--buyer-address does not match ${input.privateKeyEnv}`)
  }
  const buyerAddress = explicitBuyerAddress ?? derivedBuyerAddress
  if (!buyerAddress) throw new Error(`${input.privateKeyEnv} or --buyer-address is required for --funding-preflight-only`)
  return buyerAddress
}

export function validateCompletedCanaryBooking(input: {
  booking: Record<string, unknown>
  bookingId: string
  fundingTxRef: string
}): void {
  const failures: string[] = []
  const status = String(input.booking.status ?? "")
  const fundingTxRef = String(input.booking.funding_tx_ref ?? "")
  const payoutTxRef = String(input.booking.payout_tx_ref ?? "")
  const liveRoomId = String(input.booking.live_room_id ?? "")
  if (String(input.booking.booking_id ?? "") !== input.bookingId) {
    failures.push(`booking_id mismatch: expected ${input.bookingId}`)
  }
  if (status !== "settled") {
    failures.push(`booking status is ${status || "missing"}, expected settled`)
  }
  if (fundingTxRef.toLowerCase() !== input.fundingTxRef.toLowerCase()) {
    failures.push("funding_tx_ref does not match submitted payment")
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(payoutTxRef)) {
    failures.push("payout_tx_ref is missing or not a transaction hash")
  }
  if (liveRoomId !== `pirate-booking-${input.bookingId}`) {
    failures.push("live_room_id does not match expected Agora booking channel")
  }
  if (failures.length > 0) {
    throw new Error(`paid booking canary final verification failed: ${failures.join("; ")}`)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

function bearer(token: string): HeadersInit {
  return {
    "authorization": `Bearer ${token}`,
    "content-type": "application/json",
  }
}

async function requestJson(url: string, init: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 1000) }
    }
  }
  return { status: response.status, body }
}

function requireStatus(step: string, result: JsonResult, expected: number | number[]): Record<string, unknown> {
  const expectedStatuses = Array.isArray(expected) ? expected : [expected]
  if (!expectedStatuses.includes(result.status)) {
    throw new Error(`${step} failed: status=${result.status} body=${JSON.stringify(result.body).slice(0, 1000)}`)
  }
  return asRecord(result.body)
}

async function mintJwt(input: {
  origin: string
  subject: string
  wallet?: string
}): Promise<string> {
  const isStaging = new URL(input.origin).hostname.includes("staging")
  const issuer = env("AUTH_UPSTREAM_JWT_ISSUER") || (isStaging ? "pirate-staging-upstream" : "pirate-production-upstream")
  const audience = env("AUTH_UPSTREAM_JWT_AUDIENCE") || (isStaging ? "pirate-api-staging" : "api-core")
  const secret = env("AUTH_UPSTREAM_JWT_SHARED_SECRET") || env("JWT_BASED_AUTH_SHARED_SECRET")
  if (!secret) throw new Error("AUTH_UPSTREAM_JWT_SHARED_SECRET / JWT_BASED_AUTH_SHARED_SECRET is not configured")
  const payload: Record<string, unknown> = {}
  if (input.wallet) payload.wallet_address = input.wallet
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
}

async function exchangeSession(origin: string, subject: string, wallet?: string): Promise<Session> {
  const jwt = await mintJwt({ origin, subject, wallet })
  const exchanged = await requestJson(`${origin}/auth/session/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proof: { type: "jwt_based_auth", jwt } }),
  })
  const body = requireStatus(`session_exchange:${subject}`, exchanged, 200)
  const accessToken = typeof body.access_token === "string" ? body.access_token : ""
  const user = asRecord(body.user)
  const walletAttachments = Array.isArray(body.wallet_attachments) ? body.wallet_attachments : []
  const primary = walletAttachments
    .map(asRecord)
    .find((attachment) => attachment.is_primary === true)
    ?? walletAttachments.map(asRecord)[0]
  const walletAttachment = typeof user.primary_wallet_attachment === "string"
    ? user.primary_wallet_attachment
    : typeof primary?.wallet_attachment === "string"
      ? primary.wallet_attachment
      : null
  const userId = typeof user.id === "string" ? user.id : ""
  if (!accessToken || !userId) throw new Error(`session_exchange:${subject} did not return an access token and user id`)
  return { accessToken, userId, walletAttachment }
}

export interface DelayedCompletionDeps {
  origin: string
  bookingId: string
  hostSubject: string
  bookerSubject: string
  buyerWallet: string
  exchangeSession: (origin: string, subject: string, wallet?: string) => Promise<Session>
  requestJson: (url: string, init?: RequestInit) => Promise<JsonResult>
}

/**
 * Recover + complete a booking after the (long) slot wait.
 *
 * The 15-minute access tokens minted up front expire during the wait, so both sessions are
 * refreshed first. Then the FSM is driven confirmed → live → completed: `start` MUST precede
 * `complete`, and is idempotent-tolerant (409 = already live). Crucially, NO payment path runs
 * here — the single on-chain pay-in happened at confirm; the server-side payout is
 * idempotency-keyed — so a recovery/retry through this function can never send a second payment.
 */
export async function runDelayedCompletion(deps: DelayedCompletionDeps): Promise<{ host: Session; booker: Session; completion: Record<string, unknown> }> {
  const host = await deps.exchangeSession(deps.origin, deps.hostSubject)
  const booker = await deps.exchangeSession(deps.origin, deps.bookerSubject, deps.buyerWallet)
  requireStatus("start", await deps.requestJson(`${deps.origin}/bookings/${deps.bookingId}/start`, {
    method: "POST",
    headers: bearer(host.accessToken),
    body: "{}",
  }), [200, 202, 409])
  const completion = requireStatus("complete", await deps.requestJson(`${deps.origin}/bookings/${deps.bookingId}/complete`, {
    method: "POST",
    headers: bearer(host.accessToken),
    body: "{}",
  }), [200, 202])
  return { host, booker, completion }
}

function resolveRpcUrl(chainId: number): string {
  return env("PIRATE_BOOKING_SETTLEMENT_RPC_URL")
    || (chainId === 84532 ? env("BASE_SEPOLIA_RPC_URL") : "")
    || (chainId === 8453 ? env("BASE_MAINNET_RPC_URL") || env("ETHEREUM_RPC_URL") : "")
    || (() => {
      throw new Error(`No RPC URL configured for chain ${chainId}`)
    })()
}

async function preflightFunding(input: {
  buyerAddress: string
  chainId: number
  tokenAddress: string
  recipientAddress: string
  amountAtomic: string
}): Promise<void> {
  const provider = new JsonRpcProvider(resolveRpcUrl(input.chainId), input.chainId)
  const token = new Contract(input.tokenAddress, ERC20_ABI, provider)
  const [
    buyerNativeWei,
    buyerTokenAtomic,
    settlementNativeWei,
  ] = await Promise.all([
    provider.getBalance(input.buyerAddress),
    token.balanceOf(input.buyerAddress) as Promise<bigint>,
    provider.getBalance(input.recipientAddress),
  ])
  validateFundingReadiness({
    buyerAddress: input.buyerAddress,
    settlementAddress: input.recipientAddress,
    buyerNativeWei,
    buyerTokenAtomic,
    settlementNativeWei,
    requiredTokenAtomic: BigInt(input.amountAtomic),
  })
  console.log(JSON.stringify({
    step: "funding_preflight",
    buyer_wallet: input.buyerAddress,
    settlement_wallet: input.recipientAddress,
    buyer_native_wei: buyerNativeWei.toString(),
    buyer_token_atomic: buyerTokenAtomic.toString(),
    settlement_native_wei: settlementNativeWei.toString(),
    required_token_atomic: input.amountAtomic,
  }))
}

async function sendUsdcPayment(input: {
  privateKey: string
  chainId: number
  tokenAddress: string
  recipientAddress: string
  amountAtomic: string
}): Promise<string> {
  const provider = new JsonRpcProvider(resolveRpcUrl(input.chainId), input.chainId)
  const wallet = new Wallet(input.privateKey, provider)
  const token = new Contract(input.tokenAddress, ERC20_ABI, wallet)
  const tx = await token.transfer(input.recipientAddress, BigInt(input.amountAtomic))
  console.log(JSON.stringify({ step: "payment_submitted", from: wallet.address, tx_hash: tx.hash }))
  await tx.wait(1)
  return tx.hash
}

async function writeAgoraEvidenceFile(path: string, evidence: Record<string, unknown>): Promise<void> {
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function weekdayInTimeZone(timeZone: string): number {
  const short = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(new Date())
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(short)
}

async function main(): Promise<void> {
  if (flag("--help") || flag("-h")) {
    console.log(PAID_BOOKING_SMOKE_USAGE)
    return
  }
  const origin = (arg("--origin") || "https://api-staging.pirate.sc").replace(/\/+$/, "")
  const runId = arg("--run-id") || String(Date.now())
  const claim = flag("--claim")
  const waitForCompletion = flag("--wait-for-completion")
  const agoraEvidenceFile = arg("--agora-evidence-file")
  const privateKeyEnv = arg("--private-key-env") || "PIRATE_BOOKING_SMOKE_BUYER_PRIVATE_KEY"
  const basePriceCents = arg("--base-price-cents") == null ? 100 : parsePositiveInt(arg("--base-price-cents"), "--base-price-cents")
  let privateKey = env(privateKeyEnv)
  if (!privateKey && flag("--allow-checkout-operator-buyer")) {
    privateKey = env("PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY")
  }
  if (flag("--funding-preflight-only")) {
    const buyerAddress = resolveFundingPreflightBuyerAddress({
      explicitBuyerAddress: arg("--buyer-address"),
      buyerPrivateKey: privateKey,
      privateKeyEnv,
    })
    await preflightFunding({
      buyerAddress,
      chainId: parsePositiveInt(arg("--chain-id"), "--chain-id"),
      tokenAddress: parseAddress(arg("--token-address"), "--token-address"),
      recipientAddress: parseAddress(arg("--settlement-address") || arg("--recipient-address"), "--settlement-address"),
      amountAtomic: parsePositiveAtomic(arg("--amount-atomic"), "--amount-atomic"),
    })
    return
  }
  const buyerWallet = privateKey ? new Wallet(privateKey).address : "0x1111111111111111111111111111111111111111"
  const hostPayoutWallet = resolveHostPayoutWallet({
    explicitHostPayoutWallet: arg("--host-payout-wallet"),
    buyerPrivateKey: privateKey,
    fallbackAddress: Wallet.createRandom().address,
  })
  const hostTimezone = "Europe/Vienna"
  const hostSubject = `paid-booking-smoke-host-${runId}`
  const bookerSubject = `paid-booking-smoke-booker-${runId}`

  let host = await exchangeSession(origin, hostSubject)
  let booker = await exchangeSession(origin, bookerSubject, buyerWallet)
  if (!booker.walletAttachment) throw new Error("booker wallet attachment missing")

  const profile = await requestJson(`${origin}/host-bookings/me/profile`, {
    method: "POST",
    headers: bearer(host.accessToken),
    body: JSON.stringify({
      host_timezone: hostTimezone,
      base_price_cents: basePriceCents,
      default_slot_duration_seconds: 900,
      display_headline: `Paid booking smoke ${runId}`,
      platform_fee_bps: 1000,
      payout_wallet_address: hostPayoutWallet,
    }),
  })
  const profileBody = requireStatus("host_profile", profile, [200, 201])
  const bookingHostId = typeof profileBody.host === "string" ? profileBody.host : host.userId

  const rule = await requestJson(`${origin}/host-bookings/me/availability-rules`, {
    method: "POST",
    headers: bearer(host.accessToken),
    body: JSON.stringify({
      by_weekday: [weekdayInTimeZone(hostTimezone)],
      start_local: "00:00",
      end_local: "23:59",
      slot_duration_seconds: 900,
    }),
  })
  const ruleBody = requireStatus("availability_rule", rule, 201)

  requireStatus("publish", await requestJson(`${origin}/host-bookings/me/profile/publish`, {
    method: "POST",
    headers: bearer(host.accessToken),
    body: "{}",
  }), 200)

  const now = Date.now()
  const slots = await requestJson(
    `${origin}/bookings/hosts/${bookingHostId}/slots?from=${encodeURIComponent(new Date(now).toISOString())}&to=${encodeURIComponent(new Date(now + 3 * 3600_000).toISOString())}&tz=UTC`,
    { headers: bearer(booker.accessToken) },
  )
  const slotsBody = requireStatus("slots", slots, 200)
  const slot = (Array.isArray(slotsBody.slots) ? slotsBody.slots.map(asRecord) : [])
    .find((candidate) => candidate.available === true)
  if (!slot || typeof slot.startUtc !== "string" || typeof slot.endUtc !== "string") {
    throw new Error(`no available slot returned: ${JSON.stringify(slotsBody).slice(0, 1000)}`)
  }

  const hold = await requestJson(`${origin}/bookings/hosts/${bookingHostId}/holds`, {
    method: "POST",
    headers: bearer(booker.accessToken),
    body: JSON.stringify({
      slot_start_utc: slot.startUtc,
      slot_end_utc: slot.endUtc,
    }),
  })
  const holdBody = requireStatus("hold", hold, 201)
  const holdId = String(asRecord(holdBody.hold).hold_id ?? "")
  if (!holdId) throw new Error("hold id missing")

  const quote = await requestJson(`${origin}/bookings/holds/${holdId}/quote`, {
    method: "POST",
    headers: bearer(booker.accessToken),
    body: "{}",
  })
  const quoteBody = requireStatus("quote", quote, 200)
  const quoteDetails = asRecord(quoteBody.quote)
  const payment = asRecord(quoteDetails.payment)
  const { chainId, tokenAddress, recipientAddress, amountAtomic } = validateQuotePaymentFields(payment)

  console.log(JSON.stringify({
    step: "quote",
    run_id: runId,
    host_user_id: bookingHostId,
    booker_user_id: booker.userId,
    hold_id: holdId,
    slot_start_utc: slot.startUtc,
    slot_end_utc: slot.endUtc,
    chain_id: chainId,
    token_address: tokenAddress,
    recipient_address: recipientAddress,
    amount_atomic: amountAtomic,
    claim,
  }, null, 2))

  if (!claim) {
    console.log(JSON.stringify({
      step: "funding_required",
      private_key_env: privateKeyEnv,
      buyer_wallet: buyerWallet,
      note: "Rerun with --claim after funding the buyer wallet with gas and test USDC.",
    }, null, 2))
    return
  }
  if (!privateKey) throw new Error(`${privateKeyEnv} is required for --claim`)

  await preflightFunding({
    buyerAddress: new Wallet(privateKey).address,
    chainId,
    tokenAddress,
    recipientAddress,
    amountAtomic,
  })

  const fundingTxRef = await sendUsdcPayment({
    privateKey,
    chainId,
    tokenAddress,
    recipientAddress,
    amountAtomic,
  })

  const confirm = await requestJson(`${origin}/bookings/holds/${holdId}/confirm`, {
    method: "POST",
    headers: bearer(booker.accessToken),
    body: JSON.stringify({
      funding_tx_ref: fundingTxRef,
      wallet_attachment_id: booker.walletAttachment,
    }),
  })
  const confirmBody = requireStatus("confirm", confirm, [200, 201])
  const booking = asRecord(confirmBody.booking)
  const bookingId = String(booking.booking_id ?? "")
  if (!bookingId) throw new Error("booking id missing")

  const hostAttach = requireStatus("host_attach", await requestJson(`${origin}/bookings/${bookingId}/session/attach`, {
    method: "POST",
    headers: bearer(host.accessToken),
    body: "{}",
  }), 200)
  const bookerAttach = requireStatus("booker_attach", await requestJson(`${origin}/bookings/${bookingId}/session/attach`, {
    method: "POST",
    headers: bearer(booker.accessToken),
    body: "{}",
  }), 200)
  for (const [label, session, token] of [
    ["host", hostAttach, host.accessToken],
    ["booker", bookerAttach, booker.accessToken],
  ] as const) {
    const sessionId = String(session.session_id ?? "")
    if (!sessionId) throw new Error(`${label} attach did not return session_id`)
    requireStatus(`${label}_heartbeat`, await requestJson(`${origin}/bookings/${bookingId}/session/heartbeat`, {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ session_id: sessionId }),
    }), 200)
  }

  if (agoraEvidenceFile) {
    await writeAgoraEvidenceFile(agoraEvidenceFile, {
      booking_id: bookingId,
      host_agora: asRecord(hostAttach.agora),
      booker_agora: asRecord(bookerAttach.agora),
      live_room_id: booking.live_room_id ?? null,
      run_id: runId,
    })
    console.log(JSON.stringify({
      step: "agora_evidence_written",
      path: agoraEvidenceFile,
    }, null, 2))
  }

  let completion: Record<string, unknown> | null = null
  const slotStartMs = Date.parse(String(slot.startUtc))
  if (waitForCompletion && Number.isFinite(slotStartMs)) {
    const delay = Math.max(0, slotStartMs - Date.now() + 1000)
    if (delay > 0) await sleep(delay)
    // Tokens expire across the slot wait — refresh auth and drive confirmed → live → completed
    // (start before complete, idempotent, no second payment). See runDelayedCompletion.
    const recovered = await runDelayedCompletion({ origin, bookingId, hostSubject, bookerSubject, buyerWallet, exchangeSession, requestJson })
    host = recovered.host
    booker = recovered.booker
    completion = recovered.completion
    const finalBooking = requireStatus("final_booking", await requestJson(`${origin}/bookings/${bookingId}`, {
      headers: bearer(booker.accessToken),
    }), 200)
    const finalBookingView = asRecord(finalBooking.booking)
    validateCompletedCanaryBooking({
      booking: finalBookingView,
      bookingId,
      fundingTxRef,
    })
    console.log(JSON.stringify({
      step: "final_booking_verified",
      booking_id: bookingId,
      status: finalBookingView.status ?? null,
      funding_tx_ref: finalBookingView.funding_tx_ref ?? null,
      payout_tx_ref: finalBookingView.payout_tx_ref ?? null,
      live_room_id: finalBookingView.live_room_id ?? null,
    }, null, 2))
  }

  console.log(JSON.stringify({
    step: "smoke_complete",
    run_id: runId,
    booking_id: bookingId,
    funding_tx_ref: fundingTxRef,
    host_session_id: hostAttach.session_id,
    booker_session_id: bookerAttach.session_id,
    host_agora_configured: asRecord(hostAttach.agora).configured ?? null,
    booker_agora_configured: asRecord(bookerAttach.agora).configured ?? null,
    completion_status: completion ? asRecord(completion.booking).status ?? null : "not_requested",
    availability_rule_id: ruleBody.id ?? null,
  }, null, 2))
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
