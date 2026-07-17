import type { Env } from "../../env"

export function isStorySettlementNonceRepairDrillTarget(
  env: Pick<Env, "ENVIRONMENT" | "STORY_SETTLEMENT_NONCE_REPAIR_DRILL_TARGET">,
  request: { communityId: string; quoteId: string },
): boolean {
  if (env.ENVIRONMENT !== "staging") return false
  const configured = String(env.STORY_SETTLEMENT_NONCE_REPAIR_DRILL_TARGET || "").trim()
  return configured.length > 0 && configured === `${request.communityId}:${request.quoteId}`
}
