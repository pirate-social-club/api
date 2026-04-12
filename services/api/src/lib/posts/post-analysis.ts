import { createHash } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { makeId } from "../helpers"
import { identifyAudioAgainstAcrcloud, isAcrcloudEnabled, isAcrcloudFailOpen } from "../acrcloud"
import type {
  CreatePostRequest,
  Env,
  MediaAnalysisOutcome,
  MediaAnalysisResult,
  Post,
  SongModerationResultDoc,
} from "../../types"

type AnalysisExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

export type PrePublishAnalysisResult = {
  outcome: MediaAnalysisOutcome
  contentSafetyState: Post["content_safety_state"]
  status: Post["status"]
  analysisResultId: string | null
  policyReasonCode: string | null
  policyReason: string | null
  acrcloudMusicMatchJson: string | null
  acrcloudCustomMatchJson: string | null
  acrcloudErrorCode: string | null
  acrcloudErrorMessage: string | null
  duplicateHashPostIds: string[]
}

function computeAudioHashFromBytes(audioBytes: Uint8Array | null | undefined): string | null {
  if (!audioBytes || audioBytes.byteLength === 0) {
    return null
  }
  return `sha256:${createHash("sha256").update(audioBytes).digest("hex")}`
}

function computeAudioHash(mediaRefs: CreatePostRequest["media_refs"]): string | null {
  if (!mediaRefs || mediaRefs.length === 0) return null
  const audio = mediaRefs.find((ref) => ref.mime_type?.startsWith("audio/"))
  return audio?.content_hash ?? null
}

async function checkDuplicateAudioHash(
  client: AnalysisExecutor,
  contentHash: string,
  communityId: string,
  excludePostId?: string,
): Promise<string[]> {
  if (!contentHash) return []
  const result = await client.execute({
    sql: `
      SELECT source_post_id
      FROM assets
      WHERE community_id = ?1
        AND primary_content_hash = ?2
        AND (?3 IS NULL OR source_post_id != ?3)
      LIMIT 5
    `,
    args: [communityId, contentHash, excludePostId ?? null],
  })
  return result.rows.map((row) => String((row as Record<string, unknown>).source_post_id))
}

async function runAcrcloudIdentify(
  env: Env,
  audioBytes: Uint8Array,
): Promise<{
  musicMatches: Array<Record<string, unknown>>
  customMatches: Array<Record<string, unknown>>
  error: string | null
}> {
  try {
    const result = await identifyAudioAgainstAcrcloud({ env, audioBytes })
    return {
      musicMatches: result.musicMatches,
      customMatches: result.customMatches,
      error: null,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      musicMatches: [],
      customMatches: [],
      error: message.slice(0, 500),
    }
  }
}

function collectTextForLocalStub(body: CreatePostRequest): string {
  return [
    typeof body.title === "string" ? body.title : "",
    typeof body.body === "string" ? body.body : "",
    typeof body.caption === "string" ? body.caption : "",
    typeof body.lyrics === "string" ? body.lyrics : "",
  ].join("\n").toLowerCase()
}

