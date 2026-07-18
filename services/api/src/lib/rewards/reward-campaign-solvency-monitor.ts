import { Contract, JsonRpcProvider, formatUnits, getAddress } from "ethers"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { rowValue } from "../sql-row"
import { captureScheduledWarning } from "../ops-alerts/scheduled"

const TASK = "reward_campaign_treasury_solvency"
const CENTS_TO_USDC_ATOMIC = 10_000n
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"] as const

export const REWARD_CAMPAIGN_LIABILITY_SQL = `
  SELECT
    COALESCE((
      SELECT SUM(
        CASE WHEN status IN ('funding_quoted', 'funding_confirming', 'scheduled', 'active', 'paused', 'operational_hold')
          THEN funded_cents - reserved_cents - credited_cents - refunded_cents
          ELSE 0
        END + reserved_cents
      )
      FROM reward_campaigns
    ), 0) AS campaign_future_cents,
    GREATEST(
      COALESCE((SELECT SUM(amount_cents) FROM reward_events), 0)
        - COALESCE((
          SELECT SUM(amount_cents)
          FROM reward_payout_effects
          WHERE status IN ('submitted', 'confirmed')
        ), 0),
      0
    ) AS learner_balance_cents,
    COALESCE((
      SELECT SUM(CAST(received_amount_atomic AS NUMERIC))
      FROM reward_campaign_funding_effects
      WHERE status = 'refund_pending'
    ), 0) AS pending_refund_atomic
`

export type RewardCampaignLiability = {
  campaignFutureCents: bigint
  learnerBalanceCents: bigint
  pendingRefundAtomic: bigint
  totalAtomic: bigint
}

export type RewardCampaignSolvencySummary = {
  configured: boolean
  treasuryAddress?: `0x${string}`
  chainId?: number
  balanceAtomic?: bigint
  liability?: RewardCampaignLiability
  solvent?: boolean
}

type SolvencyConfig = {
  treasuryAddress: `0x${string}`
  tokenAddress: `0x${string}`
  rpcUrl: string
  chainId: number
}

function resolveConfig(env: Env): SolvencyConfig | null {
  const treasury = String(env.REWARDS_CAMPAIGN_TREASURY_ADDRESS ?? "").trim()
  const token = String(env.REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS ?? "").trim()
  const rpcUrl = String(env.REWARDS_CAMPAIGN_RPC_URL ?? "").trim()
  const chainId = Number(String(env.REWARDS_CAMPAIGN_CHAIN_ID ?? "").trim())
  if (!treasury && !token && !rpcUrl && !chainId) return null
  if (!treasury || !token || !/^https:\/\//i.test(rpcUrl) || !Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("Reward campaign treasury solvency configuration is incomplete")
  }
  return {
    treasuryAddress: getAddress(treasury) as `0x${string}`,
    tokenAddress: getAddress(token) as `0x${string}`,
    rpcUrl,
    chainId,
  }
}

function bigintValue(value: unknown): bigint {
  const normalized = String(value ?? "0").trim()
  return /^-?\d+$/.test(normalized) ? BigInt(normalized) : 0n
}

export async function readRewardCampaignLiability(client: Client): Promise<RewardCampaignLiability> {
  const result = await client.execute(REWARD_CAMPAIGN_LIABILITY_SQL)
  const row = result.rows[0]
  const campaignFutureCents = bigintValue(rowValue(row, "campaign_future_cents"))
  const learnerBalanceCents = bigintValue(rowValue(row, "learner_balance_cents"))
  const pendingRefundAtomic = bigintValue(rowValue(row, "pending_refund_atomic"))
  return {
    campaignFutureCents,
    learnerBalanceCents,
    pendingRefundAtomic,
    totalAtomic: (campaignFutureCents + learnerBalanceCents) * CENTS_TO_USDC_ATOMIC + pendingRefundAtomic,
  }
}

async function readTreasuryBalance(config: SolvencyConfig): Promise<bigint> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  try {
    const token = new Contract(config.tokenAddress, ERC20_BALANCE_ABI, provider)
    return BigInt(await token.balanceOf(config.treasuryAddress))
  } finally {
    void provider.destroy()
  }
}

export async function monitorRewardCampaignTreasurySolvency(input: {
  env: Env
  client: Client
  readBalance?: (config: SolvencyConfig) => Promise<bigint>
  warn?: typeof captureScheduledWarning
}): Promise<RewardCampaignSolvencySummary> {
  const config = resolveConfig(input.env)
  if (!config) return { configured: false }
  const liability = await readRewardCampaignLiability(input.client)
  const balanceAtomic = await (input.readBalance ?? readTreasuryBalance)(config)
  const solvent = balanceAtomic >= liability.totalAtomic
  if (!solvent) {
    await (input.warn ?? captureScheduledWarning)(
      input.env,
      `Reward campaign treasury USDC is insolvent — fund ${config.treasuryAddress}`,
      TASK,
      {
        treasury_address: config.treasuryAddress,
        chain_id: config.chainId,
        token_address: config.tokenAddress,
        balance_usdc: formatUnits(balanceAtomic, 6),
        liability_usdc: formatUnits(liability.totalAtomic, 6),
        shortfall_usdc: formatUnits(liability.totalAtomic - balanceAtomic, 6),
        campaign_future_cents: liability.campaignFutureCents.toString(),
        learner_balance_cents: liability.learnerBalanceCents.toString(),
        pending_refund_atomic: liability.pendingRefundAtomic.toString(),
      },
      { urgency: "high" },
    )
  }
  return {
    configured: true,
    treasuryAddress: config.treasuryAddress,
    chainId: config.chainId,
    balanceAtomic,
    liability,
    solvent,
  }
}
