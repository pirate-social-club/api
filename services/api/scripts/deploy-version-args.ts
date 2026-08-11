export type BuildVersionMetadata = {
  gitRef: string
  gitSha: string
  timestamp: string
  communityD1ShardSourceVersion: string
  releaseId: string | null
  buildId: string | null
  webSha: string | null
  apiSha: string
  coreSha: string | null
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
  const releaseId = firstNonEmpty([env.BUILD_RELEASE_ID, env.PIRATE_BUILD_RELEASE_ID])
  const buildId = firstNonEmpty([env.BUILD_ID, env.PIRATE_BUILD_ID])
  const webSha = firstNonEmpty([env.BUILD_WEB_SHA, env.PIRATE_BUILD_WEB_SHA])
  const coreSha = firstNonEmpty([env.BUILD_CORE_SHA, env.PIRATE_BUILD_CORE_SHA])

  if (!gitSha || !gitRef || !timestamp || !communityD1ShardTree || !sharedTree) {
    throw new Error("Missing build version metadata")
  }

  return {
    gitRef,
    gitSha,
    timestamp,
    communityD1ShardSourceVersion,
    releaseId,
    buildId,
    webSha,
    apiSha: gitSha,
    coreSha,
  }
}

export function buildStampedWranglerDeployArgs(
  passthroughArgs: string[],
  metadata: BuildVersionMetadata,
): string[] {
  const optionalDefines = ([
    ["__PIRATE_BUILD_RELEASE_ID__", metadata.releaseId],
    ["__PIRATE_BUILD_ID__", metadata.buildId],
    ["__PIRATE_BUILD_WEB_SHA__", metadata.webSha],
    ["__PIRATE_BUILD_API_SHA__", metadata.apiSha],
    ["__PIRATE_BUILD_CORE_SHA__", metadata.coreSha],
  ] as const).flatMap(([name, value]) => value ? ["--define", defineString(name, value)] : [])

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
    ...optionalDefines,
    "--tag",
    metadata.gitSha,
  ]
}
