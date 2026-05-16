import type { CommunityPurchaseSettlement } from "../../../types"
import type {
  PurchaseAllocationLegRow,
  PurchaseEntitlementRow,
  PurchaseQuoteRow,
  PurchaseRow,
} from "./row-types"
import { serializeSettlement } from "./quote-helpers"

export type PublicCommunityPurchaseSettlement = Omit<
  CommunityPurchaseSettlement,
  "buyer_user" | "settlement_wallet_attachment"
> & {
  buyer_kind: "wallet"
  buyer_wallet: {
    chain_ref: string
    address: string
  }
  settlement_wallet_attachment: null
}

export function serializeSettlementForBuyer(
  purchase: PurchaseRow,
  entitlement: PurchaseEntitlementRow,
  quote: PurchaseQuoteRow,
  allocations: PurchaseAllocationLegRow[],
): CommunityPurchaseSettlement | PublicCommunityPurchaseSettlement {
  if (purchase.buyer_kind === "wallet") {
    return serializePublicSettlement(purchase, entitlement, quote, allocations)
  }
  return serializeSettlement(purchase, entitlement, quote, allocations)
}

function serializePublicSettlement(
  purchase: PurchaseRow,
  entitlement: PurchaseEntitlementRow,
  quote: PurchaseQuoteRow,
  allocations: PurchaseAllocationLegRow[],
): PublicCommunityPurchaseSettlement {
  const serialized = serializeSettlement({
    ...purchase,
    buyer_kind: "user",
    buyer_user_id: "public-wallet-buyer",
  }, entitlement, quote, allocations)
  const {
    buyer_user: _buyerUser,
    settlement_wallet_attachment: _settlementWalletAttachment,
    ...rest
  } = serialized
  return {
    ...rest,
    buyer_kind: "wallet",
    buyer_wallet: {
      chain_ref: purchase.buyer_chain_ref ?? "eip155",
      address: purchase.buyer_wallet_address ?? "",
    },
    settlement_wallet_attachment: null,
  }
}
