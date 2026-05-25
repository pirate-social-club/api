import { openCommunityDb } from "../communities/community-db-factory"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { analysisBlocked, badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { sha256Hex } from "../crypto"
import { analyzeSongBundle } from "./song-artifact-analysis"
import {
  createSongArtifactBundleDraft,
  finalizeSongArtifactBundle,
  getSongArtifactBundle,
  listSongArtifactBundles,
} from "./song-artifact-repository"
import { parseSongPreviewWindow } from "./song-artifact-preview"
import {
  descriptorFromUpload,
  imageDescriptorFromUpload,
  videoDescriptorFromUpload,
} from "./song-artifact-descriptors"
import {
  requireActiveCommunity,
  requireMemberAccess,
  requireResolvedUpload,
} from "./song-artifact-access"
import type { Env } from "../../env"
import type { CreateSongArtifactBundleRequest, SongArtifactBundle, SongArtifactBundleListResponse } from "../../types"
import type { SongArtifactCommunityRepository } from "./song-artifact-types"

const SONG_BUNDLE_SLOW_STEP_MS = 10_000
const SONG_BUNDLE_STALLED_STEP_MS = 45_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function normalizeGeniusAnnotationsUrl(input: string | null | undefined): string | null {
  const value = input?.trim()
  if (!value) {
    return null
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw badRequestError("genius_annotations_url must be a Genius URL")
  }

  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== "https:" || (hostname !== "genius.com" && hostname !== "www.genius.com")) {
    throw badRequestError("genius_annotations_url must be a Genius URL")
  }

  url.hostname = "genius.com"
  return url.toString()
}

async function withSongBundleStep<T>(
  step: string,
  fields: Record<string, unknown>,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now()
  console.info("[song-artifacts] bundle step started", { ...fields, step })
  const slowTimer = setTimeout(() => {
    console.warn("[song-artifacts] bundle step still pending", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      step,
    })
  }, SONG_BUNDLE_SLOW_STEP_MS)
  const stalledTimer = setTimeout(() => {
    console.warn("[song-artifacts] bundle step appears stalled", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      step,
    })
  }, SONG_BUNDLE_STALLED_STEP_MS)

  try {
    const result = await operation()
    console.info("[song-artifacts] bundle step completed", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      step,
    })
    return result
  } catch (error) {
    console.error("[song-artifacts] bundle step failed", {
      ...fields,
      elapsed_ms: Date.now() - startedAt,
      message: errorMessage(error),
      step,
    })
    throw error
  } finally {
    clearTimeout(slowTimer)
    clearTimeout(stalledTimer)
  }
}

