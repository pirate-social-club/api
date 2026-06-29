import type { DbExecutor } from "../../../db-helpers"
import type { Env } from "../../../../env"
import type { CommunityDatabaseBindingRepository } from "../../db-community-repository"
import type { PurchaseProposalDeps } from "./purchase-proposal"
import { resolveListingForReference, resolvePrimaryEvmWalletAddress, type ListingLookupRow, type WalletAttachmentLookupRow } from "./real-resolvers"
import { createWalletBoundRoutedQuote, type CreatePublicQuoteFn } from "./real-quote"
import { insertProposedSpendIntent } from "./proposed-intent"

// Low-level functions the assembly wires the four real deps onto. They are injected so the
// assembly stays light (no community-DB/auth/quote-service runtime graph here) and the assembled
// graph is integration-testable. The real composition (purchase-proposal-real-deps.ts) supplies
// the concrete functions.
export type PurchaseProposalLowLevelDeps = {
  openCommunityDb: (
    env: Env,
    repo: CommunityDatabaseBindingRepository,
    communityId: string,
  ) => Promise<{ client: DbExecutor; close: () => void }>
  getListingRowById: (client: DbExecutor, communityId: string, listingId: string) => Promise<ListingLookupRow | null>
  getAssetDisplayTitle: (client: DbExecutor, communityId: string, assetId: string) => Promise<string | null>
  listActiveWalletAttachmentRows: (client: DbExecutor, userId: string) => Promise<WalletAttachmentLookupRow[]>
  createPublicCommunityPurchaseQuote: CreatePublicQuoteFn
}

export function buildPurchaseProposalDeps(
  ctx: {
    env: Env
    controlPlaneClient: DbExecutor
    communityRepository: CommunityDatabaseBindingRepository
    userRepository: Parameters<CreatePublicQuoteFn>[0]["userRepository"]
    now: string
  },
  lowLevel: PurchaseProposalLowLevelDeps,
): PurchaseProposalDeps {
  return {
    // Listing lookup runs against the COMMUNITY DB.
    resolveListing: async ({ communityId, reference }) => {
      const db = await lowLevel.openCommunityDb(ctx.env, ctx.communityRepository, communityId)
      try {
        return await resolveListingForReference(
          { client: db.client, communityId, reference },
          { getListingRowById: lowLevel.getListingRowById, getAssetDisplayTitle: lowLevel.getAssetDisplayTitle },
        )
      } finally {
        db.close()
      }
    },
    // Wallet lookup runs against CONTROL-PLANE (wallet_attachments), keyed by Pirate user_id.
    resolveBuyerWalletAddress: async ({ userId }) =>
      resolvePrimaryEvmWalletAddress(
        { client: ctx.controlPlaneClient, userId },
        { listActiveWalletAttachmentRows: lowLevel.listActiveWalletAttachmentRows },
      ),
    createWalletBoundQuote: async ({ communityId, listing, buyerWalletAddress }) =>
      createWalletBoundRoutedQuote(
        {
          env: ctx.env,
          communityId,
          communityRepository: ctx.communityRepository,
          userRepository: ctx.userRepository,
          listing,
          buyerWalletAddress,
        },
        { createPublicCommunityPurchaseQuote: lowLevel.createPublicCommunityPurchaseQuote },
      ),
    // Proposed intent is written to CONTROL-PLANE.
    createProposedSpendIntent: async ({ telegramUserId, userId, communityId, listing, buyerWalletAddress, quoteId, reservationExpiresAt }) =>
      insertProposedSpendIntent({
        client: ctx.controlPlaneClient,
        telegramUserId,
        userId,
        communityId,
        listing,
        buyerWalletAddress,
        quoteId,
        reservationExpiresAt,
        now: ctx.now,
      }),
  }
}
