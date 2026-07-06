import type { Client } from "../sql-client"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import { getCommunityPostPolicy } from "./community-post-policy-store"
import { analysisBlocked, badRequestError, eligibilityFailed, notFoundError } from "../errors"
import type { Env } from "../../env"
import type { Community, CreatePostRequest, Post } from "../../types"
import type {
  ResolvedSongPostBundle,
  ResolvedVideoPostAsset,
} from "../song-artifacts/song-artifact-types"
import { mergeAnalysisState, type PostAnalysisProvider } from "./post-analysis"
import { prepareSongPostAsset, prepareVideoPostAsset } from "./post-create-asset-preparation"
import { resolveCrosspostSource } from "./post-create-crosspost-source"
import type { PostWriteRequest } from "./post-create-validation"
import { decodePublicSongArtifactBundleId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import { getSongArtifactBundle } from "../song-artifacts/song-artifact-repository"

type PostCreatePreparationCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "getCommunityPostProjectionByPostId">

export type PreparedPostCreateBody = PostWriteRequest

export type PreparedPostCreate = {
  writeBody: PreparedPostCreateBody
  analysisOverride: Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status">
  analysisProviderResult: Record<string, unknown> | null | undefined
  resolvedSongBundleForAsset: ResolvedSongPostBundle | null
  resolvedVideoAsset: ResolvedVideoPostAsset | null
}

export function isAsyncSongBundleStatusPublishable(status: string): boolean {
  return status === "validating" || status === "ready"
}

function resolveAnonymousScope(input: {
  policyScope: Exclude<Post["anonymous_scope"], null> | undefined
  requestedScope: Exclude<Post["anonymous_scope"], null> | undefined
}): Exclude<Post["anonymous_scope"], null> {
  const allowedScope = input.policyScope ?? "community_stable"
  const requestedScope = input.requestedScope ?? allowedScope

  if (requestedScope !== allowedScope) {
    throw badRequestError("anonymous_scope does not match the community policy")
  }

  return requestedScope
}

function buildAnalysisOverride(input: {
  community: Community
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
}): Pick<Post, "analysis_state" | "content_safety_state" | "age_gate_policy" | "status"> {
  if (input.analysisState === "blocked") {
    throw analysisBlocked("Content analysis blocked publication")
  }
  return {
    analysis_state: input.analysisState,
    content_safety_state: input.analysisState === "review_required" && input.contentSafetyState !== "adult"
      ? "pending"
      : input.contentSafetyState,
    age_gate_policy: input.community.default_age_gate_policy === "18_plus" || input.ageGatePolicy === "18_plus"
      ? "18_plus"
      : "none",
    status: input.analysisState === "review_required" ? "draft" : "published",
  }
}

export async function preparePostCreate(input: {
  env: Env
  requestUrl: string
  userId: string
  communityId: string
  body: CreatePostRequest
  community: Community
  communityDbClient: Client
  communityRepository: PostCreatePreparationCommunityRepository
  postAnalysisProvider: PostAnalysisProvider
}): Promise<PreparedPostCreate> {
  let writeBody: PreparedPostCreateBody = input.body
  let resolvedSongBundleForAsset: PreparedPostCreate["resolvedSongBundleForAsset"] = null
  let resolvedVideoAsset: PreparedPostCreate["resolvedVideoAsset"] = null

  if ((input.body.identity_mode ?? "public") === "anonymous") {
    const policy = await getCommunityPostPolicy(input.communityDbClient, input.communityId)
    if (!policy) {
      throw notFoundError("Community not found")
    }
    if (!policy.allow_anonymous_identity) {
      throw eligibilityFailed("Anonymous posts are not enabled in this community")
    }

    writeBody = {
      ...input.body,
      anonymous_scope: resolveAnonymousScope({
        policyScope: policy.anonymous_identity_scope ?? undefined,
        requestedScope: input.body.anonymous_scope ?? undefined,
      }),
    }
  }

  if (input.body.post_type === "crosspost") {
    const crosspostSource = await resolveCrosspostSource({
      env: input.env,
      communityRepository: input.communityRepository,
      sourcePostRef: input.body.source_post,
      sourceCommunityRef: input.body.source_community,
    })
    writeBody = {
      ...input.body,
      body: null,
      caption: null,
      crosspost_source: crosspostSource,
      link_url: null,
      media_refs: undefined,
    }

    const postAnalysis = await input.postAnalysisProvider.analyze({
      env: input.env,
      community: input.community,
      body: {
        ...writeBody,
        body: null,
        caption: null,
        crosspost_source: null,
        link_url: null,
        media_refs: undefined,
      },
    })
    return {
      writeBody,
      analysisProviderResult: postAnalysis.providerResult,
      analysisOverride: buildAnalysisOverride({
        community: input.community,
        analysisState: postAnalysis.analysis_state,
        contentSafetyState: postAnalysis.content_safety_state,
        ageGatePolicy: postAnalysis.age_gate_policy,
      }),
      resolvedSongBundleForAsset,
      resolvedVideoAsset,
    }
  }

  if (input.body.post_type === "song") {
    if (input.body.publish_mode === "async") {
      const songArtifactBundleId = decodePublicSongArtifactBundleId(input.body.song_artifact_bundle || "")
      const bundle = await getSongArtifactBundle(getControlPlaneClient(input.env), input.communityId, songArtifactBundleId)
      if (!bundle || bundle.creator_user !== `usr_${input.userId}`) {
        throw notFoundError("Song artifact bundle not found")
      }
      if (!isAsyncSongBundleStatusPublishable(bundle.status)) {
        throw badRequestError("Song artifact bundle is not available for asynchronous publishing")
      }
      const accessMode = input.body.access_mode ?? "public"
      writeBody = {
        ...input.body,
        identity_mode: "public",
        media_refs: accessMode === "locked"
          ? bundle.preview_audio?.storage_ref && bundle.preview_audio?.mime_type
            ? [{
                storage_ref: bundle.preview_audio.storage_ref,
                mime_type: bundle.preview_audio.mime_type,
                size_bytes: bundle.preview_audio.size_bytes ?? null,
                content_hash: bundle.preview_audio.content_hash ?? null,
                duration_ms: bundle.preview_audio.duration_ms ?? null,
                decentralized_storage: bundle.preview_audio.decentralized_storage ?? null,
              }]
            : []
          : bundle.media_refs as NonNullable<Extract<CreatePostRequest, { post_type: "song" }>["media_refs"]>,
        lyrics: bundle.lyrics,
        access_mode: accessMode,
        asset_id: null,
        song_artifact_bundle: bundle.id,
        song_annotations_url: bundle.genius_annotations_url ?? null,
        song_cover_art_ref: bundle.cover_art?.storage_ref ?? null,
        song_duration_ms: bundle.primary_audio.duration_ms ?? null,
        song_title: bundle.title,
      }
      const postAnalysis = await input.postAnalysisProvider.analyze({
        env: input.env,
        community: input.community,
        body: writeBody,
      })
      if (postAnalysis.analysis_state === "blocked") {
        throw analysisBlocked("Content analysis blocked publication")
      }
      return {
        writeBody,
        analysisProviderResult: postAnalysis.providerResult,
        analysisOverride: {
          analysis_state: postAnalysis.analysis_state,
          content_safety_state: postAnalysis.content_safety_state,
          age_gate_policy: input.community.default_age_gate_policy === "18_plus" || postAnalysis.age_gate_policy === "18_plus"
            ? "18_plus"
            : "none",
          status: "processing",
        },
        resolvedSongBundleForAsset,
        resolvedVideoAsset,
      }
    }

    const preparedSong = await prepareSongPostAsset({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      body: input.body,
    })
    writeBody = preparedSong.writeBody
    resolvedSongBundleForAsset = preparedSong.resolvedSongBundleForAsset

    const postAnalysis = await input.postAnalysisProvider.analyze({
      env: input.env,
      community: input.community,
      body: writeBody,
    })
    const analysisState = mergeAnalysisState(
      preparedSong.resolvedSongBundleForAsset.analysisState,
      postAnalysis.analysis_state,
    )
    const contentSafetyState = postAnalysis.content_safety_state === "safe"
      ? preparedSong.resolvedSongBundleForAsset.contentSafetyState
      : postAnalysis.content_safety_state
    const ageGatePolicy = preparedSong.resolvedSongBundleForAsset.ageGatePolicy === "18_plus" || postAnalysis.age_gate_policy === "18_plus"
      ? "18_plus"
      : "none"

    return {
      writeBody,
      analysisProviderResult: postAnalysis.providerResult,
      analysisOverride: buildAnalysisOverride({
        community: input.community,
        analysisState,
        contentSafetyState,
        ageGatePolicy,
      }),
      resolvedSongBundleForAsset,
      resolvedVideoAsset,
    }
  }

  if (input.body.post_type === "video") {
    const preparedVideo = await prepareVideoPostAsset({
      env: input.env,
      requestUrl: input.requestUrl,
      userId: input.userId,
      communityId: input.communityId,
      body: input.body,
    })
    writeBody = preparedVideo.writeBody
    resolvedVideoAsset = preparedVideo.resolvedVideoAsset
  }

  const postAnalysis = await input.postAnalysisProvider.analyze({
    env: input.env,
    community: input.community,
    body: writeBody,
  })

  return {
    writeBody,
    analysisProviderResult: postAnalysis.providerResult,
    analysisOverride: buildAnalysisOverride({
      community: input.community,
      analysisState: postAnalysis.analysis_state,
      contentSafetyState: postAnalysis.content_safety_state,
      ageGatePolicy: postAnalysis.age_gate_policy,
    }),
    resolvedSongBundleForAsset,
    resolvedVideoAsset,
  }
}
