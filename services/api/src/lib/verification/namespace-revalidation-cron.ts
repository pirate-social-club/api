import type { Env } from "../../env"
import type { Client, InStatement, QueryResultRow } from "../sql-client"
import { makeId } from "../helpers"
import { inspectHnsRoot, type HnsInspectResult } from "./hns-verifier"

const HSD_EXPIRY_PROVIDER = "hsd_json_rpc"
const DEFAULT_INTERVAL_SECONDS = 24 * 60 * 60
const DEFAULT_VALIDITY_SECONDS = 30 * 24 * 60 * 60
const DEFAULT_BATCH_SIZE = 25
const MAX_RUN_TIME_MS = 25_000
const WRITE_TIME_RESERVE_MS = 2_000

export type HnsNamespaceRevalidationSummary = {
  enabled: boolean
  candidates: number
  attempted: number
  refreshed: number
  downgraded: number
  staled: number
  deferred: number
  errors: number
  deadlineReached: boolean
}

type RevalidationCandidate = {
  namespaceVerificationId: string
  sessionId: string
  rootLabel: string
  expiresAt: string
  rootExists: number
  rootControlVerified: number | null
  pirateDnsAuthorityVerified: number | null
  authorityHealthVerified: number | null
}

type RevalidationConfig = {
  enabled: boolean
  intervalSeconds: number
  validitySeconds: number
  batchSize: number
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = raw?.trim() ? Number(raw) : fallback
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

export function isHnsNamespaceRevalidationEnabled(env: Env): boolean {
  return env.HNS_NAMESPACE_REVALIDATION_ENABLED?.trim().toLowerCase() === "true"
}

export function resolveHnsNamespaceRevalidationConfig(env: Env): RevalidationConfig {
  const enabled = isHnsNamespaceRevalidationEnabled(env)
  const intervalSeconds = parseBoundedInteger(
    env.HNS_NAMESPACE_REVALIDATION_INTERVAL_SECONDS,
    DEFAULT_INTERVAL_SECONDS,
    5 * 60,
    30 * 24 * 60 * 60,
    "HNS_NAMESPACE_REVALIDATION_INTERVAL_SECONDS",
  )
  const validitySeconds = parseBoundedInteger(
    env.HNS_NAMESPACE_REVALIDATION_VALIDITY_SECONDS,
    DEFAULT_VALIDITY_SECONDS,
    60 * 60,
    90 * 24 * 60 * 60,
    "HNS_NAMESPACE_REVALIDATION_VALIDITY_SECONDS",
  )
  const batchSize = parseBoundedInteger(
    env.HNS_NAMESPACE_REVALIDATION_BATCH_SIZE,
    DEFAULT_BATCH_SIZE,
    1,
    100,
    "HNS_NAMESPACE_REVALIDATION_BATCH_SIZE",
  )
  if (validitySeconds <= intervalSeconds) {
    throw new Error("HNS namespace revalidation validity must exceed its interval")
  }
  return { enabled, intervalSeconds, validitySeconds, batchSize }
}

function requiredString(row: QueryResultRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`HNS namespace revalidation row is missing ${key}`)
  }
  return value
}

function nullableBooleanInteger(row: QueryResultRow, key: string): number | null {
  const value = row[key]
  if (value == null) return null
  const numeric = Number(value)
  return numeric === 0 || numeric === 1 ? numeric : null
}

function toCandidate(row: QueryResultRow): RevalidationCandidate {
  return {
    namespaceVerificationId: requiredString(row, "namespace_verification_id"),
    sessionId: requiredString(row, "source_namespace_verification_session_id"),
    rootLabel: requiredString(row, "normalized_root_label"),
    expiresAt: requiredString(row, "expires_at"),
    rootExists: nullableBooleanInteger(row, "root_exists") ?? 0,
    rootControlVerified: nullableBooleanInteger(row, "root_control_verified"),
    pirateDnsAuthorityVerified: nullableBooleanInteger(row, "pirate_dns_authority_verified"),
    authorityHealthVerified: nullableBooleanInteger(row, "authority_health_verified"),
  }
}

