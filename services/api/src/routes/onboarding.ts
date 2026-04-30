import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getOnboardingStatusRepository, getRedditOnboardingRepository } from "../lib/auth/repositories"
import { normalizeRedditUsername } from "../lib/onboarding/reddit-bootstrap"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import {
  serializeOnboardingStatus,
  serializeRedditImportStart,
  serializeRedditImportSummary,
  serializeRedditVerification,
} from "../serializers/onboarding"

const onboarding = new Hono<AuthenticatedEnv>()

onboarding.use("*", authenticate)

function importedRedditScoreBucket(score: number | null | undefined): string {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return "unknown"
  }
  if (score >= 100_000) return "100k_plus"
  if (score >= 50_000) return "50k_100k"
  if (score >= 10_000) return "10k_50k"
  if (score >= 1_000) return "1k_10k"
  return "under_1k"
}

onboarding.get("/status", async (c) => {
  const actor = c.get("actor")
  const repository = getOnboardingStatusRepository(c.env)
  const onboardingStatus = await repository.getOnboardingStatusByUserId(actor.userId)
  if (!onboardingStatus) {
    throw notFoundError("Onboarding status not found")
  }
  return c.json(serializeOnboardingStatus(onboardingStatus), 200)
})

onboarding.post("/dismiss", async (c) => {
  const actor = c.get("actor")
  const repository = getOnboardingStatusRepository(c.env)
  const onboardingStatus = await repository.dismissOnboarding(actor.userId)
  if (!onboardingStatus) {
    throw notFoundError("Onboarding status not found")
  }
  await trackApiEvent(c.env, c.req, {
    eventName: onboardingStatus.missing_requirements.length === 0 ? "onboarding_completed" : "onboarding_skipped",
    userId: actor.userId,
    properties: {
      missing_requirements_count: onboardingStatus.missing_requirements.length,
    },
  })
  return c.json(serializeOnboardingStatus(onboardingStatus), 200)
})

onboarding.post("/reddit-verification", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ reddit_username?: string }>().catch(() => null)
  const redditUsername = normalizeRedditUsername(String(body?.reddit_username || ""))
  if (!redditUsername) {
    throw badRequestError("Invalid reddit verification payload")
  }
  const repository = getRedditOnboardingRepository(c.env)
  const result = await repository.startOrCheckRedditVerification({
    env: c.env,
    userId: actor.userId,
    redditUsername,
  })
  if (result.status === "pending") {
    await trackApiEvent(c.env, c.req, {
      eventName: result.last_checked_at ? "reddit_verification_check_pending" : "reddit_verification_code_generated",
      userId: actor.userId,
      properties: result.last_checked_at
        ? {
            code_placement_surface: result.code_placement_surface ?? "profile",
            failure_code: result.failure_code ?? "code_not_found",
          }
        : { code_placement_surface: result.code_placement_surface ?? "profile" },
    })
  } else if (result.status === "verified") {
    await trackApiEvent(c.env, c.req, {
      eventName: "reddit_verification_succeeded",
      userId: actor.userId,
    })
  } else if (result.status === "failed" || result.status === "expired") {
    await trackApiEvent(c.env, c.req, {
      eventName: "reddit_verification_failed",
      userId: actor.userId,
      properties: { failure_code: result.failure_code ?? result.status },
    })
  }
  return c.json(serializeRedditVerification(result), 200)
})

onboarding.post("/reddit-imports", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ reddit_username?: string }>().catch(() => null)
  const redditUsername = normalizeRedditUsername(String(body?.reddit_username || ""))
  if (!redditUsername) {
    throw badRequestError("Invalid reddit import payload")
  }
  const repository = getRedditOnboardingRepository(c.env)
  const result = await repository.startRedditSnapshotImport({
    env: c.env,
    userId: actor.userId,
    redditUsername,
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "reddit_import_queued",
    userId: actor.userId,
    properties: { job_status: result.job.status },
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "reddit_import_started",
    userId: actor.userId,
    properties: { job_status: result.job.status },
  })
  if (result.job.status === "succeeded" || result.job.status === "failed") {
    const summary = result.job.status === "succeeded"
      ? await repository.getLatestRedditImportSummary(actor.userId).catch(() => null)
      : null
    await trackApiEvent(c.env, c.req, {
      eventName: result.job.status === "succeeded" ? "reddit_import_succeeded" : "reddit_import_failed",
      userId: actor.userId,
      properties: result.job.status === "succeeded"
        ? {
            imported_reddit_score_bucket: importedRedditScoreBucket(summary?.imported_reddit_score),
            top_subreddit_count: summary?.top_subreddits.length ?? 0,
            suggested_community_count: summary?.suggested_communities.length ?? 0,
            has_imported_reddit_score: typeof summary?.imported_reddit_score === "number",
          }
        : { failure_code: result.job.error_code ?? null },
    })
  }
  return c.json(serializeRedditImportStart(result), 202)
})

onboarding.get("/reddit-imports/latest", async (c) => {
  const actor = c.get("actor")
  const repository = getRedditOnboardingRepository(c.env)
  const summary = await repository.getLatestRedditImportSummary(actor.userId)
  if (!summary) {
    throw notFoundError("Reddit import summary not found")
  }
  return c.json(serializeRedditImportSummary(summary), 200)
})

export default onboarding
