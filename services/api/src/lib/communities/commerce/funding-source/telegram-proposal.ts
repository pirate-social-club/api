import { getControlPlaneClient, withRequestControlPlaneClients } from "../../../runtime-deps"
import type { Env } from "../../../../env"
import { badRequestError } from "../../../errors"
import { decodePublicListingId } from "../../../public-ids"
import type { Client } from "../../../sql-client"
import type { CommunityRepository } from "../../db-community-repository"
import { openCommunityDb } from "../../community-db-factory"
import { getAssetRow, getListingRowById } from "../queries"
import type { ResolvedListing } from "./purchase-proposal"
import { resolveListingForReference } from "./real-resolvers"
import { insertTelegramOnlyProposedSpendIntent } from "./proposed-intent"

const DEFAULT_TELEGRAM_INTENT_RESERVATION_MS = 30 * 60 * 1000

export type TelegramSpendIntentProposal = {
  spendIntentId: string
  status: "proposed"
  title: string
  priceUsd: number
  fundingProvider: "ton_testnet_transfer"
  reservationExpiresAt: string
  purchaseComplete: false
  fundsMoved: false
}

export type CreateTelegramSpendIntentProposalDeps = {
  getCommunityRepository: (env: Env) => CommunityRepository
  resolveCommunityId: (
    repo: CommunityRepository,
    identifier: string,
  ) => Promise<string | null>
  verifyMiniAppUser: (args: {
    env: Env
    communityId: string
    initData: string
  }) => Promise<{ id: string }> | { id: string }
  createProposal: (input: {
    env: Env
    communityRepository: CommunityRepository
    telegramUserId: string
    communityId: string
    listingId: string
    idempotencyKey: string
    now: string
  }) => Promise<TelegramSpendIntentProposal>
}

function bodyString(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === "string" ? body[key].trim() : ""
}

export async function handleCreateTelegramSpendIntentProposal(
  input: { env: Env; body: unknown; now: string },
  deps: CreateTelegramSpendIntentProposalDeps,
): Promise<TelegramSpendIntentProposal> {
  const body = input.body && typeof input.body === "object" ? (input.body as Record<string, unknown>) : {}
  const communityIdentifier = bodyString(body, "community_id")
  const initData = bodyString(body, "init_data")
  const listingId = bodyString(body, "listing_id")
  const idempotencyKey = bodyString(body, "idempotency_key")
  if (!communityIdentifier || !initData || !listingId || !idempotencyKey) {
    throw badRequestError("community_id, init_data, listing_id, and idempotency_key are required")
  }

  const communityRepository = deps.getCommunityRepository(input.env)
  const communityId = await deps.resolveCommunityId(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }
  const telegramUser = await deps.verifyMiniAppUser({
    env: input.env,
    communityId,
    initData,
  })

  return await deps.createProposal({
    env: input.env,
    communityRepository,
    telegramUserId: telegramUser.id,
    communityId,
    listingId,
    idempotencyKey,
    now: input.now,
  })
}

async function resolveTelegramListing(input: {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  listingId: string
}): Promise<ResolvedListing> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    let rawListingId: string
    try {
      rawListingId = decodePublicListingId(input.listingId)
    } catch {
      rawListingId = input.listingId
    }
    const resolution = await resolveListingForReference(
      { client: db.client, communityId: input.communityId, reference: { kind: "listing_id", listingId: rawListingId } },
      {
        getListingRowById: (client, communityId, listingId) => getListingRowById(client as never, communityId, listingId),
        getAssetDisplayTitle: async (client, communityId, assetId) => {
          const asset = await getAssetRow(client as never, communityId, assetId)
          return asset?.display_title ?? null
        },
      },
    )
    if (resolution.kind !== "resolved") {
      throw badRequestError("Listing was not found")
    }
    return resolution.listing
  } finally {
    db.close()
  }
}

export async function createTelegramSpendIntentProposal(input: {
  env: Env
  controlPlaneClient: Client
  communityRepository: CommunityRepository
  telegramUserId: string
  communityId: string
  listingId: string
  idempotencyKey: string
  now: string
}): Promise<TelegramSpendIntentProposal> {
  const listing = await resolveTelegramListing({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    listingId: input.listingId,
  })
  const reservationExpiresAt = new Date(Date.parse(input.now) + DEFAULT_TELEGRAM_INTENT_RESERVATION_MS).toISOString()
  const { spendIntentId } = await insertTelegramOnlyProposedSpendIntent({
    client: input.controlPlaneClient,
    telegramUserId: input.telegramUserId,
    communityId: input.communityId,
    listing,
    reservationExpiresAt,
    idempotencyKey: input.idempotencyKey,
    now: input.now,
  })
  return {
    spendIntentId,
    status: "proposed",
    title: listing.title,
    priceUsd: listing.priceUsd,
    fundingProvider: "ton_testnet_transfer",
    reservationExpiresAt,
    purchaseComplete: false,
    fundsMoved: false,
  }
}

export async function runCreateTelegramSpendIntentProposal(input: {
  env: Env
  communityRepository: CommunityRepository
  telegramUserId: string
  communityId: string
  listingId: string
  idempotencyKey: string
  now: string
}): Promise<TelegramSpendIntentProposal> {
  return await withRequestControlPlaneClients(async () => {
    const controlPlaneClient = getControlPlaneClient(input.env)
    return await createTelegramSpendIntentProposal({
      ...input,
      controlPlaneClient,
    })
  })
}
