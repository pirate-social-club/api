import { makeId } from "../helpers"
import { requiredString, rowValue } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"

export type RewardCampaignLifecycleSummary = {
  activated_campaigns: number
  canceled_draft_campaigns: number
  canceled_retired_funding_campaigns: number
  audited_retired_funding_effects: number
  retirement_policy_anomalies: number
  ended_campaigns: number
}

export const UNFUNDED_DRAFT_POOL_TTL_SECONDS = 24 * 60 * 60

export async function advanceRewardCampaignLifecycle(input: {
  client: Client
  now: string
  postgres: boolean
  activeSettlementAsset: {
    chainId: number
    tokenAddress: string
    treasuryAddress: string
  }
}): Promise<RewardCampaignLifecycleSummary> {
  const nowMs = Date.parse(input.now)
  if (!Number.isFinite(nowMs)) throw new Error("Reward campaign lifecycle timestamp is invalid")
  const draftCutoff = new Date(nowMs - UNFUNDED_DRAFT_POOL_TTL_SECONDS * 1000).toISOString()
  const nowExpression = input.postgres ? "CAST(?1 AS TIMESTAMPTZ)" : "CAST(?1 AS TEXT)"

  return withTransaction(input.client, "write", async (tx) => {
    // A retired-chain declaration removes the deliberately recoverable path
    // for an expired but timely current-chain deposit. Never infer that this
    // collision is safe: fail closed until an operator corrects the policy.
    const activeRetirement = await tx.execute({
      sql: `
        SELECT reward_funding_asset_retirement_id
        FROM reward_funding_asset_retirements
        WHERE chain_id = ?1
          AND token_address = ?2
          AND treasury_address = ?3
        LIMIT 1
      `,
      args: [
        input.activeSettlementAsset.chainId,
        input.activeSettlementAsset.tokenAddress.toLowerCase(),
        input.activeSettlementAsset.treasuryAddress.toLowerCase(),
      ],
    })
    if (activeRetirement.rows.length > 0) {
      throw new Error(
        `Active reward settlement asset is declared retired: ${requiredString(activeRetirement.rows[0], "reward_funding_asset_retirement_id")}`,
      )
    }

    const anomalousEffects = await tx.execute({
      sql: `
        SELECT
          funding.reward_campaign_funding_effect_id,
          funding.reward_campaign_id,
          funding.created_at AS effect_created_at,
          retirement.reward_funding_asset_retirement_id,
          retirement.quote_cutoff_at
        FROM reward_campaign_funding_effects AS funding
        JOIN reward_funding_asset_retirements AS retirement
          ON retirement.chain_id = funding.chain_id
         AND retirement.token_address = lower(funding.token_address)
         AND retirement.treasury_address = lower(funding.treasury_address)
        WHERE funding.created_at > retirement.quote_cutoff_at
          AND NOT EXISTS (
            SELECT 1
            FROM reward_funding_retirement_anomalies AS anomaly
            WHERE anomaly.reward_campaign_funding_effect_id = funding.reward_campaign_funding_effect_id
          )
      `,
      args: [],
    })
    let retirementPolicyAnomalies = 0
    for (const effect of anomalousEffects.rows) {
      const inserted = await tx.execute({
        sql: `
          INSERT INTO reward_funding_retirement_anomalies (
            reward_funding_retirement_anomaly_id,
            reward_funding_asset_retirement_id,
            reward_campaign_funding_effect_id,
            reward_campaign_id,
            anomaly_kind,
            effect_created_at,
            quote_cutoff_at,
            detected_at
          ) VALUES (
            ?1, ?2, ?3, ?4, 'quote_created_after_cutoff', ?5, ?6,
            ${input.postgres ? "CAST(?7 AS TIMESTAMPTZ)" : "CAST(?7 AS TEXT)"}
          )
          ON CONFLICT (reward_campaign_funding_effect_id) DO NOTHING
          RETURNING reward_funding_retirement_anomaly_id
        `,
        args: [
          makeId("rfa"),
          requiredString(effect, "reward_funding_asset_retirement_id"),
          requiredString(effect, "reward_campaign_funding_effect_id"),
          requiredString(effect, "reward_campaign_id"),
          rowValue(effect, "effect_created_at"),
          rowValue(effect, "quote_cutoff_at"),
          input.now,
        ],
      })
      retirementPolicyAnomalies += inserted.rows.length
    }

    const retiredCampaigns = await tx.execute({
      sql: `
        SELECT campaign.reward_campaign_id
        FROM reward_campaigns AS campaign
        WHERE campaign.status = 'funding_quoted'
          AND campaign.funded_cents = 0
          AND campaign.reserved_cents = 0
          AND campaign.credited_cents = 0
          AND campaign.paid_cents = 0
          AND campaign.refunded_cents = 0
          AND EXISTS (
            SELECT 1
            FROM reward_campaign_funding_effects AS funding
            WHERE funding.reward_campaign_id = campaign.reward_campaign_id
          )
          AND NOT EXISTS (
            SELECT 1
            FROM reward_campaign_funding_effects AS funding
            WHERE funding.reward_campaign_id = campaign.reward_campaign_id
              AND NOT EXISTS (
                SELECT 1
                FROM reward_funding_asset_retirements AS retirement
                WHERE retirement.chain_id = funding.chain_id
                  AND retirement.token_address = lower(funding.token_address)
                  AND retirement.treasury_address = lower(funding.treasury_address)
                  AND funding.status = 'quoted'
                  AND funding.tx_hash IS NULL
                  AND funding.received_amount_atomic IS NULL
                  AND funding.expires_at <= ${nowExpression}
                  AND funding.created_at <= retirement.quote_cutoff_at
              )
          )
        ORDER BY campaign.reward_campaign_id
        ${input.postgres ? "FOR UPDATE" : ""}
      `,
      args: [input.now],
    })
    let canceledRetiredFundingCampaigns = 0
    let auditedRetiredFundingEffects = 0
    for (const campaign of retiredCampaigns.rows) {
      const campaignId = requiredString(campaign, "reward_campaign_id")
      const canceled = await tx.execute({
        sql: `
          UPDATE reward_campaigns
          SET status = 'canceled', canceled_at = ${nowExpression}, updated_at = ${nowExpression}
          WHERE reward_campaign_id = ?2 AND status = 'funding_quoted'
          RETURNING reward_campaign_id
        `,
        args: [input.now, campaignId],
      })
      if (canceled.rows.length === 0) continue

      const effects = await tx.execute({
        sql: `
          SELECT
            funding.reward_campaign_funding_effect_id,
            funding.funder_user_id,
            funding.sender_address,
            funding.expected_amount_cents,
            funding.expected_amount_atomic,
            funding.chain_id,
            funding.token_address,
            funding.treasury_address,
            funding.created_at,
            funding.expires_at,
            retirement.reward_funding_asset_retirement_id
          FROM reward_campaign_funding_effects AS funding
          JOIN reward_funding_asset_retirements AS retirement
            ON retirement.chain_id = funding.chain_id
           AND retirement.token_address = lower(funding.token_address)
           AND retirement.treasury_address = lower(funding.treasury_address)
           AND funding.created_at <= retirement.quote_cutoff_at
          WHERE funding.reward_campaign_id = ?1
          ORDER BY funding.reward_campaign_funding_effect_id
        `,
        args: [campaignId],
      })
      for (const effect of effects.rows) {
        const audit = await tx.execute({
          sql: `
            INSERT INTO reward_retired_funding_cancellations (
              reward_retired_funding_cancellation_id,
              reward_funding_asset_retirement_id,
              reward_campaign_funding_effect_id,
              reward_campaign_id,
              funder_user_id,
              sender_address,
              expected_amount_cents,
              expected_amount_atomic,
              chain_id,
              token_address,
              treasury_address,
              quote_created_at,
              quote_expires_at,
              canceled_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
              ${input.postgres ? "CAST(?14 AS TIMESTAMPTZ)" : "CAST(?14 AS TEXT)"}
            )
            RETURNING reward_retired_funding_cancellation_id
          `,
          args: [
            makeId("rfc"),
            requiredString(effect, "reward_funding_asset_retirement_id"),
            requiredString(effect, "reward_campaign_funding_effect_id"),
            campaignId,
            requiredString(effect, "funder_user_id"),
            requiredString(effect, "sender_address"),
            rowValue(effect, "expected_amount_cents"),
            requiredString(effect, "expected_amount_atomic"),
            rowValue(effect, "chain_id"),
            requiredString(effect, "token_address"),
            requiredString(effect, "treasury_address"),
            rowValue(effect, "created_at"),
            rowValue(effect, "expires_at"),
            input.now,
          ],
        })
        auditedRetiredFundingEffects += audit.rows.length
      }
      canceledRetiredFundingCampaigns += 1
    }

    const canceledDrafts = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'canceled', canceled_at = ${nowExpression}, updated_at = ${nowExpression}
        WHERE status = 'draft'
          AND created_at <= ?2
          AND funded_cents = 0
          AND reserved_cents = 0
          AND credited_cents = 0
          AND paid_cents = 0
          AND refunded_cents = 0
          AND NOT EXISTS (
            SELECT 1
            FROM reward_campaign_funding_effects AS funding
            WHERE funding.reward_campaign_id = reward_campaigns.reward_campaign_id
              AND NOT (
                funding.status IN ('failed', 'refunded')
                OR (funding.status = 'quoted' AND funding.expires_at <= ${nowExpression})
              )
          )
        RETURNING reward_campaign_id
      `,
      args: [input.now, draftCutoff],
    })
    const ended = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'ended', ended_at = COALESCE(ended_at, ${nowExpression}), updated_at = ${nowExpression}
        WHERE status IN ('scheduled', 'active', 'paused', 'exhausted')
          AND ends_at <= ?1
        RETURNING reward_campaign_id
      `,
      args: [input.now],
    })
    await tx.execute({
      sql: `
        DELETE FROM reward_song_pools
        WHERE reward_campaign_id IN (
          SELECT reward_campaign_id
          FROM reward_campaigns
          WHERE status IN ('ended', 'canceled')
        )
      `,
      args: [],
    })
    const activated = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'active', activated_at = COALESCE(activated_at, ${nowExpression}), updated_at = ${nowExpression}
        WHERE status = 'scheduled'
          AND starts_at <= ?1
          AND ends_at > ?1
        RETURNING reward_campaign_id
      `,
      args: [input.now],
    })
    return {
      activated_campaigns: activated.rows.length,
      canceled_draft_campaigns: canceledDrafts.rows.length,
      canceled_retired_funding_campaigns: canceledRetiredFundingCampaigns,
      audited_retired_funding_effects: auditedRetiredFundingEffects,
      retirement_policy_anomalies: retirementPolicyAnomalies,
      ended_campaigns: ended.rows.length,
    }
  })
}
