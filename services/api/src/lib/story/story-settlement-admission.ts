import type { Env } from "../../env"

type AdmissionEnv = Pick<
  Env,
  "STORY_SETTLEMENT_COORDINATOR_ADMISSION_ENABLED" | "STORY_SETTLEMENT_COORDINATOR_ADMISSION_COMMUNITY_IDS"
>

export function parseStorySettlementAdmissionCommunityIds(raw: string | undefined): Set<string> {
  return new Set(
    String(raw || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  )
}

// Two keys are required to admit a plan: the rollout flag AND an explicit
// community allowlist entry. The flag alone is Worker-wide, so without the
// allowlist a canary would admit every community sharing the deployment.
export function isStorySettlementCoordinatorAdmissionEnabled(env: AdmissionEnv, communityId: string): boolean {
  if (env.STORY_SETTLEMENT_COORDINATOR_ADMISSION_ENABLED !== "true") return false
  const community = String(communityId || "").trim()
  if (!community) return false
  return parseStorySettlementAdmissionCommunityIds(
    env.STORY_SETTLEMENT_COORDINATOR_ADMISSION_COMMUNITY_IDS,
  ).has(community)
}
