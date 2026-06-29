import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { decodePublicPostId } from "../lib/public-ids"
import {
  getPostStudyPayload,
  submitPostStudyAttempt,
  transcribePostStudyAudio,
  type SongStudyAttemptRequest,
} from "../lib/posts/post-study-service"
import { badRequestError } from "../lib/errors"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

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
    })
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
