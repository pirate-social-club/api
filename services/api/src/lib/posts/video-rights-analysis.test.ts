import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"

import {
  computeVideoRightsOutcome,
  findSyncedVideoAudioCatalogEnrollment,
  hasSyncedVideoAudioCatalogEnrollment,
  persistVideoAudioCatalogEnrollment,
  persistVideoRightsAnalysis,
  type VideoAudioSafetyEvaluation,
  type VideoRightsAcrEvaluation,
  type VideoRightsDeclaredReferences,
} from "./video-rights-analysis"
import {
  chooseVideoSampleWindow,
  enqueueVideoAudioCatalogUnenrollIfEnabled,
  mergeVideoAudioSafetyWithPost,
  parseAcrEvaluation,
  unenrollVideoAudioCatalogSample,
} from "../communities/jobs/video-media-analysis-handler"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "../communities/jobs/runner-types"
import { mockFetch } from "../../test-helpers/fetch"

function acr(overrides: Partial<VideoRightsAcrEvaluation> = {}): VideoRightsAcrEvaluation {
  return {
    providerError: null,
    missingConfiguration: false,
    musicMatches: [],
    customMatches: [],
    providerResult: null,
    ...overrides,
  }
}

function declared(overrides: Partial<VideoRightsDeclaredReferences> = {}): VideoRightsDeclaredReferences {
  return {
    declaredBundleIds: [],
    declaredAssetIds: [],
    unresolvedRefs: [],
    ...overrides,
  }
}

function audioSafety(overrides: Partial<VideoAudioSafetyEvaluation> = {}): VideoAudioSafetyEvaluation {
  return {
    contentSafetyState: "safe",
    ageGatePolicy: "none",
    transcript: "clean transcript",
    transcriptProviderResult: { provider: "elevenlabs" },
    moderationStatus: "completed",
    moderationError: null,
    moderationResult: { provider: "video_audio_safety" },
    ...overrides,
  }
}

describe("computeVideoRightsOutcome", () => {
  test("declared source verified by catalog match allows", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_1"], declaredAssetIds: ["ast_1"] }),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", matchSource: "platform_song", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("declared_reference_verified")
    expect(decision.caseTrigger).toBeNull()
  })

  test("catalog match without any declaration requires a reference", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", matchSource: "platform_song", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow_with_required_reference")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("catalog match different from the declared song goes to review", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_declared"], declaredAssetIds: ["ast_1"] }),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_other", matchSource: "platform_song", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("declared_reference_mismatch")
    expect(decision.caseTrigger).toBe("declared_reference_mismatch")
  })

  test("unmappable catalog match goes to review", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: null, matchSource: "platform_song", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("unmappable_catalog_match")
  })

  test("platform video-audio-only match allows as a log-only identity signal", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: null, matchSource: "platform_video_audio", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("platform_video_audio_match")
    expect(decision.caseTrigger).toBeNull()
  })

  test("platform video-audio match neither suppresses nor exculpates song enforcement", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({
        customMatches: [
          { song_artifact_bundle_id: null, matchSource: "platform_song", raw: {} },
          { song_artifact_bundle_id: null, matchSource: "platform_video_audio", raw: {} },
        ],
      }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("unmappable_catalog_match")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("commercial catalog match goes to review by default", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ musicMatches: [{ title: "Famous Song" }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("commercial_catalog_match")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("commercial catalog match blocks when enforcement is enabled", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ musicMatches: [{ title: "Famous Song" }] }),
      audioTrackPresent: true,
      blockCommercialMusicMatches: true,
    })
    expect(decision.outcome).toBe("blocked")
    expect(decision.policyReasonCode).toBe("commercial_catalog_match")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("commercial catalog match outranks a simultaneous declared-and-verified platform match", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_1"], declaredAssetIds: ["ast_1"] }),
      acr: acr({
        customMatches: [{ song_artifact_bundle_id: "sab_1", matchSource: "platform_song", raw: {} }],
        musicMatches: [{ title: "Same Song, Commercial Release" }],
      }),
      audioTrackPresent: true,
      blockCommercialMusicMatches: true,
    })
    expect(decision.outcome).toBe("blocked")
    expect(decision.policyReasonCode).toBe("commercial_catalog_match")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("no match with a declaration allows (covers do not fingerprint)", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared({ unresolvedRefs: ["story:ip:0xabc"] }),
      acr: acr(),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("declared_reference_unmatched")
  })

  test("no match and no declaration allows", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr(),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("no_match")
  })

  test("missing ACR configuration allows without a case", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ missingConfiguration: true }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("acr_not_configured")
  })

  test("exhausted provider failure goes to review", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ providerError: "http_500" }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("acr_provider_failed")
  })

  test("no audio track allows", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr(),
      audioTrackPresent: false,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("no_audio_track")
  })

  test("skipped analysis allows and records why", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr(),
      audioTrackPresent: true,
      analysisSkippedReason: "source_too_large",
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("analysis_skipped_source_too_large")
  })
})