export async function createSongArtifactBundle(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateSongArtifactBundleRequest
  communityRepository: SongArtifactCommunityRepository
}): Promise<SongArtifactBundle> {
  const lyrics = input.body.lyrics?.trim() || ""
  const title = input.body.title?.trim() || ""
  if (!title) {
    throw badRequestError("title is required")
  }
  if (input.body.preview_audio) {
    throw badRequestError("preview_audio uploads are not supported; use preview_window")
  }
  const geniusAnnotationsUrl = normalizeGeniusAnnotationsUrl(input.body.genius_annotations_url)
  const previewWindow = parseSongPreviewWindow(input.body.preview_window)
  const requestStartedAt = Date.now()
  console.info("[song-artifacts] create bundle requested", {
    community_id: input.communityId,
    has_canvas_video: Boolean(input.body.canvas_video),
    has_cover_art: Boolean(input.body.cover_art),
    has_genius_annotations_url: Boolean(geniusAnnotationsUrl),
    has_instrumental_audio: Boolean(input.body.instrumental_audio),
    has_preview_window: Boolean(previewWindow),
    has_vocal_audio: Boolean(input.body.vocal_audio),
    lyrics_length: lyrics.length,
    title_length: title.length,
    user_id: input.userId,
  })

  await withSongBundleStep("require active community", {
    community_id: input.communityId,
  }, () => requireActiveCommunity(input.communityRepository, input.communityId))

  const db = await withSongBundleStep("open community db", {
    community_id: input.communityId,
  }, () => openCommunityDb(input.env, input.communityRepository, input.communityId))
  try {
    await withSongBundleStep("require member access", {
      community_id: input.communityId,
      user_id: input.userId,
    }, () => requireMemberAccess(db.client, input.communityId, input.userId))
    const client = getControlPlaneClient(input.env)
    const primaryAudioUpload = await withSongBundleStep("resolve primary audio upload", {
      community_id: input.communityId,
      upload_ref: input.body.primary_audio.song_artifact_upload,
      user_id: input.userId,
    }, () => requireResolvedUpload({
      client,
      communityId: input.communityId,
      userId: input.userId,
      ref: input.body.primary_audio,
      expectedKind: "primary_audio",
    }))
    const coverArtRef = input.body.cover_art
    const coverArtUpload = coverArtRef
      ? await withSongBundleStep("resolve cover art upload", {
          community_id: input.communityId,
          upload_ref: coverArtRef.song_artifact_upload,
          user_id: input.userId,
        }, () => requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: coverArtRef,
          expectedKind: "cover_art",
        }))
      : null
    const canvasVideoRef = input.body.canvas_video
    const canvasVideoUpload = canvasVideoRef
      ? await withSongBundleStep("resolve canvas video upload", {
          community_id: input.communityId,
          upload_ref: canvasVideoRef.song_artifact_upload,
          user_id: input.userId,
        }, () => requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: canvasVideoRef,
          expectedKind: "canvas_video",
        }))
      : null
    const instrumentalAudioRef = input.body.instrumental_audio
    const instrumentalAudioUpload = instrumentalAudioRef
      ? await withSongBundleStep("resolve instrumental audio upload", {
          community_id: input.communityId,
          upload_ref: instrumentalAudioRef.song_artifact_upload,
          user_id: input.userId,
        }, () => requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: instrumentalAudioRef,
          expectedKind: "instrumental_audio",
        }))
      : null
    const vocalAudioRef = input.body.vocal_audio
    const vocalAudioUpload = vocalAudioRef
      ? await withSongBundleStep("resolve vocal audio upload", {
          community_id: input.communityId,
          upload_ref: vocalAudioRef.song_artifact_upload,
          user_id: input.userId,
        }, () => requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: vocalAudioRef,
          expectedKind: "vocal_audio",
        }))
      : null

    const createdAt = nowIso()
    const songArtifactBundleId = makeId("sab")
    const lyricsSha256 = `0x${await sha256Hex(lyrics)}`
    await withSongBundleStep("create bundle draft", {
      community_id: input.communityId,
      song_artifact_bundle_id: songArtifactBundleId,
      user_id: input.userId,
    }, () => createSongArtifactBundleDraft({
      client,
      communityId: input.communityId,
      userId: input.userId,
      songArtifactBundleId,
      body: {
        ...input.body,
        title,
        lyrics,
        preview_window: previewWindow,
      },
      primaryAudio: descriptorFromUpload(primaryAudioUpload),
      coverArt: coverArtUpload ? imageDescriptorFromUpload(coverArtUpload) : null,
      previewAudio: null,
      canvasVideo: canvasVideoUpload ? videoDescriptorFromUpload(canvasVideoUpload) : null,
      instrumentalAudio: instrumentalAudioUpload ? descriptorFromUpload(instrumentalAudioUpload) : null,
      vocalAudio: vocalAudioUpload ? descriptorFromUpload(vocalAudioUpload) : null,
      lyricsSha256,
      geniusAnnotationsUrl,
      createdAt,
    }))

    const analysis = await withSongBundleStep("analyze song bundle", {
      community_id: input.communityId,
      primary_audio_upload: primaryAudioUpload.id,
      song_artifact_bundle_id: songArtifactBundleId,
    }, () => analyzeSongBundle({
      env: input.env,
      lyrics,
      primaryAudioUpload,
    }))
    const finalized = await withSongBundleStep("finalize bundle", {
      alignment_status: analysis.alignmentStatus,
      analysis_state: analysis.analysisState,
      community_id: input.communityId,
      moderation_status: analysis.moderationStatus,
      preview_status: previewWindow ? "pending" : "completed",
      song_artifact_bundle_id: songArtifactBundleId,
    }, () => finalizeSongArtifactBundle({
      client,
      communityId: input.communityId,
      songArtifactBundleId,
      status:
        analysis.analysisState === "blocked" || analysis.analysisState === "review_required"
          ? "failed"
          : "ready",
      translationStatus: "pending",
      translationError: null,
      translatedLyricsRef: null,
      translatedLyrics: null,
      alignmentStatus: analysis.alignmentStatus,
      alignmentError: analysis.alignmentError,
      timedLyricsRef: null,
      timedLyrics: analysis.timedLyrics,
      moderationStatus: analysis.moderationStatus,
      moderationError: analysis.moderationError,
      moderationResultRef: null,
      moderationResult: analysis.moderationResult,
      previewStatus: previewWindow ? "pending" : "completed",
      previewError: null,
      updatedAt: nowIso(),
    }))

    if (finalized.preview_status === "pending") {
      const songArtifactBundleId = finalized.id.replace(/^sab_/, "")
      await withSongBundleStep("enqueue preview generation job", {
        community_id: input.communityId,
        song_artifact_bundle: finalized.id,
      }, () => enqueueCommunityJob({
        client: db.client,
        communityId: input.communityId,
        jobType: "song_preview_generate",
        subjectType: "song_artifact_bundle",
        subjectId: songArtifactBundleId,
        payloadJson: JSON.stringify({
          song_artifact_bundle: songArtifactBundleId,
          primary_audio_content_hash: finalized.primary_audio.content_hash ?? null,
          preview_window: finalized.preview_window,
        }),
        createdAt: nowIso(),
      }))
    }

    if (analysis.analysisState === "blocked") {
      throw analysisBlocked("Song artifact analysis blocked publication")
    }
    if (analysis.analysisState === "review_required") {
      throw analysisBlocked("Song artifact analysis requires review before publication")
    }

    console.info("[song-artifacts] create bundle completed", {
      alignment_status: finalized.alignment_status,
      analysis_state: analysis.analysisState,
      community_id: input.communityId,
      elapsed_ms: Date.now() - requestStartedAt,
      moderation_status: finalized.moderation_status,
      preview_status: finalized.preview_status,
      song_artifact_bundle: finalized.id,
      status: finalized.status,
      user_id: input.userId,
    })
    return finalized
  } catch (error) {
    console.error("[song-artifacts] create bundle failed", {
      community_id: input.communityId,
      elapsed_ms: Date.now() - requestStartedAt,
      message: errorMessage(error),
      user_id: input.userId,
    })
    throw error
  } finally {
    db.close()
  }
}

export async function getSongArtifactBundleForCreator(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactBundleId: string
}): Promise<SongArtifactBundle> {
  const client = getControlPlaneClient(input.env)
  const bundle = await getSongArtifactBundle(client, input.communityId, input.songArtifactBundleId)
  if (!bundle || bundle.creator_user !== `usr_${input.userId}`) {
    throw notFoundError("Song artifact bundle not found")
  }
  return bundle
}

export async function listSongArtifactBundlesForCreator(input: {
  env: Env
  userId: string
  communityId: string
  query?: string | null
  limit: number
  communityRepository: SongArtifactCommunityRepository
}): Promise<SongArtifactBundleListResponse> {
  await requireActiveCommunity(input.communityRepository, input.communityId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
  } finally {
    db.close()
  }

  return await listSongArtifactBundles({
    client: getControlPlaneClient(input.env),
    communityId: input.communityId,
    creatorUserId: input.userId,
    query: input.query,
    limit: input.limit,
  })
}
