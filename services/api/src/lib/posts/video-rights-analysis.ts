import { makeId, nowIso } from "../helpers"
import type { Client } from "../sql-client"
import { upsertActiveRightsHold } from "../rights/rights-hold-store"
import type { RightsHoldType } from "../rights/rights-review-types"

// Video attribution guardrail: every run records a media_analysis_results row;
// outcomes that need action open a rights_review_cases row and create a
// rights_holds row that commerce/delivery gates can enforce. Custom-bucket
// matches are split by matchSource: platform video-audio entries are a
// repost-identity signal only (log-only, never enforced); only platform song
// matches drive the attribution outcomes below.

type VideoRightsOutcome =
  | "allow"
  | "allow_with_required_reference"
  | "review_required"
  | "blocked"

type VideoRightsCaseTrigger = "acrcloud_match" | "declared_reference_mismatch"

export type VideoRightsAcrMatchSource = "platform_song" | "platform_video_audio"

export type VideoRightsAcrCustomMatch = {
  song_artifact_bundle_id: string | null
  matchSource: VideoRightsAcrMatchSource
  raw: Record<string, unknown>
}

export type VideoRightsAcrEvaluation = {
  providerError: string | null
  missingConfiguration: boolean
  musicMatches: Array<Record<string, unknown>>
  customMatches: VideoRightsAcrCustomMatch[]
  providerResult: Record<string, unknown> | null
}

export type VideoRightsDeclaredReferences = {
  // Local assets resolved from upstream_asset_refs on the community shard.
  declaredBundleIds: string[]
  declaredAssetIds: string[]
  // story:ip:... refs (or local assets without a bundle) that cannot be mapped
  // to an ACR custom-bucket entry; they still count as a declaration.
  unresolvedRefs: string[]
}

export type VideoRightsDecision = {
  outcome: VideoRightsOutcome
  policyReasonCode: string
  policyReason: string
  caseTrigger: VideoRightsCaseTrigger | null
}

export type VideoAudioSafetyEvaluation = {
  contentSafetyState: "pending" | "safe" | "sensitive" | "adult"
  ageGatePolicy: "none" | "18_plus"
  transcript: string | null
  transcriptProviderResult: Record<string, unknown> | null
  moderationStatus: "completed" | "failed" | "skipped"
  moderationError: string | null
  moderationResult: Record<string, unknown> | null
}