describe("parseAcrEvaluation", () => {
  test("classifies custom matches by user_defined content_type", () => {
    const evaluation = parseAcrEvaluation({
      metadata: {
        custom_files: [
          { acr_id: "song", user_defined: { song_artifact_bundle_id: "sab_1" } },
          { acr_id: "video", user_defined: { content_type: "video_audio" } },
        ],
      },
    })
    expect(evaluation.customMatches).toHaveLength(2)
    expect(evaluation.customMatches[0]).toMatchObject({
      song_artifact_bundle_id: "sab_1",
      matchSource: "platform_song",
    })
    expect(evaluation.customMatches[1]).toMatchObject({
      song_artifact_bundle_id: null,
      matchSource: "platform_video_audio",
    })
  })

  test("classifies flattened user_defined fields the same way", () => {
    const evaluation = parseAcrEvaluation({
      metadata: {
        custom_files: [
          { acr_id: "video", content_type: "video_audio" },
        ],
      },
    })
    expect(evaluation.customMatches[0]?.matchSource).toBe("platform_video_audio")
  })

  test("untagged legacy entries classify as platform songs", () => {
    const evaluation = parseAcrEvaluation({
      metadata: {
        custom_files: [
          { acr_id: "legacy", user_defined: { source: "pirate", content_hash: "0xabc" } },
        ],
      },
    })
    expect(evaluation.customMatches[0]?.matchSource).toBe("platform_song")
  })
})

describe("chooseVideoSampleWindow", () => {
  test("unknown duration uses the default window", () => {
    expect(chooseVideoSampleWindow(null)).toEqual({ start_ms: 15_000, duration_ms: 60_000 })
  })

  test("short clips sample from 20% in", () => {
    expect(chooseVideoSampleWindow(30_000)).toEqual({ start_ms: 6_000, duration_ms: 24_000 })
  })

  test("long videos cap the start offset and window length", () => {
    expect(chooseVideoSampleWindow(20 * 60_000)).toEqual({ start_ms: 45_000, duration_ms: 60_000 })
  })
})

describe("mergeVideoAudioSafetyWithPost", () => {
  test("raises content safety and age gate when transcript classification is stricter", () => {
    expect(mergeVideoAudioSafetyWithPost({
      postContentSafetyState: "safe",
      postAgeGatePolicy: "none",
      audioSafety: audioSafety({
        contentSafetyState: "adult",
        ageGatePolicy: "18_plus",
      }),
    })).toEqual({
      content_safety_state: "adult",
      age_gate_policy: "18_plus",
    })
  })

  test("does not downgrade an existing stricter post state", () => {
    expect(mergeVideoAudioSafetyWithPost({
      postContentSafetyState: "adult",
      postAgeGatePolicy: "18_plus",
      audioSafety: audioSafety({
        contentSafetyState: "safe",
        ageGatePolicy: "none",
      }),
    })).toBeNull()
  })

  test("ignores skipped or failed audio safety attempts", () => {
    expect(mergeVideoAudioSafetyWithPost({
      postContentSafetyState: "safe",
      postAgeGatePolicy: "none",
      audioSafety: audioSafety({
        contentSafetyState: "pending",
        moderationStatus: "skipped",
        moderationError: "missing_elevenlabs_configuration",
      }),
    })).toBeNull()
  })
})

