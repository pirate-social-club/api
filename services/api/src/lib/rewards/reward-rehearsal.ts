import type { Env } from "../../env"
import {
  operatorSigningCoordinatorName,
  type OperatorSettleRequest,
  type OperatorSettleResult,
  type OperatorSigningCoordinatorDO,
  type RewardRehearsalScenario,
} from "../communities/bookings/operator-signing-coordinator-do"
import {
  resolveRewardsSettlementChainId,
  resolveRewardsSettlementOperatorAddress,
} from "../communities/bookings/booking-chain-config"
import { badRequestError } from "../errors"

const REHEARSAL_USER_ID = "usr_eb47ab813754497d8f107ca01d762bc9"
const REHEARSAL_RECIPIENT = "0xCc4049cEd4ff4C3CA25F7e32eDb8c69dEA4bB12f"
const CONSUMED_SCENARIO_1_EFFECT_ID = "rpe_4d49a8ee731d4fa2b6eab990a013c757"
const SCENARIO_13_FUNDING_EFFECT_ID = "rcf_13000000000000000000000020260729"

type PayoutScenario = Exclude<RewardRehearsalScenario, "refund_while_payouts_paused">

const PAYOUT_FIXTURES: Record<PayoutScenario, {
  scenarioNumber: 3 | 4 | 5 | 6
  payoutEffectId: string
  amountCents: number
}> = {
  replay: {
    scenarioNumber: 3,
    payoutEffectId: CONSUMED_SCENARIO_1_EFFECT_ID,
    amountCents: 50,
  },
  deadline_expired: {
    scenarioNumber: 4,
    payoutEffectId: "rpe_d448820ca082d9bb53f003a0f4a26b84",
    amountCents: 50,
  },
  over_limit: {
    scenarioNumber: 5,
    payoutEffectId: "rpe_6cf832d0713742e4509cbd16995b1419",
    amountCents: 60,
  },
  stale_policy: {
    scenarioNumber: 6,
    payoutEffectId: "rpe_a1051e827c685b79dbe83482d7fc9f21",
    amountCents: 50,
  },
}

export function isRewardRehearsalScenario(value: unknown): value is RewardRehearsalScenario {
  return value === "replay"
    || value === "over_limit"
    || value === "deadline_expired"
    || value === "stale_policy"
    || value === "refund_while_payouts_paused"
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
    idempotencyKey: `rehearsal:scenario${fixture.scenarioNumber}:20260729:${scenario === "over_limit" ? "v2" : "v1"}`,
    effectKind: "reward_cashout",
    amountCents: fixture.amountCents,
    recipientAddress: REHEARSAL_RECIPIENT,
    rehearsalScenario: scenario,
  }
}

export async function enqueueRewardRehearsalScenario(input: {
  env: Env
  scenario: RewardRehearsalScenario
}): Promise<OperatorSettleResult> {
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
  return stub.settle(request)
}
