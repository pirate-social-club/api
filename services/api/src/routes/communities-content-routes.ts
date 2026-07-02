import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { trackApiEvent } from "../lib/analytics/track"
import { createComment, listPostComments } from "../lib/comments/comment-service"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { badRequestError, eligibilityFailed } from "../lib/errors"
import { enforceRateLimit } from "../lib/rate-limit"
import {
  applyAdminLinkPreviewOverride,
  type LinkPreviewOverrideRequest,
} from "../lib/posts/admin-link-preview-override"
import {
  cancelPostEvent,
  createPost,
  deletePost,
  listCommunityEvents,
  listCommunityPosts,
  removePostAsModerator,
  setPostCommentLock,
} from "../lib/posts/post-service"
import { serializeComment, serializeCommentListResponse } from "../serializers/comment"
import { serializeDeletedPostResponse, serializeLocalizedPostResponse, serializePost } from "../serializers/post"
import type { CreatePostRequest } from "../types"
import { decodePublicPostId, publicCommunityId } from "../lib/public-ids"
import { writeAuditEventForEnv } from "../lib/audit"
import { resolveComposerLinkPreview } from "../lib/posts/link-embed-preview"
import type { ComposerLinkPreviewResult } from "../lib/posts/link-embed-preview"
import { ALTCHA_HEADER, readAltchaProof } from "../lib/verification/altcha-provider"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import {
  SUBMIT_TRACE_HEADER,
  submitTraceRequestFields,
  withSubmitTraceTiming,
} from "../lib/observability/submit-trace"

type ComposerLinkPreviewResponse = {
  kind: "embed" | "link"
  provider: "x" | "youtube" | "kalshi" | "polymarket" | null
  canonical_url: string
  original_url: string
  state: "embed" | "preview" | "unavailable"
  title: string | null
  image_url: string | null
  preview: Record<string, unknown> | null
  oembed_html: string | null
  oembed_cache_age: number | null
}

function serializeComposerLinkPreview(preview: ComposerLinkPreviewResult): ComposerLinkPreviewResponse {
  return {
    kind: preview.kind,
    provider: preview.provider,
    canonical_url: preview.canonicalUrl,
    original_url: preview.originalUrl,
    state: preview.state,
    title: preview.title,
    image_url: preview.imageUrl,
    preview: preview.preview,
    oembed_html: preview.oembedHtml,
    oembed_cache_age: preview.oembedCacheAge,
  }
}

