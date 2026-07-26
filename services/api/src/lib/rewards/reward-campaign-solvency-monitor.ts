import { Contract, JsonRpcProvider, formatUnits, getAddress } from "ethers"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { rowValue } from "../sql-row"
import { captureScheduledWarning } from "../ops-alerts/scheduled"
import { resolveRewardsSettlementBackend } from "./reward-vault-lit-config"

const TASK = "reward_campaign_treasury_solvency"
const CENTS_TO_USDC_ATOMIC = 10_000n
const ERC20_BALANCE_ABI = ["function balanceOf(address account) view returns (uint256)"] as const
const REWARDS_VAULT_CAPACITY_ABI = [
  "function policyVersion() view returns (uint64)",
  "function epochDuration() view returns (uint64)",
  "function currentEpoch() view returns (uint256)",
  "function payoutEpochCap() view returns (uint256)",
  "function payoutSpentByEpoch(uint256) view returns (uint256)",
  "function refundEpochCap() view returns (uint256)",
  "function refundSpentByEpoch(uint256) view returns (uint256)",
] as const

export const REWARD_CAMPAIGN_LIABILITY_SQL = `
  SELECT
    COALESCE((
      SELECT SUM(f.expected_amount_cents - COALESCE(a.allocated_cents, 0))
      FROM reward_campaign_funding_effects f
      LEFT JOIN (
        SELECT reward_campaign_funding_effect_id, SUM(amount_cents) AS allocated_cents
        FROM reward_campaign_reservation_funding_allocations
        GROUP BY reward_campaign_funding_effect_id
      ) a ON a.reward_campaign_funding_effect_id = f.reward_campaign_funding_effect_id
      WHERE f.status = 'confirmed'
    ), 0) AS contribution_liability_cents,
    GREATEST(
      COALESCE((SELECT SUM(amount_cents) FROM reward_events), 0)
        - COALESCE((
          SELECT SUM(amount_cents)
          FROM reward_payout_allocations
          WHERE status = 'confirmed'
        ), 0),
      0
    ) AS credited_unpaid_liability_cents,
    COALESCE((
      SELECT SUM(CAST(received_amount_atomic AS NUMERIC))
      FROM reward_campaign_funding_effects
      WHERE status = 'refund_pending'
    ), 0) AS pending_refund_atomic
`

export type RewardCampaignLiability = {
  contributionLiabilityCents: bigint
  creditedUnpaidLiabilityCents: bigint
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
  observedAt?: string
  signerBalanceWei?: bigint
  nonceAnomalies?: number
  vaultCapacity?: RewardVaultCapacityObservation
}

export type RewardVaultCapacityObservation = {
  policyVersion: bigint
  epochDurationSeconds: bigint
  currentEpoch: bigint
  payoutEpochCapAtomic: bigint
  payoutSpentAtomic: bigint
  refundEpochCapAtomic: bigint
  refundSpentAtomic: bigint
  observedBlockNumber: number
  observedBlockHash: string
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
  const contributionLiabilityCents = bigintValue(rowValue(row, "contribution_liability_cents"))
  const creditedUnpaidLiabilityCents = bigintValue(rowValue(row, "credited_unpaid_liability_cents"))
  const pendingRefundAtomic = bigintValue(rowValue(row, "pending_refund_atomic"))
  return {
    contributionLiabilityCents,
    creditedUnpaidLiabilityCents,
    pendingRefundAtomic,
    totalAtomic: (contributionLiabilityCents + creditedUnpaidLiabilityCents) * CENTS_TO_USDC_ATOMIC
      + pendingRefundAtomic,
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

async function readNativeBalance(config: SolvencyConfig, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  try {
    return await provider.getBalance(address)
  } finally {
    void provider.destroy()
  }
}

async function readVaultCapacity(config: SolvencyConfig): Promise<RewardVaultCapacityObservation> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId)
  try {
    const observedBlockNumber = await provider.getBlockNumber()
    const block = await provider.getBlock(observedBlockNumber)
    if (!block?.hash) throw new Error("Reward vault capacity block is unavailable")
    const vault = new Contract(config.treasuryAddress, REWARDS_VAULT_CAPACITY_ABI, provider)
    const call = { blockTag: observedBlockNumber }
    const [policyVersion, epochDurationSeconds, currentEpoch, payoutEpochCapAtomic, refundEpochCapAtomic] =
      await Promise.all([
        vault.policyVersion(call),
        vault.epochDuration(call),
        vault.currentEpoch(call),
        vault.payoutEpochCap(call),
        vault.refundEpochCap(call),
      ])
    const [payoutSpentAtomic, refundSpentAtomic] = await Promise.all([
      vault.payoutSpentByEpoch(currentEpoch, call),
      vault.refundSpentByEpoch(currentEpoch, call),
    ])
    return {
      policyVersion: BigInt(policyVersion),
      epochDurationSeconds: BigInt(epochDurationSeconds),
      currentEpoch: BigInt(currentEpoch),
      payoutEpochCapAtomic: BigInt(payoutEpochCapAtomic),
      payoutSpentAtomic: BigInt(payoutSpentAtomic),
      refundEpochCapAtomic: BigInt(refundEpochCapAtomic),
      refundSpentAtomic: BigInt(refundSpentAtomic),
      observedBlockNumber,
      observedBlockHash: block.hash,
    }
  } finally {
    void provider.destroy()
  }
}

