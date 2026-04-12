import { verificationRequired, internalError } from "../errors"
import { makeId, nowIso } from "../helpers"
import type { ControlPlaneDbClient } from "../control-plane-db"
import {
  getLatestExternalReputationSnapshotRow,
  getLatestJobRowBySubjectAndType,
  getLatestRedditVerificationSessionRowForUsername,
} from "../auth/control-plane-auth-queries"
import { serializeRedditImportSummary, serializeRedditVerification } from "../auth/control-plane-auth-serializers"
import { getJobById } from "../communities/control-plane-community-repository"
import type { Env, Job, RedditImportSummary, RedditVerification } from "../../types"
import { checkRedditVerificationCode, importRedditSnapshot, makeRedditVerificationCode } from "./reddit-bootstrap"

const DEFAULT_REDDIT_IMPORT_STALE_AFTER_SECONDS = 300

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
    job_id: row.job_id,
    job_type: row.job_type,
    status: row.status,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    result_ref: row.result_ref,
    error_code: row.error_code,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export class ControlPlaneRedditOnboardingRepository {
  constructor(private readonly client: ControlPlaneDbClient) {}

  private getRedditImportStaleAfterSeconds(env: Env): number {
    const parsed = Number(String(env.REDDIT_IMPORT_JOB_STALE_AFTER_SECONDS || "").trim())
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return DEFAULT_REDDIT_IMPORT_STALE_AFTER_SECONDS
    }
    return Math.trunc(parsed)
  }

  private async recoverStaleRunningRedditImportJobs(input: {
    staleAfterSeconds: number
    userId?: string
  }): Promise<number> {
    const staleBefore = new Date(Date.now() - (input.staleAfterSeconds * 1000)).toISOString()
    const scopedUserClause = input.userId ? "AND subject_id = ?3" : ""
    const args = input.userId
      ? [staleBefore, nowIso(), input.userId]
      : [staleBefore, nowIso()]
    const result = await this.client.execute({
      sql: `
        UPDATE jobs
        SET status = 'queued',
            error_code = NULL,
            updated_at = ?2
        WHERE job_type = 'reddit_snapshot_import'
          AND subject_type = 'user'
          AND status = 'running'
          AND updated_at < ?1
          ${scopedUserClause}
      `,
      args,
    })
    return result.rowsAffected
  }

  async startOrCheckRedditVerification(input: {
    env: Env
    userId: string
    redditUsername: string
  }): Promise<RedditVerification> {
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
    const verification = await getLatestRedditVerificationSessionRowForUsername(this.client, input.userId, input.redditUsername)
    if (!verification || verification.status !== "verified") {
      throw verificationRequired("Reddit verification is required")
    }

    const staleAfterSeconds = this.getRedditImportStaleAfterSeconds(input.env)
    await this.recoverStaleRunningRedditImportJobs({
      staleAfterSeconds,
      userId: input.userId,
    })

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

    const jobRow = await getJobById(this.client, jobId)
    if (!jobRow) {
      throw internalError("Reddit snapshot import job is missing after create")
    }
    return {
      job: serializeJob(jobRow),
    }
  }

  async processQueuedRedditSnapshotImport(input: {
    env: Env
    userId: string
    jobId: string
  }): Promise<boolean> {
    const existingJob = await getJobById(this.client, input.jobId)
    if (
      !existingJob
      || existingJob.subject_type !== "user"
      || existingJob.subject_id !== input.userId
      || existingJob.job_type !== "reddit_snapshot_import"
    ) {
      return false
    }
    if (existingJob.status === "running" || existingJob.status === "succeeded" || existingJob.status === "failed") {
      return false
    }

    const claimedAt = nowIso()
    const claim = await this.client.execute({
      sql: `
        UPDATE jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            updated_at = ?2
        WHERE job_id = ?1
          AND status = 'queued'
      `,
      args: [input.jobId, claimedAt],
    })
    if (claim.rowsAffected === 0) {
      return false
    }

    const payload = JSON.parse(String(existingJob.payload_json || "{}")) as { reddit_username?: string }
    const redditUsername = typeof payload.reddit_username === "string" ? payload.reddit_username : null
    if (!redditUsername) {
      await this.client.execute({
        sql: `
          UPDATE jobs
          SET status = 'failed',
              error_code = 'invalid_payload',
              updated_at = ?2
          WHERE job_id = ?1
        `,
        args: [input.jobId, nowIso()],
      })
      return true
    }

    try {
      const summary = await importRedditSnapshot({
        env: input.env,
        redditUsername,
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
            redditUsername,
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
          args: [input.jobId, snapshotId, completedAt],
        })
        await tx.commit()
      } catch (error) {
        try {
          await tx.rollback()
        } catch {}
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
        args: [input.jobId, errorCode, nowIso()],
      })
    }
    return true
  }

  async drainRedditSnapshotImportJobs(input: {
    env: Env
    maxJobs: number
    staleAfterSeconds: number
  }): Promise<{ recoveredCount: number; drainedCount: number }> {
    const recoveredCount = await this.recoverStaleRunningRedditImportJobs({
      staleAfterSeconds: input.staleAfterSeconds,
    })
    const jobs = await this.client.execute({
      sql: `
        SELECT job_id, subject_id
        FROM jobs
        WHERE job_type = 'reddit_snapshot_import'
          AND subject_type = 'user'
          AND status = 'queued'
        ORDER BY created_at ASC, job_id ASC
        LIMIT ?1
      `,
      args: [input.maxJobs],
    })

    let drainedCount = 0
    for (const row of jobs.rows) {
      const claimed = await this.processQueuedRedditSnapshotImport({
        env: input.env,
        userId: String((row as Record<string, unknown>).subject_id),
        jobId: String((row as Record<string, unknown>).job_id),
      })
      if (claimed) {
        drainedCount += 1
      }
    }

    return {
      recoveredCount,
      drainedCount,
    }
  }

  async getLatestRedditImportSummary(userId: string): Promise<RedditImportSummary | null> {
    const snapshot = await getLatestExternalReputationSnapshotRow(this.client, userId)
    return snapshot ? serializeRedditImportSummary(snapshot) : null
  }
}
