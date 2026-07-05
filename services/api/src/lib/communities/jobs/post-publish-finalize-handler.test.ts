import { describe, expect, test } from "bun:test"

import type { SongArtifactBundle } from "../../../types"
import {
  buildSongPreviewJobRequest,
  postModerationPublishFailure,
  resolveFinalPostModeration,
  shouldRunPostPublishFinalize,
  songAnalysisPublishFailure,
} from "./post-publish-finalize-handler"

describe("shouldRunPostPublishFinalize", () => {
  test("only processing posts are eligible for finalize jobs", () => {
    expect(shouldRunPostPublishFinalize("processing")).toBe(true)
    expect(shouldRunPostPublishFinalize("failed")).toBe(false)
    expect(shouldRunPostPublishFinalize("published")).toBe(false)
    expect(shouldRunPostPublishFinalize("removed")).toBe(false)
  })
})

describe("songAnalysisPublishFailure", () => {
  test("turns blocked analysis into a terminal publish failure", () => {
    expect(songAnalysisPublishFailure({
      analysisState: "blocked",
      rightsBasis: "original",
      upstreamAssetRefs: [],
    })).toEqual({
      code: "song_analysis_blocked",
      message: "Song analysis blocked publication",
      retryable: false,
    })
  })

  test("turns required references without derivative refs into a terminal failed-card state", () => {
    expect(songAnalysisPublishFailure({
      analysisState: "allow_with_required_reference",
      rightsBasis: "original",
      upstreamAssetRefs: [],
    })).toEqual({
      code: "song_rights_reference_required",
      message: "Matched audio requires derivative rights and a reference",
      retryable: false,
    })
  })

  test("allows derivative posts with upstream references to continue publishing", () => {
    expect(songAnalysisPublishFailure({
      analysisState: "allow_with_required_reference",
      rightsBasis: "derivative",
      upstreamAssetRefs: ["asset_parent"],
    })).toBeNull()
  })
})

describe("post publish moderation resolution", () => {
  test("classifies request-time moderation failures separately from song analysis", () => {
    expect(postModerationPublishFailure({ analysisState: "review_required" })).toEqual({
      code: "text_moderation_blocked",
      message: "Post moderation blocked publication",
      retryable: false,
    })
    expect(postModerationPublishFailure({ analysisState: "allow" })).toBeNull()
  })

  test("preserves request-time safety and age-gate state when bundle analysis completes", () => {
    expect(resolveFinalPostModeration({
      postAnalysisState: "allow",
      postContentSafetyState: "sensitive",
      postAgeGatePolicy: "18_plus",
      bundleAnalysisState: "allow",
      bundleContentSafetyState: "safe",
      bundleAgeGatePolicy: "none",
    })).toEqual({
      analysis_state: "allow",
      content_safety_state: "sensitive",
      age_gate_policy: "18_plus",
    })
  })

  test("keeps the most restrictive bundle moderation result", () => {
    expect(resolveFinalPostModeration({
      postAnalysisState: "pending",
      postContentSafetyState: "safe",
      postAgeGatePolicy: "none",
      bundleAnalysisState: "allow_with_required_reference",
      bundleContentSafetyState: "adult",
      bundleAgeGatePolicy: "18_plus",
    })).toEqual({
      analysis_state: "allow_with_required_reference",
      content_safety_state: "adult",
      age_gate_policy: "18_plus",
    })
  })
})

describe("buildSongPreviewJobRequest", () => {
  function bundle(input: {
    id?: string
    previewStatus?: SongArtifactBundle["preview_status"]
    previewWindow?: SongArtifactBundle["preview_window"]
  } = {}): Pick<SongArtifactBundle, "id" | "preview_status" | "preview_window" | "primary_audio"> {
    return {
      id: input.id ?? "sab_bundle_1",
      preview_status: input.previewStatus ?? "pending",
      preview_window: Object.prototype.hasOwnProperty.call(input, "previewWindow")
        ? input.previewWindow ?? null
        : { start_ms: 12_000, duration_ms: 30_000 },
      primary_audio: {
        storage_ref: "https://media.test/audio.wav",
        mime_type: "audio/wav",
        size_bytes: 1234,
        content_hash: "0xabc123",
        duration_ms: 45_000,
      },
    }
  }

  test("builds the existing song_preview_generate subject and payload for pending preview windows", () => {
    const request = buildSongPreviewJobRequest(bundle())

    expect(request?.subjectId).toBe("bundle_1")
    expect(JSON.parse(request?.payloadJson ?? "{}")).toEqual({
      song_artifact_bundle: "bundle_1",
      primary_audio_content_hash: "0xabc123",
      preview_window: { start_ms: 12_000, duration_ms: 30_000 },
    })
  })

  test("does not enqueue previews for completed or windowless bundles", () => {
    expect(buildSongPreviewJobRequest(bundle({ previewStatus: "completed" }))).toBeNull()
    expect(buildSongPreviewJobRequest(bundle({ previewWindow: null }))).toBeNull()
    expect(buildSongPreviewJobRequest(null)).toBeNull()
  })
})
