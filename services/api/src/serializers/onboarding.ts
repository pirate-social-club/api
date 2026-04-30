import type { Job, OnboardingStatus, RedditImportSummary, RedditVerification } from "../types"

export type RedditImportStartResponse = {
  job: Job
}

export function serializeOnboardingStatus(status: OnboardingStatus): OnboardingStatus {
  return status
}

export function serializeRedditVerification(verification: RedditVerification): RedditVerification {
  return verification
}

export function serializeRedditImportStart(response: RedditImportStartResponse): RedditImportStartResponse {
  return response
}

export function serializeRedditImportSummary(summary: RedditImportSummary): RedditImportSummary {
  return summary
}
