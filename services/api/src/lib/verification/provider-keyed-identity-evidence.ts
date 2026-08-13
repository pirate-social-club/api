import type { InStatement, QueryResult } from "../sql-client"
import { normalizeIdentityCountryCode } from "../identity/country-codes"
import { rowValue, stringOrNull } from "../sql-row"

export const PROVIDER_KEYED_EVIDENCE_CAPABILITIES = [
  "unique_human",
  "age_over_18",
  "minimum_age",
  "nationality",
  "gender",
] as const

export type ProviderKeyedEvidenceCapability = typeof PROVIDER_KEYED_EVIDENCE_CAPABILITIES[number]

export type IdentityEvidence = {
  evidenceId: string
  userId: string
  capability: ProviderKeyedEvidenceCapability
  provider: string
  mechanism: string
  value: unknown
  verifiedAt: string
  expiresAt: string | null
  sourceVerificationSessionId: string | null
  sourceIdentityNullifierId: string | null
}

export type IdentityEvidenceAtom = {
  capability: ProviderKeyedEvidenceCapability
  acceptedProviders: readonly string[]
  requiredCountries?: readonly string[]
  excludedCountries?: readonly string[]
  minimumAge?: number
  requiredGender?: string
  allowedGenders?: readonly string[]
}

export type IdentityEvidenceAtomEvaluation = {
  outcome: "passed" | "action_required" | "terminal_mismatch"
  witnesses: IdentityEvidence[]
  missingCapabilities: string[]
  mismatchReasons: string[]
}

type Executor = { execute(statement: InStatement | string): Promise<QueryResult> }

function parseJsonValue(raw: unknown): unknown {
  if (raw == null || typeof raw !== "string") return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function valueRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function rowTime(value: unknown): string | null {
  const parsed = stringOrNull(value)
  if (!parsed) return null
  const timestamp = Date.parse(parsed)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}

function rowCapability(value: unknown): ProviderKeyedEvidenceCapability | null {
  const capability = stringOrNull(value)
  return capability && (PROVIDER_KEYED_EVIDENCE_CAPABILITIES as readonly string[]).includes(capability)
    ? capability as ProviderKeyedEvidenceCapability
    : null
}

function countryValue(evidence: IdentityEvidence): string | null {
  const value = valueRecord(evidence.value).nationality ?? evidence.value
  return normalizeIdentityCountryCode(value)
}

function minimumAgeValue(evidence: IdentityEvidence): number | null {
  const value = valueRecord(evidence.value)
  if (evidence.capability === "age_over_18") return value.age_over_18 === true ? 18 : null
  return typeof value.minimum_age === "number" && Number.isInteger(value.minimum_age)
    ? value.minimum_age
    : null
}

function genderValue(evidence: IdentityEvidence): string | null {
  const value = valueRecord(evidence.value).gender ?? evidence.value
  return typeof value === "string" ? value : null
}

/** Return the canonical value used by policy evaluators and reward consumers. */
export function normalizeIdentityEvidenceValue(evidence: IdentityEvidence): string | number | boolean | null {
  switch (evidence.capability) {
    case "nationality":
      return countryValue(evidence)
    case "minimum_age":
      return minimumAgeValue(evidence)
    case "age_over_18":
      return minimumAgeValue(evidence) != null && minimumAgeValue(evidence)! >= 18
    case "gender":
      return genderValue(evidence)
    case "unique_human":
      return true
  }
}

function normalizedCountries(values: readonly string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => normalizeIdentityCountryCode(value))
    .filter((value): value is string => value !== null)
}

function matchesAtom(evidence: IdentityEvidence, atom: IdentityEvidenceAtom): boolean {
  if (!atom.acceptedProviders.includes(evidence.provider)) return false
  switch (atom.capability) {
    case "unique_human":
      return true
    case "nationality": {
      const country = countryValue(evidence)
      if (!country) return false
      const required = normalizedCountries(atom.requiredCountries)
      const excluded = normalizedCountries(atom.excludedCountries)
      return (required.length === 0 || required.includes(country)) && !excluded.includes(country)
    }
    case "minimum_age":
      return (minimumAgeValue(evidence) ?? -1) >= (atom.minimumAge ?? Number.POSITIVE_INFINITY)
    case "age_over_18":
      return (minimumAgeValue(evidence) ?? -1) >= 18
    case "gender":
      return (atom.requiredGender == null || genderValue(evidence) === atom.requiredGender)
        && (atom.allowedGenders == null || atom.allowedGenders.includes(genderValue(evidence) ?? ""))
  }
}

