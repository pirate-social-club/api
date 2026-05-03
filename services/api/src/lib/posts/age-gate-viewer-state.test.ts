import { describe, expect, test } from "bun:test"
import { resolveAgeGateViewerState } from "./age-gate-viewer-state"
import type { User } from "../../types"
import type { UserRepository } from "../auth/repositories"
import { buildDefaultVerificationCapabilities } from "../verification/verification-capabilities"

function mockUserRepository(user: User | null): UserRepository {
  return {
    getUserById: async () => user,
  } as unknown as UserRepository
}

function verifiedUser(): User {
  const capabilities = buildDefaultVerificationCapabilities()
  capabilities.age_over_18 = {
    state: "verified",
    provider: "self",
    proof_type: "age_over_18",
    mechanism: null,
    verified_at: null,
  }
  return {
    user_id: "usr_test",
    verification_state: "verified",
    verification_capabilities: capabilities,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function unverifiedUser(): User {
  return {
    user_id: "usr_test",
    verification_state: "unverified",
    verification_capabilities: buildDefaultVerificationCapabilities(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe("resolveAgeGateViewerState", () => {
  test("returns null when post is not age-gated", async () => {
    const result = await resolveAgeGateViewerState({
      userId: "usr_test",
      userRepository: mockUserRepository(verifiedUser()),
      postAgeGatePolicy: "none",
    })
    expect(result).toBeNull()
  })

  test("returns proof_required when post is age-gated and user is unverified", async () => {
    const result = await resolveAgeGateViewerState({
      userId: "usr_test",
      userRepository: mockUserRepository(unverifiedUser()),
      postAgeGatePolicy: "18_plus",
    })
    expect(result).toBe("proof_required")
  })

  test("returns verified_allowed when post is age-gated and user is verified 18+", async () => {
    const result = await resolveAgeGateViewerState({
      userId: "usr_test",
      userRepository: mockUserRepository(verifiedUser()),
      postAgeGatePolicy: "18_plus",
    })
    expect(result).toBe("verified_allowed")
  })

  test("returns proof_required when post is age-gated and userId is null", async () => {
    const result = await resolveAgeGateViewerState({
      userId: null,
      userRepository: mockUserRepository(null),
      postAgeGatePolicy: "18_plus",
    })
    expect(result).toBe("proof_required")
  })

  test("returns proof_required when post is age-gated and user not found", async () => {
    const result = await resolveAgeGateViewerState({
      userId: "usr_missing",
      userRepository: mockUserRepository(null),
      postAgeGatePolicy: "18_plus",
    })
    expect(result).toBe("proof_required")
  })

  test("returns proof_required when age_over_18 capability is expired", async () => {
    const user = unverifiedUser()
    user.verification_capabilities.age_over_18 = {
      state: "expired",
      provider: "self",
      proof_type: "age_over_18",
      mechanism: null,
      verified_at: null,
    }
    const result = await resolveAgeGateViewerState({
      userId: "usr_test",
      userRepository: mockUserRepository(user),
      postAgeGatePolicy: "18_plus",
    })
    expect(result).toBe("proof_required")
  })
})