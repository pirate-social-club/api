import type { Client } from "../../sql-client"
import type { Env } from "../../../env"
import { badRequestError } from "../../errors"
import { decodePublicAssetId } from "../../public-ids"
import {
  findZeroRevenueShareStoryParentIpIds,
  findZeroRevenueShareStoryParentRefs,
} from "./derivative-source-projection"
import { getAssetRow } from "./queries"

const DIRECT_STORY_PARENT_PATTERN = /^story:ip:(0x[a-fA-F0-9]{40})#licenseTermsId=(\d+)$/
const REVENUE_SHARE_ERROR = "Derivative sources must have a positive commercial revenue share"

export async function assertDerivativeParentRevenueShare(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  upstreamAssetRefs: string[] | null | undefined
}): Promise<void> {
  const directStoryRefs: Array<{ storyIpId: string; licenseTermsId: string }> = []
  for (const value of input.upstreamAssetRefs ?? []) {
    const ref = value.trim()
    const directMatch = DIRECT_STORY_PARENT_PATTERN.exec(ref)
    if (directMatch) {
      directStoryRefs.push({ storyIpId: directMatch[1], licenseTermsId: directMatch[2] })
      continue
    }

    const encodedAssetId = ref.startsWith("story:asset:")
      ? ref.slice("story:asset:".length)
      : ref
    const assetId = decodePublicAssetId(encodedAssetId)
    if (!assetId.startsWith("ast_")) continue
    const parent = await getAssetRow(input.client, input.communityId, assetId)
    if (parent && (parent.commercial_rev_share_pct ?? 0) <= 0) {
      throw badRequestError(REVENUE_SHARE_ERROR)
    }
  }

  const zeroShareParentRefs = await findZeroRevenueShareStoryParentRefs({
    env: input.env,
    refs: directStoryRefs,
  })
  if (zeroShareParentRefs.size > 0) {
    throw badRequestError(REVENUE_SHARE_ERROR)
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
