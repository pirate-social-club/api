import type { Env } from "../../../env"
import { nowIso } from "../../helpers"
import { getAssetRow } from "../commerce/queries"
import { openCommunityWriteClient } from "../community-read-access"
import { recoverCommunityJobByIdIfStale } from "./runner"
import type { CommunityJobRepository } from "./runner-types"
import {
  enqueueCommunityJob,
  findLatestCommunityJobBySubjectAndType,
} from "./store"

export async function recoverRequestedLockedAssetDelivery(input: {
  env: Env
  communityId: string
  assetId: string
  communityRepository: CommunityJobRepository
}): Promise<void> {
  let jobId: string | null = null
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset || asset.locked_delivery_status !== "requested") return

    const existing = await findLatestCommunityJobBySubjectAndType({
      client: db.client,
      jobType: "locked_asset_delivery_prepare",
      subjectType: "asset",
      subjectId: asset.asset_id,
    })
    const job = existing && (existing.status === "queued" || existing.status === "running" || existing.status === "failed")
      ? existing
      : await enqueueCommunityJob({
        client: db.client,
        communityId: input.communityId,
        jobType: "locked_asset_delivery_prepare",
        subjectType: "asset",
        subjectId: asset.asset_id,
        payloadJson: JSON.stringify({ post_id: asset.source_post_id }),
        createdAt: nowIso(),
      })
    jobId = job.job_id
  } finally {
    db.close()
  }

  if (!jobId) return
  await recoverCommunityJobByIdIfStale({
    env: input.env,
    communityId: input.communityId,
    jobId,
    communityRepository: input.communityRepository,
  })
}