function signerGasFloor(env: Env): bigint {
  const raw = String(env.REWARDS_LIT_SIGNER_MIN_ETH_WEI ?? "0").trim()
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw new Error("REWARDS_LIT_SIGNER_MIN_ETH_WEI is invalid")
  }
  return BigInt(raw)
}

async function readNonceAnomalies(client: Client): Promise<number> {
  const result = await client.execute(`
    SELECT (
      (SELECT COUNT(*) FROM reward_payout_effects
        WHERE updated_at >= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          AND (
            coordinator_state = 'replaced'
            OR LOWER(COALESCE(failure_reason, '')) LIKE '%nonce%'
          ))
      +
      (SELECT COUNT(*) FROM reward_campaign_funding_effects
        WHERE updated_at >= CURRENT_TIMESTAMP - INTERVAL '15 minutes'
          AND (
            refund_coordinator_state = 'replaced'
            OR LOWER(COALESCE(refund_last_error, '')) LIKE '%nonce%'
          ))
    ) AS nonce_anomalies
  `)
  const value = Number(rowValue(result.rows[0], "nonce_anomalies") ?? 0)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Rewards nonce anomaly count is invalid")
  return value
}

export async function monitorRewardCampaignTreasurySolvency(input: {
  env: Env
  client: Client
  readBalance?: (config: SolvencyConfig) => Promise<bigint>
  readSignerBalance?: (config: SolvencyConfig, address: string) => Promise<bigint>
  readCapacity?: (config: SolvencyConfig) => Promise<RewardVaultCapacityObservation>
  warn?: typeof captureScheduledWarning
}): Promise<RewardCampaignSolvencySummary> {
  const config = resolveConfig(input.env)
  if (!config) return { configured: false }
  const liability = await readRewardCampaignLiability(input.client)
  const balanceAtomic = await (input.readBalance ?? readTreasuryBalance)(config)
  const solvent = balanceAtomic >= liability.totalAtomic
  const observedAt = new Date().toISOString()
  await input.client.execute({
    sql: `
      INSERT INTO reward_solvency_observations (
        observation_key, chain_id, treasury_address, token_address,
        balance_atomic, contribution_liability_cents,
        credited_unpaid_liability_cents, pending_refund_atomic,
        total_liability_atomic, solvent, observed_at, updated_at
      ) VALUES (
        'rewards_treasury', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
      )
      ON CONFLICT (observation_key) DO UPDATE SET
        chain_id = excluded.chain_id,
        treasury_address = excluded.treasury_address,
        token_address = excluded.token_address,
        balance_atomic = excluded.balance_atomic,
        contribution_liability_cents = excluded.contribution_liability_cents,
        credited_unpaid_liability_cents = excluded.credited_unpaid_liability_cents,
        pending_refund_atomic = excluded.pending_refund_atomic,
        total_liability_atomic = excluded.total_liability_atomic,
        solvent = excluded.solvent,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `,
    args: [
      config.chainId,
      config.treasuryAddress,
      config.tokenAddress,
      balanceAtomic.toString(),
      liability.contributionLiabilityCents.toString(),
      liability.creditedUnpaidLiabilityCents.toString(),
      liability.pendingRefundAtomic.toString(),
      liability.totalAtomic.toString(),
      solvent,
      observedAt,
    ],
  })
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
        contribution_liability_cents: liability.contributionLiabilityCents.toString(),
        credited_unpaid_liability_cents: liability.creditedUnpaidLiabilityCents.toString(),
        pending_refund_atomic: liability.pendingRefundAtomic.toString(),
      },
      { urgency: "high" },
    )
  }
  let signerBalanceWei: bigint | undefined
  let nonceAnomalies: number | undefined
  let vaultCapacity: RewardVaultCapacityObservation | undefined
  if (resolveRewardsSettlementBackend(input.env) === "lit_vault") {
    vaultCapacity = await (input.readCapacity ?? readVaultCapacity)(config)
    if (
      vaultCapacity.payoutSpentAtomic > vaultCapacity.payoutEpochCapAtomic
      || vaultCapacity.refundSpentAtomic > vaultCapacity.refundEpochCapAtomic
    ) {
      throw new Error("Reward vault capacity observation violates its epoch cap")
    }
    await input.client.execute({
      sql: `
        INSERT INTO reward_vault_capacity_observations (
          observation_key, chain_id, vault_address, policy_version,
          epoch_duration_seconds, current_epoch,
          payout_epoch_cap_atomic, payout_spent_atomic,
          refund_epoch_cap_atomic, refund_spent_atomic,
          observed_block_number, observed_block_hash, observed_at, updated_at
        ) VALUES (
          'rewards_vault', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
        )
        ON CONFLICT (observation_key) DO UPDATE SET
          chain_id = excluded.chain_id,
          vault_address = excluded.vault_address,
          policy_version = excluded.policy_version,
          epoch_duration_seconds = excluded.epoch_duration_seconds,
          current_epoch = excluded.current_epoch,
          payout_epoch_cap_atomic = excluded.payout_epoch_cap_atomic,
          payout_spent_atomic = excluded.payout_spent_atomic,
          refund_epoch_cap_atomic = excluded.refund_epoch_cap_atomic,
          refund_spent_atomic = excluded.refund_spent_atomic,
          observed_block_number = excluded.observed_block_number,
          observed_block_hash = excluded.observed_block_hash,
          observed_at = excluded.observed_at,
          updated_at = excluded.updated_at
      `,
      args: [
        config.chainId,
        config.treasuryAddress,
        vaultCapacity.policyVersion.toString(),
        vaultCapacity.epochDurationSeconds.toString(),
        vaultCapacity.currentEpoch.toString(),
        vaultCapacity.payoutEpochCapAtomic.toString(),
        vaultCapacity.payoutSpentAtomic.toString(),
        vaultCapacity.refundEpochCapAtomic.toString(),
        vaultCapacity.refundSpentAtomic.toString(),
        vaultCapacity.observedBlockNumber,
        vaultCapacity.observedBlockHash,
        observedAt,
      ],
    })
    const signerAddress = getAddress(String(input.env.PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS ?? ""))
    signerBalanceWei = await (input.readSignerBalance ?? readNativeBalance)(config, signerAddress)
    nonceAnomalies = await readNonceAnomalies(input.client)
    const floor = signerGasFloor(input.env)
    if (signerBalanceWei <= floor) {
      await (input.warn ?? captureScheduledWarning)(
        input.env,
        "Lit rewards signer ETH is at or below its operational floor",
        `${TASK}:signer_eth`,
        {
          signer_address: signerAddress,
          signer_balance_wei: signerBalanceWei.toString(),
          configured_floor_wei: floor.toString(),
        },
        { urgency: "high" },
      )
    }
    if (nonceAnomalies > 0) {
      await (input.warn ?? captureScheduledWarning)(
        input.env,
        "Lit rewards signer nonce contention detected",
        `${TASK}:nonce_contention`,
        { signer_address: signerAddress, anomaly_count_15m: nonceAnomalies },
        { urgency: "high" },
      )
    }
  }
  return {
    configured: true,
    treasuryAddress: config.treasuryAddress,
    chainId: config.chainId,
    balanceAtomic,
    liability,
    solvent,
    observedAt,
    signerBalanceWei,
    nonceAnomalies,
    vaultCapacity,
  }
}
