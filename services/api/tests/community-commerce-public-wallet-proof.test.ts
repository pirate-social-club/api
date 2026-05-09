import { describe, expect, test } from "bun:test"
import { Wallet } from "ethers"
import {
  publicAssetAccessMessage,
  publicPurchaseQuoteMessage,
  verifyPublicAssetAccessWalletProof,
  verifyPublicPurchaseQuoteWalletProof,
} from "../src/lib/communities/commerce/public-wallet-proof"

describe("public community purchase wallet proof", () => {
  test("verifies a quote-bound EVM wallet signature", async () => {
    const wallet = Wallet.createRandom()
    const issuedAt = Math.floor(Date.now() / 1000)
    const message = publicPurchaseQuoteMessage({
      communityId: "cmt_test",
      listing: "lst_listing",
      walletAddress: wallet.address,
      chainRef: "eip155",
      nonce: "nonce-public-quote-1",
      issuedAt,
    })
    const signature = await wallet.signMessage(message)

    const buyer = verifyPublicPurchaseQuoteWalletProof({
      communityId: "cmt_test",
      listing: "lst_listing",
      proof: {
        wallet_address: wallet.address,
        chain_ref: "eip155",
        nonce: "nonce-public-quote-1",
        issued_at: issuedAt,
        signature,
      },
      nowMs: issuedAt * 1000,
    })

    expect(buyer.kind).toBe("wallet")
    expect(buyer.walletAddress).toBe(wallet.address)
    expect(buyer.walletAddressNormalized).toBe(wallet.address.toLowerCase())
  })

  test("rejects a signature bound to a different listing", async () => {
    const wallet = Wallet.createRandom()
    const issuedAt = Math.floor(Date.now() / 1000)
    const signature = await wallet.signMessage(publicPurchaseQuoteMessage({
      communityId: "cmt_test",
      listing: "lst_listing_a",
      walletAddress: wallet.address,
      chainRef: "eip155",
      nonce: "nonce-public-quote-2",
      issuedAt,
    }))

    expect(() => verifyPublicPurchaseQuoteWalletProof({
      communityId: "cmt_test",
      listing: "lst_listing_b",
      proof: {
        wallet_address: wallet.address,
        chain_ref: "eip155",
        nonce: "nonce-public-quote-2",
        issued_at: issuedAt,
        signature,
      },
      nowMs: issuedAt * 1000,
    })).toThrow("wallet_proof signature does not match wallet")
  })

  test("verifies an asset-access-bound EVM wallet signature", async () => {
    const wallet = Wallet.createRandom()
    const issuedAt = Math.floor(Date.now() / 1000)
    const message = publicAssetAccessMessage({
      communityId: "cmt_test",
      asset: "asset_locked",
      walletAddress: wallet.address,
      chainRef: "eip155",
      nonce: "nonce-public-access-1",
      issuedAt,
    })
    const signature = await wallet.signMessage(message)

    const buyer = verifyPublicAssetAccessWalletProof({
      communityId: "cmt_test",
      asset: "asset_locked",
      proof: {
        wallet_address: wallet.address,
        chain_ref: "eip155",
        nonce: "nonce-public-access-1",
        issued_at: issuedAt,
        signature,
      },
      nowMs: issuedAt * 1000,
    })

    expect(buyer.kind).toBe("wallet")
    expect(buyer.walletAddress).toBe(wallet.address)
  })
})
