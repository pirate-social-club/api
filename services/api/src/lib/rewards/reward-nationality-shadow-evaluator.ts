import type { Env } from "../../env"
import { makeId } from "../helpers"
import type { InStatement, QueryResult } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import {
  deriveRewardIdentityId,
  resolveRewardIdentityProvider,
} from "../verification/unique-human-eligibility"

type Executor = { execute(statement: InStatement | string): Promise<QueryResult> }

export const REWARD_NATIONALITY_EVALUATOR_VERSION = "nationality_binding_v1"

export type RewardNationalityShadowPersistence =
  | "not_applicable"
  | "not_attempted"
  | "written"
  | "already_recorded"
  | "not_recorded"

export type RewardNationalityShadowOutcome =
  | "resolved"
  | "identity_document_not_selected"
  | "nationality_evidence_missing"
  | "identity_binding_mismatch"
  | "identity_evidence_conflict"

export type RewardNationalityShadowDecision = {
  capability: "binding_preview" | "paused" | "unavailable"
  persisted: boolean
  persistence: RewardNationalityShadowPersistence
  evaluatorVersion: string | null
  outcome: RewardNationalityShadowOutcome | null
  retryability: "resolved" | "retryable" | "terminal" | null
  rewardIdentityBindingId: string | null
  identityNullifierId: string | null
  userAttestationId: string | null
  nationality: string | null
  rewardIdentityId: string | null
  bindingSelectedAt: string | null
  evidenceVerificationSessionId: string | null
  evidenceVerifiedAt: string | null
}

type CandidateDecision = Omit<
  RewardNationalityShadowDecision,
  "capability" | "persisted" | "persistence" | "evaluatorVersion"
>

type PersistedDecision = {
  outcome: "resolved_tier" | "resolved_default" | Exclude<RewardNationalityShadowOutcome, "resolved">
  resultKey: string | null
}

function payoutTiers(value: unknown): Array<{ nationalities: string[] }> {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new Error("reward campaign payout tiers are corrupt")
    }
  }
  if (!Array.isArray(parsed)) throw new Error("reward campaign payout tiers are corrupt")
  return parsed.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("reward campaign payout tiers are corrupt")
    }
    const nationalities = (value as Record<string, unknown>).nationalities
    if (!Array.isArray(nationalities) || nationalities.some((country) => typeof country !== "string")) {
      throw new Error("reward campaign payout tiers are corrupt")
    }
    return { nationalities: nationalities.map((country) => country.toUpperCase()) }
  })
}

function persistedDecision(
  decision: RewardNationalityShadowDecision,
  payoutTiersValue: unknown,
): PersistedDecision {
  if (decision.outcome !== "resolved" || !decision.nationality) {
    return {
      outcome: decision.outcome as Exclude<RewardNationalityShadowOutcome, "resolved">,
      resultKey: null,
    }
  }
  const tierIndex = payoutTiers(payoutTiersValue)
    .findIndex((tier) => tier.nationalities.includes(decision.nationality!))
  return tierIndex >= 0
    ? { outcome: "resolved_tier", resultKey: `tier:${tierIndex}` }
    : { outcome: "resolved_default", resultKey: "default" }
}

function plusDays(value: string, days: number): string {
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) throw new Error("reward nationality decision timestamp is invalid")
  return new Date(parsed + days * 24 * 60 * 60 * 1_000).toISOString()
}

function parseNationality(value: unknown): string | null {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object") return null
  const nationality = String((parsed as Record<string, unknown>).nationality ?? "").trim().toUpperCase()
  return /^[A-Z]{3}$/.test(nationality) ? nationality : null
}

function unresolved(
  outcome: Exclude<RewardNationalityShadowOutcome, "resolved">,
  retryability: "retryable" | "terminal",
  input: Partial<CandidateDecision> = {},
): CandidateDecision {
  return {
    outcome,
    retryability,
    rewardIdentityBindingId: input.rewardIdentityBindingId ?? null,
    identityNullifierId: input.identityNullifierId ?? null,
    userAttestationId: input.userAttestationId ?? null,
    nationality: null,
    rewardIdentityId: null,
    bindingSelectedAt: input.bindingSelectedAt ?? null,
    evidenceVerificationSessionId: input.evidenceVerificationSessionId ?? null,
    evidenceVerifiedAt: input.evidenceVerifiedAt ?? null,
  }
}

