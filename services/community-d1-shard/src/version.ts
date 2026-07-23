import type { ShardVersionInfo } from "@pirate/api-shared"
import type { Env } from "./env"

declare const __PIRATE_BUILD_GIT_REF__: string | undefined
declare const __PIRATE_BUILD_GIT_SHA__: string | undefined
declare const __PIRATE_BUILD_TIMESTAMP__: string | undefined
declare const __PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__: string | undefined

export function shardVersionInfo(env: Pick<Env, "CF_VERSION_METADATA">): ShardVersionInfo {
  const workerVersion = env.CF_VERSION_METADATA
  return {
    build: {
      gitRef: typeof __PIRATE_BUILD_GIT_REF__ === "string" ? __PIRATE_BUILD_GIT_REF__ : null,
      gitSha: typeof __PIRATE_BUILD_GIT_SHA__ === "string" ? __PIRATE_BUILD_GIT_SHA__ : null,
      timestamp: typeof __PIRATE_BUILD_TIMESTAMP__ === "string" ? __PIRATE_BUILD_TIMESTAMP__ : null,
      sourceVersion: typeof __PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__ === "string"
        ? __PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__
        : null,
    },
    workerVersion: {
      id: workerVersion?.id ?? null,
      tag: workerVersion?.tag ?? null,
      timestamp: workerVersion?.timestamp ?? null,
    },
  }
}
