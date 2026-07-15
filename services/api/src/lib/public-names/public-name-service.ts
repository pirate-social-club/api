import { getAddress } from "ethers"
import type { Env } from "../../env"
import { buildHandleUpgradeQuote, normalizeDesiredGlobalHandleLabel, resolveGlobalHandlePaidPrice } from "../auth/global-handle-policy"
import { hasUniqueConstraintField } from "../auth/auth-db-query-helpers"
import {
  resolvePirateCheckoutOperatorAddress,
  resolvePirateCheckoutSourceChainId,
  resolvePirateCheckoutSourceChainName,
  resolvePirateCheckoutUsdcTokenAddress,
} from "../communities/commerce/checkout-config"
import { verifyPirateCheckoutUsdcFunding } from "../communities/commerce/funding-proof-service"
import { badRequestError, conflictError, eligibilityFailed, internalError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { safeRollback } from "../transactions"
import { unixSeconds } from "../../serializers/time"

const PUBLIC_PIRATE_NAME_QUOTE_TTL_SECONDS = 15 * 60
const PUBLIC_PIRATE_NAME_QUOTE_PREFIX = "pnq"
const PUBLIC_PIRATE_NAME_REGISTRATION_PREFIX = "pnr"

type PublicPirateNamePaymentInstructions = {
  chain: {
    chain_namespace: "eip155"
    chain_id: number
    display_name: string
  }
  token_address: string
  recipient_address: string
  amount_atomic: string
  amount_display: string
}

export type PublicPirateNameQuoteResponse = {
  quote: string
  desired_label: string
  label_normalized: string
  buyer: {
    kind: "wallet"
    wallet_address: string
    chain_ref: string
  }
  price_cents: number
  currency: "USD"
  eligible: true
  reason: null
  policy_version: string
  pricing_tier: string | null
  quote_ttl_seconds: number
  quoted_at: number
  expires_at: number
  payment_instructions: PublicPirateNamePaymentInstructions
}

export type PublicPirateNameRegistrationResponse = {
  registration: {
    id: string
    label: string
    label_normalized: string
    status: "active" | "expired" | "revoked"
    owner_kind: "wallet"
    owner_wallet_address: string
    chain_ref: string
    price_paid_cents: number
    currency: "USD"
    issued_at: number
    expires_at: number | null
    pirate_user_id: string | null
  }
  quote: string
  funding_tx_ref: string | null
  settlement_tx_ref: string | null
}

export type PublicPirateNameStatusResponse =
  | {
    label: string
    label_normalized: string
    status: "available"
  }
  | {
    label: string
    label_normalized: string
    status: "registered"
    registration: PublicPirateNameRegistrationResponse["registration"]
  }
  | {
    label: string
    label_normalized: string
    status: "taken"
    owner_kind: "user"
  }

function normalizeSubmittedPublicPirateNameQuoteId(value: string): string {
  const trimmed = value.trim()
  if (trimmed.startsWith(`${PUBLIC_PIRATE_NAME_QUOTE_PREFIX}_${PUBLIC_PIRATE_NAME_QUOTE_PREFIX}_`)) {
    return trimmed.slice(PUBLIC_PIRATE_NAME_QUOTE_PREFIX.length + 1)
  }
  return trimmed
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString()
}

export function normalizeBuyerWalletAddress(value: string): string {
  try {
    return getAddress(value.trim()).toLowerCase()
  } catch {
    throw badRequestError("buyer_wallet_address must be a valid EVM address")
  }
}

export function normalizePublicPirateNameLabel(value: string): ReturnType<typeof normalizeDesiredGlobalHandleLabel> {
  return normalizeDesiredGlobalHandleLabel(value)
}

function buildChainRef(env: Env): string {
  return `eip155:${resolvePirateCheckoutSourceChainId(env)}`
}

function buildSourceChainJson(env: Env): string {
  const chainId = resolvePirateCheckoutSourceChainId(env)
  return JSON.stringify({
    chain_namespace: "eip155",
    chain_id: chainId,
    display_name: resolvePirateCheckoutSourceChainName(chainId),
  })
}

function buildPublicNamePaymentInstructions(env: Env, priceCents: number): PublicPirateNamePaymentInstructions {
  const chainId = resolvePirateCheckoutSourceChainId(env)
  return {
    chain: {
      chain_namespace: "eip155",
      chain_id: chainId,
      display_name: resolvePirateCheckoutSourceChainName(chainId),
    },
    token_address: resolvePirateCheckoutUsdcTokenAddress(env),
    recipient_address: resolvePirateCheckoutOperatorAddress(env),
    amount_atomic: String(BigInt(priceCents) * 10_000n),
    amount_display: (priceCents / 100).toFixed(2),
  }
}

function parseSettingsSnapshot(row: QueryResultRow): {
  pricing_tier: string | null
} {
  const raw = stringOrNull(rowValue(row, "settings_snapshot_json"))
  if (!raw) {
    return { pricing_tier: null }
  }
  try {
    const parsed = JSON.parse(raw) as { pricing_tier?: unknown }
    return {
      pricing_tier: typeof parsed.pricing_tier === "string" ? parsed.pricing_tier : null,
    }
  } catch {
    return { pricing_tier: null }
  }
}

function serializeQuote(env: Env, row: QueryResultRow): PublicPirateNameQuoteResponse {
  const priceCents = requiredNumber(row, "price_cents")
  const settings = parseSettingsSnapshot(row)
  return {
    quote: requiredString(row, "pirate_name_quote_id"),
    desired_label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    buyer: {
      kind: "wallet",
      wallet_address: requiredString(row, "buyer_wallet_address_normalized"),
      chain_ref: requiredString(row, "chain_ref"),
    },
    price_cents: priceCents,
    currency: "USD",
    eligible: true,
    reason: null,
    policy_version: requiredString(row, "policy_version"),
    pricing_tier: settings.pricing_tier,
    quote_ttl_seconds: requiredNumber(row, "quote_ttl_seconds"),
    quoted_at: unixSeconds(requiredString(row, "quoted_at")),
    expires_at: unixSeconds(requiredString(row, "expires_at")),
    payment_instructions: buildPublicNamePaymentInstructions(env, priceCents),
  }
}

function serializeRegistration(row: QueryResultRow): PublicPirateNameRegistrationResponse {
  const registration = {
    id: requiredString(row, "pirate_name_registration_id"),
    label: requiredString(row, "label_display"),
    label_normalized: requiredString(row, "label_normalized"),
    status: requiredString(row, "status") as "active" | "expired" | "revoked",
    owner_kind: "wallet" as const,
    owner_wallet_address: requiredString(row, "owner_wallet_address_normalized"),
    chain_ref: requiredString(row, "chain_ref"),
    price_paid_cents: requiredNumber(row, "price_paid_cents"),
    currency: "USD" as const,
    issued_at: unixSeconds(requiredString(row, "issued_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")) ? unixSeconds(requiredString(row, "expires_at")) : null,
    pirate_user_id: stringOrNull(rowValue(row, "pirate_user_id")),
  }
  return {
    registration,
    quote: requiredString(row, "pirate_name_quote_id"),
    funding_tx_ref: stringOrNull(rowValue(row, "funding_tx_ref")),
    settlement_tx_ref: stringOrNull(rowValue(row, "settlement_tx_ref")),
  }
}

async function expireStalePublicPirateNameQuotes(input: {
  executor: Client | Transaction
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE pirate_name_quotes
      SET status = 'expired',
          updated_at = ?1
      WHERE status = 'quoted'
        AND expires_at <= ?1
    `,
    args: [input.now],
  })
}

async function activeGlobalHandleExists(
  executor: Client | Transaction,
  labelNormalized: string,
): Promise<boolean> {
  const row = (await executor.execute({
    sql: `
      SELECT 1
      FROM global_handles
      WHERE label_normalized = ?1
        AND status = 'active'
      LIMIT 1
    `,
    args: [labelNormalized],
  })).rows[0]
  return Boolean(row)
}

async function activePublicRegistrationRow(
  executor: Client | Transaction,
  labelNormalized: string,
): Promise<QueryResultRow | null> {
  return (await executor.execute({
    sql: `
      SELECT pr.*, pq.funding_tx_ref, pq.settlement_tx_ref
      FROM pirate_name_registrations AS pr
      JOIN pirate_name_quotes AS pq
        ON pq.pirate_name_quote_id = pr.pirate_name_quote_id
      WHERE pr.label_normalized = ?1
        AND pr.status = 'active'
      LIMIT 1
    `,
    args: [labelNormalized],
  })).rows[0] ?? null
}

async function loadRegistrationForQuote(
  executor: Client | Transaction,
  quoteId: string,
): Promise<QueryResultRow | null> {
  return (await executor.execute({
    sql: `
      SELECT pr.*, pq.funding_tx_ref, pq.settlement_tx_ref
      FROM pirate_name_registrations AS pr
      JOIN pirate_name_quotes AS pq
        ON pq.pirate_name_quote_id = pr.pirate_name_quote_id
      WHERE pr.pirate_name_quote_id = ?1
      ORDER BY pr.created_at DESC
      LIMIT 1
    `,
    args: [quoteId],
  })).rows[0] ?? null
}

async function publicNameLabelAvailable(input: {
  executor: Client | Transaction
  labelNormalized: string
}): Promise<boolean> {
  if (await activeGlobalHandleExists(input.executor, input.labelNormalized)) {
    return false
  }
  if (await activePublicRegistrationRow(input.executor, input.labelNormalized)) {
    return false
  }
  const activeQuote = (await input.executor.execute({
    sql: `
      SELECT 1
      FROM pirate_name_quotes
      WHERE label_normalized = ?1
        AND status IN ('quoted', 'claimed')
      LIMIT 1
    `,
    args: [input.labelNormalized],
  })).rows[0]
  return !activeQuote
}

export async function createPublicPirateNameQuote(input: {
  env: Env
  client: Client
  desiredLabel: string
  buyerWalletAddress: string
}): Promise<PublicPirateNameQuoteResponse> {
  const desired = normalizeDesiredGlobalHandleLabel(input.desiredLabel)
  const buyerWalletAddressNormalized = normalizeBuyerWalletAddress(input.buyerWalletAddress)
  const now = nowIso()
  await expireStalePublicPirateNameQuotes({ executor: input.client, now })

  const existing = (await input.client.execute({
    sql: `
      SELECT *
      FROM pirate_name_quotes
      WHERE label_normalized = ?1
        AND buyer_wallet_address_normalized = ?2
        AND status = 'quoted'
        AND expires_at > ?3
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [desired.labelNormalized, buyerWalletAddressNormalized, now],
  })).rows[0]
  if (existing) {
    const price = resolveGlobalHandlePaidPrice({ labelNormalized: desired.labelNormalized })
    if (
      price.eligible
      && price.priceCents === requiredNumber(existing, "price_cents")
      && price.policyVersion === requiredString(existing, "policy_version")
    ) {
      return serializeQuote(input.env, existing)
    }
    await input.client.execute({
      sql: `
        UPDATE pirate_name_quotes
        SET status = 'failed',
            updated_at = ?2
        WHERE pirate_name_quote_id = ?1
      `,
      args: [requiredString(existing, "pirate_name_quote_id"), now],
    })
  }

  const labelAvailable = await publicNameLabelAvailable({
    executor: input.client,
    labelNormalized: desired.labelNormalized,
  })
  const quote = buildHandleUpgradeQuote({
    desiredLabel: desired.labelDisplay,
    labelNormalized: desired.labelNormalized,
    currentActiveLabelNormalized: "",
    cleanupRenameAvailable: false,
    labelAvailable,
  })
  if (!quote.eligible || quote.price_cents <= 0) {
    throw eligibilityFailed(quote.reason ?? "Desired label is not available for public purchase")
  }

  const quoteId = makeId(PUBLIC_PIRATE_NAME_QUOTE_PREFIX)
  const expiresAt = addSeconds(now, PUBLIC_PIRATE_NAME_QUOTE_TTL_SECONDS)
  const settingsSnapshot = JSON.stringify({
    pricing_tier: quote.pricing_tier ?? null,
    tier: quote.tier,
  })

  try {
    await input.client.execute({
      sql: `
        INSERT INTO pirate_name_quotes (
          pirate_name_quote_id, label_normalized, label_display, status,
          buyer_kind, buyer_wallet_address_normalized, chain_ref,
          price_cents, currency, policy_version, quote_ttl_seconds,
          quoted_at, expires_at, claimed_at,
          funding_tx_ref, settlement_tx_ref, settings_snapshot_json,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'quoted',
          'wallet', ?4, ?5,
          ?6, 'USD', ?7, ?8,
          ?9, ?10, NULL,
          NULL, NULL, ?11,
          ?9, ?9
        )
      `,
      args: [
        quoteId,
        desired.labelNormalized,
        desired.labelDisplay,
        buyerWalletAddressNormalized,
        buildChainRef(input.env),
        quote.price_cents,
        quote.policy_version ?? resolveGlobalHandlePaidPrice({ labelNormalized: desired.labelNormalized }).policyVersion,
        PUBLIC_PIRATE_NAME_QUOTE_TTL_SECONDS,
        now,
        expiresAt,
        settingsSnapshot,
      ],
    })
  } catch (error) {
    if (hasUniqueConstraintField(error, "pirate_name_quotes.label_normalized")) {
      throw conflictError("Desired label is unavailable")
    }
    throw error
  }

  const created = (await input.client.execute({
    sql: `
      SELECT *
      FROM pirate_name_quotes
      WHERE pirate_name_quote_id = ?1
      LIMIT 1
    `,
    args: [quoteId],
  })).rows[0]
  if (!created) {
    throw internalError("Created public pirate name quote row is missing")
  }
  return serializeQuote(input.env, created)
}

