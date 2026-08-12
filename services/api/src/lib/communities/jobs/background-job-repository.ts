import { getCommunityRepository } from "../db-community-repository"
import type { CommunityJobRepository } from "./runner-types"
import type { Env } from "../../../env"

type CommunityJobRepositoryFactory = (env: Env) => CommunityJobRepository

const defaultCommunityJobRepositoryFactory: CommunityJobRepositoryFactory = (env) =>
  getCommunityRepository(env) as unknown as CommunityJobRepository

let communityJobRepositoryFactoryForRuntime: CommunityJobRepositoryFactory =
  defaultCommunityJobRepositoryFactory

/**
 * Repository for community-job processing that outlives the request that
 * scheduled it (`ctx.waitUntil` immediate-processing paths).
 *
 * Must be called INSIDE `withBackgroundControlPlaneClients`: the repository
 * captures a control-plane client at construction, and a repository built
 * during the request holds the request store's client, which the middleware
 * closes as soon as the response is produced. A background task that reuses it
 * fails with "Client was closed and is not queryable" on its first
 * control-plane call.
 */
export function getBackgroundCommunityJobRepository(env: Env): CommunityJobRepository {
  return communityJobRepositoryFactoryForRuntime(env)
}

export function setBackgroundCommunityJobRepositoryForTests(
  factory: CommunityJobRepositoryFactory | null,
): void {
  communityJobRepositoryFactoryForRuntime = factory ?? defaultCommunityJobRepositoryFactory
}
