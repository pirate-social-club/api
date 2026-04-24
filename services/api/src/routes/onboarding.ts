import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getOnboardingStatusRepository, getRedditOnboardingRepository } from "../lib/auth/repositories"
import { normalizeRedditUsername } from "../lib/onboarding/reddit-bootstrap"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"

const onboarding = new Hono<AuthenticatedEnv>()

onboarding.use("*", authenticate)

onboarding.get("/status", async (c) => {
  const actor = c.get("actor")
  const repository = getOnboardingStatusRepository(c.env)
  const onboardingStatus = await repository.getOnboardingStatusByUserId(actor.userId)
  if (!onboardingStatus) {
    throw notFoundError("Onboarding status not found")
  }
  return c.json(onboardingStatus, 200)
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
  return c.json(onboardingStatus, 200)
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
      eventName: "reddit_verification_code_generated",
      userId: actor.userId,
      properties: { code_placement_surface: result.code_placement_surface ?? "profile" },
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
  return c.json(result, 200)
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
    await trackApiEvent(c.env, c.req, {
      eventName: result.job.status === "succeeded" ? "reddit_import_succeeded" : "reddit_import_failed",
      userId: actor.userId,
      properties: { failure_code: result.job.error_code ?? null },
    })
  }
  return c.json(result, 202)
})

onboarding.get("/reddit-imports/latest", async (c) => {
  const actor = c.get("actor")
  const repository = getRedditOnboardingRepository(c.env)
  const summary = await repository.getLatestRedditImportSummary(actor.userId)
  if (!summary) {
    throw notFoundError("Reddit import summary not found")
  }
  return c.json(summary, 200)
})

export default onboarding
