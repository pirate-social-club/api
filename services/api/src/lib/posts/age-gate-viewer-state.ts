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
    return "proof_required"
  }
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    return "proof_required"
  }
  const ageOver18 = user.verification_capabilities?.age_over_18
  if (!ageOver18 || ageOver18.state !== "verified") {
    return "proof_required"
  }
  return "verified_allowed"
}