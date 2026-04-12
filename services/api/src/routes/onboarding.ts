import { Hono } from "hono"
import { authError, badRequestError, notFoundError } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import { getOnboardingStatusRepository, getProfileRepository, getRedditOnboardingRepository } from "../lib/auth/repositories"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { normalizeRedditUsername } from "../lib/onboarding/reddit-bootstrap"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const onboarding = new Hono<{ Bindings: Env }>()

function scheduleBackgroundTask(c: { executionCtx?: { waitUntil(promise: Promise<unknown>): void } }, task: Promise<unknown>): void {
  if (c.executionCtx) {
    c.executionCtx.waitUntil(task)
    return
  }
  void task.catch((error) => {
    console.error("[onboarding.background]", error)
  })
}

onboarding.get("/status", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({
    env: c.env,
    token,
  })
  const repository = getOnboardingStatusRepository(c.env)
  const onboardingStatus = await repository.getOnboardingStatusByUserId(session.userId)
  if (!onboardingStatus) {
    throw authError("Authentication failed")
  }
  return c.json(onboardingStatus, 200)
}))

onboarding.post("/reddit-verification", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({
    env: c.env,
    token,
  })
  const body = await c.req.json<{ reddit_username?: string }>().catch(() => null)
  const redditUsername = normalizeRedditUsername(String(body?.reddit_username || ""))
  if (!redditUsername) {
    throw badRequestError("Invalid reddit verification payload")
  }
  const repository = getRedditOnboardingRepository(c.env)
  const result = await repository.startOrCheckRedditVerification({
    env: c.env,
    userId: session.userId,
    redditUsername,
  })
  return c.json(result, 200)
}))

onboarding.post("/reddit-imports", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({
    env: c.env,
    token,
  })
  const body = await c.req.json<{ reddit_username?: string }>().catch(() => null)
  const redditUsername = normalizeRedditUsername(String(body?.reddit_username || ""))
  if (!redditUsername) {
    throw badRequestError("Invalid reddit import payload")
  }
  const repository = getRedditOnboardingRepository(c.env)
  const result = await repository.startRedditSnapshotImport({
    env: c.env,
    userId: session.userId,
    redditUsername,
  })
  if (result.job.status === "queued") {
    scheduleBackgroundTask(c, repository.processQueuedRedditSnapshotImport({
      env: c.env,
      userId: session.userId,
      jobId: result.job.job_id,
    }))
  }
  return c.json(result, 202)
}))

onboarding.get("/reddit-imports/latest", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({
    env: c.env,
    token,
  })
  const repository = getRedditOnboardingRepository(c.env)
  const summary = await repository.getLatestRedditImportSummary(session.userId)
  if (!summary) {
    throw notFoundError("Reddit import summary not found")
  }
  return c.json(summary, 200)
}))

onboarding.get("/global-handle-availability", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({
    env: c.env,
    token,
  })
  const label = String(c.req.query("label") || "").trim()
  if (!label) {
    throw badRequestError("label query parameter is required")
  }
  const repository = getProfileRepository(c.env)
  const result = await repository.checkGlobalHandleAvailability(session.userId, label)
  return c.json(result, 200)
}))

export default onboarding
