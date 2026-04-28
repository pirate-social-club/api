import { conflictError, internalError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import { checkRedditVerificationCode, importRedditSnapshot, makeRedditVerificationCode } from "./reddit-bootstrap"
import { getMemoryRecordByUserId, getMemoryStore } from "../auth/memory-auth-store"
import type { Env, Job, RedditImportSummary, RedditVerification } from "../../types"

export class MemoryRedditOnboardingRepository {
  async startOrCheckRedditVerification(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<RedditVerification> {
    const record = getMemoryRecordByUserId(input.userId)
    if (!record) {
      throw internalError(`Missing user record for ${input.userId}`)
    }
    this.assertRedditClaimAvailable(input.userId, input.redditUsername)

    const existing = record.redditVerification
    const now = new Date()
    if (
      existing
      && existing.reddit_username === input.redditUsername
      && existing.status === "pending"
      && record.redditVerificationCode
      && record.redditVerificationExpiresAt
    ) {
      if (Date.parse(record.redditVerificationExpiresAt) <= now.getTime()) {
        record.redditVerification = {
          ...existing,
          status: "expired",
        }
      } else if (record.redditVerificationCheckedCount >= 10) {
        record.redditVerificationCheckedCount += 1
        record.redditVerification = {
          ...existing,
          status: "failed",
          failure_code: "rate_limited",
          last_checked_at: now.toISOString(),
        }
      } else {
        const result = await checkRedditVerificationCode({
          env: input.env,
          redditUsername: input.redditUsername,
          verificationCode: record.redditVerificationCode,
        })
        record.redditVerificationCheckedCount += 1
        const next: RedditVerification = result.status === "verified"
          ? {
              ...existing,
              status: "verified",
              failure_code: null,
              last_checked_at: now.toISOString(),
            }
          : result.status === "pending"
            ? {
                ...existing,
                failure_code: result.failureCode,
                last_checked_at: now.toISOString(),
              }
            : {
                ...existing,
                status: "failed",
                failure_code: result.failureCode,
                last_checked_at: now.toISOString(),
              }
        record.redditVerification = next
      }
      record.onboarding.reddit_verification_status = record.redditVerification.status === "verified"
        ? "verified"
        : record.redditVerification.status === "pending"
          ? "pending"
          : "failed"
      return record.redditVerification
    }

    const verificationCode = makeRedditVerificationCode()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
    const created: RedditVerification = {
      reddit_username: input.redditUsername,
      status: "pending",
      verification_hint: `Add \`${verificationCode}\` to your Reddit profile and retry verification.`,
      code_placement_surface: "profile",
      last_checked_at: null,
      failure_code: null,
    }
    record.redditVerification = created
    record.redditVerificationCode = verificationCode
    record.redditVerificationExpiresAt = expiresAt
    record.redditVerificationCheckedCount = 0
    record.onboarding.reddit_verification_status = "pending"
    return created
  }

  async startRedditSnapshotImport(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<{ job: Job }> {
    const record = getMemoryRecordByUserId(input.userId)
    if (!record) {
      throw internalError(`Missing user record for ${input.userId}`)
    }
    this.assertRedditClaimAvailable(input.userId, input.redditUsername)
    if (record.redditVerification?.status !== "verified" || record.redditVerification.reddit_username !== input.redditUsername) {
      throw verificationRequired("Reddit verification is required")
    }

    const job: Job = {
      job_id: makeId("job"),
      job_type: "reddit_snapshot_import",
      status: "running",
      subject_type: "user",
      subject_id: input.userId,
      result_ref: null,
      error_code: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    }
    record.redditImportJob = job
    record.onboarding.reddit_import_status = "running"

    try {
      const summary = await importRedditSnapshot({
        env: input.env,
        redditUsername: input.redditUsername,
      })
      record.redditImportSummary = summary
      record.redditImportJob = {
        ...job,
        status: "succeeded",
        result_ref: makeId("ers"),
        updated_at: nowIso(),
      }
      record.onboarding.reddit_import_status = "succeeded"
      record.onboarding.suggested_community_ids = summary.suggested_communities.map((community) => community.community_id)
    } catch {
      record.redditImportJob = {
        ...job,
        status: "failed",
        error_code: "source_error",
        updated_at: nowIso(),
      }
      record.onboarding.reddit_import_status = "failed"
    }

    return {
      job: record.redditImportJob,
    }
  }

  async getLatestRedditImportSummary(userId: string): Promise<RedditImportSummary | null> {
    return getMemoryRecordByUserId(userId)?.redditImportSummary ?? null
  }

  private assertRedditClaimAvailable(userId: string, redditUsername: string): void {
    const owner = [...getMemoryStore().byUserId.values()].find((candidateRecord) => (
      candidateRecord.profile.global_handle.issuance_source === "reddit_verified_claim"
      && candidateRecord.profile.global_handle.label.replace(/\.pirate$/i, "").toLowerCase() === redditUsername
    ))
    if (owner && owner.user.user_id !== userId) {
      throw conflictError("This Reddit account has already been used for a Pirate handle")
    }
  }
}
