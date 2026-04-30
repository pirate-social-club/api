import type { UserRepository } from "../auth/repositories"
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
  requireVerifiedHuman,
} from "./song-artifact-access"
import type { CreateSongArtifactBundleRequest, Env, SongArtifactBundle } from "../../types"
import type { SongArtifactCommunityRepository } from "./song-artifact-types"

export async function createSongArtifactBundle(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateSongArtifactBundleRequest
  userRepository: UserRepository
  communityRepository: SongArtifactCommunityRepository
}): Promise<SongArtifactBundle> {
  const lyrics = input.body.lyrics?.trim() || ""
  if (!lyrics) {
    throw badRequestError("lyrics is required")
  }
  if (input.body.preview_audio) {
    throw badRequestError("preview_audio uploads are not supported; use preview_window")
  }
  const previewWindow = parseSongPreviewWindow(input.body.preview_window)

  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)
    const client = getControlPlaneClient(input.env)
    const primaryAudioUpload = await requireResolvedUpload({
      client,
      communityId: input.communityId,
      userId: input.userId,
      ref: input.body.primary_audio,
      expectedKind: "primary_audio",
    })
    const coverArtUpload = input.body.cover_art
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.cover_art,
          expectedKind: "cover_art",
        })
      : null
    const canvasVideoUpload = input.body.canvas_video
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.canvas_video,
          expectedKind: "canvas_video",
        })
      : null
    const instrumentalAudioUpload = input.body.instrumental_audio
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.instrumental_audio,
          expectedKind: "instrumental_audio",
        })
      : null
    const vocalAudioUpload = input.body.vocal_audio
      ? await requireResolvedUpload({
          client,
          communityId: input.communityId,
          userId: input.userId,
          ref: input.body.vocal_audio,
          expectedKind: "vocal_audio",
        })
      : null

    const createdAt = nowIso()
    const songArtifactBundleId = makeId("sab")
    await createSongArtifactBundleDraft({
      client,
      communityId: input.communityId,
      userId: input.userId,
      songArtifactBundleId,
      body: {
        ...input.body,
        lyrics,
        preview_window: previewWindow,
      },
      primaryAudio: descriptorFromUpload(primaryAudioUpload),
      coverArt: coverArtUpload ? imageDescriptorFromUpload(coverArtUpload) : null,
      previewAudio: null,
      canvasVideo: canvasVideoUpload ? videoDescriptorFromUpload(canvasVideoUpload) : null,
      instrumentalAudio: instrumentalAudioUpload ? descriptorFromUpload(instrumentalAudioUpload) : null,
      vocalAudio: vocalAudioUpload ? descriptorFromUpload(vocalAudioUpload) : null,
      lyricsSha256: `0x${await sha256Hex(lyrics)}`,
      createdAt,
    })

    const analysis = await analyzeSongBundle({
      env: input.env,
      lyrics,
      primaryAudioUpload,
    })
    const finalized = await finalizeSongArtifactBundle({
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
    })

    if (finalized.preview_status === "pending") {
      await enqueueCommunityJob({
        client: db.client,
        communityId: input.communityId,
        jobType: "song_preview_generate",
        subjectType: "song_artifact_bundle",
        subjectId: finalized.id,
        payloadJson: JSON.stringify({
          song_artifact_bundle: finalized.id,
          primary_audio_content_hash: finalized.primary_audio.content_hash ?? null,
          preview_window: finalized.preview_window,
        }),
        createdAt: nowIso(),
      })
    }

    if (analysis.analysisState === "blocked") {
      throw analysisBlocked("Song artifact analysis blocked publication")
    }
    if (analysis.analysisState === "review_required") {
      throw analysisBlocked("Song artifact analysis requires review before publication")
    }

    return finalized
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