export async function resolvePrePublishAnalysis(input: {
  client: AnalysisExecutor
  env: Env
  communityId: string
  authorUserId: string
  body: CreatePostRequest
  excludePostId?: string
  audioBytes?: Uint8Array | null
}): Promise<PrePublishAnalysisResult> {
  const { client, env, communityId, body } = input
  const localStubText = collectTextForLocalStub(body)
  if (localStubText.includes("[blocked]")) {
    return {
      outcome: "blocked",
      contentSafetyState: "pending",
      status: "hidden",
      analysisResultId: null,
      policyReasonCode: "local_stub_blocked",
      policyReason: "Local stub blocked the post before publication",
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds: [],
    }
  }
  if (localStubText.includes("[review-required]")) {
    return {
      outcome: "review_required",
      contentSafetyState: "pending",
      status: "draft",
      analysisResultId: null,
      policyReasonCode: "local_stub_review_required",
      policyReason: "Local stub moved the post into review",
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds: [],
    }
  }
  const isSongPost = body.post_type === "song"
  const isOriginal = !body.song_mode || body.song_mode === "original"
  const hasDerivativeBasis = body.rights_basis === "derivative"
  const hasUpstreamRefs = body.upstream_asset_refs && body.upstream_asset_refs.length > 0

  if (hasDerivativeBasis && !hasUpstreamRefs) {
    return {
      outcome: "review_required",
      contentSafetyState: "pending",
      status: "draft",
      analysisResultId: null,
      policyReasonCode: "derivative_without_upstream_refs",
      policyReason: "Derivative/remix posts require upstream_asset_refs",
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds: [],
    }
  }

  if (!isSongPost || !isOriginal) {
    return {
      outcome: "allow",
      contentSafetyState: "safe",
      status: "published",
      analysisResultId: null,
      policyReasonCode: null,
      policyReason: null,
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds: [],
    }
  }

  const contentHash = computeAudioHashFromBytes(input.audioBytes) ?? computeAudioHash(body.media_refs)
  const duplicateHashPostIds = contentHash
    ? await checkDuplicateAudioHash(client, contentHash, communityId, input.excludePostId)
    : []

  if (duplicateHashPostIds.length > 0) {
    return {
      outcome: "review_required",
      contentSafetyState: "pending",
      status: "draft",
      analysisResultId: null,
      policyReasonCode: "duplicate_audio_hash",
      policyReason: "Audio content hash matches an existing post in this community",
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds,
    }
  }

  if (!isAcrcloudEnabled(env)) {
    return {
      outcome: "allow",
      contentSafetyState: "safe",
      status: "published",
      analysisResultId: null,
      policyReasonCode: null,
      policyReason: null,
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds: [],
    }
  }

  if (!input.audioBytes || input.audioBytes.byteLength === 0) {
    if (isAcrcloudFailOpen(env)) {
      return {
        outcome: "allow",
        contentSafetyState: "safe",
        status: "published",
        analysisResultId: null,
        policyReasonCode: "acrcloud_no_audio_bytes_fail_open",
        policyReason: "No audio bytes available for ACRCloud check; fail-open mode",
        acrcloudMusicMatchJson: null,
        acrcloudCustomMatchJson: null,
        acrcloudErrorCode: null,
        acrcloudErrorMessage: null,
        duplicateHashPostIds: [],
      }
    }
    return {
      outcome: "review_required",
      contentSafetyState: "pending",
      status: "draft",
      analysisResultId: null,
      policyReasonCode: "acrcloud_no_audio_bytes_fail_closed",
      policyReason: "No audio bytes available for ACRCloud check; moved to review",
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode: "no_audio_bytes",
      acrcloudErrorMessage: "Audio bytes not provided for ACRCloud identify",
      duplicateHashPostIds: [],
    }
  }

  const acrResult = await runAcrcloudIdentify(env, input.audioBytes)
  const acrcloudMusicMatchJson = acrResult.musicMatches.length > 0
    ? JSON.stringify(acrResult.musicMatches)
    : null
  const acrcloudCustomMatchJson = acrResult.customMatches.length > 0
    ? JSON.stringify(acrResult.customMatches)
    : null
  const hasMusicMatch = acrResult.musicMatches.length > 0
  const hasCustomMatch = acrResult.customMatches.length > 0

  if (acrResult.error) {
    const acrcloudErrorCode = acrResult.error.startsWith("acrcloud_identify_payload_too_large")
      ? "acrcloud_payload_too_large"
      : "acrcloud_unavailable"
    if (isAcrcloudFailOpen(env)) {
      return {
        outcome: "allow",
        contentSafetyState: "safe",
        status: "published",
        analysisResultId: null,
        policyReasonCode: acrcloudErrorCode,
        policyReason: `ACRCloud check failed but fail-open is enabled: ${acrResult.error.slice(0, 200)}`,
        acrcloudMusicMatchJson: null,
        acrcloudCustomMatchJson: null,
        acrcloudErrorCode,
        acrcloudErrorMessage: acrResult.error.slice(0, 500),
        duplicateHashPostIds: [],
      }
    }
    return {
      outcome: "review_required",
      contentSafetyState: "pending",
      status: "draft",
      analysisResultId: null,
      policyReasonCode: acrcloudErrorCode,
      policyReason: "ACRCloud identify failed; moved to review per fail-closed policy",
      acrcloudMusicMatchJson: null,
      acrcloudCustomMatchJson: null,
      acrcloudErrorCode,
      acrcloudErrorMessage: acrResult.error.slice(0, 500),
      duplicateHashPostIds: [],
    }
  }

  if (hasMusicMatch || hasCustomMatch) {
    const matchKind = hasMusicMatch && hasCustomMatch
      ? "both"
      : hasMusicMatch
        ? "music"
        : "custom"
    const policyReasonCode = matchKind === "both"
      ? "acrcloud_both_match"
      : matchKind === "music"
        ? "acrcloud_music_match"
        : "acrcloud_custom_match"

    return {
      outcome: "allow_with_required_reference",
      contentSafetyState: "safe",
      status: "draft",
      analysisResultId: null,
      policyReasonCode,
      policyReason: `ACRCloud detected ${matchKind} match; upstream reference required before publication`,
      acrcloudMusicMatchJson,
      acrcloudCustomMatchJson,
      acrcloudErrorCode: null,
      acrcloudErrorMessage: null,
      duplicateHashPostIds: [],
    }
  }

  return {
    outcome: "allow",
    contentSafetyState: "safe",
    status: "published",
    analysisResultId: null,
    policyReasonCode: null,
    policyReason: null,
    acrcloudMusicMatchJson,
    acrcloudCustomMatchJson,
    acrcloudErrorCode: null,
    acrcloudErrorMessage: null,
    duplicateHashPostIds: [],
  }
}

