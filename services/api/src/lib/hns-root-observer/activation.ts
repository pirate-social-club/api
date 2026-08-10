import { auditEventInsert } from "../audit"
import { conflictError, verificationRequired } from "../errors"
import type { Client, QueryResultRow } from "../sql-client"
import { withTransaction } from "../transactions"
import { assertHnsRootLabel, normalizeHnsRootLabel } from "../verification/hns-verifier"

const REQUIRED_HEALTHY_CYCLES = 3
const MAX_OBSERVATION_AGE_MS = 15 * 60 * 1000
const MIN_RRSIG_REMAINING_MS = 30 * 60 * 1000
const MIN_OBSERVATION_SPREAD_MS = 10 * 60 * 1000

export type HnsRootActivationResult = {
  normalizedRootLabel: string
  activated: boolean
  alreadyActive: boolean
  evidenceObservationIds: string[]
}

function requiredText(row: QueryResultRow, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) {
    throw verificationRequired(`HNS activation evidence is missing ${key}`)
  }
  return value
}

function assertHealthyCycle(row: QueryResultRow, nowMs: number): { id: string; observedAt: number } {
  if (
    row.outcome !== "succeeded"
    || row.observed_delegation_security !== "secure"
    || Number(row.parent_ds_matches_live_dnskey) !== 1
    || Number(row.authoritative_dnssec_valid) !== 1
  ) {
    throw verificationRequired("The latest three HNS observations must all be secure")
  }

  const observedAt = Date.parse(requiredText(row, "observed_at"))
  if (!Number.isFinite(observedAt) || observedAt > nowMs || nowMs - observedAt > MAX_OBSERVATION_AGE_MS) {
    throw verificationRequired("The latest HNS observations are not fresh enough for activation")
  }
  const rrsigExpiresAt = Date.parse(requiredText(row, "earliest_rrsig_expires_at"))
  if (!Number.isFinite(rrsigExpiresAt) || rrsigExpiresAt - nowMs <= MIN_RRSIG_REMAINING_MS) {
    throw verificationRequired("The HNS DNSSEC signatures are too close to expiry for activation")
  }
  return { id: requiredText(row, "parent_observation_id"), observedAt }
}

export async function activateHnsRootRouting(
  client: Client,
  input: {
    rootLabel: string
    operatorActorId: string
    reason: string
    now?: string
  },
): Promise<HnsRootActivationResult> {
  const normalizedRootLabel = normalizeHnsRootLabel(input.rootLabel)
  assertHnsRootLabel(normalizedRootLabel)
  const reason = input.reason.trim()
  if (!reason) throw conflictError("HNS root activation requires an audit reason")
  const now = input.now ?? new Date().toISOString()
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw conflictError("HNS root activation time is invalid")

  return withTransaction(client, "write", async (tx) => {
    const stateResult = await tx.execute({
      sql: `
        SELECT canonical_routing_eligible, routing_hard_denied
        FROM hns_root_delegation_state
        WHERE normalized_root_label = ?1
        LIMIT 1
      `,
      args: [normalizedRootLabel],
    })
    const state = stateResult.rows[0]
    if (!state) throw verificationRequired("HNS root has no observer state")
    if (Number(state.routing_hard_denied) === 1) {
      throw conflictError("HNS root is hard-denied for routing")
    }

    const attachment = await tx.execute({
      sql: `
        SELECT 1 AS attached
        FROM namespace_verifications AS verification
        JOIN community_namespace_bindings AS binding
          ON binding.namespace_verification_id = verification.namespace_verification_id
        JOIN communities AS community
          ON community.community_id = binding.community_id
        WHERE verification.family = 'hns'
          AND verification.normalized_root_label = ?1
          AND verification.status = 'verified'
          AND verification.expires_at > ?2
          AND binding.status = 'active'
          AND community.status = 'active'
        LIMIT 1
      `,
      args: [normalizedRootLabel, now],
    })
    if (attachment.rows.length !== 1) {
      throw verificationRequired("HNS root is not attached to an active community")
    }

    const observations = await tx.execute({
      sql: `
        SELECT parent_observation_id, outcome, observed_delegation_security,
               parent_ds_matches_live_dnskey, authoritative_dnssec_valid,
               earliest_rrsig_expires_at, observed_at
        FROM hns_root_parent_observations
        WHERE normalized_root_label = ?1
        ORDER BY observed_at DESC, created_at DESC
        LIMIT 3
      `,
      args: [normalizedRootLabel],
    })
    if (observations.rows.length !== REQUIRED_HEALTHY_CYCLES) {
      throw verificationRequired("Three HNS observer cycles are required before activation")
    }
    const healthyCycles = observations.rows.map((row) => assertHealthyCycle(row, nowMs))
    const observationTimes = healthyCycles.map((cycle) => cycle.observedAt)
    if (Math.max(...observationTimes) - Math.min(...observationTimes) < MIN_OBSERVATION_SPREAD_MS) {
      throw verificationRequired("Three HNS observer cycles must span at least ten minutes")
    }
    const evidenceObservationIds = healthyCycles.map((cycle) => cycle.id)
    const alreadyActive = Number(state.canonical_routing_eligible) === 1
    if (alreadyActive) {
      return {
        normalizedRootLabel,
        activated: false,
        alreadyActive: true,
        evidenceObservationIds,
      }
    }

    const update = await tx.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET canonical_routing_eligible = 1,
            updated_at = ?2
        WHERE normalized_root_label = ?1
          -- Legacy rows created before the non-null defaults were enforced
          -- can still carry NULL. Treat it as the existing false read value.
          -- TODO(2026-09-01, control-plane schema owner): remove COALESCE after
          -- the production constraint audit confirms no nullable rows remain.
          AND COALESCE(canonical_routing_eligible, 0) = 0
          AND COALESCE(routing_hard_denied, 0) = 0
      `,
      args: [normalizedRootLabel, now],
    })
    if ((update.rowsAffected ?? 0) !== 1) {
      throw conflictError("HNS root activation state changed concurrently")
    }

    await tx.execute(auditEventInsert({
      action: "hns_root.routing_activate",
      actorId: input.operatorActorId,
      actorType: "operator",
      createdAt: now,
      metadata: {
        reason,
        required_healthy_cycles: REQUIRED_HEALTHY_CYCLES,
        minimum_observation_spread_ms: MIN_OBSERVATION_SPREAD_MS,
        evidence_parent_observation_ids: evidenceObservationIds,
        redundancy_policy: "report_only",
      },
      targetId: normalizedRootLabel,
      targetType: "hns_root",
    }))

    return {
      normalizedRootLabel,
      activated: true,
      alreadyActive: false,
      evidenceObservationIds,
    }
  })
}