export function registerCommunityContentRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreatePostRequest>(c, "Invalid post create payload")
    const traceFields = {
      ...submitTraceRequestFields({
        contentLengthHeader: c.req.header("content-length"),
        sessionIdHeader: c.req.header("x-pirate-session-id"),
        submitTraceHeader: c.req.header(SUBMIT_TRACE_HEADER),
      }),
      access_mode: body.access_mode ?? "public",
      community_id: publicCommunityId(communityId),
      media_ref_count: body.media_refs?.length ?? 0,
      post_type: body.post_type,
      rights_basis: body.rights_basis ?? null,
      upstream_asset_ref_count: body.upstream_asset_refs?.length ?? 0,
    }
    if (actor.authType !== "admin") {
      assertAgentDelegatedWriteMatchesActor({ actor, body })
    }
    const result = await withSubmitTraceTiming("[create-post-submit] post create", traceFields, () => createPost({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      body,
      bypassAuthorAccessChecks: actor.authType === "admin",
      altchaProof: readAltchaProof({
        headerValue: c.req.header(ALTCHA_HEADER),
        body,
        scope: "post_create",
        action: `community:${publicCommunityId(communityId)}`,
      }),
      userRepository,
      profileRepository,
      communityRepository,
    }))
    console.info("[create-post-submit] post create:result", {
      ...traceFields,
      asset_id: result.asset_id ?? null,
      post_id: result.post_id,
      status: result.status,
      story_royalty_registration_status: result.asset_story?.story_royalty_registration_status ?? null,
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
    const postId = decodePublicPostId(c.req.param("postId"))
    const result = await applyAdminLinkPreviewOverride({
      env: c.env,
      communityRepository,
      communityId,
      postId,
      body,
    })
    await writeAuditEventForEnv(c.env, {
      action: "community.admin_link_preview_updated",
      actorId: actor.adminOverride.adminActorId,
      actorType: "operator",
      communityId,
      targetId: postId,
      targetType: "post",
      metadata: {
        acting_user_id: actor.userId,
        link_og_image_url: result.imageUrl,
        link_og_title: result.title,
      },
    })

    return c.json(serializePost(result.post))
  })

  communities.post("/:communityId/posts/:postId/event-status", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ status?: string | null }>(c, "Invalid event status payload")
    if (body.status !== "canceled") {
      throw badRequestError("status must be canceled")
    }
    const postId = decodePublicPostId(c.req.param("postId"))
    const result = await cancelPostEvent({
      env: c.env,
      userId: actor.userId,
      userRepository,
      communityId,
      postId,
      communityRepository,
    })
    await writeAuditEventForEnv(c.env, {
      action: "community.post_event_canceled",
      actorId: actor.userId,
      actorType: "user",
      communityId,
      targetId: postId,
      targetType: "post",
      metadata: {
        status: "canceled",
      },
    })
    return c.json(serializeLocalizedPostResponse(result), 200)
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

  communities.post("/:communityId/posts/:postId/remove", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const postId = decodePublicPostId(c.req.param("postId"))
    const result = await removePostAsModerator({
      env: c.env,
      userId: actor.userId,
      communityId,
      postId,
      communityRepository,
    })
    await writeAuditEventForEnv(c.env, {
      action: "community.post_removed_by_moderator",
      actorId: actor.userId,
      actorType: "user",
      communityId,
      targetId: postId,
      targetType: "post",
      metadata: {
        removed_at: result.updated_at,
      },
    })
    return c.json(serializePost(result), 200)
  })

  communities.post("/:communityId/posts/:postId/comments-lock", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ locked?: boolean; reason?: string | null }>(c, "Invalid comment lock payload")
    const postId = decodePublicPostId(c.req.param("postId"))
    const result = await setPostCommentLock({
      env: c.env,
      userId: actor.userId,
      communityId,
      postId,
      locked: body.locked !== false,
      reason: body.reason ?? null,
      communityRepository,
    })
    await writeAuditEventForEnv(c.env, {
      action: result.comments_locked ? "community.thread_locked_by_moderator" : "community.thread_unlocked_by_moderator",
      actorId: actor.userId,
      actorType: "user",
      communityId,
      targetId: postId,
      targetType: "post",
      metadata: {
        locked: result.comments_locked,
        reason: result.comments_lock_reason,
      },
    })
    return c.json(serializePost(result), 200)
  })

  communities.get("/:communityId/link-preview", async (c) => {
    await getResolvedCommunityRouteContext(c)
    // Bound abuse of the server-side unfurl fetch (egress / open-proxy) per user.
    const actor = c.get("actor")
    await enforceRateLimit(
      c.env.LINK_PREVIEW_RATE_LIMITER,
      `link-preview:${actor.userId}`,
      "Too many link preview requests. Please slow down and try again shortly.",
      { scope: "link_preview" },
    )
    const url = c.req.query("url")
    if (!url || !url.trim()) {
      throw badRequestError("url is required")
    }

    let normalizedUrl: URL
    try {
      normalizedUrl = new URL(url.trim())
    } catch {
      throw badRequestError("url must be a valid HTTP or HTTPS URL")
    }
    if (normalizedUrl.protocol !== "http:" && normalizedUrl.protocol !== "https:") {
      throw badRequestError("url must be a valid HTTP or HTTPS URL")
    }

    const preview = await resolveComposerLinkPreview({
      url: normalizedUrl.href,
      fetcher: fetch,
    })

    return c.json(preview ? serializeComposerLinkPreview(preview) : {
      kind: "link",
      provider: null,
      canonical_url: normalizedUrl.href,
      original_url: normalizedUrl.href,
      state: "preview",
      title: null,
      image_url: null,
      preview: null,
      oembed_html: null,
      oembed_cache_age: null,
    })
  })

  communities.get("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityPosts({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
      limit: c.req.query("limit") ?? null,
      cursor: c.req.query("cursor") ?? null,
      flairId: c.req.query("flair_id") ?? null,
      hasEvent: c.req.query("has_event") ?? null,
      sort: c.req.query("sort") ?? null,
      communityRepository,
      userRepository,
      profileRepository,
    })
    return c.json({
      ...result,
      items: result.items.map((item) => serializeLocalizedPostResponse(item)),
    }, 200)
  })

  communities.get("/:communityId/events", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityEvents({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
      from: c.req.query("from") ?? null,
      to: c.req.query("to") ?? null,
      limit: c.req.query("limit") ?? null,
      status: c.req.query("status") ?? null,
      communityRepository,
      userRepository,
      profileRepository,
    })
    return c.json({
      ...result,
      items: result.items.map((item) => serializeLocalizedPostResponse(item)),
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
      altchaProof: readAltchaProof({
        headerValue: c.req.header(ALTCHA_HEADER),
        body,
        scope: "comment_create",
        action: `post:${c.req.param("postId")}`,
      }),
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
