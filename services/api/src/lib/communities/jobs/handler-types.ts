import type { Env } from "../../../env"
import type { UserRepository } from "../../auth/repositories"
import type { CommunityJobRow } from "./store"
import type { CommunityJobRepository } from "./runner-types"

export type CommunityJobHandlerInput = {
  job: CommunityJobRow
  env: Env
  communityRepository: CommunityJobRepository
  userRepository?: UserRepository
}
