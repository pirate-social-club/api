import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { listPublicCommentReplies, listPublicPostComments } from "../lib/comments/comment-service"
import { serializeCommentListResponse } from "../serializers/comment"
import { decodePublicCommentId, decodePublicPostId } from "../lib/public-ids"
import type { Env } from "../types"

const publicComments = new Hono<{ Bindings: Env }>()

publicComments.get("/:commentId/replies", async (c) => {
  const result = await listPublicCommentReplies({
    env: c.env,
    commentId: decodePublicCommentId(c.req.param("commentId")),
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    cursor: c.req.query("cursor") ?? null,
    limit: c.req.query("limit") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(serializeCommentListResponse(result), 200)
})

publicComments.get("/posts/:postId/comments", async (c) => {
  const result = await listPublicPostComments({
    env: c.env,
    threadRootPostId: decodePublicPostId(c.req.param("postId")),
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    cursor: c.req.query("cursor") ?? null,
    limit: c.req.query("limit") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(serializeCommentListResponse(result), 200)
})

export default publicComments
