import type { Client } from "../../sql-client"
import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { decodePublicAssetId } from "../../public-ids"
import {
  findEligibleStoryParentProjectionByRef,
  findZeroRevenueShareStoryParentIpIds,
  resolveEligibleStoryParentProjectionByAssetId,
} from "./derivative-source-projection"
import { getAssetRow } from "./queries"

const DIRECT_STORY_PARENT_PATTERN = /^story:ip:(0x[a-fA-F0-9]{40})#licenseTermsId=(\d+)$/
const REVENUE_SHARE_ERROR = "Derivative sources must have a positive commercial revenue share"
const INELIGIBLE_SOURCE_ERROR = "Selected derivative source is no longer eligible"
const AMBIGUOUS_SOURCE_ERROR = "Selected derivative source is ambiguous; select it again"

export async function assertDerivativeParentRevenueShare(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  upstreamAssetRefs: string[] | null | undefined
}): Promise<void> {
  for (const value of input.upstreamAssetRefs ?? []) {
    const ref = value.trim()
    const directMatch = DIRECT_STORY_PARENT_PATTERN.exec(ref)
    if (directMatch) {
      const parent = await findEligibleStoryParentProjectionByRef({
        env: input.env,
        storyIpId: directMatch[1],
        storyLicenseTermsId: directMatch[2],
      })
      if (!parent) throw badRequestError(INELIGIBLE_SOURCE_ERROR)
      continue
    }

    const encodedAssetId = ref.startsWith("story:asset:")
      ? ref.slice("story:asset:".length)
      : ref
    const assetId = decodePublicAssetId(encodedAssetId)
    if (!assetId.startsWith("ast_")) continue
    const parent = await getAssetRow(input.client, input.communityId, assetId)
    if (parent) {
      if ((parent.commercial_rev_share_pct ?? 0) <= 0) {
        throw badRequestError(REVENUE_SHARE_ERROR)
      }
      continue
    }
    const projected = await resolveEligibleStoryParentProjectionByAssetId({
      env: input.env,
      assetId,
    })
    if (projected.status === "resolved") continue
    if (projected.status === "ambiguous") throw badRequestError(AMBIGUOUS_SOURCE_ERROR)
    throw badRequestError(INELIGIBLE_SOURCE_ERROR)
  }
}

export async function excludeKnownZeroRevenueShareStoryParents(input: {
  env: Env
  parentIpIds: string[]
}): Promise<string[]> {
  const zeroShareParentIpIds = await findZeroRevenueShareStoryParentIpIds({
    env: input.env,
    storyIpIds: input.parentIpIds,
  })
  return input.parentIpIds.filter((parentIpId) => !zeroShareParentIpIds.has(parentIpId.toLowerCase()))
}