export async function persistMediaAnalysisResult(input: {
  client: AnalysisExecutor
  communityId: string
  sourcePostId: string | null
  sourceAssetId: string | null
  result: PrePublishAnalysisResult
  createdAt: string
}): Promise<string> {
  const analysisId = makeId("mar")
  await input.client.execute({
    sql: `
      INSERT INTO media_analysis_results (
        media_analysis_result_id, community_id, source_post_id, source_asset_id,
        outcome, content_safety_state, age_gate_policy,
        trigger_sources_json, acrcloud_music_match_json, acrcloud_custom_match_json,
        acrcloud_error_code, acrcloud_error_message, acrcloud_checked_at,
        safety_signals_json, authenticity_signals_json,
        policy_reason_code, policy_reason,
        resolved_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, ?9, ?10,
        ?11, ?12, ?13,
        ?14, ?15,
        ?16, ?17,
        ?18, ?19, ?19
      )
    `,
    args: [
      analysisId,
      input.communityId,
      input.sourcePostId,
      input.sourceAssetId,
      input.result.outcome,
      input.result.contentSafetyState,
      "none",
      input.result.policyReasonCode ? JSON.stringify([input.result.policyReasonCode]) : null,
      input.result.acrcloudMusicMatchJson,
      input.result.acrcloudCustomMatchJson,
      input.result.acrcloudErrorCode,
      input.result.acrcloudErrorMessage,
      (input.result.acrcloudMusicMatchJson || input.result.acrcloudCustomMatchJson || input.result.acrcloudErrorCode)
        ? input.createdAt
        : null,
      null,
      null,
      input.result.policyReasonCode,
      input.result.policyReason,
      input.result.outcome === "allow" ? input.createdAt : null,
      input.createdAt,
    ],
  })
  return analysisId
}

export async function getMediaAnalysisResultById(input: {
  client: AnalysisExecutor
  analysisResultId: string
}): Promise<MediaAnalysisResult | null> {
  const result = await input.client.execute({
    sql: `
      SELECT media_analysis_result_id, community_id, source_post_id, source_asset_id,
             outcome, content_safety_state, age_gate_policy,
             trigger_sources_json, acrcloud_music_match_json, acrcloud_custom_match_json,
             acrcloud_error_code, acrcloud_error_message, acrcloud_checked_at,
             safety_signals_json, authenticity_signals_json,
             policy_reason_code, policy_reason,
             resolved_at, created_at, updated_at
      FROM media_analysis_results
      WHERE media_analysis_result_id = ?1
      LIMIT 1
    `,
    args: [input.analysisResultId],
  })
  const row = result.rows[0] as Record<string, unknown> | undefined
  if (!row) {
    return null
  }
  return {
    media_analysis_result_id: String(row.media_analysis_result_id || ""),
    community_id: String(row.community_id || ""),
    source_post_id: row.source_post_id == null ? null : String(row.source_post_id),
    source_asset_id: row.source_asset_id == null ? null : String(row.source_asset_id),
    outcome: String(row.outcome || "") as MediaAnalysisOutcome,
    content_safety_state: String(row.content_safety_state || "") as MediaAnalysisResult["content_safety_state"],
    age_gate_policy: String(row.age_gate_policy || "") as MediaAnalysisResult["age_gate_policy"],
    trigger_sources_json: row.trigger_sources_json == null ? null : String(row.trigger_sources_json),
    acrcloud_music_match_json: row.acrcloud_music_match_json == null ? null : String(row.acrcloud_music_match_json),
    acrcloud_custom_match_json: row.acrcloud_custom_match_json == null ? null : String(row.acrcloud_custom_match_json),
    acrcloud_error_code: row.acrcloud_error_code == null ? null : String(row.acrcloud_error_code),
    acrcloud_error_message: row.acrcloud_error_message == null ? null : String(row.acrcloud_error_message),
    acrcloud_checked_at: row.acrcloud_checked_at == null ? null : String(row.acrcloud_checked_at),
    safety_signals_json: row.safety_signals_json == null ? null : String(row.safety_signals_json),
    authenticity_signals_json: row.authenticity_signals_json == null ? null : String(row.authenticity_signals_json),
    policy_reason_code: row.policy_reason_code == null ? null : String(row.policy_reason_code),
    policy_reason: row.policy_reason == null ? null : String(row.policy_reason),
    resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  }
}

