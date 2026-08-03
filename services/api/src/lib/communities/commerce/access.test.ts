import { describe, expect, test } from "bun:test"
import type { Env } from "../../../env"
import type { User } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { resolvePrimaryWalletAddress } from "./access"

const OPERATOR_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const OPERATOR_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"

function fakeUserRepository(input: {
  walletAddress?: string
}): UserRepository {
  const user = { primary_wallet_attachment_id: null } as unknown as User
  return {
    async getUserById() {
      return user
    },
    async getWalletAttachmentsByUserId() {
      return input.walletAddress
        ? [{ wallet_attachment: "wal_test", wallet_address: input.walletAddress, is_primary: true }]
        : []
    },
  } as unknown as UserRepository
}

const envWithOperator = { STORY_OPERATOR_PRIVATE_KEY: OPERATOR_KEY } as Env

describe("resolvePrimaryWalletAddress", () => {
  test("returns the user's wallet address when one is attached", async () => {
    const address = await resolvePrimaryWalletAddress({
      env: {} as Env,
      userRepository: fakeUserRepository({ walletAddress: "0x7100000000000000000000000000000000000007" }),
      userId: "usr_wallet",
    })
    expect(address).toBe("0x7100000000000000000000000000000000000007")
  })

  test("fails closed when the user has no wallet and no opt-in is given", async () => {
    await expect(resolvePrimaryWalletAddress({
      env: envWithOperator,
      userRepository: fakeUserRepository({}),
      userId: "usr_nowallet",
    })).rejects.toThrow("Primary wallet is required")
  })

  test("fails closed when the opt-in is explicitly false", async () => {
    await expect(resolvePrimaryWalletAddress({
      env: envWithOperator,
      userRepository: fakeUserRepository({}),
      userId: "usr_nowallet",
      fallbackToRuntimeSigner: false,
    })).rejects.toThrow("Primary wallet is required")
  })

  test("substitutes the runtime signer only when the harness opts in", async () => {
    const address = await resolvePrimaryWalletAddress({
      env: envWithOperator,
      userRepository: fakeUserRepository({}),
      userId: "usr_nowallet",
      fallbackToRuntimeSigner: true,
    })
    expect(address).toBe(OPERATOR_ADDRESS)
  })

  test("still fails closed when the opt-in is set but no signer is configured", async () => {
    await expect(resolvePrimaryWalletAddress({
      env: {} as Env,
      userRepository: fakeUserRepository({}),
      userId: "usr_nowallet",
      fallbackToRuntimeSigner: true,
    })).rejects.toThrow("Primary wallet is required")
  })
})
