import { getAddress } from "ethers"

export type BuyerIdentity =
  | { kind: "user"; userId: string }
  | { kind: "wallet"; chainRef: string; walletAddress: string; walletAddressNormalized: string }

export type WalletBuyerIdentity = Extract<BuyerIdentity, { kind: "wallet" }>

export type BuyerIdentityFields = {
  buyer_kind: BuyerIdentity["kind"]
  buyer_user_id: string | null
  buyer_wallet_address: string | null
  buyer_wallet_address_normalized: string | null
  buyer_chain_ref: string | null
}

export function userBuyer(userId: string): BuyerIdentity {
  return { kind: "user", userId }
}

export function walletBuyer(input: {
  chainRef?: string | null
  walletAddress: string
}): WalletBuyerIdentity {
  const walletAddress = getAddress(input.walletAddress)
  return {
    kind: "wallet",
    chainRef: input.chainRef?.trim() || "eip155",
    walletAddress,
    walletAddressNormalized: walletAddress.toLowerCase(),
  }
}

export function buyerIdentityFields(buyer: BuyerIdentity): BuyerIdentityFields {
  if (buyer.kind === "user") {
    return {
      buyer_kind: "user",
      buyer_user_id: buyer.userId,
      buyer_wallet_address: null,
      buyer_wallet_address_normalized: null,
      buyer_chain_ref: null,
    }
  }
  return {
    buyer_kind: "wallet",
    buyer_user_id: null,
    buyer_wallet_address: buyer.walletAddress,
    buyer_wallet_address_normalized: buyer.walletAddressNormalized,
    buyer_chain_ref: buyer.chainRef,
  }
}

export function buyerMatchesFields(
  buyer: BuyerIdentity,
  fields: BuyerIdentityFields,
): boolean {
  if (buyer.kind !== fields.buyer_kind) {
    return false
  }
  if (buyer.kind === "user") {
    return fields.buyer_user_id === buyer.userId
  }
  return fields.buyer_chain_ref === buyer.chainRef
    && fields.buyer_wallet_address_normalized === buyer.walletAddressNormalized
}

export function requireUserBuyerId(fields: BuyerIdentityFields): string {
  if (fields.buyer_kind !== "user" || !fields.buyer_user_id?.trim()) {
    throw new Error("User buyer is required")
  }
  return fields.buyer_user_id
}

export function requireWalletBuyerIdentity(fields: BuyerIdentityFields): WalletBuyerIdentity {
  if (
    fields.buyer_kind !== "wallet"
    || !fields.buyer_wallet_address?.trim()
    || !fields.buyer_wallet_address_normalized?.trim()
    || !fields.buyer_chain_ref?.trim()
  ) {
    throw new Error("Wallet buyer is required")
  }
  return walletBuyer({
    chainRef: fields.buyer_chain_ref,
    walletAddress: fields.buyer_wallet_address,
  })
}
