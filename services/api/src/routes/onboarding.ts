import { Hono } from "hono"
import { authError, badRequestError, errorResponse, notFoundError } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import { getOnboardingStatusRepository, getRedditOnboardingRepository } from "../lib/auth/repositories"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { normalizeRedditUsername } from "../lib/onboarding/reddit-bootstrap"
import type { Env } from "../types"

const onboarding = new Hono<{ Bindings: Env }>()

onboarding.get("/status", async (c) => {
  try {
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
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    })
  }
})

onboarding.post("/reddit-verification", async (c) => {
  try {
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
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    })
  }
})

onboarding.post("/reddit-imports", async (c) => {
  try {
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
    return c.json(result, 202)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    })
  }
})

onboarding.get("/reddit-imports/latest", async (c) => {
  try {
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
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    })
  }
})

export default onboarding
