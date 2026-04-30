import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { trackApiEvent } from "../lib/analytics/track"
import { createComment, listPostComments } from "../lib/comments/comment-service"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { makeId, nowIso } from "../lib/helpers"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import { serializeComment, serializeCommentListResponse } from "../serializers/comment"
import { serializeLocalizedPostResponse, serializePost } from "../serializers/post"
import type { CreatePostRequest } from "../types"
import { decodePublicPostId } from "../lib/public-ids"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

export function registerCommunityContentRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreatePostRequest>(c, "Invalid post create payload")
    if (actor.authType !== "admin") {
      assertAgentDelegatedWriteMatchesActor({ actor, body })
    }
    const result = await createPost({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      body,
      bypassAuthorAccessChecks: actor.authType === "admin",
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
    if (actor.authType === "admin") {
      const operationClass = c.req.header("x-admin-operation-class")?.trim() || "admin_post"
      await getControlPlaneClient(c.env).execute({
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
          ) VALUES (
            ?1, 'operator', ?2, ?3, 'post', ?4, ?5, ?6, ?7
          )
        `,
        args: [
          makeId("aud"),
          actor.adminOverride.adminActorId,
          operationClass === "launch_seed" ? "community.seed_post_created" : "community.admin_post_created",
          result.post_id,
          communityId,
          JSON.stringify({
            operation_class: operationClass,
            acting_user_id: actor.userId,
            idempotency_key: body.idempotency_key ?? null,
            post_type: result.post_type,
            status: result.status,
          }),
          nowIso(),
        ],
      })
    }
    return c.json(serializePost(result), result.status === "published" ? 201 : 202)
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
    return c.json({
      ...result,
      items: result.items.map(serializeLocalizedPostResponse),
    }, 200)
  })

  communities.post("/:communityId/posts/:postId/comments", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const body = await requireJsonBody<CreateCommentRequest>(c, "Invalid comment create payload")
    if (actor.authType !== "admin") {
      assertAgentDelegatedWriteMatchesActor({ actor, body })
    }
    const result = await createComment({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      threadRootPostId: postId,
      body,
      bypassAuthorAccessChecks: actor.authType === "admin",
      userRepository,
      profileRepository,
      communityRepository,
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "comment_created",
      userId: actor.userId,
      communityId,
      postId,
      commentId: result.comment_id,
      properties: {
        depth: result.depth,
      },
    })
    if (actor.authType === "admin") {
      const operationClass = c.req.header("x-admin-operation-class")?.trim() || "admin_comment"
      await getControlPlaneClient(c.env).execute({
        sql: `
          INSERT INTO audit_log (
            audit_event_id, actor_type, actor_id, action, target_type, target_id, community_id, metadata_json, created_at
          ) VALUES (
            ?1, 'operator', ?2, ?3, 'comment', ?4, ?5, ?6, ?7
          )
        `,
        args: [
          makeId("aud"),
          actor.adminOverride.adminActorId,
          operationClass === "launch_seed" ? "community.seed_comment_created" : "community.admin_comment_created",
          result.comment_id,
          communityId,
          JSON.stringify({
            operation_class: operationClass,
            acting_user_id: actor.userId,
            idempotency_key: body.idempotency_key ?? null,
            post_id: postId,
            depth: result.depth,
          }),
          nowIso(),
        ],
      })
    }
    return c.json(serializeComment(result), 201)
  })

  communities.get("/:communityId/posts/:postId/comments", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listPostComments({
      env: c.env,
      userId: actor.userId,
      communityId,
      threadRootPostId: decodePublicPostId(c.req.param("postId")),
      locale: c.req.query("locale") ?? null,
      sort: c.req.query("sort") ?? null,
      cursor: c.req.query("cursor") ?? null,
      limit: c.req.query("limit") ?? null,
      communityRepository,
    })
    return c.json(serializeCommentListResponse(result), 200)
  })
}