export function computeVideoRightsOutcome(input: {
  declared: VideoRightsDeclaredReferences
  acr: VideoRightsAcrEvaluation
  audioTrackPresent: boolean
  analysisSkippedReason?: string | null
  blockCommercialMusicMatches?: boolean
}): VideoRightsDecision {
  if (input.analysisSkippedReason) {
    return {
      outcome: "allow",
      policyReasonCode: `analysis_skipped_${input.analysisSkippedReason}`,
      policyReason: `Soundtrack analysis skipped (${input.analysisSkippedReason}); declaration-only attribution applies.`,
      caseTrigger: null,
    }
  }
  if (!input.audioTrackPresent) {
    return {
      outcome: "allow",
      policyReasonCode: "no_audio_track",
      policyReason: "Video has no audio track to identify.",
      caseTrigger: null,
    }
  }
  if (input.acr.missingConfiguration) {
    return {
      outcome: "allow",
      policyReasonCode: "acr_not_configured",
      policyReason: "ACRCloud identification is not configured; declaration-only attribution applies.",
      caseTrigger: null,
    }
  }
  if (input.acr.providerError) {
    // The job retries transient provider failures before this is persisted;
    // reaching here means attempts are exhausted, so surface for review.
    return {
      outcome: "review_required",
      policyReasonCode: "acr_provider_failed",
      policyReason: `ACRCloud identification failed after retries: ${input.acr.providerError}`,
      caseTrigger: "acrcloud_match",
    }
  }

  const declaredBundleIds = new Set(input.declared.declaredBundleIds)
  // Only platform song matches participate in rights enforcement; platform
  // video-audio matches are a repost-identity signal and stay log-only.
  const songMatches = input.acr.customMatches.filter((match) => match.matchSource === "platform_song")
  const videoAudioMatches = input.acr.customMatches.filter((match) => match.matchSource === "platform_video_audio")
  const matchedBundleIds = songMatches
    .map((match) => match.song_artifact_bundle_id)
    .filter((id): id is string => Boolean(id))
  const undeclaredMatches = matchedBundleIds.filter((id) => !declaredBundleIds.has(id))
  const declarationExists = declaredBundleIds.size > 0 || input.declared.unresolvedRefs.length > 0
  const hasCustomMatch = songMatches.length > 0
  const hasMusicMatch = input.acr.musicMatches.length > 0

  if (hasMusicMatch) {
    if (!input.blockCommercialMusicMatches) {
      return {
        outcome: "review_required",
        policyReasonCode: "commercial_catalog_match",
        policyReason: "Soundtrack matches commercial music that is not available for reuse on this platform.",
        caseTrigger: "acrcloud_match",
      }
    }
    return {
      outcome: "blocked",
      policyReasonCode: "commercial_catalog_match",
      policyReason: "Soundtrack matches commercial music that is not available for reuse on this platform.",
      caseTrigger: "acrcloud_match",
    }
  }
  if (!hasCustomMatch && videoAudioMatches.length > 0) {
    return {
      outcome: "allow",
      policyReasonCode: "platform_video_audio_match",
      policyReason: "Soundtrack matches platform video audio; the match is a platform-identity signal only and does not affect rights enforcement.",
      caseTrigger: null,
    }
  }
  if (hasCustomMatch && matchedBundleIds.length > 0 && undeclaredMatches.length === 0 && declaredBundleIds.size > 0) {
    return {
      outcome: "allow",
      policyReasonCode: "declared_reference_verified",
      policyReason: "Soundtrack matches the declared source song(s) in the catalog.",
      caseTrigger: null,
    }
  }
  if (hasCustomMatch && undeclaredMatches.length > 0 && declarationExists) {
    return {
      outcome: "review_required",
      policyReasonCode: "declared_reference_mismatch",
      policyReason: "Soundtrack matches catalog song(s) the poster did not declare.",
      caseTrigger: "declared_reference_mismatch",
    }
  }
  if (hasCustomMatch && matchedBundleIds.length === 0) {
    // Matches exist but none carried a bundle id we can compare (stale bucket
    // metadata). A human should look rather than guessing either way.
    return {
      outcome: "review_required",
      policyReasonCode: "unmappable_catalog_match",
      policyReason: "Soundtrack matched the catalog bucket but the match could not be mapped to a song.",
      caseTrigger: "acrcloud_match",
    }
  }
  if (hasCustomMatch && !declarationExists) {
    return {
      outcome: "allow_with_required_reference",
      policyReasonCode: "undeclared_catalog_match",
      policyReason: "Soundtrack matches a published catalog song but the post declares no source.",
      caseTrigger: "acrcloud_match",
    }
  }
  if (declarationExists) {
    return {
      outcome: "allow",
      policyReasonCode: "declared_reference_unmatched",
      policyReason: "No fingerprint match; the poster's declared source stands (covers and re-recordings do not fingerprint-match).",
      caseTrigger: null,
    }
  }
  return {
    outcome: "allow",
    policyReasonCode: "no_match",
    policyReason: "No fingerprint match and no declared source.",
    caseTrigger: null,
  }
}

export type PersistVideoRightsAnalysisInput = {
  client: Pick<Client, "execute">
  communityId: string
  postId: string
  assetId: string | null
  decision: VideoRightsDecision
  acr: VideoRightsAcrEvaluation
  declared: VideoRightsDeclaredReferences
  audioSafety?: VideoAudioSafetyEvaluation | null
  sampleWindow: { start_ms: number; duration_ms: number } | null
  createdAt?: string
}

function holdTypeForRightsOutcome(outcome: VideoRightsOutcome): RightsHoldType | null {
  switch (outcome) {
    case "allow":
      return null
    case "allow_with_required_reference":
      return "reference_required"
    case "review_required":
      return "review_hold"
    case "blocked":
      return "blocked"
  }
}

