import type { Env } from "../../../env"
import type { CommunityJobCheckpoint, CommunityJobRow } from "./store"
import type { CommunityJobRepository } from "./runner-types"

export type CommunityJobHandlerInput = {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
  recordCheckpoint?: (
    checkpoint: CommunityJobCheckpoint,
    details?: Record<string, unknown> | null,
  ) => Promise<void>
}
