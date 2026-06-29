import { executeFirst, type DbExecutor } from "../../../db-helpers"
import { makeId } from "../../../helpers"
import { requiredString } from "../../../sql-row"
import type { ResolvedListing } from "./purchase-proposal"

// Create (idempotently) a `proposed` spend intent for an AI purchase proposal, in control-plane.
// Idempotent on (telegram_user, quote): re-proposing the same quote returns the existing intent
// rather than creating a duplicate. Pre-money — the intent only becomes fundable after the user
// accepts (proposed -> funding_pending) and the provider is chosen then, so it is left null here.
export async function insertProposedSpendIntent(input: {
  client: DbExecutor
  telegramUserId: string
  userId?: string | null
  communityId: string
  listing: ResolvedListing
  buyerWalletAddress: string
  quoteId: string
  reservationExpiresAt: string
  now: string
}): Promise<{ spendIntentId: string }> {
  const idempotencyKey = `propose:${input.telegramUserId}:${input.quoteId}`

  const existing = await executeFirst(input.client, {
    sql: `SELECT spend_intent_id FROM spend_intents WHERE idempotency_key = ?1 LIMIT 1`,
    args: [idempotencyKey],
  })
  if (existing) {
    return { spendIntentId: requiredString(existing, "spend_intent_id") }
  }

  const spendIntentId = makeId("spi")
  try {
    await input.client.execute({
      sql: `
        INSERT INTO spend_intents (
          spend_intent_id, telegram_user_id, user_id, community_id, listing_id, asset_id,
          quote_id, buyer_address, price_reservation_expires_at, status, idempotency_key,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'proposed', ?10, ?11, ?11
        )
      `,
      args: [
        spendIntentId,
        input.telegramUserId,
        input.userId ?? null,
        input.communityId,
        input.listing.listingId,
        input.listing.assetId,
        input.quoteId,
        input.buyerWalletAddress,
        input.reservationExpiresAt,
        idempotencyKey,
        input.now,
      ],
    })
  } catch (error) {
    // Lost a race to a concurrent identical proposal — return the one that won.
    const raced = await executeFirst(input.client, {
      sql: `SELECT spend_intent_id FROM spend_intents WHERE idempotency_key = ?1 LIMIT 1`,
      args: [idempotencyKey],
    })
    if (raced) {
      return { spendIntentId: requiredString(raced, "spend_intent_id") }
    }
    throw error
  }
  return { spendIntentId }
}

// Telegram Wallet Step 1: create a pre-money, Telegram-bound proposal without a Pirate user,
// EVM buyer address, or community quote. This is safe only for gated simulation funding paths;
// pirate_checkout settlement still requires a wallet-bound quote + buyer_address later.
export async function insertTelegramOnlyProposedSpendIntent(input: {
  client: DbExecutor
  telegramUserId: string
  communityId: string
  listing: ResolvedListing
  reservationExpiresAt: string
  idempotencyKey: string
  now: string
}): Promise<{ spendIntentId: string }> {
  const idempotencyKey = `telegram-propose:${input.telegramUserId}:${input.idempotencyKey}`

  const existing = await executeFirst(input.client, {
    sql: `SELECT spend_intent_id FROM spend_intents WHERE idempotency_key = ?1 LIMIT 1`,
    args: [idempotencyKey],
  })
  if (existing) {
    return { spendIntentId: requiredString(existing, "spend_intent_id") }
  }

  const spendIntentId = makeId("spi")
  try {
    await input.client.execute({
      sql: `
        INSERT INTO spend_intents (
          spend_intent_id, telegram_user_id, user_id, community_id, listing_id, asset_id,
          quote_id, buyer_address, price_reservation_expires_at, status, idempotency_key,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, NULL, ?3, ?4, ?5, NULL, NULL, ?6, 'proposed', ?7, ?8, ?8
        )
      `,
      args: [
        spendIntentId,
        input.telegramUserId,
        input.communityId,
        input.listing.listingId,
        input.listing.assetId,
        input.reservationExpiresAt,
        idempotencyKey,
        input.now,
      ],
    })
  } catch (error) {
    const raced = await executeFirst(input.client, {
      sql: `SELECT spend_intent_id FROM spend_intents WHERE idempotency_key = ?1 LIMIT 1`,
      args: [idempotencyKey],
    })
    if (raced) {
      return { spendIntentId: requiredString(raced, "spend_intent_id") }
    }
    throw error
  }
  return { spendIntentId }
}