async function selectCandidates(
  client: Client,
  now: string,
  dueBefore: string,
  limit: number,
): Promise<RevalidationCandidate[]> {
  const result = await client.execute({
    sql: `
      SELECT
        nv.namespace_verification_id,
        nv.source_namespace_verification_session_id,
        nv.normalized_root_label,
        nv.expires_at,
        nv.root_exists,
        nv.root_control_verified,
        nv.pirate_dns_authority_verified,
        nv.authority_health_verified
      FROM namespace_verifications AS nv
      WHERE nv.family = 'hns'
        AND nv.status = 'verified'
        AND (
          nv.expires_at <= ?1
          OR EXISTS (
            SELECT 1
            FROM namespace_verification_assertions AS expiry_assertion
            WHERE expiry_assertion.namespace_verification_id = nv.namespace_verification_id
              AND expiry_assertion.assertion_name = 'expiry_horizon_sufficient'
              AND expiry_assertion.status = 'accepted'
              AND expiry_assertion.last_revalidated_at IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM namespace_verification_evidence_bundles AS attempted_revalidation
                WHERE attempted_revalidation.namespace_verification_id = nv.namespace_verification_id
                  AND attempted_revalidation.evidence_kind = 'revalidation_snapshot'
              )
          )
          OR COALESCE(
            (
              SELECT MAX(evidence.observed_at)
              FROM namespace_verification_evidence_bundles AS evidence
              WHERE evidence.namespace_verification_id = nv.namespace_verification_id
                AND evidence.evidence_kind = 'revalidation_snapshot'
            ),
            (
              SELECT MAX(expiry_assertion.last_revalidated_at)
              FROM namespace_verification_assertions AS expiry_assertion
              WHERE expiry_assertion.namespace_verification_id = nv.namespace_verification_id
                AND expiry_assertion.assertion_name = 'expiry_horizon_sufficient'
            ),
            nv.accepted_at
          ) <= ?2
        )
      ORDER BY nv.expires_at ASC, nv.accepted_at ASC
      LIMIT ?3
    `,
    args: [now, dueBefore, limit],
  })
  return result.rows.map(toCandidate)
}

function evidenceStatement(input: {
  candidate: RevalidationCandidate
  evidenceBundleId: string
  inspection: HnsInspectResult | null
  outcome: "refreshed" | "downgraded" | "stale" | "deferred"
  observedAt: string
}): InStatement {
  const provider = input.inspection?.expiry_observation_provider ?? null
  return {
    sql: `
      INSERT INTO namespace_verification_evidence_bundles (
        evidence_bundle_id, namespace_verification_session_id, namespace_verification_id,
        family, normalized_root_label, evidence_kind, provider, resolver_path_json,
        raw_response_json, evidence_hash, observed_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'hns', ?4, 'revalidation_snapshot', ?5, ?6, ?7, NULL, ?8, ?8, ?8)
    `,
    args: [
      input.evidenceBundleId,
      input.candidate.sessionId,
      input.candidate.namespaceVerificationId,
      input.candidate.rootLabel,
      provider,
      JSON.stringify(provider ? [provider] : []),
      JSON.stringify({
        revalidation_outcome: input.outcome,
        previous_expires_at: input.candidate.expiresAt,
        inspection: input.inspection,
      }),
      input.observedAt,
    ],
  }
}

function expiryCapabilityValues(candidate: RevalidationCandidate): {
  clubAttachAllowed: number
  pirateSubdomainIssuanceAllowed: number
} {
  return {
    clubAttachAllowed: candidate.rootControlVerified === 1 ? 1 : 0,
    pirateSubdomainIssuanceAllowed:
      candidate.rootControlVerified === 1
        && candidate.pirateDnsAuthorityVerified === 1
        && candidate.authorityHealthVerified === 1
        ? 1
        : 0,
  }
}

