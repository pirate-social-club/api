import type { Client } from "../sql-client"
import type {
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import type { ProfileRepository } from "../auth/repositories"
import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import { getLatestThreadSnapshotForRead } from "../comments/community-comment-store"
import { buildLocalizedPostResponse } from "../localization/post-localization-service"
import type { AgeGateViewerState } from "./age-gate-viewer-state"
import { hydrateCrosspostSourcesForResponses } from "./crosspost-source-hydration"
import {
  enqueueEmbedHydrateOnReadIfNeeded,
  enqueueLinkSummaryRepairOnReadIfNeeded,
  enqueuePostTranslationOnReadIfNeeded,
} from "./post-jobs"
import { hydrateDerivativeSourcesForResponses } from "./upstream-source-hydration"
import { getPostReadMetrics } from "./community-post-metrics-store"
import type { CommentThreadSnapshot, LocalizedPostResponse, Post } from "../../types"
import type { PublishedLocalizedPostFeedItem } from "./community-post-feed"

type PostReadResponseCommunityRepository =
  & CommunityReadRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">

export async function buildLocalizedPostFeedResponses(input: {
  client: Client
  songArtifactExecutor?: Client | null
  feedItems: readonly PublishedLocalizedPostFeedItem[]
  locale?: string | null
  viewerUserId: string | null
  ageGateState: AgeGateViewerState | null
}): Promise<LocalizedPostResponse[]> {
  const studyEnabledCache = new Map<string, Promise<boolean>>()
  return Promise.all(input.feedItems.map(async (item) => {
    const ageGateViewerState = item.post.age_gate_policy === "18_plus" ? input.ageGateState : null
    const threadSnapshot = await getLatestThreadSnapshotForRead(input.client, item.post.post_id)
    return buildLocalizedPostResponse({
      executor: input.client,
      songArtifactExecutor: input.songArtifactExecutor,
      post: item.post,
      locale: input.locale ?? undefined,
      metrics: {
        upvote_count: item.upvote_count,
        downvote_count: item.downvote_count,
        comment_count: item.comment_count,
        like_count: item.like_count,
        viewer_vote: item.viewer_vote,
      },
      threadSnapshot,
      ageGateViewerState,
      studyEnabledCache,
      viewerUserId: input.viewerUserId,
    })
  }))
}

export async function buildLocalizedPostReadResponse(input: {
  client: Client
  songArtifactExecutor?: Client | null
  post: Post
  locale?: string | null
  viewerUserId: string | null
  ageGateViewerState: AgeGateViewerState | null
}): Promise<LocalizedPostResponse> {
  const threadSnapshot = await getLatestThreadSnapshotForRead(input.client, input.post.post_id)
  const metrics = await getPostReadMetrics({
    executor: input.client,
    postId: input.post.post_id,
    viewerUserId: input.viewerUserId,
  })
  return buildLocalizedPostResponse({
    executor: input.client,
    songArtifactExecutor: input.songArtifactExecutor,
    post: input.post,
    locale: input.locale ?? undefined,
    metrics,
    threadSnapshot,
    ageGateViewerState: input.ageGateViewerState,
    viewerUserId: input.viewerUserId,
  })
}

/**
 * Resolves the read-time public handle label for public-identity human authors
 * and stamps it onto `response.post.author_public_handle`, so clients render the
 * byline on first paint instead of doing a per-author profile lookup. Anonymous
 * and agent (`user_agent`) posts are left untouched (byline comes from the
 * anonymous label or the agent snapshot). One batched profile lookup per read.
 */
export async function hydrateAuthorPublicHandlesForResponses(input: {
  responses: LocalizedPostResponse[]
  profileRepository?: ProfileRepository | null
}): Promise<void> {
  if (!input.profileRepository) return

  const eligiblePosts = input.responses
    .map((response) => response.post)
    .filter((post): post is Post & { author_user_id: string } =>
      post.identity_mode === "public"
      && post.authorship_mode === "human_direct"
      && Boolean(post.author_user_id))

  const authorUserIds = [...new Set(eligiblePosts.map((post) => post.author_user_id))]
  if (authorUserIds.length === 0) return

  const profileRepository = input.profileRepository
  const profilesByUserId = profileRepository.listProfilesByUserIds
    ? await profileRepository.listProfilesByUserIds(authorUserIds).catch(() => new Map())
    : new Map(await Promise.all(authorUserIds.map(async (userId): Promise<[
        string,
        Awaited<ReturnType<ProfileRepository["getProfileByUserId"]>>,
      ]> => [
        userId,
        await profileRepository.getProfileByUserId(userId).catch(() => null),
      ])))

  for (const post of eligiblePosts) {
    const profile = profilesByUserId.get(post.author_user_id) ?? null
    post.author_public_handle = profile ? getProfilePublicHandleLabel(profile) : null
  }
}

export async function hydrateAndEnqueuePostReadResponses(input: {
  client: Client
  communityId: string
  responses: LocalizedPostResponse[]
  communityRepository?: PostReadResponseCommunityRepository | null
  profileRepository?: ProfileRepository | null
}): Promise<void> {
  if (input.communityRepository) {
    await hydrateCrosspostSourcesForResponses({
      responses: input.responses,
      communityRepository: input.communityRepository,
      profileRepository: input.profileRepository,
    })
  }

  await hydrateAuthorPublicHandlesForResponses({
    responses: input.responses,
    profileRepository: input.profileRepository,
  })

  await hydrateDerivativeSourcesForResponses({
    client: input.client,
    communityId: input.communityId,
    responses: input.responses,
    profileRepository: input.profileRepository,
  })

  for (const response of input.responses) {
    await enqueuePostTranslationOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      response,
    })
    await enqueueLinkSummaryRepairOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      post: response.post,
    })
    await enqueueEmbedHydrateOnReadIfNeeded({
      client: input.client,
      communityId: input.communityId,
      post: response.post,
    })
  }
}