export async function claimPublicPirateName(input: {
  env: Env
  client: Client
  quote: string
  fundingTxRef: string
}): Promise<PublicPirateNameRegistrationResponse> {
  const quoteId = normalizeSubmittedPublicPirateNameQuoteId(input.quote)
  if (!quoteId) {
    throw badRequestError("quote is required")
  }
  const fundingTxRef = input.fundingTxRef.trim()
  if (!fundingTxRef) {
    throw badRequestError("funding_tx_ref is required")
  }

  const checkedAt = nowIso()
  await expireStalePublicPirateNameQuotes({ executor: input.client, now: checkedAt })

  const quote = (await input.client.execute({
    sql: `
      SELECT *
      FROM pirate_name_quotes
      WHERE pirate_name_quote_id = ?1
      LIMIT 1
    `,
    args: [quoteId],
  })).rows[0]
  if (!quote) {
    throw notFoundError("Public pirate name quote not found")
  }

  const existingForQuote = await loadRegistrationForQuote(input.client, quoteId)
  if (existingForQuote) {
    return serializeRegistration(existingForQuote)
  }
  const quoteStatus = requiredString(quote, "status")
  if (quoteStatus === "expired") {
    throw eligibilityFailed("Public pirate name quote has expired")
  }
  if (quoteStatus !== "quoted") {
    throw eligibilityFailed("Public pirate name quote is no longer claimable")
  }
  if (Date.parse(requiredString(quote, "expires_at")) <= Date.parse(checkedAt)) {
    throw eligibilityFailed("Public pirate name quote has expired")
  }

  await verifyPirateCheckoutUsdcFunding({
    env: input.env,
    quoteId,
    amountUsd: requiredNumber(quote, "price_cents") / 100,
    buyerAddress: requiredString(quote, "buyer_wallet_address_normalized"),
    fundingTxRef,
    fundingDestinationAddress: resolvePirateCheckoutOperatorAddress(input.env),
    sourceChainJson: buildSourceChainJson(input.env),
  })

  // Single-use funding tx: reject a payment already consumed by a DIFFERENT claimed
  // quote. This flow is unauthenticated and the name price is per-label-length, so
  // without this one on-chain payment could register unlimited same-length names by
  // reusing the same funding_tx_ref across quotes. Migration 0124's partial-unique
  // index (pirate_name_quotes(funding_tx_ref) WHERE status='claimed') is the
  // race-safe backstop; this gives a clean error before the write.
  const priorFundingClaim = await input.client.execute({
    sql: `
      SELECT pirate_name_quote_id
      FROM pirate_name_quotes
      WHERE funding_tx_ref = ?1 AND status = 'claimed' AND pirate_name_quote_id <> ?2
      LIMIT 1
    `,
    args: [fundingTxRef, quoteId],
  })
  if (priorFundingClaim.rows.length > 0) {
    throw eligibilityFailed("Funding transaction has already been used to claim a name")
  }

  const tx = await input.client.transaction("write")
  let deferredEligibilityError: Error | null = null
  let createdRegistration: QueryResultRow | null = null
  try {
    const latestQuote = (await tx.execute({
      sql: `
        SELECT *
        FROM pirate_name_quotes
        WHERE pirate_name_quote_id = ?1
        LIMIT 1
      `,
      args: [quoteId],
    })).rows[0]
    if (!latestQuote || requiredString(latestQuote, "status") !== "quoted") {
      const existing = await loadRegistrationForQuote(tx, quoteId)
      if (existing) {
        await tx.commit()
        return serializeRegistration(existing)
      }
      throw eligibilityFailed("Public pirate name quote is no longer claimable")
    }

    const now = nowIso()
    if (Date.parse(requiredString(latestQuote, "expires_at")) <= Date.parse(now)) {
      await tx.execute({
        sql: `
          UPDATE pirate_name_quotes
          SET status = 'expired',
              updated_at = ?2
          WHERE pirate_name_quote_id = ?1
        `,
        args: [quoteId, now],
      })
      deferredEligibilityError = eligibilityFailed("Public pirate name quote has expired")
    } else {
      const labelNormalized = requiredString(latestQuote, "label_normalized")
      const currentPrice = resolveGlobalHandlePaidPrice({ labelNormalized })
      if (
        !currentPrice.eligible
        || currentPrice.priceCents !== requiredNumber(latestQuote, "price_cents")
        || currentPrice.policyVersion !== requiredString(latestQuote, "policy_version")
      ) {
        await tx.execute({
          sql: `
            UPDATE pirate_name_quotes
            SET status = 'failed',
                updated_at = ?2
            WHERE pirate_name_quote_id = ?1
          `,
          args: [quoteId, now],
        })
        deferredEligibilityError = eligibilityFailed("Public pirate name quote is no longer claimable under the current pricing policy")
      } else {
        const gatedUpdate = await tx.execute({
          sql: `
            UPDATE pirate_name_quotes
            SET status = 'claimed',
                funding_tx_ref = ?2,
                settlement_tx_ref = ?2,
                claimed_at = ?3,
                updated_at = ?3
            WHERE pirate_name_quote_id = ?1
              AND status = 'quoted'
          `,
          args: [quoteId, fundingTxRef, now],
        })
        if (gatedUpdate.rowsAffected === 0) {
          const existing = await loadRegistrationForQuote(tx, quoteId)
          if (existing) {
            await tx.commit()
            return serializeRegistration(existing)
          }
          throw eligibilityFailed("Public pirate name quote is no longer claimable")
        }

        if (await activeGlobalHandleExists(tx, labelNormalized)) {
          throw conflictError("Desired label is unavailable")
        }
        const existingActiveRegistration = await activePublicRegistrationRow(tx, labelNormalized)
        if (existingActiveRegistration) {
          throw conflictError("Desired label is unavailable")
        }

        const registrationId = makeId(PUBLIC_PIRATE_NAME_REGISTRATION_PREFIX)
        await tx.execute({
          sql: `
            INSERT INTO pirate_name_registrations (
              pirate_name_registration_id, pirate_name_quote_id,
              label_normalized, label_display, status,
              owner_kind, owner_wallet_address_normalized, chain_ref,
              price_paid_cents, currency, issued_at, expires_at,
              pirate_user_id, created_at, updated_at
            ) VALUES (
              ?1, ?2,
              ?3, ?4, 'active',
              'wallet', ?5, ?6,
              ?7, 'USD', ?8, NULL,
              NULL, ?8, ?8
            )
          `,
          args: [
            registrationId,
            quoteId,
            labelNormalized,
            requiredString(latestQuote, "label_display"),
            requiredString(latestQuote, "buyer_wallet_address_normalized"),
            requiredString(latestQuote, "chain_ref"),
            requiredNumber(latestQuote, "price_cents"),
            now,
          ],
        })

        createdRegistration = await loadRegistrationForQuote(tx, quoteId)
        if (!createdRegistration) {
          throw internalError("Created public pirate name registration row is missing")
        }
      }
    }

    await tx.commit()
  } catch (error) {
    await safeRollback(tx, "[public-names] rollback failed while claiming public pirate name")
    if (
      hasUniqueConstraintField(error, "pirate_name_registrations.label_normalized")
      || hasUniqueConstraintField(error, "pirate_name_quotes.label_normalized")
    ) {
      throw conflictError("Desired label is unavailable")
    }
    throw error
  } finally {
    tx.close()
  }

  if (deferredEligibilityError) {
    throw deferredEligibilityError
  }
  if (!createdRegistration) {
    throw internalError("Created public pirate name registration row is missing")
  }
  return serializeRegistration(createdRegistration)
}

export async function getPublicPirateNameStatus(input: {
  client: Client
  label: string
}): Promise<PublicPirateNameStatusResponse> {
  const desired = normalizeDesiredGlobalHandleLabel(input.label)
  const registration = await activePublicRegistrationRow(input.client, desired.labelNormalized)
  if (registration) {
    return {
      label: desired.labelDisplay,
      label_normalized: desired.labelNormalized,
      status: "registered",
      registration: serializeRegistration(registration).registration,
    }
  }
  if (await activeGlobalHandleExists(input.client, desired.labelNormalized)) {
    return {
      label: desired.labelDisplay,
      label_normalized: desired.labelNormalized,
      status: "taken",
      owner_kind: "user",
    }
  }
  return {
    label: desired.labelDisplay,
    label_normalized: desired.labelNormalized,
    status: "available",
  }
}
