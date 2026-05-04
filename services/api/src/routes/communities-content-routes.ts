import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { trackApiEvent } from "../lib/analytics/track"
import { createComment, listPostComments } from "../lib/comments/comment-service"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { openCommunityDb } from "../lib/communities/community-db-factory"
import { badRequestError, eligibilityFailed, notFoundError } from "../lib/errors"
import { getPostById, updatePostLinkPreviewMetadata } from "../lib/posts/community-post-store"
import { createPost, deletePost, listCommunityPosts } from "../lib/posts/post-service"
import { serializeComment, serializeCommentListResponse } from "../serializers/comment"
import { serializeDeletedPostResponse, serializeLocalizedPostResponse, serializePost } from "../serializers/post"
import type { CreatePostRequest } from "../types"
import { decodePublicPostId } from "../lib/public-ids"
import { writeAuditEventForEnv } from "../lib/audit"
import { nowIso } from "../lib/helpers"
import { normalizeLinkUrl } from "../lib/posts/link-enrichment/url-normalization"
import { upsertLinkEnrichment } from "../lib/posts/link-enrichment/repository"
import { getControlPlaneClient } from "../lib/runtime-deps"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

type LinkPreviewOverrideRequest = {
  image_url?: string | null
  title?: string | null
}

function requirePreviewTitle(value: string | null | undefined): string {
  const title = String(value ?? "").trim()
  if (!title) {
    throw badRequestError("title is required")
  }
  return title.slice(0, 300)
}

function requireHttpsImageUrl(value: string | null | undefined): string {
  const imageUrl = String(value ?? "").trim()
  if (!imageUrl) {
    throw badRequestError("image_url is required")
  }

  let parsed: URL
  try {
    parsed = new URL(imageUrl)
  } catch {
    throw badRequestError("image_url must be a valid HTTPS URL")
  }
  if (parsed.protocol !== "https:") {
    throw badRequestError("image_url must be a valid HTTPS URL")
  }
  return parsed.href
}

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
      await writeAuditEventForEnv(c.env, {
        action: operationClass === "launch_seed" ? "community.seed_post_created" : "community.admin_post_created",
        actorId: actor.adminOverride.adminActorId,
        actorType: "operator",
        communityId,
        targetId: result.post_id,
        targetType: "post",
        metadata: {
          operation_class: operationClass,
          acting_user_id: actor.userId,
          idempotency_key: body.idempotency_key ?? null,
          post_type: result.post_type,
          status: result.status,
        },
      })
    }
    return c.json(serializePost(result), result.status === "published" ? 201 : 202)
  })

  communities.post("/:communityId/posts/:postId/link-preview", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    if (actor.authType !== "admin") {
      throw eligibilityFailed("Admin token required")
    }

    const body = await requireJsonBody<LinkPreviewOverrideRequest>(c, "Invalid link preview payload")
    const title = requirePreviewTitle(body.title)
    const imageUrl = requireHttpsImageUrl(body.image_url)
    const postId = decodePublicPostId(c.req.param("postId"))

    const db = await openCommunityDb(c.env, communityRepository, communityId)
    try {
      const post = await getPostById(db.client, postId)
      if (!post || post.community_id !== communityId) {
        throw notFoundError("Post not found")
      }
      if (post.post_type !== "link") {
        throw badRequestError("link preview can only be updated for link posts")
      }

      const updatedAt = nowIso()
      const normalizedUrl = post.link_url ? normalizeLinkUrl(post.link_url) : null
      const snapshot = normalizedUrl
        ? JSON.stringify({
          version: 1,
          provider: "manual",
          status: "ready",
          normalized_url: normalizedUrl,
          canonical_url: post.link_url,
          title,
          description: null,
          publisher: null,
          image_url: imageUrl,
          summary: {
            status: null,
            short_summary: null,
            key_points: [],
            generated_at: null,
            model: null,
          },
          error: null,
          fetched_at: updatedAt,
        })
        : null
      await updatePostLinkPreviewMetadata({
        client: db.client,
        postId,
        linkOgImageUrl: imageUrl,
        linkOgTitle: title,
        linkEnrichmentSnapshotJson: snapshot,
        linkEnrichmentSyncedAt: snapshot ? updatedAt : null,
        updatedAt,
      })
      if (normalizedUrl && c.env.CONTROL_PLANE_DATABASE_URL) {
        await upsertLinkEnrichment({
          client: getControlPlaneClient(c.env),
          normalizedUrl,
          canonicalUrl: post.link_url ?? normalizedUrl,
          provider: "manual",
          status: "ready",
          title,
          description: null,
          publisher: null,
          publishedAt: null,
          imageUrl,
          markdown: null,
          error: null,
          fetchedAt: updatedAt,
          now: updatedAt,
        })
      }
      await writeAuditEventForEnv(c.env, {
        action: "community.admin_link_preview_updated",
        actorId: actor.adminOverride.adminActorId,
        actorType: "operator",
        communityId,
        targetId: postId,
        targetType: "post",
        metadata: {
          acting_user_id: actor.userId,
          link_og_image_url: imageUrl,
          link_og_title: title,
        },
      })

      const updated = await getPostById(db.client, postId)
      if (!updated) {
        throw notFoundError("Post not found")
      }
      return c.json(serializePost(updated))
    } finally {
      db.close()
    }
  })

  communities.post("/:communityId/posts/:postId/delete", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const result = await deletePost({
      env: c.env,
      userId: actor.userId,
      communityId,
      postId,
      communityRepository,
    })
    if (!result.alreadyDeleted) {
      await writeAuditEventForEnv(c.env, {
        action: "community.post_deleted_by_author",
        actorId: actor.userId,
        actorType: "user",
        communityId,
        targetId: postId,
        targetType: "post",
        metadata: {
          deleted_at: result.deletedAt,
        },
      })
    }
    return c.json(serializeDeletedPostResponse(result.post), 200)
  })

  communities.get("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
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
      userRepository,
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
      await writeAuditEventForEnv(c.env, {
        action: operationClass === "launch_seed" ? "community.seed_comment_created" : "community.admin_comment_created",
        actorId: actor.adminOverride.adminActorId,
        actorType: "operator",
        communityId,
        targetId: result.comment_id,
        targetType: "comment",
        metadata: {
          operation_class: operationClass,
          acting_user_id: actor.userId,
          idempotency_key: body.idempotency_key ?? null,
          post_id: postId,
          depth: result.depth,
        },
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
