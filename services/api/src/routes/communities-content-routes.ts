import type { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import { createComment, listPostComments } from "../lib/comments/comment-service"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { trackApiEvent } from "../lib/analytics/track"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type { CreatePostRequest } from "../types"
import type { CreateCommentRequest } from "../lib/comments/comment-types"

export function registerCommunityContentRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreatePostRequest>(c, "Invalid post create payload")
    assertAgentDelegatedWriteMatchesActor({ actor, body })
    const result = await createPost({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      profileRepository,
      communityRepository,
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "post_created",
      userId: actor.userId,
      communityId,
      postId: result.post_id,
      idempotencyKey: body.idempotency_key ?? null,
      properties: {
        post_type: result.post_type,
        status: result.status,
      },
    })
    return c.json(result, result.status === "published" ? 201 : 202)
  })

  communities.get("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityPosts({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
      limit: c.req.query("limit") ?? null,
      cursor: c.req.query("cursor") ?? null,
      flairId: c.req.query("flair_id") ?? null,
      sort: c.req.query("sort") ?? null,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/posts/:postId/comments", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateCommentRequest>(c, "Invalid comment create payload")
    assertAgentDelegatedWriteMatchesActor({ actor, body })
    const result = await createComment({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      threadRootPostId: c.req.param("postId"),
      body,
      userRepository,
      profileRepository,
      communityRepository,
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "comment_created",
      userId: actor.userId,
      communityId,
      postId: c.req.param("postId"),
      commentId: result.comment_id,
      properties: {
        depth: result.depth,
      },
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/posts/:postId/comments", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listPostComments({
      env: c.env,
      userId: actor.userId,
      communityId,
      threadRootPostId: c.req.param("postId"),
      locale: c.req.query("locale") ?? null,
      sort: c.req.query("sort") ?? null,
      cursor: c.req.query("cursor") ?? null,
      limit: c.req.query("limit") ?? null,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
