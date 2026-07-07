import type { Env } from "../../env"
import { isProductionEnv, splitCsv } from "../helpers"
import { decodePublicCommunityId } from "../public-ids"

export function shouldSkipSongAcr(input: {
  communityId: string
  env: Pick<Env, "ENVIRONMENT" | "SONG_ACR_BYPASS_COMMUNITY_IDS">
}): boolean {
  if (isProductionEnv(input.env)) return false

  const communityId = input.communityId.trim()
  if (!communityId) return false

  const allowedIds = new Set(
    splitCsv(input.env.SONG_ACR_BYPASS_COMMUNITY_IDS)
      .flatMap((value) => {
        const trimmed = value.trim()
        const decoded = decodePublicCommunityId(trimmed).trim()
        return decoded && decoded !== trimmed ? [trimmed, decoded] : [trimmed]
      })
      .filter(Boolean),
  )

  return allowedIds.has(communityId) || allowedIds.has(decodePublicCommunityId(communityId))
}