describe("persistVideoRightsAnalysis", () => {
  const clients: Array<ReturnType<typeof createClient>> = []

  afterEach(() => {
    for (const client of clients.splice(0)) {
      client.close()
    }
  })

  async function createTestClient() {
    const client = createClient({ url: ":memory:" })
    clients.push(client)
    await client.execute(`
      CREATE TABLE media_analysis_results (
        media_analysis_result_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        source_post_id TEXT,
        source_asset_id TEXT,
        outcome TEXT NOT NULL CHECK (
          outcome IN ('allow', 'allow_with_required_reference', 'review_required', 'blocked')
        ),
        content_safety_state TEXT NOT NULL CHECK (
          content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
        ),
        age_gate_policy TEXT NOT NULL CHECK (age_gate_policy IN ('none', '18_plus')),
        trigger_sources_json TEXT,
        acrcloud_music_match_json TEXT,
        acrcloud_custom_match_json TEXT,
        acrcloud_error_code TEXT,
        acrcloud_error_message TEXT,
        acrcloud_checked_at TEXT,
        safety_signals_json TEXT,
        authenticity_signals_json TEXT,
        policy_reason_code TEXT,
        policy_reason TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    await client.execute(`
      CREATE TABLE asset_derivative_links (
        asset_derivative_link_id TEXT PRIMARY KEY,
        asset_id TEXT NOT NULL,
        upstream_asset_id TEXT NOT NULL,
        relationship_type TEXT NOT NULL CHECK (
          relationship_type IN ('remix_of', 'references_song', 'inspired_by', 'samples')
        ),
        created_at TEXT NOT NULL
      )
    `)
    await client.execute(`
      CREATE TABLE rights_review_cases (
        rights_review_case_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL CHECK (
          subject_type IN ('asset', 'post', 'live_room', 'replay_asset')
        ),
        subject_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'under_review', 'resolved', 'blocked')),
        trigger_source TEXT NOT NULL CHECK (
          trigger_source IN ('acrcloud_match', 'declared_reference_mismatch', 'manual_report', 'operator_escalation')
        ),
        analysis_result_ref TEXT,
        submitted_evidence_refs_json TEXT,
        resolution TEXT CHECK (
          resolution IS NULL OR resolution IN ('clear', 'clear_with_upstream_refs', 'block', 'needs_more_evidence')
        ),
        resolver_user_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      )
    `)
    await client.execute(`
      CREATE UNIQUE INDEX idx_rights_review_cases_open_subject_trigger
        ON rights_review_cases(subject_type, subject_id, trigger_source)
        WHERE status IN ('open', 'under_review')
    `)
    await client.execute(`
      CREATE TABLE rights_holds (
        rights_hold_id TEXT PRIMARY KEY,
        subject_type TEXT NOT NULL CHECK (
          subject_type IN ('asset', 'post', 'live_room', 'replay_asset')
        ),
        subject_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        hold_type TEXT NOT NULL CHECK (
          hold_type IN ('reference_required', 'review_hold', 'blocked')
        ),
        source_case_id TEXT,
        analysis_result_ref TEXT,
        status TEXT NOT NULL CHECK (status IN ('active', 'released')),
        reason_code TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        released_at TEXT
      )
    `)
    await client.execute(`
      CREATE UNIQUE INDEX idx_rights_holds_active_subject
        ON rights_holds(subject_type, subject_id)
        WHERE status = 'active'
    `)
    return client
  }

  test("persists the outcome row, declared links, and a review case", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_declared"], declaredAssetIds: ["ast_up"] }),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_other", matchSource: "platform_song", raw: { acr_id: "x" } }] }),
      audioTrackPresent: true,
    })
    const persisted = await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_video",
      assetId: "ast_video",
      decision,
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_other", matchSource: "platform_song", raw: { acr_id: "x" } }] }),
      declared: declared({ declaredBundleIds: ["sab_declared"], declaredAssetIds: ["ast_up"] }),
      sampleWindow: { start_ms: 15_000, duration_ms: 60_000 },
    })

    const analysisRows = await client.execute("SELECT * FROM media_analysis_results")
    expect(analysisRows.rows).toHaveLength(1)
    expect(analysisRows.rows[0]?.outcome).toBe("review_required")
    expect(analysisRows.rows[0]?.source_post_id).toBe("pst_video")
    expect(analysisRows.rows[0]?.source_asset_id).toBe("ast_video")
    expect(analysisRows.rows[0]?.policy_reason_code).toBe("declared_reference_mismatch")

    const linkRows = await client.execute("SELECT * FROM asset_derivative_links")
    expect(linkRows.rows).toHaveLength(1)
    expect(linkRows.rows[0]?.asset_id).toBe("ast_video")
    expect(linkRows.rows[0]?.upstream_asset_id).toBe("ast_up")
    expect(linkRows.rows[0]?.relationship_type).toBe("references_song")

    const caseRows = await client.execute("SELECT * FROM rights_review_cases")
    expect(caseRows.rows).toHaveLength(1)
    expect(caseRows.rows[0]?.subject_type).toBe("asset")
    expect(caseRows.rows[0]?.subject_id).toBe("ast_video")
    expect(caseRows.rows[0]?.trigger_source).toBe("declared_reference_mismatch")
    expect(caseRows.rows[0]?.analysis_result_ref).toBe(persisted.mediaAnalysisResultId)
    expect(persisted.rightsReviewCaseId).toBe(caseRows.rows[0]?.rights_review_case_id as string)

    const holdRows = await client.execute("SELECT * FROM rights_holds")
    expect(holdRows.rows).toHaveLength(1)
    expect(holdRows.rows[0]?.subject_type).toBe("asset")
    expect(holdRows.rows[0]?.subject_id).toBe("ast_video")
    expect(holdRows.rows[0]?.hold_type).toBe("review_hold")
    expect(holdRows.rows[0]?.source_case_id).toBe(persisted.rightsReviewCaseId)
    expect(holdRows.rows[0]?.analysis_result_ref).toBe(persisted.mediaAnalysisResultId)
  })

  test("posts without an asset open post-subject cases and skip links", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", matchSource: "platform_song", raw: {} }] }),
      audioTrackPresent: true,
    })
    await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_public_video",
      assetId: null,
      decision,
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", matchSource: "platform_song", raw: {} }] }),
      declared: declared(),
      sampleWindow: null,
    })

    const caseRows = await client.execute("SELECT subject_type, subject_id FROM rights_review_cases")
    expect(caseRows.rows).toHaveLength(1)
    expect(caseRows.rows[0]?.subject_type).toBe("post")
    expect(caseRows.rows[0]?.subject_id).toBe("pst_public_video")
    const linkRows = await client.execute("SELECT * FROM asset_derivative_links")
    expect(linkRows.rows).toHaveLength(0)
    const holdRows = await client.execute("SELECT subject_type, subject_id, hold_type FROM rights_holds")
    expect(holdRows.rows).toEqual([{
      subject_type: "post",
      subject_id: "pst_public_video",
      hold_type: "reference_required",
    }])
  })

  test("re-analysis does not duplicate an open case or derivative link", async () => {
    const client = await createTestClient()
    const inputs = {
      communityId: "cmt_test",
      postId: "pst_video",
      assetId: "ast_video",
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", matchSource: "platform_song", raw: {} }] }),
      declared: declared({ declaredBundleIds: [], declaredAssetIds: ["ast_up"], unresolvedRefs: [] }),
      sampleWindow: null,
    }
    const decision = computeVideoRightsOutcome({
      declared: inputs.declared,
      acr: inputs.acr,
      audioTrackPresent: true,
    })
    const first = await persistVideoRightsAnalysis({ client, decision, ...inputs })
    const second = await persistVideoRightsAnalysis({ client, decision, ...inputs })

    expect(first.rightsReviewCaseId).not.toBeNull()
    expect(second.rightsReviewCaseId).toBeNull()
    const caseRows = await client.execute("SELECT * FROM rights_review_cases")
    expect(caseRows.rows).toHaveLength(1)
    const linkRows = await client.execute("SELECT * FROM asset_derivative_links")
    expect(linkRows.rows).toHaveLength(1)
    const analysisRows = await client.execute("SELECT * FROM media_analysis_results")
    expect(analysisRows.rows).toHaveLength(2)
  })

  test("does not mark ACR checked when analysis never called ACR", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr(),
      audioTrackPresent: false,
    })
    await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_silent_video",
      assetId: null,
      decision,
      acr: acr(),
      declared: declared(),
      sampleWindow: null,
      createdAt: "2026-07-06T14:30:00.000Z",
    })

    const analysisRows = await client.execute("SELECT policy_reason_code, acrcloud_checked_at FROM media_analysis_results")
    expect(analysisRows.rows).toHaveLength(1)
    expect(analysisRows.rows[0]?.policy_reason_code).toBe("no_audio_track")
    expect(analysisRows.rows[0]?.acrcloud_checked_at).toBeNull()
  })

  test("marks ACR checked when provider returned a no-match result", async () => {
    const client = await createTestClient()
    const providerResult = { status: { code: 1001, msg: "No result" } }
    const acrResult = acr({ providerResult })
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acrResult,
      audioTrackPresent: true,
    })
    await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_checked_video",
      assetId: null,
      decision,
      acr: acrResult,
      declared: declared(),
      sampleWindow: { start_ms: 15_000, duration_ms: 60_000 },
      createdAt: "2026-07-06T14:31:00.000Z",
    })

    const analysisRows = await client.execute("SELECT policy_reason_code, acrcloud_checked_at FROM media_analysis_results")
    expect(analysisRows.rows).toHaveLength(1)
    expect(analysisRows.rows[0]?.policy_reason_code).toBe("no_match")
    expect(analysisRows.rows[0]?.acrcloud_checked_at).toBe("2026-07-06T14:31:00.000Z")
  })

  test("persists video audio safety classification signals", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr(),
      audioTrackPresent: true,
    })
    await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_audio_safety",
      assetId: null,
      decision,
      acr: acr({ providerResult: { status: { code: 1001 } } }),
      declared: declared(),
      audioSafety: audioSafety({
        contentSafetyState: "adult",
        ageGatePolicy: "18_plus",
        transcript: "explicit transcript",
        transcriptProviderResult: { provider: "elevenlabs", model: "scribe_v2" },
        moderationResult: {
          provider: "video_audio_safety",
          text_age_gate: {
            age_gate_policy: "18_plus",
            content_safety_state: "adult",
          },
        },
      }),
      sampleWindow: { start_ms: 15_000, duration_ms: 60_000 },
    })

    const analysisRows = await client.execute("SELECT content_safety_state, age_gate_policy, safety_signals_json FROM media_analysis_results")
    expect(analysisRows.rows).toHaveLength(1)
    expect(analysisRows.rows[0]?.content_safety_state).toBe("adult")
    expect(analysisRows.rows[0]?.age_gate_policy).toBe("18_plus")
    const safetySignals = JSON.parse(String(analysisRows.rows[0]?.safety_signals_json)) as {
      transcript: string
      content_safety_state: string
      age_gate_policy: string
    }
    expect(safetySignals.transcript).toBe("explicit transcript")
    expect(safetySignals.content_safety_state).toBe("adult")
    expect(safetySignals.age_gate_policy).toBe("18_plus")
  })

  test("video-audio-only match persists the log payload without a review case or hold", async () => {
    const client = await createTestClient()
    const acrResult = acr({
      customMatches: [{
        song_artifact_bundle_id: null,
        matchSource: "platform_video_audio",
        raw: { acr_id: "vid_1", user_defined: { content_type: "video_audio" } },
      }],
      providerResult: { status: { code: 0 } },
    })
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acrResult,
      audioTrackPresent: true,
    })
    const persisted = await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_repost_video",
      assetId: null,
      decision,
      acr: acrResult,
      declared: declared(),
      sampleWindow: null,
    })

    expect(persisted.rightsReviewCaseId).toBeNull()
    const caseRows = await client.execute("SELECT * FROM rights_review_cases")
    expect(caseRows.rows).toHaveLength(0)
    const holdRows = await client.execute("SELECT * FROM rights_holds")
    expect(holdRows.rows).toHaveLength(0)

    const analysisRows = await client.execute(
      "SELECT outcome, policy_reason_code, acrcloud_custom_match_json FROM media_analysis_results",
    )
    expect(analysisRows.rows).toHaveLength(1)
    expect(analysisRows.rows[0]?.outcome).toBe("allow")
    expect(analysisRows.rows[0]?.policy_reason_code).toBe("platform_video_audio_match")
    const loggedMatches = JSON.parse(String(analysisRows.rows[0]?.acrcloud_custom_match_json)) as Array<{
      user_defined?: { content_type?: string }
    }>
    expect(loggedMatches).toHaveLength(1)
    expect(loggedMatches[0]?.user_defined?.content_type).toBe("video_audio")
  })

  test("catalog enrollment evidence preserves existing authenticity signals", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredAssetIds: ["ast_upstream"] }),
      acr: acr(),
      audioTrackPresent: true,
    })
    const persisted = await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_catalog_enrollment",
      assetId: null,
      decision,
      acr: acr({ providerResult: { status: { code: 1001 } } }),
      declared: declared({ declaredAssetIds: ["ast_upstream"] }),
      sampleWindow: { start_ms: 6_000, duration_ms: 24_000 },
    })

    await persistVideoAudioCatalogEnrollment({
      client,
      mediaAnalysisResultId: persisted.mediaAnalysisResultId,
      catalogEnrollment: {
        provider: "acrcloud_catalog",
        attempted: true,
        synced: true,
        acr_id: "acr_video_123",
      },
    })

    const rows = await client.execute(
      "SELECT authenticity_signals_json FROM media_analysis_results WHERE media_analysis_result_id = ?1",
      [persisted.mediaAnalysisResultId],
    )
    const signals = JSON.parse(String(rows.rows[0]?.authenticity_signals_json)) as {
      declared_asset_ids?: string[]
      video_audio_catalog_enrollment?: { synced?: boolean; acr_id?: string }
    }
    expect(signals.declared_asset_ids).toEqual(["ast_upstream"])
    expect(signals.video_audio_catalog_enrollment).toMatchObject({
      synced: true,
      acr_id: "acr_video_123",
    })
  })
})

describe("video audio catalog enrollment evidence", () => {
  const clients: Array<ReturnType<typeof createClient>> = []
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    for (const client of clients.splice(0)) {
      client.close()
    }
  })

  async function createEvidenceClient() {
    const client = createClient({ url: ":memory:" })
    clients.push(client)
    await client.execute(`
      CREATE TABLE media_analysis_results (
        media_analysis_result_id TEXT PRIMARY KEY,
        community_id TEXT NOT NULL,
        source_post_id TEXT,
        authenticity_signals_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `)
    return client
  }

  async function seedAnalysisRow(
    client: ReturnType<typeof createClient>,
    input: { id: string; postId: string; signals: unknown; createdAt?: string },
  ) {
    const createdAt = input.createdAt ?? "2026-07-24T00:00:00.000Z"
    await client.execute({
      sql: `
        INSERT INTO media_analysis_results (
          media_analysis_result_id, community_id, source_post_id,
          authenticity_signals_json, created_at, updated_at
        ) VALUES (?1, 'cmt_test', ?2, ?3, ?4, ?4)
      `,
      args: [
        input.id,
        input.postId,
        typeof input.signals === "string" ? input.signals : JSON.stringify(input.signals),
        createdAt,
      ],
    })
  }

  async function readSignals(client: ReturnType<typeof createClient>, id: string) {
    const rows = await client.execute({
      sql: "SELECT authenticity_signals_json FROM media_analysis_results WHERE media_analysis_result_id = ?1",
      args: [id],
    })
    return JSON.parse(String(rows.rows[0]?.authenticity_signals_json)) as Record<string, any>
  }

  function acrConsoleEnv() {
    return {
      ACRCLOUD_PERSONAL_ACCESS_TOKEN: "test-token",
      ACRCLOUD_BUCKET_ID: "30358",
      ACRCLOUD_CONSOLE_BASE_URL: "https://console.test/api",
    }
  }

  describe("findSyncedVideoAudioCatalogEnrollment", () => {
    test("finds a synced enrollment so re-analysis skips a duplicate enroll", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: {
            provider: "acrcloud_catalog",
            attempted: true,
            synced: true,
            file_id: "file_1",
          },
        },
      })

      const evidence = await findSyncedVideoAudioCatalogEnrollment({ client, postId: "pst_1" })
      expect(evidence?.mediaAnalysisResultId).toBe("mar_1")
      expect(evidence?.enrollment.file_id).toBe("file_1")
      expect(await hasSyncedVideoAudioCatalogEnrollment({ client, postId: "pst_1" })).toBe(true)
    })

    test("ignores enrollments already unenrolled successfully", async () => {
      const client = await createEvidenceClient()
      for (const [index, outcome] of ["deleted", "already_missing"].entries()) {
        await seedAnalysisRow(client, {
          id: `mar_${index}`,
          postId: `pst_${outcome}`,
          signals: {
            video_audio_catalog_enrollment: { attempted: true, synced: true, file_id: "file_1" },
            video_audio_catalog_unenrollment: { outcome, at: "2026-07-24T01:00:00.000Z" },
          },
        })
        expect(await hasSyncedVideoAudioCatalogEnrollment({ client, postId: `pst_${outcome}` })).toBe(false)
      }
    })

    test("a failed unenrollment leaves the enrollment active", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: { attempted: true, synced: true, file_id: "file_1" },
          video_audio_catalog_unenrollment: {
            outcome: "failed",
            at: "2026-07-24T01:00:00.000Z",
            error: "http_500",
          },
        },
      })

      expect(await hasSyncedVideoAudioCatalogEnrollment({ client, postId: "pst_1" })).toBe(true)
    })

    test("tolerates malformed evidence and unsynced enrollments", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_malformed",
        postId: "pst_1",
        signals: "{not json",
        createdAt: "2026-07-24T02:00:00.000Z",
      })
      await seedAnalysisRow(client, {
        id: "mar_unsynced",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: { attempted: true, synced: false, error: "http_500" },
        },
        createdAt: "2026-07-24T01:00:00.000Z",
      })

      expect(await findSyncedVideoAudioCatalogEnrollment({ client, postId: "pst_1" })).toBeNull()
      expect(await hasSyncedVideoAudioCatalogEnrollment({ client, postId: "pst_1" })).toBe(false)
    })
  })

  describe("unenrollVideoAudioCatalogSample", () => {
    test("no-ops when the post has no enrollment evidence", async () => {
      const client = await createEvidenceClient()
      let fetchCalls = 0
      globalThis.fetch = mockFetch(async () => {
        fetchCalls += 1
        return new Response(null, { status: 200 })
      })

      const result = await unenrollVideoAudioCatalogSample({
        env: acrConsoleEnv(),
        client,
        postId: "pst_none",
      })

      expect(result).toBeNull()
      expect(fetchCalls).toBe(0)
    })

    test("deletes the exact bucket file and keeps a redacted tombstone", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: {
            provider: "acrcloud_catalog",
            attempted: true,
            synced: true,
            file_id: "file_123",
            acr_id: "acr_1",
            uploader: "usr_author",
            post_id: "pst_1",
            sample_window: { start_ms: 6_000, duration_ms: 24_000 },
          },
        },
      })
      const requests: Array<{ url: string; method: string; authorization: string | null }> = []
      globalThis.fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init)
        requests.push({
          url: request.url,
          method: request.method,
          authorization: request.headers.get("authorization"),
        })
        return Response.json({})
      })

      const result = await unenrollVideoAudioCatalogSample({
        env: acrConsoleEnv(),
        client,
        postId: "pst_1",
        redactUploader: true,
        attemptCount: 1,
        now: "2026-07-24T10:00:00.000Z",
      })

      expect(result).toBe("mar_1")
      expect(requests).toEqual([{
        url: "https://console.test/api/buckets/30358/files/file_123",
        method: "DELETE",
        authorization: "Bearer test-token",
      }])

      const signals = await readSignals(client, "mar_1")
      expect(signals.video_audio_catalog_unenrollment).toEqual({
        provider: "acrcloud_catalog",
        file_id: "file_123",
        outcome: "deleted",
        at: "2026-07-24T10:00:00.000Z",
      })
      // Tombstone keeps non-identifying operational metadata...
      expect(signals.video_audio_catalog_enrollment).toMatchObject({
        synced: true,
        file_id: "file_123",
        post_id: "pst_1",
        sample_window: { start_ms: 6_000, duration_ms: 24_000 },
      })
      // ...but the uploader identity is redacted on author-initiated deletion.
      expect(signals.video_audio_catalog_enrollment).not.toHaveProperty("uploader")
    })

    test("keeps the uploader identity for moderator-initiated removals", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: {
            attempted: true,
            synced: true,
            file_id: "file_123",
            uploader: "usr_author",
          },
        },
      })
      globalThis.fetch = mockFetch(async () => Response.json({}))

      await unenrollVideoAudioCatalogSample({
        env: acrConsoleEnv(),
        client,
        postId: "pst_1",
        redactUploader: false,
        attemptCount: 1,
      })

      const signals = await readSignals(client, "mar_1")
      expect(signals.video_audio_catalog_enrollment).toMatchObject({ uploader: "usr_author" })
    })

    test("treats an already-missing bucket entry as success", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: { attempted: true, synced: true, file_id: "file_gone" },
        },
      })
      globalThis.fetch = mockFetch(async () => new Response(null, { status: 404 }))

      const result = await unenrollVideoAudioCatalogSample({
        env: acrConsoleEnv(),
        client,
        postId: "pst_1",
        attemptCount: 1,
        now: "2026-07-24T10:00:00.000Z",
      })

      expect(result).toBe("mar_1")
      const signals = await readSignals(client, "mar_1")
      expect(signals.video_audio_catalog_unenrollment).toMatchObject({ outcome: "already_missing" })
    })

    test("persists the failure and rethrows for retry on a transient provider error", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: { attempted: true, synced: true, file_id: "file_123" },
        },
      })
      globalThis.fetch = mockFetch(async () => new Response(null, { status: 500 }))

      await expect(unenrollVideoAudioCatalogSample({
        env: acrConsoleEnv(),
        client,
        postId: "pst_1",
        attemptCount: 1,
        now: "2026-07-24T10:00:00.000Z",
      })).rejects.toThrow("ACRCloud catalog unenroll failed: http_500")

      const signals = await readSignals(client, "mar_1")
      expect(signals.video_audio_catalog_unenrollment).toEqual({
        provider: "acrcloud_catalog",
        file_id: "file_123",
        outcome: "failed",
        at: "2026-07-24T10:00:00.000Z",
        error: "http_500",
      })
      // The failed attempt leaves the enrollment active, so the retried job
      // finds the evidence and re-attempts the delete.
      expect(await hasSyncedVideoAudioCatalogEnrollment({ client, postId: "pst_1" })).toBe(true)
    })

    test("does not rethrow on the terminal attempt", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: { attempted: true, synced: true, file_id: "file_123" },
        },
      })
      globalThis.fetch = mockFetch(async () => new Response(null, { status: 500 }))

      const result = await unenrollVideoAudioCatalogSample({
        env: acrConsoleEnv(),
        client,
        postId: "pst_1",
        attemptCount: COMMUNITY_JOB_MAX_ATTEMPTS,
      })

      expect(result).toBe("mar_1")
      const signals = await readSignals(client, "mar_1")
      expect(signals.video_audio_catalog_unenrollment).toMatchObject({
        outcome: "failed",
        error: "http_500",
      })
    })

    test("missing ACR configuration records a terminal failure without a fetch", async () => {
      const client = await createEvidenceClient()
      await seedAnalysisRow(client, {
        id: "mar_1",
        postId: "pst_1",
        signals: {
          video_audio_catalog_enrollment: { attempted: true, synced: true, file_id: "file_123" },
        },
      })
      let fetchCalls = 0
      globalThis.fetch = mockFetch(async () => {
        fetchCalls += 1
        return new Response(null, { status: 200 })
      })

      const result = await unenrollVideoAudioCatalogSample({
        env: {},
        client,
        postId: "pst_1",
        attemptCount: 1,
      })

      expect(result).toBe("mar_1")
      expect(fetchCalls).toBe(0)
      const signals = await readSignals(client, "mar_1")
      expect(signals.video_audio_catalog_unenrollment).toMatchObject({
        outcome: "failed",
        error: "missing_configuration",
      })
    })
  })

  describe("enqueueVideoAudioCatalogUnenrollIfEnabled", () => {
    function makeExecutor() {
      const statements: Array<{ sql: string; args?: unknown[] }> = []
      return {
        statements,
        executor: {
          async execute(statement: { sql: string; args?: unknown[] } | string) {
            const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
            statements.push(normalized)
            return { rows: [], rowsAffected: 1 }
          },
        },
      }
    }

    test("enqueues the unenroll job when enrollment is enabled", async () => {
      const { executor, statements } = makeExecutor()

      await enqueueVideoAudioCatalogUnenrollIfEnabled({
        env: { VIDEO_AUDIO_CATALOG_ENROLLMENT_ENABLED: "1" },
        client: executor,
        communityId: "cmt_1",
        postId: "pst_1",
        redactUploader: true,
        createdAt: "2026-07-24T10:00:00.000Z",
      })

      const insert = statements.find((statement) => statement.sql.includes("INSERT OR IGNORE INTO community_jobs"))
      expect(insert).toBeDefined()
      expect(insert?.args).toContain("video_audio_catalog_unenroll")
      expect(insert?.args).toContain("pst_1")
      const payload = JSON.parse(String(insert?.args?.[5])) as { post_id: string; redact_uploader: boolean }
      expect(payload).toEqual({ post_id: "pst_1", redact_uploader: true })
    })

    test("does not enqueue when enrollment is disabled", async () => {
      const { executor, statements } = makeExecutor()

      await enqueueVideoAudioCatalogUnenrollIfEnabled({
        env: {},
        client: executor,
        communityId: "cmt_1",
        postId: "pst_1",
        redactUploader: true,
      })

      expect(statements).toHaveLength(0)
    })
  })
})