async function resolveDecision(client: Executor, userId: string): Promise<CandidateDecision> {
  const bindingResult = await client.execute({
    sql: `
      SELECT b.reward_identity_binding_id, b.identity_nullifier_id, b.selected_at,
        n.user_id AS nullifier_user_id, n.provider, n.mechanism, n.nullifier_hash,
        n.status AS nullifier_status
      FROM reward_identity_bindings b
      LEFT JOIN identity_nullifiers n
        ON n.identity_nullifier_id = b.identity_nullifier_id
      WHERE b.user_id = ?1 AND b.status = 'active'
      LIMIT 1
    `,
    args: [userId],
  })
  const binding = bindingResult.rows[0]
  const bindingId = stringOrNull(rowValue(binding, "reward_identity_binding_id"))
  const identityNullifierId = stringOrNull(rowValue(binding, "identity_nullifier_id"))
  const bindingSelectedAt = stringOrNull(rowValue(binding, "selected_at"))
  if (!bindingId || !identityNullifierId || !bindingSelectedAt) {
    return unresolved("identity_document_not_selected", "retryable")
  }

  const nullifierUserId = stringOrNull(rowValue(binding, "nullifier_user_id"))
  const provider = stringOrNull(rowValue(binding, "provider"))
  const mechanism = stringOrNull(rowValue(binding, "mechanism"))
  const nullifierHash = stringOrNull(rowValue(binding, "nullifier_hash"))
  const nullifierStatus = stringOrNull(rowValue(binding, "nullifier_status"))
  if (nullifierUserId !== userId || provider !== "self" || nullifierStatus !== "active" || !mechanism || !nullifierHash) {
    return unresolved("identity_binding_mismatch", "terminal", {
      rewardIdentityBindingId: bindingId,
      identityNullifierId,
      bindingSelectedAt,
    })
  }

  const evidence = await client.execute({
    sql: `
      SELECT user_attestation_id, source_verification_session_id, value_json, verified_at
      FROM user_attestations
      WHERE user_id = ?1
        AND provider = 'self'
        AND capability_key = 'nationality'
        AND status = 'accepted'
        AND revoked_at IS NULL
        AND source_identity_nullifier_id = ?2
      ORDER BY verified_at DESC, user_attestation_id ASC
    `,
    args: [userId, identityNullifierId],
  })
  if (evidence.rows.length === 0) {
    return unresolved("nationality_evidence_missing", "retryable", {
      rewardIdentityBindingId: bindingId,
      identityNullifierId,
      bindingSelectedAt,
    })
  }

  const parsed = evidence.rows.map((row) => ({
    userAttestationId: stringOrNull(rowValue(row, "user_attestation_id")),
    verificationSessionId: stringOrNull(rowValue(row, "source_verification_session_id")),
    nationality: parseNationality(rowValue(row, "value_json")),
    verifiedAt: stringOrNull(rowValue(row, "verified_at")),
  }))
  const nationalities = new Set(parsed.map((entry) => entry.nationality).filter((value): value is string => value !== null))
  if (nationalities.size !== 1 || parsed.some((entry) => !entry.nationality)) {
    return unresolved("identity_evidence_conflict", "terminal", {
      rewardIdentityBindingId: bindingId,
      identityNullifierId,
      bindingSelectedAt,
    })
  }
  const selectedEvidence = parsed[0]!
  if (!selectedEvidence.userAttestationId || !selectedEvidence.verifiedAt) {
    return unresolved("identity_evidence_conflict", "terminal", {
      rewardIdentityBindingId: bindingId,
      identityNullifierId,
      bindingSelectedAt,
    })
  }
  return {
    outcome: "resolved",
    retryability: "resolved",
    rewardIdentityBindingId: bindingId,
    identityNullifierId,
    userAttestationId: selectedEvidence.userAttestationId,
    nationality: selectedEvidence.nationality,
    rewardIdentityId: await deriveRewardIdentityId("self", mechanism, nullifierHash),
    bindingSelectedAt,
    evidenceVerificationSessionId: selectedEvidence.verificationSessionId,
    evidenceVerifiedAt: selectedEvidence.verifiedAt,
  }
}

