import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"

import {
  computeVideoRightsOutcome,
  persistVideoRightsAnalysis,
  type VideoAudioSafetyEvaluation,
  type VideoRightsAcrEvaluation,
  type VideoRightsDeclaredReferences,
} from "./video-rights-analysis"
import { chooseVideoSampleWindow, mergeVideoAudioSafetyWithPost } from "../communities/jobs/video-media-analysis-handler"

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
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("declared_reference_verified")
    expect(decision.caseTrigger).toBeNull()
  })

  test("catalog match without any declaration requires a reference", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow_with_required_reference")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("catalog match different from the declared song goes to review", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_declared"], declaredAssetIds: ["ast_1"] }),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_other", raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("declared_reference_mismatch")
    expect(decision.caseTrigger).toBe("declared_reference_mismatch")
  })

  test("unmappable catalog match goes to review", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: null, raw: {} }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("unmappable_catalog_match")
  })

  test("commercial catalog match goes to review", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ musicMatches: [{ title: "Famous Song" }] }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("review_required")
    expect(decision.policyReasonCode).toBe("commercial_catalog_match")
    expect(decision.caseTrigger).toBe("acrcloud_match")
  })

  test("declared-and-verified wins over a simultaneous commercial match", () => {
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_1"], declaredAssetIds: ["ast_1"] }),
      acr: acr({
        customMatches: [{ song_artifact_bundle_id: "sab_1", raw: {} }],
        musicMatches: [{ title: "Same Song, Commercial Release" }],
      }),
      audioTrackPresent: true,
    })
    expect(decision.outcome).toBe("allow")
    expect(decision.policyReasonCode).toBe("declared_reference_verified")
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
    return client
  }

  test("persists the outcome row, declared links, and a review case", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared({ declaredBundleIds: ["sab_declared"], declaredAssetIds: ["ast_up"] }),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_other", raw: { acr_id: "x" } }] }),
      audioTrackPresent: true,
    })
    const persisted = await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_video",
      assetId: "ast_video",
      decision,
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_other", raw: { acr_id: "x" } }] }),
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
  })

  test("posts without an asset open post-subject cases and skip links", async () => {
    const client = await createTestClient()
    const decision = computeVideoRightsOutcome({
      declared: declared(),
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", raw: {} }] }),
      audioTrackPresent: true,
    })
    await persistVideoRightsAnalysis({
      client,
      communityId: "cmt_test",
      postId: "pst_public_video",
      assetId: null,
      decision,
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", raw: {} }] }),
      declared: declared(),
      sampleWindow: null,
    })

    const caseRows = await client.execute("SELECT subject_type, subject_id FROM rights_review_cases")
    expect(caseRows.rows).toHaveLength(1)
    expect(caseRows.rows[0]?.subject_type).toBe("post")
    expect(caseRows.rows[0]?.subject_id).toBe("pst_public_video")
    const linkRows = await client.execute("SELECT * FROM asset_derivative_links")
    expect(linkRows.rows).toHaveLength(0)
  })

  test("re-analysis does not duplicate an open case or derivative link", async () => {
    const client = await createTestClient()
    const inputs = {
      communityId: "cmt_test",
      postId: "pst_video",
      assetId: "ast_video",
      acr: acr({ customMatches: [{ song_artifact_bundle_id: "sab_1", raw: {} }] }),
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
})
