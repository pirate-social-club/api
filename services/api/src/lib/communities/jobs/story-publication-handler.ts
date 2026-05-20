import { getUserRepository } from "../../auth/repositories"
import { retryStoryRoyaltyRegistrationForAsset } from "../commerce/service"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

type StoryPublicationPayload = {
  asset_id?: string | null
}

export async function runStoryPublication(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<StoryPublicationPayload>(input.job.payload_json)
  const assetId = payload?.asset_id ?? input.job.subject_id
  const db = await openCommunityDb(input.env, input.communityRepository, input.job.community_id)
  try {
    const asset = await retryStoryRoyaltyRegistrationForAsset({
      env: input.env,
      client: db.client,
      communityId: input.job.community_id,
      assetId,
      userRepository: input.userRepository ?? getUserRepository(input.env),
    })
    if (asset.story_royalty_registration_status !== "registered") {
      throw new Error(asset.story_error ?? "story_royalty_registration_failed")
    }
    return asset.id
  } finally {
    db.close()
  }
}