export function buildDeletedPostStubResponse(input: {
  post: Post
  threadSnapshot: CommentThreadSnapshot | null
  viewerUserId?: string | null
}): LocalizedPostResponse {
  const redactedPost: Post = {
    ...input.post,
    author_user_id: null,
    agent_id: null,
    agent_ownership_record_id: null,
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    agent_handle_snapshot: null,
    agent_display_name_snapshot: null,
    agent_owner_handle_snapshot: null,
    agent_ownership_provider_snapshot: null,
    disclosed_qualifiers_json: null,
    label_id: null,
    post_type: "text",
    title: null,
    body: null,
    caption: null,
    lyrics: null,
    link_url: null,
    link_og_image_url: null,
    link_og_title: null,
    link_enrichment_snapshot_json: null,
    link_enrichment_synced_at: null,
    embeds: null,
    media_refs: [],
    creator_relation: null,
    promotion_disclosure: null,
    source_language: null,
    translation_policy: "none",
    access_mode: null,
    asset_id: null,
    song_artifact_bundle_id: null,
    song_annotations_url: null,
    parent_post_id: null,
    song_mode: null,
    rights_basis: null,
    upstream_asset_refs: null,
    analysis_result_ref: null,
    content_safety_state: "safe",
    age_gate_policy: "none",
    label_assignment_status: null,
    label_assigned_by: null,
    label_assigned_at: null,
    label_ai_confidence: null,
    label_assignment_error: null,
    label_assignment_model: null,
    label_assignment_result_json: null,
  }

  return {
    post: redactedPost,
    author_community_role: null,
    thread_snapshot: input.threadSnapshot,
    market_context: null,
    label: null,
    upvote_count: 0,
    downvote_count: 0,
    like_count: 0,
    comment_count: input.threadSnapshot?.comment_count ?? 0,
    viewer_vote: null,
    viewer_is_author: Boolean(input.viewerUserId && input.post.author_user_id === input.viewerUserId),
    viewer_reaction_kinds: [],
    age_gate_viewer_state: null,
    resolved_locale: "en",
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    translated_title: null,
    translated_caption: null,
    translated_embeds: null,
    song_presentation: null,
    study_capability: null,
    derivative_sources: null,
    source_hash: "",
  }
}
