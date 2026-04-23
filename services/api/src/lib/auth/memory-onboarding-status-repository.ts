import { getMemoryRecordByUserId } from "./memory-auth-store"
import type { OnboardingStatus } from "../../types"

export class MemoryOnboardingStatusRepository {
  async getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null> {
    return getMemoryRecordByUserId(userId)?.onboarding ?? null
  }
}
