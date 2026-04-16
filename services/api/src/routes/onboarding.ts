import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getOnboardingStatusRepository, getRedditOnboardingRepository } from "../lib/auth/repositories"
import { normalizeRedditUsername } from "../lib/onboarding/reddit-bootstrap"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"

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