async function refreshCandidate(input: {
  client: Client
  candidate: RevalidationCandidate
  inspection: HnsInspectResult
  now: string
  nextExpiry: string
}): Promise<void> {
  const evidenceBundleId = makeId("nev")
  const capabilities = expiryCapabilityValues(input.candidate)
  await input.client.batch([
    evidenceStatement({
      candidate: input.candidate,
      evidenceBundleId,
      inspection: input.inspection,
      outcome: "refreshed",
      observedAt: input.now,
    }),
    {
      sql: `
        UPDATE namespace_verifications
        SET root_exists = 1,
            expiry_horizon_sufficient = 1,
            club_attach_allowed = ?2,
            pirate_subdomain_issuance_allowed = ?3,
            evidence_bundle_ref = ?4,
            expires_at = ?5,
            updated_at = ?6
        WHERE namespace_verification_id = ?1
          AND status = 'verified'
      `,
      args: [
        input.candidate.namespaceVerificationId,
        capabilities.clubAttachAllowed,
        capabilities.pirateSubdomainIssuanceAllowed,
        evidenceBundleId,
        input.nextExpiry,
        input.now,
      ],
    },
    {
      sql: `
        UPDATE namespace_verification_assertions
        SET assertion_value = 1,
            status = 'accepted',
            source_evidence_bundle_id = ?2,
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND assertion_name IN ('root_exists', 'expiry_horizon_sufficient')
          AND EXISTS (
            SELECT 1
            FROM namespace_verifications AS current_verification
            WHERE current_verification.namespace_verification_id = ?1
              AND current_verification.status = 'verified'
          )
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    },
    {
      sql: `
        UPDATE namespace_verification_capabilities
        SET capability_value = CASE capability_name
              WHEN 'club_attach_allowed' THEN ?2
              WHEN 'pirate_subdomain_issuance_allowed' THEN ?3
              ELSE capability_value
            END,
            status = 'accepted',
            source_evidence_bundle_id = ?4,
            last_revalidated_at = ?5,
            updated_at = ?5
        WHERE namespace_verification_id = ?1
          AND capability_name IN ('club_attach_allowed', 'pirate_subdomain_issuance_allowed')
          AND EXISTS (
            SELECT 1
            FROM namespace_verifications AS current_verification
            WHERE current_verification.namespace_verification_id = ?1
              AND current_verification.status = 'verified'
          )
      `,
      args: [
        input.candidate.namespaceVerificationId,
        capabilities.clubAttachAllowed,
        capabilities.pirateSubdomainIssuanceAllowed,
        evidenceBundleId,
        input.now,
      ],
    },
  ], "write")
}

async function downgradeCandidate(input: {
  client: Client
  candidate: RevalidationCandidate
  inspection: HnsInspectResult
  now: string
}): Promise<void> {
  const evidenceBundleId = makeId("nev")
  await input.client.batch([
    evidenceStatement({
      candidate: input.candidate,
      evidenceBundleId,
      inspection: input.inspection,
      outcome: "downgraded",
      observedAt: input.now,
    }),
    {
      sql: `
        UPDATE namespace_verifications
        SET root_exists = 1,
            expiry_horizon_sufficient = 0,
            club_attach_allowed = 0,
            pirate_subdomain_issuance_allowed = 0,
            evidence_bundle_ref = ?2,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND status = 'verified'
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    },
    {
      sql: `
        UPDATE namespace_verification_assertions
        SET assertion_value = 0,
            status = 'stale',
            source_evidence_bundle_id = ?2,
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND assertion_name = 'expiry_horizon_sufficient'
          AND EXISTS (
            SELECT 1
            FROM namespace_verifications AS current_verification
            WHERE current_verification.namespace_verification_id = ?1
              AND current_verification.status = 'verified'
          )
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    },
    {
      sql: `
        UPDATE namespace_verification_capabilities
        SET capability_value = 0,
            status = 'stale',
            source_evidence_bundle_id = ?2,
            last_revalidated_at = ?3,
            updated_at = ?3
        WHERE namespace_verification_id = ?1
          AND capability_name IN ('club_attach_allowed', 'pirate_subdomain_issuance_allowed')
          AND EXISTS (
            SELECT 1
            FROM namespace_verifications AS current_verification
            WHERE current_verification.namespace_verification_id = ?1
              AND current_verification.status = 'verified'
          )
      `,
      args: [input.candidate.namespaceVerificationId, evidenceBundleId, input.now],
    },
  ], "write")
}

async function staleCandidate(input: {
  client: Client
  candidate: RevalidationCandidate
  inspection: HnsInspectResult | null
  now: string
  definitiveObservation: boolean
}): Promise<void> {
  const evidenceBundleId = makeId("nev")
  const rootMissing = input.inspection?.expiry_root_exists === false
  const expiryValue = input.inspection?.expiry_horizon_sufficient === true
    ? 1
    : input.inspection?.expiry_horizon_sufficient === false
      ? 0
      : null
  await input.client.batch([
    evidenceStatement({
      candidate: input.candidate,
      evidenceBundleId,
      inspection: input.inspection,
      outcome: "stale",
      observedAt: input.now,
    }),
    {
      sql: `
        UPDATE namespace_verifications
        SET status = 'stale',
            root_exists = ?2,
            expiry_horizon_sufficient = ?3,
            club_attach_allowed = 0,
            pirate_web_routing_allowed = 0,
            pirate_subdomain_issuance_allowed = 0,
            evidence_bundle_ref = ?4,
            updated_at = ?5
        WHERE namespace_verification_id = ?1
          AND status = 'verified'
      `,
      args: [
        input.candidate.namespaceVerificationId,
        rootMissing ? 0 : input.candidate.rootExists,
        expiryValue,
        evidenceBundleId,
        input.now,
      ],
    },
    {
      sql: `
        UPDATE namespace_verification_assertions
        SET assertion_value = CASE
              WHEN assertion_name = 'root_exists' AND ?2 = 1 THEN 0
              WHEN assertion_name = 'expiry_horizon_sufficient' THEN ?3
              ELSE assertion_value
            END,
            status = 'stale',
            source_evidence_bundle_id = ?4,
            last_revalidated_at = CASE
              WHEN ?5 = 1 AND assertion_name IN ('root_exists', 'expiry_horizon_sufficient') THEN ?6
              WHEN ?2 = 1 AND assertion_name = 'root_control_verified' THEN ?6
              ELSE last_revalidated_at
            END,
            updated_at = ?6
        WHERE namespace_verification_id = ?1
          AND assertion_name IN (
            'root_exists',
            'root_control_verified',
            'expiry_horizon_sufficient',
            'routing_enabled',
            'pirate_dns_authority_verified',
            'authority_health_verified'
          )
      `,
      args: [
        input.candidate.namespaceVerificationId,
        rootMissing ? 1 : 0,
        expiryValue,
        evidenceBundleId,
        input.definitiveObservation ? 1 : 0,
        input.now,
      ],
    },
    {
      sql: `
        UPDATE namespace_verification_capabilities
        SET capability_value = 0,
            status = 'stale',
            source_evidence_bundle_id = ?2,
            last_revalidated_at = CASE WHEN ?3 = 1 THEN ?4 ELSE last_revalidated_at END,
            updated_at = ?4
        WHERE namespace_verification_id = ?1
      `,
      args: [
        input.candidate.namespaceVerificationId,
        evidenceBundleId,
        input.definitiveObservation ? 1 : 0,
        input.now,
      ],
    },
  ], "write")
}

async function recordDeferredAttempt(input: {
  client: Client
  candidate: RevalidationCandidate
  inspection: HnsInspectResult | null
  now: string
}): Promise<void> {
  await input.client.execute(evidenceStatement({
    candidate: input.candidate,
    evidenceBundleId: makeId("nev"),
    inspection: input.inspection,
    outcome: "deferred",
    observedAt: input.now,
  }))
}

export async function sweepHnsNamespaceRevalidations(input: {
  client: Client
  env: Env
  now?: Date
  config?: RevalidationConfig
  clock?: () => number
}): Promise<HnsNamespaceRevalidationSummary> {
  const config = input.config ?? resolveHnsNamespaceRevalidationConfig(input.env)
  const summary: HnsNamespaceRevalidationSummary = {
    enabled: config.enabled,
    candidates: 0,
    attempted: 0,
    refreshed: 0,
    downgraded: 0,
    staled: 0,
    deferred: 0,
    errors: 0,
    deadlineReached: false,
  }
  if (!config.enabled) return summary

  const now = input.now ?? new Date()
  const clock = input.clock ?? Date.now
  const deadline = clock() + MAX_RUN_TIME_MS
  const nowIso = now.toISOString()
  const dueBefore = new Date(now.getTime() - config.intervalSeconds * 1000).toISOString()
  const nextExpiry = new Date(now.getTime() + config.validitySeconds * 1000).toISOString()
  const candidates = await selectCandidates(input.client, nowIso, dueBefore, config.batchSize)
  summary.candidates = candidates.length

  for (const candidate of candidates) {
    const inspectionBudgetMs = deadline - clock() - WRITE_TIME_RESERVE_MS
    if (inspectionBudgetMs <= 0) {
      summary.deadlineReached = true
      break
    }
    summary.attempted += 1
    let inspection: HnsInspectResult | null = null
    try {
      inspection = await inspectHnsRoot(input.env, {
        rootLabel: candidate.rootLabel,
        signal: AbortSignal.timeout(Math.min(12_000, inspectionBudgetMs)),
      })
    } catch {
      try {
        if (Date.parse(candidate.expiresAt) <= now.getTime()) {
          await staleCandidate({
            client: input.client,
            candidate,
            inspection,
            now: nowIso,
            definitiveObservation: false,
          })
          summary.staled += 1
        } else {
          await recordDeferredAttempt({ client: input.client, candidate, inspection, now: nowIso })
          summary.deferred += 1
        }
      } catch {
        summary.errors += 1
      }
      continue
    }

    try {
      const trustedChainObservation = inspection.expiry_observation_provider === HSD_EXPIRY_PROVIDER
      const leaseExpired = Date.parse(candidate.expiresAt) <= now.getTime()

      if (trustedChainObservation && inspection.expiry_root_exists === false) {
        await staleCandidate({
          client: input.client,
          candidate,
          inspection,
          now: nowIso,
          definitiveObservation: true,
        })
        summary.staled += 1
        continue
      }

      // expires_at is also the accepted ownership proof's freshness lease.
      // Expiry-only evidence can never revive it: the current root may now
      // belong to someone else even when hsd reports a healthy renewal horizon.
      if (leaseExpired) {
        await staleCandidate({
          client: input.client,
          candidate,
          inspection,
          now: nowIso,
          definitiveObservation:
            trustedChainObservation
            && inspection.expiry_root_exists != null
            && inspection.expiry_horizon_sufficient != null,
        })
        summary.staled += 1
        continue
      }

      if (
        trustedChainObservation
        && inspection.expiry_root_exists === true
        && inspection.expiry_horizon_sufficient === true
      ) {
        await refreshCandidate({
          client: input.client,
          candidate,
          inspection,
          now: nowIso,
          nextExpiry,
        })
        summary.refreshed += 1
        continue
      }

      if (
        trustedChainObservation
        && inspection.expiry_root_exists === true
        && inspection.expiry_horizon_sufficient === false
      ) {
        await downgradeCandidate({ client: input.client, candidate, inspection, now: nowIso })
        summary.downgraded += 1
        continue
      }

      await recordDeferredAttempt({ client: input.client, candidate, inspection, now: nowIso })
      summary.deferred += 1
    } catch {
      summary.errors += 1
    }
  }

  return summary
}
