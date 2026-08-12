import type { Env } from "../../env"

export function rewardPayoutsEnabled(env: Pick<Env, "REWARDS_PAYOUTS_ENABLED">): boolean {
  return String(env.REWARDS_PAYOUTS_ENABLED ?? "").trim().toLowerCase() === "true"
}
