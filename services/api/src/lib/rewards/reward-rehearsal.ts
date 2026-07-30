import type { Env } from "../../env"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSigningCoordinatorDO,
  type RewardRehearsalScenario,
} from "../communities/bookings/operator-signing-coordinator-do"
import {
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../communities/bookings/booking-chain-config"
import { badRequestError } from "../errors"
import { cashOutRewards } from "./reward-cashout-service"
import { getControlPlaneClient } from "../runtime-deps"

const REHEARSAL_USER_ID = "usr_eb47ab813754497d8f107ca01d762bc9"
const REHEARSAL_RECIPIENT = "0xCc4049cEd4ff4C3CA25F7e32eDb8c69dEA4bB12f"
const EOA_FIRST_PAYOUT_EFFECT_ID = "rpe_e0a50000000000000000000020260730"
const CONSUMED_SCENARIO_1_EFFECT_ID = "rpe_4d49a8ee731d4fa2b6eab990a013c757"
const SCENARIO_13_FUNDING_EFFECT_ID = "rcf_13000000000000000000000020260729"
const EPOCH_CAP_IDEMPOTENCY_KEYS = {
  epoch_cap_fill_1: "rehearsal:scenario7:fill1:20260729",
  epoch_cap_fill_2: "rehearsal:scenario7:fill2:20260729",
  epoch_cap_defer: "rehearsal:scenario7:defer:20260729",
} as const

export type RewardEpochCapRehearsalScenario = keyof typeof EPOCH_CAP_IDEMPOTENCY_KEYS
export type RewardRehearsalRouteScenario = RewardRehearsalScenario | RewardEpochCapRehearsalScenario

export type RewardRehearsalEnqueueResult = {
  idempotencyKey: string
  state: string
  payoutEffectId: string | null
  transactionHash: string | null
}

export type RewardEpochCapSnapshotRow = {
  scenario: RewardEpochCapRehearsalScenario
  idempotencyKey: string
  payoutEffectId: string | null
  payoutStatus: string | null
  settlementRef: string | null
  coordinatorRef: string | null
  coordinatorState: string | null
  attemptCount: number | null
  failureReason: string | null
  allocationCount: number
  submittedAllocationCount: number
  confirmedAllocationCount: number
  releasedAllocationCount: number
  allocationAmountCents: number | null
  campaignId: string | null
  campaignPaidCents: number | null
}

type PayoutScenario = Exclude<RewardRehearsalScenario, "refund_while_payouts_paused">

const PAYOUT_FIXTURES: Record<PayoutScenario, {
  idempotencyKey: string
  payoutEffectId: string
  amountCents: number
}> = {
  eoa_first_payout: {
    idempotencyKey: "rehearsal:eoa-first-payout:20260730:v1",
    payoutEffectId: EOA_FIRST_PAYOUT_EFFECT_ID,
    amountCents: 500,
  },
  replay: {
    idempotencyKey: "rehearsal:scenario3:20260729:v1",
    payoutEffectId: CONSUMED_SCENARIO_1_EFFECT_ID,
    amountCents: 50,
  },
  deadline_expired: {
    idempotencyKey: "rehearsal:scenario4:20260729:v1",
    payoutEffectId: "rpe_d448820ca082d9bb53f003a0f4a26b84",
    amountCents: 50,
  },
  over_limit: {
    idempotencyKey: "rehearsal:scenario5:20260729:v2",
    payoutEffectId: "rpe_6cf832d0713742e4509cbd16995b1419",
    amountCents: 60,
  },
  stale_policy: {
    idempotencyKey: "rehearsal:scenario6:20260729:v1",
    payoutEffectId: "rpe_a1051e827c685b79dbe83482d7fc9f21",
    amountCents: 50,
  },
}

export function isRewardRehearsalScenario(value: unknown): value is RewardRehearsalRouteScenario {
  return value === "eoa_first_payout"
    || value === "replay"
    || value === "over_limit"
    || value === "deadline_expired"
    || value === "stale_policy"
    || value === "refund_while_payouts_paused"
    || value === "epoch_cap_fill_1"
    || value === "epoch_cap_fill_2"
    || value === "epoch_cap_defer"
}

function isRewardEpochCapRehearsalScenario(
  value: RewardRehearsalRouteScenario,
): value is RewardEpochCapRehearsalScenario {
  return value === "epoch_cap_fill_1"
    || value === "epoch_cap_fill_2"
    || value === "epoch_cap_defer"
}

export function rewardEpochCapCashoutFixture(scenario: RewardEpochCapRehearsalScenario): {
  userId: string
  amountCents: 50
  idempotencyKey: string
} {
  return {
    userId: REHEARSAL_USER_ID,
    amountCents: 50,
    idempotencyKey: EPOCH_CAP_IDEMPOTENCY_KEYS[scenario],
  }
}

export function rewardRehearsalRequest(
  env: Pick<Env, "ENVIRONMENT">,
  scenario: RewardRehearsalScenario,
): OperatorSettleRequest {
  if (env.ENVIRONMENT !== "staging") {
    throw badRequestError("Rewards rehearsal fixture is staging-only")
  }
  if (scenario === "refund_while_payouts_paused") {
    return {
      operatorKind: "rewards",
      fundingEffectId: SCENARIO_13_FUNDING_EFFECT_ID,
      idempotencyKey: SCENARIO_13_FUNDING_EFFECT_ID,
      effectKind: "reward_funding_refund",
      amountAtomic: "500000",
      recipientAddress: REHEARSAL_RECIPIENT,
      rehearsalScenario: scenario,
    }
  }
  const fixture = PAYOUT_FIXTURES[scenario]
  return {
    operatorKind: "rewards",
    userId: REHEARSAL_USER_ID,
    payoutEffectId: fixture.payoutEffectId,
    idempotencyKey: fixture.idempotencyKey,
    effectKind: "reward_cashout",
    amountCents: fixture.amountCents,
    recipientAddress: REHEARSAL_RECIPIENT,
    rehearsalScenario: scenario,
  }
}

export async function enqueueRewardRehearsalScenario(input: {
  env: Env
  scenario: RewardRehearsalRouteScenario
}): Promise<RewardRehearsalEnqueueResult> {
  if (input.env.ENVIRONMENT !== "staging") {
    throw badRequestError("Rewards rehearsal fixture is staging-only")
  }
  if (isRewardEpochCapRehearsalScenario(input.scenario)) {
    const scenario = input.scenario
    const fixture = rewardEpochCapCashoutFixture(scenario)
    const client = getControlPlaneClient(input.env)
    try {
      const cashout = await cashOutRewards({
        env: input.env,
        client,
        userId: fixture.userId,
        amountCents: fixture.amountCents,
        idempotencyKey: fixture.idempotencyKey,
      })
      const result = await client.execute({
        sql: `
          SELECT coordinator_ref, coordinator_state
          FROM reward_payout_effects
          WHERE reward_payout_effect_id = ?1
          LIMIT 1
        `,
        args: [cashout.payout.id],
      })
      const row = result.rows[0]
      return {
        idempotencyKey: typeof row?.coordinator_ref === "string"
          ? row.coordinator_ref
          : fixture.idempotencyKey,
        state: typeof row?.coordinator_state === "string"
          ? row.coordinator_state
          : cashout.payout.status,
        payoutEffectId: cashout.payout.id,
        transactionHash: cashout.payout.settlement_ref,
      }
    } finally {
      client.close?.()
    }
  }
  const request = rewardRehearsalRequest(input.env, input.scenario)
  const namespace = input.env.OPERATOR_SIGNING_COORDINATOR as
    | DurableObjectNamespace<OperatorSigningCoordinatorDO>
    | undefined
  if (!namespace) throw badRequestError("Operator signing coordinator is not configured")
  const stub = namespace.getByName(operatorSigningCoordinatorName(
    resolveRewardsSettlementOperatorAddress(input.env),
    resolveRewardsSettlementChainId(input.env),
    "rewards",
  ))
  const result = await stub.settle(request)
  return {
    idempotencyKey: result.idempotencyKey,
    state: result.state,
    payoutEffectId: request.payoutEffectId ?? null,
    transactionHash: result.txHash,
  }
}

export async function getRewardEpochCapRehearsalSnapshot(
  env: Env,
): Promise<{ userId: string; amountCentsEach: 50; rows: RewardEpochCapSnapshotRow[] }> {
  if (env.ENVIRONMENT !== "staging") {
    throw badRequestError("Rewards rehearsal fixture is staging-only")
  }
  const client = getControlPlaneClient(env)
  try {
    const rows: RewardEpochCapSnapshotRow[] = []
    for (const [scenario, idempotencyKey] of Object.entries(EPOCH_CAP_IDEMPOTENCY_KEYS) as
      [RewardEpochCapRehearsalScenario, string][]) {
      const result = await client.execute({
        sql: `
          SELECT
            payout.reward_payout_effect_id,
            payout.status AS payout_status,
            payout.settlement_ref,
            payout.coordinator_ref,
            payout.coordinator_state,
            payout.attempt_count,
            payout.failure_reason,
            COUNT(allocation.reward_payout_allocation_id) AS allocation_count,
            SUM(CASE WHEN allocation.status = 'submitted' THEN 1 ELSE 0 END)
              AS submitted_allocation_count,
            SUM(CASE WHEN allocation.status = 'confirmed' THEN 1 ELSE 0 END)
              AS confirmed_allocation_count,
            SUM(CASE WHEN allocation.status = 'released' THEN 1 ELSE 0 END)
              AS released_allocation_count,
            SUM(allocation.amount_cents) AS allocation_amount_cents,
            MIN(allocation.reward_campaign_id) AS reward_campaign_id,
            MAX(campaign.paid_cents) AS campaign_paid_cents
          FROM reward_payout_effects payout
          LEFT JOIN reward_payout_allocations allocation
            ON allocation.reward_payout_effect_id = payout.reward_payout_effect_id
          LEFT JOIN reward_campaigns campaign
            ON campaign.reward_campaign_id = allocation.reward_campaign_id
          WHERE payout.user_id = ?1 AND payout.idempotency_key = ?2
          GROUP BY
            payout.reward_payout_effect_id,
            payout.status,
            payout.settlement_ref,
            payout.coordinator_ref,
            payout.coordinator_state,
            payout.attempt_count,
            payout.failure_reason
          LIMIT 1
        `,
        args: [REHEARSAL_USER_ID, idempotencyKey],
      })
      const row = result.rows[0]
      const numberOrNull = (value: unknown): number | null => {
        if (value === null || value === undefined || value === "") return null
        const parsed = Number(value)
        return Number.isSafeInteger(parsed) ? parsed : null
      }
      const stringOrNull = (value: unknown): string | null =>
        typeof value === "string" && value.length > 0 ? value : null
      rows.push({
        scenario,
        idempotencyKey,
        payoutEffectId: stringOrNull(row?.reward_payout_effect_id),
        payoutStatus: stringOrNull(row?.payout_status),
        settlementRef: stringOrNull(row?.settlement_ref),
        coordinatorRef: stringOrNull(row?.coordinator_ref),
        coordinatorState: stringOrNull(row?.coordinator_state),
        attemptCount: numberOrNull(row?.attempt_count),
        failureReason: stringOrNull(row?.failure_reason),
        allocationCount: numberOrNull(row?.allocation_count) ?? 0,
        submittedAllocationCount: numberOrNull(row?.submitted_allocation_count) ?? 0,
        confirmedAllocationCount: numberOrNull(row?.confirmed_allocation_count) ?? 0,
        releasedAllocationCount: numberOrNull(row?.released_allocation_count) ?? 0,
        allocationAmountCents: numberOrNull(row?.allocation_amount_cents),
        campaignId: stringOrNull(row?.reward_campaign_id),
        campaignPaidCents: numberOrNull(row?.campaign_paid_cents),
      })
    }
    return { userId: REHEARSAL_USER_ID, amountCentsEach: 50, rows }
  } finally {
    client.close?.()
  }
}
