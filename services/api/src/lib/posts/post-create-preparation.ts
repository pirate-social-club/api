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
import { decodePublicAssetId } from "../public-ids"

const STORY_IP_REF_PATTERN = /^story:ip:0x[a-fA-F0-9]{40}#licenseTermsId=\d+$/

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

async function validateVideoDerivativeSongRefs(input: {
  client: Client
  communityId: string
  body: CreatePostRequest
}): Promise<void> {
  if (input.body.post_type !== "video" || input.body.rights_basis !== "derivative") {
    return
  }

  const assetIds = new Set<string>()
  for (const sourceRef of input.body.upstream_asset_refs ?? []) {
    const normalized = sourceRef.trim()
    if (!normalized) continue
    if (STORY_IP_REF_PATTERN.test(normalized)) {
      continue
    }
    if (!normalized.startsWith("story:asset:")) {
      throw badRequestError("video upstream_asset_refs must be Story asset or IP refs")
    }
    const decodedAssetId = decodePublicAssetId(normalized.slice("story:asset:".length))
    if (!decodedAssetId.startsWith("ast_")) {
      throw badRequestError("video upstream_asset_refs must be Story asset or IP refs")
    }
    assetIds.add(decodedAssetId)
  }

  if (assetIds.size === 0) {
    return
  }

  const ids = [...assetIds]
  const placeholders = ids.map((_, index) => `?${index + 2}`).join(", ")
  const result = await input.client.execute({
    sql: `
      SELECT asset_id, asset_kind, story_ip_id, story_license_terms_id
      FROM assets
      WHERE community_id = ?1
        AND asset_id IN (${placeholders})
    `,
    args: [input.communityId, ...ids],
  })
  const rowsByAssetId = new Map(result.rows.map((row) => [String(row.asset_id), row]))

  for (const assetId of ids) {
    const row = rowsByAssetId.get(assetId)
    if (
      !row ||
      row.asset_kind !== "song_audio" ||
      !String(row.story_ip_id ?? "").trim() ||
      !String(row.story_license_terms_id ?? "").trim()
    ) {
      throw badRequestError("video upstream_asset_refs must reference registered song assets")
    }
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
    await validateVideoDerivativeSongRefs({
      client: input.communityDbClient,
      communityId: input.communityId,
      body: input.body,
    })
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
