import { getAddress, verifyMessage } from "ethers"
import { badRequestError } from "../../errors"
import { publicCommunityId } from "../../public-ids"
import { walletBuyer, type WalletBuyerIdentity } from "./buyer-identity"

const PUBLIC_PURCHASE_QUOTE_PURPOSE = "public_community_purchase_quote"
const PUBLIC_ASSET_ACCESS_PURPOSE = "public_community_asset_access"
const MAX_WALLET_PROOF_AGE_MS = 10 * 60 * 1000

export type PublicWalletProof = {
  wallet_address: string
  chain_ref?: string | null
  nonce: string
  issued_at: number
  signature: string
}

function requireNonce(value: string): string {
  const nonce = value.trim()
  if (nonce.length < 8 || nonce.length > 128 || /[\s\u0000-\u001f\u007f]/u.test(nonce)) {
    throw badRequestError("wallet_proof nonce is invalid")
  }
  return nonce
}

export function publicPurchaseQuoteMessage(input: {
  communityId: string
  listing: string
  walletAddress: string
  chainRef: string
  nonce: string
  issuedAt: number
}): string {
  return [
    "Pirate public community purchase quote",
    `purpose: ${PUBLIC_PURCHASE_QUOTE_PURPOSE}`,
    `community: ${publicCommunityId(input.communityId)}`,
    `listing: ${input.listing}`,
    `wallet: ${input.chainRef}:${input.walletAddress.toLowerCase()}`,
    `nonce: ${input.nonce}`,
    `issued_at: ${input.issuedAt}`,
  ].join("\n")
}

export function publicAssetAccessMessage(input: {
  communityId: string
  asset: string
  walletAddress: string
  chainRef: string
  nonce: string
  issuedAt: number
}): string {
  return [
    "Pirate public community asset access",
    `purpose: ${PUBLIC_ASSET_ACCESS_PURPOSE}`,
    `community: ${publicCommunityId(input.communityId)}`,
    `asset: ${input.asset}`,
    `wallet: ${input.chainRef}:${input.walletAddress.toLowerCase()}`,
    `nonce: ${input.nonce}`,
    `issued_at: ${input.issuedAt}`,
  ].join("\n")
}

function verifyPublicWalletProof(input: {
  proof: PublicWalletProof
  message: (input: {
    walletAddress: string
    chainRef: string
    nonce: string
    issuedAt: number
  }) => string
  nowMs?: number
}): WalletBuyerIdentity {
  const chainRef = input.proof.chain_ref?.trim() || "eip155"
  if (chainRef !== "eip155" && !chainRef.startsWith("eip155:")) {
    throw badRequestError("wallet_proof chain_ref is unsupported")
  }
  let walletAddress: string
  try {
    walletAddress = getAddress(input.proof.wallet_address)
  } catch {
    throw badRequestError("wallet_proof wallet_address is invalid")
  }
  const issuedAt = Number(input.proof.issued_at)
  const nowMs = input.nowMs ?? Date.now()
  if (!Number.isFinite(issuedAt) || issuedAt <= 0) {
    throw badRequestError("wallet_proof issued_at is invalid")
  }
  const issuedAtMs = issuedAt * 1000
  if (issuedAtMs > nowMs + 60_000 || nowMs - issuedAtMs > MAX_WALLET_PROOF_AGE_MS) {
    throw badRequestError("wallet_proof is expired")
  }
  const nonce = requireNonce(input.proof.nonce)
  const message = input.message({ walletAddress, chainRef, nonce, issuedAt })
  let recovered: string
  try {
    recovered = verifyMessage(message, input.proof.signature)
  } catch {
    throw badRequestError("wallet_proof signature is invalid")
  }
  if (getAddress(recovered) !== walletAddress) {
    throw badRequestError("wallet_proof signature does not match wallet")
  }
  return walletBuyer({ chainRef, walletAddress })
}

export function verifyPublicPurchaseQuoteWalletProof(input: {
  communityId: string
  listing: string
  proof: PublicWalletProof
  nowMs?: number
}): WalletBuyerIdentity {
  return verifyPublicWalletProof({
    proof: input.proof,
    nowMs: input.nowMs,
    message: ({ walletAddress, chainRef, nonce, issuedAt }) => publicPurchaseQuoteMessage({
      communityId: input.communityId,
      listing: input.listing,
      walletAddress,
      chainRef,
      nonce,
      issuedAt,
    }),
  })
}

export function verifyPublicAssetAccessWalletProof(input: {
  communityId: string
  asset: string
  proof: PublicWalletProof
  nowMs?: number
}): WalletBuyerIdentity {
  return verifyPublicWalletProof({
    proof: input.proof,
    nowMs: input.nowMs,
    message: ({ walletAddress, chainRef, nonce, issuedAt }) => publicAssetAccessMessage({
      communityId: input.communityId,
      asset: input.asset,
      walletAddress,
      chainRef,
      nonce,
      issuedAt,
    }),
  })
}