export async function resolveRewardNationalityBindingShadow(input: {
  env: Env
  client: Executor
  userId: string
}): Promise<RewardNationalityShadowDecision> {
  if (input.env.REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED !== "true") {
    return {
      capability: "paused",
      persisted: false,
      persistence: "not_applicable",
      evaluatorVersion: null,
      outcome: null,
      retryability: null,
      rewardIdentityBindingId: null,
      identityNullifierId: null,
      userAttestationId: null,
      nationality: null,
      rewardIdentityId: null,
      bindingSelectedAt: null,
      evidenceVerificationSessionId: null,
      evidenceVerifiedAt: null,
    }
  }
  if (resolveRewardIdentityProvider(input.env.REWARDS_NATIONALITY_SHADOW_IDENTITY_PROVIDER) !== "self") {
    return {
      capability: "unavailable",
      persisted: false,
      persistence: "not_applicable",
      evaluatorVersion: null,
      outcome: null,
      retryability: null,
      rewardIdentityBindingId: null,
      identityNullifierId: null,
      userAttestationId: null,
      nationality: null,
      rewardIdentityId: null,
      bindingSelectedAt: null,
      evidenceVerificationSessionId: null,
      evidenceVerifiedAt: null,
    }
  }

  const decision = await resolveDecision(input.client, input.userId)
  return {
    capability: "binding_preview",
    persisted: false,
    persistence: "not_attempted",
    evaluatorVersion: REWARD_NATIONALITY_EVALUATOR_VERSION,
    ...decision,
  }
}

export async function persistRewardNationalityBindingShadow(input: {
  client: Executor
  rewardQualificationEventId: string
  rewardCampaignId: string
  userId: string
  now: string
  decision: RewardNationalityShadowDecision
}): Promise<RewardNationalityShadowDecision> {
  if (input.decision.capability !== "binding_preview" || !input.decision.outcome || !input.decision.retryability) {
    return input.decision
  }
  const decision = input.decision
  const campaign = await input.client.execute({
    sql: `
      SELECT payout_tiers_json, terms_version, ends_at
      FROM reward_campaigns
      WHERE reward_campaign_id = ?1
      LIMIT 1
    `,
    args: [input.rewardCampaignId],
  })
  const campaignRow = campaign.rows[0]
  if (!campaignRow) return { ...decision, persisted: false, persistence: "not_recorded" }
  const termsVersion = Number(rowValue(campaignRow, "terms_version"))
  const campaignEndsAt = stringOrNull(rowValue(campaignRow, "ends_at"))
  if (!Number.isSafeInteger(termsVersion) || termsVersion <= 0 || !campaignEndsAt) {
    throw new Error("reward campaign nationality decision metadata is invalid")
  }
  const minimal = persistedDecision(decision, rowValue(campaignRow, "payout_tiers_json"))
  const expiryBase = decision.retryability === "resolved"
    ? new Date(Math.max(Date.parse(input.now), Date.parse(campaignEndsAt))).toISOString()
    : input.now
  const expiresAt = plusDays(expiryBase, decision.retryability === "retryable" ? 30 : 180)
  const inserted = await input.client.execute({
    sql: `
      INSERT INTO reward_nationality_decisions (
        reward_nationality_decision_id, reward_qualification_event_id,
        reward_campaign_id, user_id, result_key, outcome, retryability,
        campaign_terms_version, evaluator_version, evaluated_at, expires_at,
        created_at
      ) SELECT
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?10
      WHERE EXISTS (
        SELECT 1 FROM reward_qualification_events
        WHERE reward_qualification_event_id = ?2
      )
      ON CONFLICT (reward_qualification_event_id) DO UPDATE SET
        result_key = excluded.result_key,
        outcome = excluded.outcome,
        retryability = excluded.retryability,
        campaign_terms_version = excluded.campaign_terms_version,
        evaluator_version = excluded.evaluator_version,
        evaluated_at = excluded.evaluated_at,
        expires_at = excluded.expires_at
      WHERE reward_nationality_decisions.retryability = 'retryable'
    `,
    args: [
      makeId("rnd"), input.rewardQualificationEventId, input.rewardCampaignId,
      input.userId, minimal.resultKey, minimal.outcome, decision.retryability,
      termsVersion, decision.evaluatorVersion, input.now, expiresAt,
    ],
  })
  if ((inserted.rowsAffected ?? inserted.rows.length) > 0) {
    return { ...decision, persisted: true, persistence: "written" }
  }
  const existing = await input.client.execute({
    sql: `
      SELECT reward_nationality_decision_id
      FROM reward_nationality_decisions
      WHERE reward_qualification_event_id = ?1
      LIMIT 1
    `,
    args: [input.rewardQualificationEventId],
  })
  if (existing.rows.length > 0) {
    return { ...decision, persisted: true, persistence: "already_recorded" }
  }
  return { ...decision, persisted: false, persistence: "not_recorded" }
}

export async function evaluateRewardNationalityBindingShadow(input: {
  env: Env
  client: Executor
  rewardQualificationEventId: string
  rewardCampaignId: string
  userId: string
  now: string
}): Promise<RewardNationalityShadowDecision> {
  const decision = await resolveRewardNationalityBindingShadow(input)
  return persistRewardNationalityBindingShadow({ ...input, decision })
}