/** Read durable evidence, optionally retaining expired rows for explicit binding reads. The projection is never consulted. */
export async function readActiveIdentityEvidence(input: {
  client: Executor
  userId: string
  now?: Date
  capabilities?: readonly ProviderKeyedEvidenceCapability[]
  includeExpired?: boolean
}): Promise<IdentityEvidence[]> {
  const now = input.now ?? new Date()
  const capabilities = input.capabilities?.length
    ? [...new Set(input.capabilities)]
    : [...PROVIDER_KEYED_EVIDENCE_CAPABILITIES]
  const placeholders = capabilities.map((_, index) => `?${index + 3}`).join(", ")
  const expiryClause = input.includeExpired ? "" : "AND (a.expires_at IS NULL OR a.expires_at > ?2)"
  const result = await input.client.execute({
    sql: `
      SELECT
        a.user_attestation_id,
        a.user_id,
        a.source_verification_session_id,
        a.source_identity_nullifier_id,
        a.provider,
        a.attestation_type,
        a.capability_key,
        a.value_json,
        a.verified_at,
        a.expires_at,
        n.identity_nullifier_id AS active_nullifier_id,
        n.mechanism AS nullifier_mechanism,
        n.status AS nullifier_status,
        n.user_id AS nullifier_user_id,
        n.provider AS nullifier_provider
      FROM user_attestations a
      LEFT JOIN identity_nullifiers n
        ON n.user_id = a.user_id
       AND n.provider = a.provider
       AND n.status = 'active'
       AND (
         (a.capability_key = 'unique_human' AND n.source_user_attestation_id = a.user_attestation_id)
         OR (a.capability_key = 'nationality' AND n.identity_nullifier_id = a.source_identity_nullifier_id)
       )
      WHERE a.user_id = ?1
        AND a.status = 'accepted'
        AND a.revoked_at IS NULL
        AND a.verified_at IS NOT NULL
        AND a.verified_at <= ?2
        ${expiryClause}
        AND a.capability_key IN (${placeholders})
      ORDER BY a.verified_at DESC, a.user_attestation_id ASC
    `,
    args: [input.userId, now.toISOString(), ...capabilities],
  })

  const evidence: IdentityEvidence[] = []
  for (const row of result.rows) {
    const evidenceId = stringOrNull(rowValue(row, "user_attestation_id"))
    const userId = stringOrNull(rowValue(row, "user_id"))
    const capability = rowCapability(rowValue(row, "capability_key"))
    const provider = stringOrNull(rowValue(row, "provider"))
    const verifiedAt = rowTime(rowValue(row, "verified_at"))
    if (!evidenceId || !userId || !capability || !provider || !verifiedAt) continue

    const activeNullifierId = stringOrNull(rowValue(row, "active_nullifier_id"))
    const requiresNullifier = capability === "unique_human" || capability === "nationality"
    if (requiresNullifier && !activeNullifierId) continue
    const sourceIdentityNullifierId = requiresNullifier
      ? activeNullifierId
      : stringOrNull(rowValue(row, "source_identity_nullifier_id"))
    evidence.push({
      evidenceId,
      userId,
      capability,
      provider,
      mechanism: stringOrNull(rowValue(row, "nullifier_mechanism"))
        ?? stringOrNull(rowValue(row, "attestation_type"))
        ?? "attestation",
      value: parseJsonValue(rowValue(row, "value_json")),
      verifiedAt,
      expiresAt: rowTime(rowValue(row, "expires_at")),
      sourceVerificationSessionId: stringOrNull(rowValue(row, "source_verification_session_id")),
      sourceIdentityNullifierId,
    })
  }
  return evidence
}

/** Evaluate one atom using a single matching provider-keyed witness. */
export function evaluateIdentityEvidenceAtom(input: {
  evidence: readonly IdentityEvidence[]
  atom: IdentityEvidenceAtom
}): IdentityEvidenceAtomEvaluation {
  const candidates = input.evidence.filter((evidence) => evidence.capability === input.atom.capability)
  const witnesses = candidates.filter((evidence) => matchesAtom(evidence, input.atom))
  if (witnesses.length > 0) {
    return { outcome: "passed", witnesses, missingCapabilities: [], mismatchReasons: [] }
  }
  const acceptedCandidates = candidates.filter((evidence) => input.atom.acceptedProviders.includes(evidence.provider))
  if (acceptedCandidates.length === 0 && candidates.length > 0) {
    return {
      outcome: "action_required",
      witnesses: [],
      missingCapabilities: [input.atom.capability],
      mismatchReasons: ["provider_not_accepted"],
    }
  }
  if (candidates.length === 0) {
    return { outcome: "action_required", witnesses: [], missingCapabilities: [input.atom.capability], mismatchReasons: [] }
  }
  return {
    outcome: "terminal_mismatch",
    witnesses: [],
    missingCapabilities: [],
    mismatchReasons: [
      input.atom.capability === "nationality" && (input.atom.requiredCountries?.length ?? 0) > 0
        ? "nationality_mismatch"
        : input.atom.capability === "nationality" && (input.atom.excludedCountries?.length ?? 0) > 0
          ? "nationality_excluded"
          : input.atom.capability === "minimum_age" || input.atom.capability === "age_over_18"
            ? "minimum_age_mismatch"
            : input.atom.capability === "gender"
              ? "gender_mismatch"
              : "provider_or_value_mismatch",
    ],
  }
}
