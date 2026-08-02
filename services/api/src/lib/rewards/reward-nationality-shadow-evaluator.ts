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
  capability: "binding_preview" | "unavailable"
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
  if (resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER) !== "self") {
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
  const inserted = await input.client.execute({
    sql: `
      INSERT INTO reward_claim_identity_evidence (
        reward_claim_identity_evidence_id, reward_qualification_event_id,
        reward_campaign_id, user_id, reward_identity_binding_id,
        identity_nullifier_id, user_attestation_id, provider, outcome,
        retryability, nationality, reward_identity_id, binding_selected_at,
        evidence_verification_session_id, evidence_verified_at,
        evaluator_version, evaluated_at, created_at
      ) SELECT
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'self', ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?16
      WHERE EXISTS (
        SELECT 1 FROM reward_qualification_events
        WHERE reward_qualification_event_id = ?2
      )
      ON CONFLICT (reward_qualification_event_id) DO UPDATE SET
        reward_identity_binding_id = excluded.reward_identity_binding_id,
        identity_nullifier_id = excluded.identity_nullifier_id,
        user_attestation_id = excluded.user_attestation_id,
        outcome = excluded.outcome,
        retryability = excluded.retryability,
        nationality = excluded.nationality,
        reward_identity_id = excluded.reward_identity_id,
        binding_selected_at = excluded.binding_selected_at,
        evidence_verification_session_id = excluded.evidence_verification_session_id,
        evidence_verified_at = excluded.evidence_verified_at,
        evaluator_version = excluded.evaluator_version,
        evaluated_at = excluded.evaluated_at
      WHERE reward_claim_identity_evidence.retryability = 'retryable'
    `,
    args: [
      makeId("rcie"), input.rewardQualificationEventId, input.rewardCampaignId,
      input.userId, decision.rewardIdentityBindingId, decision.identityNullifierId,
      decision.userAttestationId, decision.outcome, decision.retryability,
      decision.nationality, decision.rewardIdentityId, decision.bindingSelectedAt,
      decision.evidenceVerificationSessionId, decision.evidenceVerifiedAt,
      decision.evaluatorVersion, input.now,
    ],
  })
  if ((inserted.rowsAffected ?? inserted.rows.length) > 0) {
    return { ...decision, persisted: true, persistence: "written" }
  }
  const existing = await input.client.execute({
    sql: `
      SELECT reward_claim_identity_evidence_id
      FROM reward_claim_identity_evidence
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
