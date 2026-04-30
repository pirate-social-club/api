import type { Client } from "../sql-client"
import { conflictError, verificationRequired, internalError } from "../errors"
import { makeId, nowIso } from "../helpers"
import {
  getLatestExternalReputationSnapshotRow,
  getLatestRedditVerificationSessionRowForUsername,
} from "../auth/auth-db-user-queries"
import { getLatestJobRowBySubjectAndType } from "../auth/auth-db-community-queries"
import { serializeRedditImportSummary, serializeRedditVerification } from "../auth/auth-serializers"
import { getJobById } from "../communities/db-community-repository"
import type { Env, Job, RedditImportSummary, RedditVerification } from "../../types"
import { checkRedditVerificationCode, importRedditSnapshot, makeRedditVerificationCode } from "./reddit-bootstrap"
import { unixSeconds } from "../../serializers/time"

function serializeJob(row: {
  job_id: string
  job_type: Job["job_type"]
  status: Job["status"]
  subject_type: string
  subject_id: string
  result_ref: string | null
  error_code: string | null
  created_at: string
  updated_at: string
}): Job {
  return {
    id: `job_${row.job_id}`,
    object: "job",
    job_type: row.job_type,
    status: row.status,
    subject_type: row.subject_type,
    subject: row.subject_id,
    result_ref: row.result_ref,
    error_code: row.error_code,
    created: unixSeconds(row.created_at),
  }
}

export class DatabaseRedditOnboardingRepository {
  constructor(private readonly client: Client) {}

  close(): void | Promise<void> {
    return this.client.close?.()
  }

