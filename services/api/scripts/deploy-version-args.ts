export type BuildVersionMetadata = {
  gitRef: string
  gitSha: string
  timestamp: string
  communityD1ShardSourceVersion: string
}

export type RunTextCommand = (command: string, args: string[]) => string

export function defineString(name: string, value: string): string {
  return `${name}:${JSON.stringify(value)}`
}

function firstNonEmpty(values: Array<string | undefined>): string | null {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return null
}

export function resolveBuildVersionMetadata(
  env: Record<string, string | undefined>,
  runText: RunTextCommand,
  now: () => Date = () => new Date(),
): BuildVersionMetadata {
  const dirtyShardSources = runText(
    "git",
    [
      "status",
      "--porcelain",
      "--",
      ":(top)services/community-d1-shard",
      ":(top)services/shared",
    ],
  ).trim()
  if (dirtyShardSources) {
    throw new Error(
      "Refusing to stamp a deploy from dirty community-d1-shard/shared sources; commit the exact source tree first.",
    )
  }

  const gitSha = firstNonEmpty([
    env.BUILD_GIT_SHA,
    env.PIRATE_BUILD_GIT_SHA,
    env.GITHUB_SHA,
  ]) ?? runText("git", ["rev-parse", "HEAD"]).trim()

  let gitRef = firstNonEmpty([
    env.BUILD_GIT_REF,
    env.PIRATE_BUILD_GIT_REF,
    env.GITHUB_REF_NAME,
  ])
  if (!gitRef) {
    gitRef = runText("git", ["branch", "--show-current"]).trim() || "detached"
  }

  const timestamp = firstNonEmpty([
    env.BUILD_TIMESTAMP,
    env.PIRATE_BUILD_TIMESTAMP,
  ]) ?? now().toISOString()
  const communityD1ShardTree = runText(
    "git",
    ["rev-parse", "HEAD:services/community-d1-shard"],
  ).trim()
  const sharedTree = runText("git", ["rev-parse", "HEAD:services/shared"]).trim()
  const communityD1ShardSourceVersion = `${communityD1ShardTree}.${sharedTree}`

  if (!gitSha || !gitRef || !timestamp || !communityD1ShardTree || !sharedTree) {
    throw new Error("Missing build version metadata")
  }

  return {
    gitRef,
    gitSha,
    timestamp,
    communityD1ShardSourceVersion,
  }
}

export function buildStampedWranglerDeployArgs(
  passthroughArgs: string[],
  metadata: BuildVersionMetadata,
): string[] {
  return [
    "deploy",
    ...passthroughArgs,
    "--define",
    defineString("__PIRATE_BUILD_GIT_SHA__", metadata.gitSha),
    "--define",
    defineString("__PIRATE_BUILD_GIT_REF__", metadata.gitRef),
    "--define",
    defineString("__PIRATE_BUILD_TIMESTAMP__", metadata.timestamp),
    "--define",
    defineString(
      "__PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__",
      metadata.communityD1ShardSourceVersion,
    ),
    "--tag",
    metadata.gitSha,
  ]
}
