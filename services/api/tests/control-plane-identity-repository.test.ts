import { afterEach, describe, expect, test } from "bun:test"
import { ControlPlaneIdentityRepository } from "../src/lib/auth/control-plane-identity-repository"
import { createControlPlaneTestClient } from "./helpers"

const WALLET_A = "0x1111111111111111111111111111111111111111"
const WALLET_B = "0x2222222222222222222222222222222222222222"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("control-plane identity repository", () => {
  test("jwt identities create users with empty wallet attachments", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const repo = new ControlPlaneIdentityRepository(setup.client)

    const session = await repo.exchangeIdentity({
      provider: "jwt",
      providerSubject: "pirate-dev|jwt-user",
      providerUserRef: "jwt-user",
      walletAddresses: [],
      selectedWalletAddress: null,
    })

    expect(session.user.primary_wallet_attachment_id).toBeNull()
    expect(session.wallet_attachments).toEqual([])
  }, 10_000)

  test("privy identities persist wallet attachments and can switch the primary wallet", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const repo = new ControlPlaneIdentityRepository(setup.client)

    const first = await repo.exchangeIdentity({
      provider: "privy",
      providerSubject: "did:privy:alice",
      providerUserRef: "did:privy:alice",
      walletAddresses: [WALLET_A, WALLET_B],
      selectedWalletAddress: WALLET_A,
    })

    expect(first.wallet_attachments).toHaveLength(2)
    expect(first.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_address).toBe(WALLET_A)
    expect(first.user.primary_wallet_attachment_id).toBe(first.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_attachment_id)

    const second = await repo.exchangeIdentity({
      provider: "privy",
      providerSubject: "did:privy:alice",
      providerUserRef: "did:privy:alice",
      walletAddresses: [WALLET_A, WALLET_B],
      selectedWalletAddress: WALLET_B,
    })

    expect(second.user.user_id).toBe(first.user.user_id)
    expect(second.wallet_attachments).toHaveLength(2)
    expect(second.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_address).toBe(WALLET_B)
    expect(second.user.primary_wallet_attachment_id).toBe(second.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_attachment_id)
  }, 10_000)
})