export function mediaAnalysisHasAcrcloudMatch(result: Pick<MediaAnalysisResult, "acrcloud_music_match_json" | "acrcloud_custom_match_json"> | null): boolean {
  return Boolean(result?.acrcloud_music_match_json || result?.acrcloud_custom_match_json)
}

export async function updateMediaAnalysisResultSafety(input: {
  client: AnalysisExecutor
  analysisResultId: string
  outcome: MediaAnalysisOutcome
  contentSafetyState: MediaAnalysisResult["content_safety_state"]
  ageGatePolicy: MediaAnalysisResult["age_gate_policy"]
  moderationResult: SongModerationResultDoc
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE media_analysis_results
      SET outcome = ?2,
          content_safety_state = ?3,
          age_gate_policy = ?4,
          safety_signals_json = ?5,
          resolved_at = CASE
            WHEN ?2 = 'allow' THEN COALESCE(resolved_at, ?6)
            ELSE NULL
          END,
          updated_at = ?6
      WHERE media_analysis_result_id = ?1
    `,
    args: [
      input.analysisResultId,
      input.outcome,
      input.contentSafetyState,
      input.ageGatePolicy,
      JSON.stringify(input.moderationResult),
      input.updatedAt,
    ],
  })
}

export async function createMediaAnalysisResultFromModeration(input: {
  client: AnalysisExecutor
  communityId: string
  sourcePostId: string
  sourceAssetId: string | null
  outcome: MediaAnalysisOutcome
  contentSafetyState: MediaAnalysisResult["content_safety_state"]
  ageGatePolicy: MediaAnalysisResult["age_gate_policy"]
  moderationResult: SongModerationResultDoc
  createdAt: string
}): Promise<string> {
  const analysisId = makeId("mar")
  await input.client.execute({
    sql: `
      INSERT INTO media_analysis_results (
        media_analysis_result_id, community_id, source_post_id, source_asset_id,
        outcome, content_safety_state, age_gate_policy,
        trigger_sources_json, acrcloud_music_match_json, acrcloud_custom_match_json,
        acrcloud_error_code, acrcloud_error_message, acrcloud_checked_at,
        safety_signals_json, authenticity_signals_json,
        policy_reason_code, policy_reason,
        resolved_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, NULL, NULL,
        NULL, NULL, NULL,
        ?9, NULL,
        NULL, NULL,
        CASE WHEN ?5 = 'allow' THEN ?10 ELSE NULL END, ?10, ?10
      )
    `,
    args: [
      analysisId,
      input.communityId,
      input.sourcePostId,
      input.sourceAssetId,
      input.outcome,
      input.contentSafetyState,
      input.ageGatePolicy,
      JSON.stringify(["lyrics_moderation"]),
      JSON.stringify(input.moderationResult),
      input.createdAt,
    ],
  })
  return analysisId
}

export async function markMediaAnalysisReferencesSatisfied(input: {
  client: AnalysisExecutor
  analysisResultId: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE media_analysis_results
      SET outcome = 'allow',
          resolved_at = ?2,
          updated_at = ?2
      WHERE media_analysis_result_id = ?1
    `,
    args: [input.analysisResultId, input.updatedAt],
  })
}

export async function deleteMediaAnalysisResultsBySourcePostId(input: {
  client: AnalysisExecutor
  sourcePostId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      DELETE FROM media_analysis_results
      WHERE source_post_id = ?1
    `,
    args: [input.sourcePostId],
  })
}