export async function persistVideoRightsAnalysis(
  input: PersistVideoRightsAnalysisInput,
): Promise<{ mediaAnalysisResultId: string; rightsReviewCaseId: string | null }> {
  const createdAt = input.createdAt ?? nowIso()
  const mediaAnalysisResultId = makeId("mar")
  const acrCheckedAt = input.acr.providerResult ? createdAt : null

  await input.client.execute({
    sql: `
      INSERT INTO media_analysis_results (
        media_analysis_result_id, community_id, source_post_id, source_asset_id,
        outcome, content_safety_state, age_gate_policy,
        trigger_sources_json, acrcloud_music_match_json, acrcloud_custom_match_json,
        acrcloud_error_code, acrcloud_error_message, acrcloud_checked_at,
        safety_signals_json, authenticity_signals_json,
        policy_reason_code, policy_reason, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
    `,
    args: [
      mediaAnalysisResultId,
      input.communityId,
      input.postId,
      input.assetId,
      input.decision.outcome,
      input.audioSafety?.contentSafetyState ?? "pending",
      input.audioSafety?.ageGatePolicy ?? "none",
      JSON.stringify({ source: "video_media_analysis", sample_window: input.sampleWindow }),
      input.acr.musicMatches.length ? JSON.stringify(input.acr.musicMatches) : null,
      input.acr.customMatches.length ? JSON.stringify(input.acr.customMatches.map((match) => match.raw)) : null,
      input.acr.missingConfiguration ? "missing_configuration" : input.acr.providerError ? "provider_failed" : null,
      input.acr.providerError,
      acrCheckedAt,
      input.audioSafety ? JSON.stringify({
        provider: "video_audio_safety",
        transcript: input.audioSafety.transcript,
        transcript_provider_result: input.audioSafety.transcriptProviderResult,
        moderation_status: input.audioSafety.moderationStatus,
        moderation_error: input.audioSafety.moderationError,
        moderation_result: input.audioSafety.moderationResult,
        content_safety_state: input.audioSafety.contentSafetyState,
        age_gate_policy: input.audioSafety.ageGatePolicy,
      }) : null,
      JSON.stringify({
        declared_bundle_ids: input.declared.declaredBundleIds,
        declared_asset_ids: input.declared.declaredAssetIds,
        declared_unresolved_refs: input.declared.unresolvedRefs,
      }),
      input.decision.policyReasonCode,
      input.decision.policyReason,
      createdAt,
    ],
  })

  if (input.assetId) {
    for (const upstreamAssetId of input.declared.declaredAssetIds) {
      await input.client.execute({
        sql: `
          INSERT INTO asset_derivative_links (
            asset_derivative_link_id, asset_id, upstream_asset_id, relationship_type, created_at
          )
          SELECT ?1, ?2, ?3, 'references_song', ?4
          WHERE NOT EXISTS (
            SELECT 1 FROM asset_derivative_links
            WHERE asset_id = ?2 AND upstream_asset_id = ?3 AND relationship_type = 'references_song'
          )
        `,
        args: [makeId("adl"), input.assetId, upstreamAssetId, createdAt],
      })
    }
  }

  let rightsReviewCaseId: string | null = null
  let holdSourceCaseId: string | null = null
  if (input.decision.caseTrigger) {
    rightsReviewCaseId = makeId("rrc")
    // The partial unique index (subject, trigger, open statuses) makes retries
    // and re-analysis idempotent: an already-open case absorbs the conflict.
    const result = await input.client.execute({
      sql: `
        INSERT INTO rights_review_cases (
          rights_review_case_id, subject_type, subject_id, community_id,
          status, trigger_source, analysis_result_ref, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?7)
        ON CONFLICT DO NOTHING
      `,
      args: [
        rightsReviewCaseId,
        input.assetId ? "asset" : "post",
        input.assetId ?? input.postId,
        input.communityId,
        input.decision.caseTrigger,
        mediaAnalysisResultId,
        createdAt,
      ],
    })
    if (!result.rowsAffected) {
      rightsReviewCaseId = null
    } else {
      holdSourceCaseId = rightsReviewCaseId
    }
    if (!holdSourceCaseId) {
      const existing = await input.client.execute({
        sql: `
          SELECT rights_review_case_id
          FROM rights_review_cases
          WHERE subject_type = ?1
            AND subject_id = ?2
            AND trigger_source = ?3
            AND status IN ('open', 'under_review')
          ORDER BY updated_at DESC, rights_review_case_id DESC
          LIMIT 1
        `,
        args: [
          input.assetId ? "asset" : "post",
          input.assetId ?? input.postId,
          input.decision.caseTrigger,
        ],
      })
      holdSourceCaseId = typeof existing.rows[0]?.rights_review_case_id === "string"
        ? existing.rows[0].rights_review_case_id
        : null
    }
  }

  const holdType = holdTypeForRightsOutcome(input.decision.outcome)
  if (holdType && input.decision.caseTrigger) {
    await upsertActiveRightsHold({
      executor: input.client,
      communityId: input.communityId,
      subjectType: input.assetId ? "asset" : "post",
      subjectId: input.assetId ?? input.postId,
      holdType,
      sourceCaseId: holdSourceCaseId,
      analysisResultRef: mediaAnalysisResultId,
      reasonCode: input.decision.policyReasonCode,
      reason: input.decision.policyReason,
      now: createdAt,
    })
  }

  return { mediaAnalysisResultId, rightsReviewCaseId }
}
