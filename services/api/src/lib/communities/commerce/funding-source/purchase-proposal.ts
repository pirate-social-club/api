import type { Env } from "../../../../env"
import { badRequestError } from "../../../errors"
import type { CommunityAssistantToolDefinition } from "../../assistant-policy/assistant-tools"

// The AI structured-intent boundary. The LLM supplies only a fuzzy REFERENCE; the server resolves
// the concrete listing + price and creates a PROPOSAL. The LLM never controls the binding (asset
// id / price) and the result never claims money moved or a purchase completed. Actual spending
// happens later, gated by wallet approval + on-chain funding confirmation.

// What the LLM provides — a hint to resolve, never the binding itself.
export type PurchaseReference =
  | { kind: "listing_id"; listingId: string }
  | { kind: "query"; query: string }

export type ResolvedListing = {
  listingId: string
  assetId: string
  title: string
  priceUsd: number
}

// Resolution succeeds with exactly one listing, is ambiguous (must NOT guess), or finds nothing.
export type ListingResolution =
  | { kind: "resolved"; listing: ResolvedListing }
  | { kind: "ambiguous"; candidates: Array<{ listingId: string; title: string }> }
  | { kind: "not_found" }

export type PurchaseProposalDeps = {
  resolveListing: (input: {
    communityId: string
    reference: PurchaseReference
  }) => Promise<ListingResolution>
  // Wallet lookup uses the canonical Pirate user_id, not the Telegram id (different concerns).
  resolveBuyerWalletAddress: (input: {
    userId: string
    communityId: string
  }) => Promise<string | null>
  createWalletBoundQuote: (input: {
    communityId: string
    listing: ResolvedListing
    buyerWalletAddress: string
  }) => Promise<{ quoteId: string; finalPriceUsd: number; expiresAt: string }>
  createProposedSpendIntent: (input: {
    telegramUserId: string
    userId: string
    communityId: string
    listing: ResolvedListing
    buyerWalletAddress: string
    quoteId: string
    reservationExpiresAt: string
  }) => Promise<{ spendIntentId: string }>
}

// Deliberately a PROPOSAL: it never claims money moved or a purchase completed. The assistant must
// present it as "confirm in your wallet", never "bought"/"paid"/"unlocked".
export type PurchaseProposal =
  | {
      outcome: "proposed"
      spendIntentId: string
      title: string
      priceUsd: number
      fundingProvider: "pirate_checkout"
      reservationExpiresAt: string
      purchaseComplete: false
      fundsMoved: false
    }
  | { outcome: "needs_disambiguation"; candidates: Array<{ listingId: string; title: string }> }
  | { outcome: "not_found" }

export async function proposeSongPurchase(
  input: {
    env: Env
    telegramUserId: string
    userId: string
    communityId: string
    reference: PurchaseReference
  },
  deps: PurchaseProposalDeps,
): Promise<PurchaseProposal> {
  // Server-side resolution. The LLM reference is a hint; the binding comes from here.
  const resolution = await deps.resolveListing({
    communityId: input.communityId,
    reference: input.reference,
  })
  if (resolution.kind === "not_found") {
    return { outcome: "not_found" }
  }
  if (resolution.kind === "ambiguous") {
    // NEVER guess which song — return candidates for the user to disambiguate. No intent created.
    return { outcome: "needs_disambiguation", candidates: resolution.candidates }
  }
  const listing = resolution.listing

  const buyerWalletAddress = await deps.resolveBuyerWalletAddress({
    userId: input.userId,
    communityId: input.communityId,
  })
  if (!buyerWalletAddress) {
    throw badRequestError("A connected wallet is required before proposing a purchase")
  }

  const quote = await deps.createWalletBoundQuote({
    communityId: input.communityId,
    listing,
    buyerWalletAddress,
  })

  const { spendIntentId } = await deps.createProposedSpendIntent({
    telegramUserId: input.telegramUserId,
    userId: input.userId,
    communityId: input.communityId,
    listing,
    buyerWalletAddress,
    quoteId: quote.quoteId,
    reservationExpiresAt: quote.expiresAt,
  })

  return {
    outcome: "proposed",
    spendIntentId,
    // Title and price come from the SERVER-resolved listing/quote, never from LLM-authored text.
    title: listing.title,
    priceUsd: quote.finalPriceUsd,
    fundingProvider: "pirate_checkout",
    reservationExpiresAt: quote.expiresAt,
    purchaseComplete: false,
    fundsMoved: false,
  }
}

