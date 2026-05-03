import type { UserRepository } from "../auth/repositories"

export type AgeGateViewerState = "proof_required" | "verified_allowed"

export async function resolveAgeGateViewerState(input: {
  userId: string | null | undefined
  userRepository: UserRepository
  postAgeGatePolicy: "none" | "18_plus"
}): Promise<AgeGateViewerState | null> {
  if (input.postAgeGatePolicy !== "18_plus") {
    return null
  }
  if (!input.userId) {
    console.info("[age-gate] no user — proof_required")
    return "proof_required"
  }
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    console.info("[age-gate] user not found — proof_required", { userId: input.userId })
    return "proof_required"
  }
  const ageOver18 = user.verification_capabilities?.age_over_18
  if (!ageOver18 || ageOver18.state !== "verified") {
    console.info("[age-gate] age_over_18 not verified", {
      userId: input.userId,
      state: ageOver18?.state ?? "missing",
    })
    return "proof_required"
  }
  console.info("[age-gate] verified_allowed", { userId: input.userId })
  return "verified_allowed"
}