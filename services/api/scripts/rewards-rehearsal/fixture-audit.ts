import { createHash } from "node:crypto"

export const REHEARSAL_FIXTURE_ARCHIVE_REASON = "fixture_without_funding_provenance" as const
export const REHEARSAL_FIXTURE_KIND = "rewards_vault_rehearsal_baseline" as const

export function rehearsalFixtureFundingEffectId(campaignId: string): string {
  return `rff_${createHash("sha256").update(`fixture-funding:${campaignId}`).digest("hex").slice(0, 32)}`
}
