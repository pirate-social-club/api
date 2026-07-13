import { JsonRpcProvider } from "ethers"
import type { Env } from "../../env"
import { makeId, nowIso } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import { isPostgresControlPlaneUrl } from "../runtime-deps"

export type RewardCampaignMonitorSummary = {
  scanned: number
  held: number
  accounting_mismatches: number
  finality_failures: number
  missing_provenance: number
  transient_finality_checks: number
  heartbeat_stale: boolean
  incidents: Array<{ campaign_id: string; kind: string; reason: string }>
}

function requiredOwnership(env: Env): { owner: string; destination: string } {
  const owner = String(env.REWARDS_CAMPAIGN_ALERT_OWNER ?? "").trim()
  const destination = String(env.REWARDS_CAMPAIGN_ALERT_DESTINATION ?? "").trim()
  if (!owner || !destination) throw new Error("reward_campaign_alert_ownership_missing")
  return { owner, destination }
}

export type IncidentKind = "accounting_mismatch" | "funding_finality_failure" | "funding_provenance_missing"

async function recordIncidentCandidate(input: {
  client: Client; campaignId: string; kind: IncidentKind
  reason: string; details: Record<string, unknown>; owner: string; destination: string; now: string; rowLocks: boolean
}): Promise<boolean> {
  return withTransaction(input.client, "write", async (tx) => {
    const locked = await tx.execute({
      sql: `SELECT status FROM reward_campaigns WHERE reward_campaign_id = ?1${input.rowLocks ? " FOR UPDATE" : ""}`,
      args: [input.campaignId],
    })
    if (!locked.rows[0]) return false
    // The broad scan is only a candidate finder. Accounting evidence must still be bad
    // after acquiring the same campaign lock used by the credit writer.
    if (input.kind === "accounting_mismatch") {
      const current = await tx.execute({
        sql: `SELECT counters_match FROM reward_campaign_accounting_reconciliation WHERE reward_campaign_id = ?1`,
        args: [input.campaignId],
      })
      if (current.rows[0]?.counters_match !== false) return false
    }
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_incidents (
          reward_campaign_incident_id, reward_campaign_id, incident_kind, reason,
          details_json, opened_at, last_seen_at, alert_owner, alert_destination
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, ?7, ?8)
        ON CONFLICT (reward_campaign_id, incident_kind) WHERE resolved_at IS NULL
        DO UPDATE SET
          last_seen_at = CASE
            WHEN excluded.last_seen_at >= reward_campaign_incidents.last_seen_at + INTERVAL '55 seconds'
              THEN excluded.last_seen_at
            ELSE reward_campaign_incidents.last_seen_at
          END,
          occurrence_count = reward_campaign_incidents.occurrence_count + CASE
            WHEN excluded.last_seen_at >= reward_campaign_incidents.last_seen_at + INTERVAL '55 seconds'
              THEN 1
            ELSE 0
          END,
          details_json = excluded.details_json
      `,
      args: [makeId("rci"), input.campaignId, input.kind, input.reason, JSON.stringify(input.details), input.now, input.owner, input.destination],
    })
    const incident = await tx.execute({
      sql: `SELECT occurrence_count FROM reward_campaign_incidents WHERE reward_campaign_id = ?1 AND incident_kind = ?2 AND resolved_at IS NULL`,
      args: [input.campaignId, input.kind],
    })
    if (
      Number(rowValue(incident.rows[0], "occurrence_count")) < 2
      || input.kind === "funding_provenance_missing"
    ) return false
    // Incidents remain auditable for terminal campaigns, but a hold may only stop a
    // lifecycle that can still admit rewards. Never destroy ended/exhausted state.
    const held = await tx.execute({
      sql: `UPDATE reward_campaigns SET status_before_operational_hold = status, status = 'operational_hold', operational_hold_reason = ?2, operational_held_at = COALESCE(operational_held_at, ?3), operational_held_by = 'scheduled_monitor', updated_at = ?3 WHERE reward_campaign_id = ?1 AND status IN ('scheduled', 'active', 'paused') RETURNING reward_campaign_id`,
      args: [input.campaignId, input.reason, input.now],
    })
    return (held.rowsAffected ?? held.rows.length) > 0
  })
}

export async function monitorRewardCampaigns(input: { env: Env; client: Client; now?: string; limit?: number }): Promise<RewardCampaignMonitorSummary> {
  const ownership = requiredOwnership(input.env)
  const now = input.now ?? nowIso()
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
  const heartbeat = await input.client.execute({
    sql: `SELECT last_successful_scan_at FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
    args: [],
  })
  const lastSuccess = stringOrNull(rowValue(heartbeat.rows[0], "last_successful_scan_at"))
  const summary: RewardCampaignMonitorSummary = {
    scanned: 0, held: 0, accounting_mismatches: 0, finality_failures: 0,
    missing_provenance: 0, transient_finality_checks: 0,
    heartbeat_stale: Boolean(lastSuccess && Date.parse(now) - Date.parse(lastSuccess) > 20 * 60_000),
    incidents: [],
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
  const mismatches = await input.client.execute({
    sql: `SELECT * FROM reward_campaign_accounting_reconciliation WHERE counters_match = FALSE ORDER BY reward_campaign_id LIMIT ?1`, args: [limit],
  })
  for (const row of mismatches.rows) {
    const campaignId = requiredString(row, "reward_campaign_id")
    summary.accounting_mismatches += 1
    const details = { stored_funded_cents: rowValue(row, "stored_funded_cents"), computed_funded_cents: rowValue(row, "computed_funded_cents"), stored_reserved_cents: rowValue(row, "stored_reserved_cents"), computed_reserved_cents: rowValue(row, "computed_reserved_cents"), stored_credited_cents: rowValue(row, "stored_credited_cents"), computed_credited_cents: rowValue(row, "computed_credited_cents") }
    if (await recordIncidentCandidate({ client: input.client, campaignId, kind: "accounting_mismatch", reason: "campaign_accounting_counters_mismatch", details, ...ownership, now, rowLocks })) summary.held += 1
    summary.incidents.push({ campaign_id: campaignId, kind: "accounting_mismatch", reason: "campaign_accounting_counters_mismatch" })
  }
  const effects = await input.client.execute({
    sql: `SELECT f.reward_campaign_id, f.tx_hash, f.confirmed_block_number, f.confirmed_block_hash FROM reward_campaign_funding_effects f JOIN reward_campaigns c ON c.reward_campaign_id = f.reward_campaign_id WHERE f.status = 'confirmed' AND c.status IN ('scheduled','active','paused','operational_hold','exhausted','ended') ORDER BY f.reward_campaign_id LIMIT ?1`, args: [limit],
  })
  const rpcUrl = String(input.env.REWARDS_CAMPAIGN_RPC_URL ?? "").trim()
  const chainId = Number(input.env.REWARDS_CAMPAIGN_CHAIN_ID)
  const provider = rpcUrl && Number.isSafeInteger(chainId) ? new JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true }) : null
  for (const row of effects.rows) {
    summary.scanned += 1
    const campaignId = requiredString(row, "reward_campaign_id")
    if (rowValue(row, "confirmed_block_number") == null || !stringOrNull(rowValue(row, "confirmed_block_hash"))) {
      const reason = "confirmed_funding_provenance_missing"
      summary.missing_provenance += 1
      if (await recordIncidentCandidate({ client: input.client, campaignId, kind: "funding_provenance_missing", reason, details: { tx_hash: stringOrNull(rowValue(row, "tx_hash")) }, ...ownership, now, rowLocks })) summary.held += 1
      summary.incidents.push({ campaign_id: campaignId, kind: "funding_provenance_missing", reason })
      continue
    }
    try {
      if (!provider) throw new Error("reward_campaign_rpc_not_configured")
      const receipt = await provider.getTransactionReceipt(requiredString(row, "tx_hash"))
      const blockNumber = Number(rowValue(row, "confirmed_block_number"))
      const expectedHash = requiredString(row, "confirmed_block_hash").toLowerCase()
      if (!receipt) {
        summary.transient_finality_checks += 1
        continue
      }
      const canonical = await provider.getBlock(blockNumber)
      if (!canonical?.hash) {
        summary.transient_finality_checks += 1
        continue
      }
      if (receipt.blockNumber !== blockNumber || receipt.blockHash.toLowerCase() !== expectedHash || canonical.hash.toLowerCase() !== expectedHash) {
        const reason = "confirmed_funding_receipt_not_canonical"
        const details = { tx_hash: stringOrNull(rowValue(row, "tx_hash")), confirmed_block_number: blockNumber, confirmed_block_hash: expectedHash }
        summary.finality_failures += 1
        if (await recordIncidentCandidate({ client: input.client, campaignId, kind: "funding_finality_failure", reason, details, ...ownership, now, rowLocks })) summary.held += 1
        summary.incidents.push({ campaign_id: campaignId, kind: "funding_finality_failure", reason })
      }
    } catch {
      summary.transient_finality_checks += 1
    }
  }
  await input.client.execute({
    sql: `
      INSERT INTO reward_campaign_monitor_state (monitor_name, last_successful_scan_at, updated_at)
      VALUES ('reward_campaign_integrity', ?1, ?1)
      ON CONFLICT (monitor_name) DO UPDATE SET
        last_successful_scan_at = excluded.last_successful_scan_at,
        updated_at = excluded.updated_at
    `,
    args: [now],
  })
  return summary
}

export async function markRewardCampaignIncidentAlerted(input: {
  client: Client
  campaignId: string
  kind: IncidentKind
  alertedAt?: string
}): Promise<void> {
  await input.client.execute({
    sql: `UPDATE reward_campaign_incidents SET alerted_at = ?3 WHERE resolved_at IS NULL AND reward_campaign_id = ?1 AND incident_kind = ?2`,
    args: [input.campaignId, input.kind, input.alertedAt ?? nowIso()],
  })
}