  async startOrCheckRedditVerification(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<RedditVerification> {
    await this.assertRedditClaimAvailable(input.userId, input.redditUsername)

    const existing = await getLatestRedditVerificationSessionRowForUsername(this.client, input.userId, input.redditUsername)
    const now = new Date()
    const nowText = now.toISOString()

    if (existing?.status === "verified") {
      return serializeRedditVerification(existing)
    }

    if (existing?.status === "pending") {
      if (Date.parse(existing.expires_at) <= now.getTime()) {
        await this.client.execute({
          sql: `
            UPDATE reddit_verification_sessions
            SET status = 'expired',
                updated_at = ?2
            WHERE reddit_verification_session_id = ?1
          `,
          args: [existing.reddit_verification_session_id, nowText],
        })
      } else if (existing.checked_count >= 10) {
        await this.client.execute({
          sql: `
            UPDATE reddit_verification_sessions
            SET status = 'failed',
                failure_code = 'rate_limited',
                checked_count = checked_count + 1,
                last_checked_at = ?2,
                updated_at = ?2
            WHERE reddit_verification_session_id = ?1
          `,
          args: [existing.reddit_verification_session_id, nowText],
        })

        const limited = await getLatestRedditVerificationSessionRowForUsername(this.client, input.userId, input.redditUsername)
        if (!limited) {
          throw internalError("Reddit verification session missing after rate limit update")
        }
        return serializeRedditVerification(limited)
      } else {
        const result = await checkRedditVerificationCode({
          env: input.env,
          redditUsername: input.redditUsername,
          verificationCode: existing.verification_code,
        })

        if (result.status === "verified") {
          await this.client.execute({
            sql: `
              UPDATE reddit_verification_sessions
              SET status = 'verified',
                  failure_code = NULL,
                  checked_count = checked_count + 1,
                  last_checked_at = ?2,
                  verified_at = ?2,
                  updated_at = ?2
              WHERE reddit_verification_session_id = ?1
            `,
            args: [existing.reddit_verification_session_id, nowText],
          })
        } else if (result.status === "pending") {
          await this.client.execute({
            sql: `
              UPDATE reddit_verification_sessions
              SET failure_code = ?2,
                  checked_count = checked_count + 1,
                  last_checked_at = ?3,
                  updated_at = ?3
              WHERE reddit_verification_session_id = ?1
            `,
            args: [existing.reddit_verification_session_id, result.failureCode, nowText],
          })
        } else {
          await this.client.execute({
            sql: `
              UPDATE reddit_verification_sessions
              SET status = 'failed',
                  failure_code = ?2,
                  checked_count = checked_count + 1,
                  last_checked_at = ?3,
                  updated_at = ?3
              WHERE reddit_verification_session_id = ?1
            `,
            args: [existing.reddit_verification_session_id, result.failureCode, nowText],
          })
        }

        const refreshed = await getLatestRedditVerificationSessionRowForUsername(this.client, input.userId, input.redditUsername)
        if (!refreshed) {
          throw internalError("Reddit verification session missing after check")
        }
        return serializeRedditVerification(refreshed)
      }
    }

    const verificationSessionId = makeId("rvs")
    const verificationCode = makeRedditVerificationCode()
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString()
    const verificationHint = `Add \`${verificationCode}\` to your Reddit profile and retry verification.`

    await this.client.execute({
      sql: `
        INSERT INTO reddit_verification_sessions (
          reddit_verification_session_id, user_id, reddit_username, verification_code, code_placement_surface,
          status, verification_hint, failure_code, checked_count, last_checked_at, verified_at,
          expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'profile',
          'pending', ?5, NULL, 0, NULL, NULL,
          ?6, ?7, ?7
        )
      `,
      args: [
        verificationSessionId,
        input.userId,
        input.redditUsername,
        verificationCode,
        verificationHint,
        expiresAt,
        nowText,
      ],
    })

    const created = await getLatestRedditVerificationSessionRowForUsername(this.client, input.userId, input.redditUsername)
    if (!created) {
      throw internalError("Reddit verification session missing after create")
    }
    return serializeRedditVerification(created)
  }

  async startRedditSnapshotImport(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<{ job: Job }> {
    await this.assertRedditClaimAvailable(input.userId, input.redditUsername)

    const verification = await getLatestRedditVerificationSessionRowForUsername(this.client, input.userId, input.redditUsername)
    if (!verification || verification.status !== "verified") {
      throw verificationRequired("Reddit verification is required")
    }

    const existingJob = await getLatestJobRowBySubjectAndType(this.client, {
      subjectType: "user",
      subjectId: input.userId,
      jobType: "reddit_snapshot_import",
    })
    if (existingJob && (existingJob.status === "queued" || existingJob.status === "running")) {
      return {
        job: serializeJob(existingJob),
      }
    }

    const jobId = makeId("job")
    const createdAt = nowIso()
    await this.client.execute({
      sql: `
        INSERT INTO jobs (
          job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ?1, 'reddit_snapshot_import', 'platform', NULL, 'user', ?2, 'queued', ?3,
          NULL, NULL, 0, NULL, ?4, ?4
        )
      `,
      args: [jobId, input.userId, JSON.stringify({ reddit_username: input.redditUsername }), createdAt],
    })

    try {
      await this.client.execute({
        sql: `
          UPDATE jobs
          SET status = 'running',
              updated_at = ?2
          WHERE job_id = ?1
        `,
        args: [jobId, nowIso()],
      })

      const summary = await importRedditSnapshot({
        env: input.env,
        redditUsername: input.redditUsername,
      })
      const snapshotId = makeId("ers")
      const completedAt = nowIso()

      const tx = await this.client.transaction("write")
      try {
        await tx.execute({
          sql: `
            INSERT INTO external_reputation_snapshots (
              external_reputation_snapshot_id, user_id, source_platform, snapshot_type, source_account_handle,
              proof_method, captured_at, snapshot_payload_json, created_at, updated_at
            ) VALUES (
              ?1, ?2, 'reddit', 'onboarding', ?3,
              'profile_code', ?4, ?5, ?4, ?4
            )
          `,
          args: [
            snapshotId,
            input.userId,
            input.redditUsername,
            summary.imported_at,
            JSON.stringify(summary),
          ],
        })
        await tx.execute({
          sql: `
            UPDATE jobs
            SET status = 'succeeded',
                result_ref = ?2,
                error_code = NULL,
                updated_at = ?3
            WHERE job_id = ?1
          `,
          args: [jobId, snapshotId, completedAt],
        })
        await tx.commit()
      } catch (error) {
        try {
          await tx.rollback()
        } catch (rollbackError) {
          console.error("[reddit-onboarding] rollback failed while starting snapshot import", rollbackError)
        }
        throw error
      } finally {
        tx.close()
      }
    } catch (error) {
      const errorCode = error instanceof Error && error.message === "rate_limited"
        ? "rate_limited"
        : "source_error"
      await this.client.execute({
        sql: `
          UPDATE jobs
          SET status = 'failed',
              error_code = ?2,
              updated_at = ?3
          WHERE job_id = ?1
        `,
        args: [jobId, errorCode, nowIso()],
      })
    }

    const jobRow = await getJobById(this.client, jobId)
    if (!jobRow) {
      throw internalError("Reddit snapshot import job is missing after create")
    }
    return {
      job: serializeJob(jobRow),
    }
  }

  async getLatestRedditImportSummary(userId: string): Promise<RedditImportSummary | null> {
    const snapshot = await getLatestExternalReputationSnapshotRow(this.client, userId)
    return snapshot ? serializeRedditImportSummary(snapshot) : null
  }

  private async assertRedditClaimAvailable(userId: string, redditUsername: string): Promise<void> {
    const row = await this.client.execute({
      sql: `
        SELECT user_id
        FROM global_handles
        WHERE label_normalized = ?1
          AND issuance_source = 'reddit_verified_claim'
        ORDER BY created_at ASC
        LIMIT 1
      `,
      args: [redditUsername],
    })
    const ownerUserId = row.rows[0]?.user_id == null ? null : String(row.rows[0]?.user_id)
    if (ownerUserId != null && ownerUserId !== userId) {
      throw conflictError("This Reddit account has already been used for a Pirate handle")
    }
  }
}
