import { Hono } from "hono"
import type { Context } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { decodePublicPostId } from "../lib/public-ids"
import {
  getPostStreakLeaderboard,
  getPostStudyPayload,
  getSongStudyAttemptTiming,
  resolveStudyTimezone,
  submitPostStudyAttempt,
  transcribePostStudyAudio,
  type SongStudyAttemptRequest,
} from "../lib/posts/post-study-service"
import { badRequestError } from "../lib/errors"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

function parseLeaderboardLimit(value: string | undefined): number | undefined {
  if (value == null || value.trim() === "") return undefined
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw badRequestError("limit must be an integer between 1 and 100")
  }
  return limit
}

function getWaitUntil(c: Context): ((promise: Promise<void>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return undefined
  }
}

export function registerCommunityStudyRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/posts/:postId/study", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const targetLanguage = new URL(c.req.url).searchParams.get("target_language")
    const payload = await getPostStudyPayload({
      actor,
      communityId,
      communityRepository,
      env: c.env,
      postId,
      targetLanguage,
    })
    return c.json(payload, 200)
  })

  communities.get("/:communityId/posts/:postId/streaks/leaderboard", async (c) => {
    const { actor, communityId, communityRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const limit = parseLeaderboardLimit(new URL(c.req.url).searchParams.get("limit") ?? undefined)
    const payload = await getPostStreakLeaderboard({
      actor,
      communityId,
      communityRepository,
      env: c.env,
      limit,
      postId,
      profileRepository,
      studyTimezone: resolveStudyTimezone(c.req.raw.cf),
    })
    return c.json(payload, 200)
  })

  communities.post("/:communityId/posts/:postId/study/attempts", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const body = await requireJsonBody<SongStudyAttemptRequest>(c, "Invalid study attempt payload")
    const result = await submitPostStudyAttempt({
      actor,
      body,
      communityId,
      communityRepository,
      env: c.env,
      postId,
      studyTimezone: resolveStudyTimezone(c.req.raw.cf),
      waitUntil: getWaitUntil(c),
    })
    const timing = getSongStudyAttemptTiming(result)
    if (timing) {
      c.header("x-song-study-attempt-timing", JSON.stringify(timing))
      c.header("server-timing", `song-study-attempt;dur=${timing.total_ms}`)
    }
    return c.json(result, 200)
  })

  communities.post("/:communityId/posts/:postId/study/transcriptions", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const formData = await c.req.formData().catch(() => null)
    const file = formData?.get("file")
    if (!(file instanceof File)) {
      throw badRequestError("file is required")
    }
    const result = await transcribePostStudyAudio({
      actor,
      communityId,
      communityRepository,
      env: c.env,
      file,
      postId,
    })
    return c.json(result, 200)
  })
}
