import type { Env } from "../../env"
import { makeId, nowIso } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { requireRewardCampaignAlertOwnership } from "./reward-campaign-alert-config"
import { resolveRewardCampaignConfig } from "./reward-campaign-config"
import {
  checkRewardCampaignFundingFinality,
  createRewardCampaignFinalityProvider,
  type RewardCampaignFinalityProvider,
  verifyRewardCampaignFinalityChain,
} from "./reward-campaign-finality"

export type RewardCampaignMonitorSummary = {
  enabled: boolean
  scanned: number
  held: number
  accounting_mismatches: number
  finality_failures: number
  missing_provenance: number
  finality_checks_attempted: number
  transient_finality_checks: number
  transient_finality_rate: number
  liveness_stale: boolean
  coverage_stale: boolean
  wholly_blind: boolean
  partial_finality_degraded: boolean
  scan_successful: boolean
  incidents: Array<{
    incident_id: string
    campaign_id: string
    kind: IncidentKind
    reason: string
    details: Record<string, unknown>
  }>
}

export type IncidentKind = "accounting_mismatch" | "funding_finality_failure" | "funding_provenance_missing"

const MONITOR_STALE_AFTER_MS = 20 * 60_000
const PARTIAL_FINALITY_ALERT_RATE = 0.25

function integerText(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value)
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) return value.trim()
  return null
}

function centsDelta(stored: unknown, computed: unknown): string | null {
  const storedText = integerText(stored)
  const computedText = integerText(computed)
  if (storedText === null || computedText === null) return null
  return (BigInt(storedText) - BigInt(computedText)).toString()
}

export function rewardCampaignAccountingAlertDetails(row: Record<string, unknown>): Record<string, unknown> {
  const storedFunded = rowValue(row, "stored_funded_cents")
  const computedFunded = rowValue(row, "computed_funded_cents")
  const storedReserved = rowValue(row, "stored_reserved_cents")
  const computedReserved = rowValue(row, "computed_reserved_cents")
  const storedCredited = rowValue(row, "stored_credited_cents")
  const computedCredited = rowValue(row, "computed_credited_cents")
  return {
    stored_funded_cents: storedFunded,
    computed_funded_cents: computedFunded,
    funded_delta_cents: centsDelta(storedFunded, computedFunded),
    stored_reserved_cents: storedReserved,
    computed_reserved_cents: computedReserved,
    reserved_delta_cents: centsDelta(storedReserved, computedReserved),
    stored_credited_cents: storedCredited,
    computed_credited_cents: computedCredited,
    credited_delta_cents: centsDelta(storedCredited, computedCredited),
  }
}

function emptyMonitorSummary(enabled: boolean): RewardCampaignMonitorSummary {
  return {
    enabled,
    scanned: 0,
    held: 0,
    accounting_mismatches: 0,
    finality_failures: 0,
    missing_provenance: 0,
    finality_checks_attempted: 0,
    transient_finality_checks: 0,
    transient_finality_rate: 0,
    liveness_stale: false,
    coverage_stale: false,
    wholly_blind: false,
    partial_finality_degraded: false,
    scan_successful: false,
    incidents: [],
  }
}

