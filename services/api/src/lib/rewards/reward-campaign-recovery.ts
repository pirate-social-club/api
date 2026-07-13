import type { Env } from "../../env"
import { conflictError, notFoundError } from "../errors"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import { isPostgresControlPlaneUrl } from "../runtime-deps"
import { nowIso } from "../helpers"
import {
  checkRewardCampaignFundingFinality,
  createRewardCampaignFinalityProvider,
  type RewardCampaignFinalityProvider,
  verifyRewardCampaignFinalityChain,
} from "./reward-campaign-finality"
import { requireRewardCampaignAlertOwnership } from "./reward-campaign-alert-config"

export async function recoverRewardCampaignIncident(input: {
  env: Env
  client: Client
  campaignId: string
  incidentId: string
  incidentVersion: number
  operatorActorId: string
  resolutionNote: string
  now?: string
  finalityProvider?: RewardCampaignFinalityProvider
}): Promise<{ campaign_id: string; status: string }> {
  const note = input.resolutionNote.trim()
  if (!note || note.length > 2_000) throw conflictError("A recovery resolution note is required")
  if (!Number.isSafeInteger(input.incidentVersion) || input.incidentVersion < 1) throw conflictError("Invalid incident version")
  requireRewardCampaignAlertOwnership(input.env)
  const incidentResult = await input.client.execute({
    sql: `SELECT incident_kind FROM reward_campaign_incidents WHERE reward_campaign_incident_id = ?1 AND reward_campaign_id = ?2 AND resolved_at IS NULL`,
    args: [input.incidentId, input.campaignId],
  })
  const incident = incidentResult.rows[0]
  if (!incident) throw notFoundError("Reward campaign incident not found")
  const effects = await input.client.execute({
    sql: `SELECT tx_hash, confirmed_block_number, confirmed_block_hash FROM reward_campaign_funding_effects WHERE reward_campaign_id = ?1 AND status = 'confirmed'`,
    args: [input.campaignId],
  })
  if (effects.rows.length === 0) throw conflictError("Campaign has no confirmed funding to verify")
  const rpcUrl = String(input.env.REWARDS_CAMPAIGN_RPC_URL ?? "").trim()
  const chainId = Number(input.env.REWARDS_CAMPAIGN_CHAIN_ID)
  const provider = input.finalityProvider
    ?? (rpcUrl && Number.isSafeInteger(chainId) && chainId > 0
      ? createRewardCampaignFinalityProvider(rpcUrl, chainId)
      : null)
  if (!provider || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw conflictError("Campaign finality verification is unavailable")
  }
  if (!await verifyRewardCampaignFinalityChain(provider, chainId)) {
    throw conflictError("Campaign finality verification is on the wrong chain")
  }
  for (const effect of effects.rows) {
    const txHash = stringOrNull(rowValue(effect, "tx_hash"))
    const blockNumber = Number(rowValue(effect, "confirmed_block_number"))
    const blockHash = stringOrNull(rowValue(effect, "confirmed_block_hash"))?.toLowerCase()
    if (!txHash || !Number.isSafeInteger(blockNumber) || !blockHash) {
      throw conflictError("Campaign funding provenance is incomplete")
    }
    const result = await checkRewardCampaignFundingFinality({
      provider,
      txHash,
      confirmedBlockNumber: blockNumber,
      confirmedBlockHash: blockHash,
    })
    if (result.kind !== "healthy") throw conflictError("Campaign funding finality is not healthy")
  }
  const now = input.now ?? nowIso()
  const rowLocks = isPostgresControlPlaneUrl(String(input.env.CONTROL_PLANE_DATABASE_URL ?? ""))
  return withTransaction(input.client, "write", async (tx) => {
    const campaignResult = await tx.execute({
      sql: `SELECT status, status_before_operational_hold FROM reward_campaigns WHERE reward_campaign_id = ?1${rowLocks ? " FOR UPDATE" : ""}`,
      args: [input.campaignId],
    })
    const campaign = campaignResult.rows[0]
    if (!campaign || requiredString(campaign, "status") !== "operational_hold") throw conflictError("Campaign is not operationally held")
    const health = await tx.execute({
      sql: `SELECT counters_match FROM reward_campaign_accounting_reconciliation WHERE reward_campaign_id = ?1`,
      args: [input.campaignId],
    })
    if (health.rows[0]?.counters_match !== true) throw conflictError("Campaign accounting is not healthy")
    const target = await tx.execute({
      sql: `SELECT incident_version FROM reward_campaign_incidents WHERE reward_campaign_incident_id = ?1 AND reward_campaign_id = ?2 AND resolved_at IS NULL${rowLocks ? " FOR UPDATE" : ""}`,
      args: [input.incidentId, input.campaignId],
    })
    if (Number(rowValue(target.rows[0], "incident_version")) !== input.incidentVersion) {
      throw conflictError("Reward campaign incident changed; reload before recovery")
    }
    const unalerted = await tx.execute({
      sql: `SELECT 1 AS present FROM reward_campaign_incidents WHERE reward_campaign_id = ?1 AND resolved_at IS NULL AND alerted_at IS NULL LIMIT 1`,
      args: [input.campaignId],
    })
    if (unalerted.rows[0]) throw conflictError("Reward campaign incidents have not been delivered")
    await tx.execute({
      sql: `UPDATE reward_campaign_incidents SET resolved_at = ?2, resolved_by = ?3, resolution_note = ?4, incident_version = incident_version + 1 WHERE reward_campaign_id = ?1 AND resolved_at IS NULL`,
      args: [input.campaignId, now, input.operatorActorId, note],
    })
    const prior = requiredString(campaign, "status_before_operational_hold")
    await tx.execute({
      sql: `UPDATE reward_campaigns SET status = ?2, status_before_operational_hold = NULL, operational_hold_reason = NULL, operational_held_at = NULL, operational_held_by = NULL, operational_recovered_at = ?3, operational_recovered_by = ?4, updated_at = ?5 WHERE reward_campaign_id = ?1 AND status = 'operational_hold'`,
      args: [input.campaignId, prior, now, input.operatorActorId, now],
    })
    return { campaign_id: input.campaignId, status: prior }
  })
}
