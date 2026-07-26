import { internalError } from "../../errors"
import { publishPostProjectionToTelegram } from "../../telegram/channel-publishing-service"
import type { CommunityJobHandlerInput } from "./handler-types"

export async function runTelegramPostPublish(input: CommunityJobHandlerInput): Promise<string | null> {
  const projection = await input.communityRepository.getCommunityPostProjectionByPostId(input.job.subject_id)
  if (!projection || projection.community_id !== input.job.community_id) {
    throw internalError("Telegram publication post projection is missing")
  }
  return publishPostProjectionToTelegram({
    env: input.env,
    projection,
  })
}
