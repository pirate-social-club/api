import { openCommunityDb } from "../../community-db-factory"
import { getAssetRow, getListingRowById } from "../queries"
import { listActiveWalletAttachmentRows } from "../../../auth/auth-db-user-queries"
import { createPublicCommunityPurchaseQuote } from "../quote-service"
import { decodePublicListingId } from "../../../public-ids"
import type { Env } from "../../../../env"
import type { DbExecutor } from "../../../db-helpers"
import type { CommunityDatabaseBindingRepository } from "../../db-community-repository"
import type { PurchaseProposalDeps } from "./purchase-proposal"
import type { CreatePublicQuoteFn } from "./real-quote"
import {
  buildPurchaseProposalDeps,
  type PurchaseProposalLowLevelDeps,
} from "./purchase-proposal-deps"

// Real low-level functions for the proposal deps. Kept here (heavy imports) so the assembly and
// its integration test stay free of the community-DB / auth / quote-service runtime graph.
const realLowLevel: PurchaseProposalLowLevelDeps = {
  openCommunityDb: (env, repo, communityId) => openCommunityDb(env, repo, communityId),
  // The LLM passes the PUBLIC listing id (from the read-only board/search tools); decode it to
  // the raw id. An un-decodable id resolves to nothing rather than throwing.
  getListingRowById: async (client, communityId, listingId) => {
    let rawId: string
    try {
      rawId = decodePublicListingId(listingId)
    } catch {
      return null
    }
    return getListingRowById(client as never, communityId, rawId)
  },
  getAssetDisplayTitle: async (client, communityId, assetId) => {
    const asset = await getAssetRow(client as never, communityId, assetId)
    return asset?.display_title ?? null
  },
  listActiveWalletAttachmentRows: (client, userId) => listActiveWalletAttachmentRows(client as never, userId),
  createPublicCommunityPurchaseQuote,
}

export function realPurchaseProposalDeps(ctx: {
  env: Env
  controlPlaneClient: DbExecutor
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: Parameters<CreatePublicQuoteFn>[0]["userRepository"]
  now: string
}): PurchaseProposalDeps {
  return buildPurchaseProposalDeps(ctx, realLowLevel)
}