async function recordIncidentCandidate(input: {
  client: Client; campaignId: string; kind: IncidentKind
  reason: string; details: Record<string, unknown>; owner: string; destination: string; now: string; rowLocks: boolean
}): Promise<{ incidentId: string; held: boolean } | null> {
  return withTransaction(input.client, "write", async (tx) => {
    const locked = await tx.execute({
      sql: `SELECT status FROM reward_campaigns WHERE reward_campaign_id = ?1${input.rowLocks ? " FOR UPDATE" : ""}`,
      args: [input.campaignId],
    })
    if (!locked.rows[0]) return null
    // The broad scan is only a candidate finder. Accounting evidence must still be bad
    // after acquiring the same campaign lock used by the credit writer.
    if (input.kind === "accounting_mismatch") {
      const current = await tx.execute({
        sql: `SELECT counters_match FROM reward_campaign_accounting_reconciliation WHERE reward_campaign_id = ?1`,
        args: [input.campaignId],
      })
      if (current.rows[0]?.counters_match !== false) return null
    }
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_incidents (
          reward_campaign_incident_id, reward_campaign_id, incident_kind, reason,
          details_json, opened_at, last_seen_at, alert_owner, alert_destination
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
        ON CONFLICT (reward_campaign_id, incident_kind) WHERE resolved_at IS NULL
        DO UPDATE SET
          last_seen_at = GREATEST(reward_campaign_incidents.last_seen_at, excluded.last_seen_at),
          occurrence_count = reward_campaign_incidents.occurrence_count + CASE
            WHEN excluded.last_seen_at <= reward_campaign_incidents.last_seen_at THEN 0
            WHEN reward_campaign_incidents.occurrence_count = 1
              AND excluded.last_seen_at >= reward_campaign_incidents.opened_at + INTERVAL '55 seconds' THEN 1
            WHEN reward_campaign_incidents.occurrence_count > 1
              AND excluded.last_seen_at >= reward_campaign_incidents.last_seen_at + INTERVAL '55 seconds' THEN 1
            ELSE 0
          END
      `,
      args: [makeId("rci"), input.campaignId, input.kind, input.reason, JSON.stringify(input.details), input.now, input.owner, input.destination],
    })
    const incident = await tx.execute({
      sql: `SELECT reward_campaign_incident_id, occurrence_count FROM reward_campaign_incidents WHERE reward_campaign_id = ?1 AND incident_kind = ?2 AND resolved_at IS NULL`,
      args: [input.campaignId, input.kind],
    })
    const incidentId = requiredString(incident.rows[0], "reward_campaign_incident_id")
    if (
      Number(rowValue(incident.rows[0], "occurrence_count")) < 2
      || input.kind === "funding_provenance_missing"
    ) return { incidentId, held: false }
    // Incidents remain auditable for terminal campaigns, but a hold may only stop a
    // lifecycle that can still admit rewards. Never destroy ended/exhausted state.
    const held = await tx.execute({
      sql: `UPDATE reward_campaigns SET status_before_operational_hold = status, status = 'operational_hold', operational_hold_reason = ?2, operational_held_at = COALESCE(operational_held_at, ?3), operational_held_by = 'scheduled_monitor', updated_at = ?3 WHERE reward_campaign_id = ?1 AND status IN ('scheduled', 'active', 'paused') RETURNING reward_campaign_id`,
      args: [input.campaignId, input.reason, input.now],
    })
    return { incidentId, held: (held.rowsAffected ?? held.rows.length) > 0 }
  })
}

function rotatingPageOffset(now: string, total: number, limit: number): number {
  const pages = Math.max(1, Math.ceil(total / limit))
  const minute = Math.floor(Date.parse(now) / 60_000)
  const page = Number.isSafeInteger(minute) ? ((minute % pages) + pages) % pages : 0
  return page * limit
}

export async function monitorRewardCampaigns(input: {
  env: Env
  client: Client
  now?: string
  limit?: number
  finalityProvider?: RewardCampaignFinalityProvider
}): Promise<RewardCampaignMonitorSummary> {
  const config = resolveRewardCampaignConfig(input.env)
  if (!config.enabled) return emptyMonitorSummary(false)
  const ownership = requireRewardCampaignAlertOwnership(input.env)
  const now = input.now ?? nowIso()
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
  const monitorState = await input.client.execute({
    sql: `SELECT first_attempted_scan_at, last_attempted_scan_at, last_successful_scan_at FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
    args: [],
  })
  const previousLastAttempt = stringOrNull(rowValue(monitorState.rows[0], "last_attempted_scan_at"))
  const summary: RewardCampaignMonitorSummary = {
    ...emptyMonitorSummary(true),
    liveness_stale: Boolean(previousLastAttempt && Date.parse(now) - Date.parse(previousLastAttempt) > MONITOR_STALE_AFTER_MS),
  }
  const rowLocks = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL ?? ""))
  // Coverage incidents auto-resolve once every confirmed effect has persisted provenance.
  await input.client.execute({
    sql: `
      UPDATE reward_campaign_incidents i
      SET resolved_at = ?1, resolved_by = 'scheduled_monitor',
          resolution_note = 'Funding provenance backfilled', incident_version = incident_version + 1
      WHERE i.reward_campaign_incident_id IN (
        SELECT candidate.reward_campaign_incident_id
        FROM reward_campaign_incidents candidate
        WHERE candidate.incident_kind = 'funding_provenance_missing'
          AND candidate.resolved_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM reward_campaign_funding_effects f
            WHERE f.reward_campaign_id = candidate.reward_campaign_id AND f.status = 'confirmed'
              AND (f.confirmed_block_number IS NULL OR f.confirmed_block_hash IS NULL)
          )
        ORDER BY candidate.opened_at, candidate.reward_campaign_incident_id
        LIMIT ?2
      )
    `,
    args: [now, limit],
  })
  const mismatchCount = await input.client.execute({
    sql: `SELECT COUNT(*) AS count FROM reward_campaign_accounting_reconciliation WHERE counters_match = FALSE`, args: [],
  })
  const mismatchTotal = Number(rowValue(mismatchCount.rows[0], "count") ?? 0)
  const mismatches = await input.client.execute({
    sql: `SELECT * FROM reward_campaign_accounting_reconciliation WHERE counters_match = FALSE ORDER BY reward_campaign_id LIMIT ?1 OFFSET ?2`,
    args: [limit, rotatingPageOffset(now, mismatchTotal, limit)],
  })
  for (const row of mismatches.rows) {
    const campaignId = requiredString(row, "reward_campaign_id")
    summary.accounting_mismatches += 1
    const details = rewardCampaignAccountingAlertDetails(row)
    const recorded = await recordIncidentCandidate({ client: input.client, campaignId, kind: "accounting_mismatch", reason: "campaign_accounting_counters_mismatch", details, ...ownership, now, rowLocks })
    if (!recorded) continue
    if (recorded.held) summary.held += 1
    summary.incidents.push({ incident_id: recorded.incidentId, campaign_id: campaignId, kind: "accounting_mismatch", reason: "campaign_accounting_counters_mismatch", details })
  }
  const effectFilter = `f.status = 'confirmed' AND c.status IN ('scheduled','active','paused','operational_hold','exhausted','ended')`
  const effectCount = await input.client.execute({
    sql: `SELECT COUNT(*) AS count FROM reward_campaign_funding_effects f JOIN reward_campaigns c ON c.reward_campaign_id = f.reward_campaign_id WHERE ${effectFilter}`,
    args: [],
  })
  const effectTotal = Number(rowValue(effectCount.rows[0], "count") ?? 0)
  const effects = await input.client.execute({
    sql: `SELECT f.reward_campaign_funding_effect_id, f.reward_campaign_id, f.tx_hash, f.confirmed_block_number, f.confirmed_block_hash FROM reward_campaign_funding_effects f JOIN reward_campaigns c ON c.reward_campaign_id = f.reward_campaign_id WHERE ${effectFilter} ORDER BY f.reward_campaign_id, f.reward_campaign_funding_effect_id LIMIT ?1 OFFSET ?2`,
    args: [limit, rotatingPageOffset(now, effectTotal, limit)],
  })
  const rpcUrl = String(input.env.REWARDS_CAMPAIGN_RPC_URL ?? "").trim()
  const chainId = Number(input.env.REWARDS_CAMPAIGN_CHAIN_ID)
  const provider = input.finalityProvider
    ?? (rpcUrl && Number.isSafeInteger(chainId) && chainId > 0
      ? createRewardCampaignFinalityProvider(rpcUrl, chainId)
      : null)
  const hasFinalityCandidates = effects.rows.some((row) => (
    rowValue(row, "confirmed_block_number") != null
    && Boolean(stringOrNull(rowValue(row, "confirmed_block_hash")))
  ))
  const chainVerified = provider && Number.isSafeInteger(chainId) && chainId > 0 && hasFinalityCandidates
    ? await verifyRewardCampaignFinalityChain(provider, chainId)
    : !hasFinalityCandidates
  for (const row of effects.rows) {
    summary.scanned += 1
    const campaignId = requiredString(row, "reward_campaign_id")
    if (rowValue(row, "confirmed_block_number") == null || !stringOrNull(rowValue(row, "confirmed_block_hash"))) {
      const reason = "confirmed_funding_provenance_missing"
      summary.missing_provenance += 1
      const details = { tx_hash: stringOrNull(rowValue(row, "tx_hash")) }
      const recorded = await recordIncidentCandidate({ client: input.client, campaignId, kind: "funding_provenance_missing", reason, details, ...ownership, now, rowLocks })
      if (!recorded) continue
      if (recorded.held) summary.held += 1
      summary.incidents.push({ incident_id: recorded.incidentId, campaign_id: campaignId, kind: "funding_provenance_missing", reason, details })
      continue
    }
    summary.finality_checks_attempted += 1
    if (!provider || !chainVerified) {
      summary.transient_finality_checks += 1
      continue
    }
    const blockNumber = Number(rowValue(row, "confirmed_block_number"))
    const expectedHash = requiredString(row, "confirmed_block_hash").toLowerCase()
    const result = await checkRewardCampaignFundingFinality({
      provider,
      txHash: requiredString(row, "tx_hash"),
      confirmedBlockNumber: blockNumber,
      confirmedBlockHash: expectedHash,
    })
    if (result.kind === "transient") {
      summary.transient_finality_checks += 1
      continue
    }
    if (result.kind === "definitive_loss") {
      const details = { tx_hash: stringOrNull(rowValue(row, "tx_hash")), confirmed_block_number: blockNumber, confirmed_block_hash: expectedHash }
      summary.finality_failures += 1
      const recorded = await recordIncidentCandidate({ client: input.client, campaignId, kind: "funding_finality_failure", reason: result.reason, details, ...ownership, now, rowLocks })
      if (!recorded) continue
      if (recorded.held) summary.held += 1
      summary.incidents.push({ incident_id: recorded.incidentId, campaign_id: campaignId, kind: "funding_finality_failure", reason: result.reason, details })
    }
  }
  summary.scan_successful = summary.transient_finality_checks === 0
  summary.transient_finality_rate = summary.finality_checks_attempted === 0
    ? 0
    : summary.transient_finality_checks / summary.finality_checks_attempted
  summary.wholly_blind = summary.finality_checks_attempted > 0
    && summary.transient_finality_checks === summary.finality_checks_attempted
  summary.partial_finality_degraded = summary.transient_finality_checks > 0
    && !summary.wholly_blind
    && summary.transient_finality_rate >= PARTIAL_FINALITY_ALERT_RATE
  const updatedState = await input.client.execute({
    sql: `
      INSERT INTO reward_campaign_monitor_state (
        monitor_name, first_attempted_scan_at, last_attempted_scan_at,
        last_successful_scan_at, updated_at
      ) VALUES (
        'reward_campaign_integrity',
        CAST(?1 AS TIMESTAMPTZ), CAST(?1 AS TIMESTAMPTZ),
        CASE WHEN CAST(?2 AS BOOLEAN) THEN CAST(?1 AS TIMESTAMPTZ) ELSE NULL END,
        CAST(?1 AS TIMESTAMPTZ)
      )
      ON CONFLICT (monitor_name) DO UPDATE SET
        last_attempted_scan_at = excluded.last_attempted_scan_at,
        last_successful_scan_at = CASE
          WHEN CAST(?2 AS BOOLEAN) THEN excluded.last_successful_scan_at
          ELSE reward_campaign_monitor_state.last_successful_scan_at
        END,
        updated_at = excluded.updated_at
      RETURNING first_attempted_scan_at, last_successful_scan_at
    `,
    args: [now, summary.scan_successful],
  })
  const firstAttempt = stringOrNull(rowValue(updatedState.rows[0], "first_attempted_scan_at"))
  const lastSuccess = stringOrNull(rowValue(updatedState.rows[0], "last_successful_scan_at"))
  const coverageReference = lastSuccess ?? firstAttempt
  summary.coverage_stale = !summary.scan_successful
    && Boolean(coverageReference && Date.parse(now) - Date.parse(coverageReference) > MONITOR_STALE_AFTER_MS)
  return summary
}

export async function markRewardCampaignIncidentAlerted(input: {
  client: Client
  incidentId: string
  alertedAt?: string
}): Promise<void> {
  await input.client.execute({
    sql: `UPDATE reward_campaign_incidents SET alerted_at = COALESCE(alerted_at, ?2) WHERE resolved_at IS NULL AND reward_campaign_incident_id = ?1`,
    args: [input.incidentId, input.alertedAt ?? nowIso()],
  })
}
