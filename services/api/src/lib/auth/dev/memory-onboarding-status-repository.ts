import { getMemoryRecordByUserId } from "./memory-auth-store"
import type { OnboardingStatus } from "../../../types"
import { nowIso } from "../../helpers"
import { unixSeconds } from "../../../serializers/time"

export class MemoryOnboardingStatusRepository {
  async getOnboardingStatusByUserId(userId: string): Promise<OnboardingStatus | null> {
    return getMemoryRecordByUserId(userId)?.onboarding ?? null
  }

  async dismissOnboarding(userId: string): Promise<OnboardingStatus | null> {
    const record = getMemoryRecordByUserId(userId)
    if (!record) {
      return null
    }
    record.onboarding = {
      ...record.onboarding,
      onboarding_dismissed_at: unixSeconds(nowIso()),
    }
    return record.onboarding
  }
}