// Convert raw LLM tool arguments into a PurchaseReference. Prefer an exact listing_id over a
// free-text query when both are present.
export function parsePurchaseReferenceFromToolArgs(args: unknown): PurchaseReference {
  const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {}
  const listingId = typeof a.listing_id === "string" ? a.listing_id.trim() : ""
  const query = typeof a.query === "string" ? a.query.trim() : ""
  if (listingId) {
    return { kind: "listing_id", listingId }
  }
  if (query) {
    return { kind: "query", query }
  }
  throw badRequestError("propose_song_purchase requires a listing_id or a query")
}

export type PurchaseProposalToolContext = {
  env: Env
  // Telegram identity (binds the intent) and the canonical Pirate user id (wallet lookup). Both
  // are required to propose; the Telegram->user mapping happens upstream of these deps.
  telegramUserId: string | null
  userId: string | null
  communityId: string
}

// Adapter: an LLM `propose_song_purchase` tool call -> server-resolved proposal -> a constrained
// assistant_tool_result object. The result NEVER implies a completed purchase, and it carries an
// explicit directive constraining the assistant's language to proposal/payment states only.
// `toolArgs` is the already-parsed tool-call arguments object.
export async function buildPurchaseProposalToolResult(
  toolArgs: unknown,
  context: PurchaseProposalToolContext,
  deps: PurchaseProposalDeps,
): Promise<Record<string, unknown>> {
  const base = { object: "assistant_tool_result", tool: "propose_song_purchase" as const }

  if (!context.telegramUserId || !context.userId) {
    return {
      ...base,
      status: "unavailable",
      message: "Purchases are only available in a private chat where the user is identified (Telegram and account).",
    }
  }

  let reference: PurchaseReference
  try {
    reference = parsePurchaseReferenceFromToolArgs(toolArgs)
  } catch {
    return { ...base, status: "needs_reference", message: "Ask the user which song they mean (a title, artist, or listing)." }
  }

  const proposal = await proposeSongPurchase(
    {
      env: context.env,
      telegramUserId: context.telegramUserId,
      userId: context.userId,
      communityId: context.communityId,
      reference,
    },
    deps,
  )

  if (proposal.outcome === "not_found") {
    return { ...base, status: "not_found", message: "No matching song was found in this community." }
  }
  if (proposal.outcome === "needs_disambiguation") {
    return { ...base, status: "needs_disambiguation", candidates: proposal.candidates, message: "Multiple matches — ask the user which one they mean." }
  }

  return {
    ...base,
    status: "proposed",
    spend_intent_id: proposal.spendIntentId,
    title: proposal.title,
    price_usd: proposal.priceUsd,
    funding_provider: proposal.fundingProvider,
    reservation_expires_at: proposal.reservationExpiresAt,
    purchase_complete: false,
    funds_moved: false,
    // Hard language constraint for the assistant.
    assistant_directive:
      "Present this strictly as a PROPOSAL the user must confirm and pay for in their own wallet. Nothing has happened yet. Do NOT claim the song was bought, paid, purchased, unlocked, or that royalties were paid — only describe the proposed item and price and that the user must approve payment.",
  }
}

// Tool definition for the community assistant's tool-calling loop. The description constrains the
// LLM to PROPOSE, not claim completion.
export const PROPOSE_SONG_PURCHASE_TOOL: CommunityAssistantToolDefinition = {
  type: "function",
  function: {
    name: "propose_song_purchase",
    description:
      "Prepare a purchase proposal for a song the user wants, for them to confirm and pay in their own wallet. " +
      "This does NOT buy anything, move money, or complete a purchase — it only resolves which song they mean and prepares a priced confirmation. " +
      "Never tell the user the purchase is done, paid, or unlocked. If the reference is ambiguous the tool returns candidates — ask the user which one. " +
      "Provide either a known listing_id or a short search query describing the song.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        listing_id: { type: "string", description: "The exact listing id, if known." },
        query: {
          type: "string",
          description: "A short description of the song to resolve (title, artist, or lyric).",
        },
      },
      required: [],
    },
  },
}
