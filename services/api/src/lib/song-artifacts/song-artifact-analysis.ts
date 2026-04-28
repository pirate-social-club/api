import type { Env, Post, SongArtifactUpload } from "../../types"
import { evaluateAudioIdentification } from "./song-audio-identification"
import { evaluateAlignment } from "./song-lyrics-alignment"
import { evaluateLyricsModeration } from "./song-lyrics-moderation"

export type SongBundleAnalysisResult = {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
  moderationStatus: "completed" | "failed"
  moderationError: string | null
  moderationResult: Record<string, unknown> | null
  alignmentStatus: "completed" | "failed"
  alignmentError: string | null
  timedLyrics: Record<string, unknown> | null
}

function mergeAnalysisStates(
  left: Post["analysis_state"],
  right: Post["analysis_state"],
): Post["analysis_state"] {
  const precedence: Record<Post["analysis_state"], number> = {
    blocked: 4,
    review_required: 3,
    allow_with_required_reference: 2,
    allow: 1,
    pending: 0,
  }
  return precedence[left] >= precedence[right] ? left : right
}

export async function analyzeSongBundle(input: {
  env: Env
  lyrics: string
  primaryAudioUpload: SongArtifactUpload
}): Promise<SongBundleAnalysisResult> {
  const lyricsModeration = await evaluateLyricsModeration({
    env: input.env,
    lyrics: input.lyrics,
  })
  const audioIdentification = await evaluateAudioIdentification({
    env: input.env,
    primaryAudioUpload: input.primaryAudioUpload,
  })
  const alignment = await evaluateAlignment({
    env: input.env,
    lyrics: input.lyrics,
    primaryAudioUpload: input.primaryAudioUpload,
  })
  const analysisState = mergeAnalysisStates(lyricsModeration.analysisState, audioIdentification.analysisState)

  return {
    analysisState,
    contentSafetyState: lyricsModeration.contentSafetyState,
    ageGatePolicy: lyricsModeration.ageGatePolicy,
    moderationStatus:
      lyricsModeration.moderationStatus === "failed" || audioIdentification.moderationStatus === "failed"
        ? "failed"
        : "completed",
    moderationError: lyricsModeration.moderationError || audioIdentification.moderationError,
    moderationResult: {
      provider: "song_bundle_analysis",
      lyrics: lyricsModeration.moderationResult,
      audio_identification: audioIdentification.moderationResult,
      analysis_state: analysisState,
      content_safety_state: lyricsModeration.contentSafetyState,
      age_gate_policy: lyricsModeration.ageGatePolicy,
    },
    alignmentStatus: alignment.alignmentStatus,
    alignmentError: alignment.alignmentError,
    timedLyrics: alignment.timedLyrics,
  }
}
