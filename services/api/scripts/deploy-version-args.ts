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
  sourceState: "clean" | "dirty"
  hotfixReasonSlug: string | null
  patchSha256: string | null
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
  const dirtySources = runText("git", ["status", "--porcelain", "--untracked-files=all"]).trim()

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
  const requestedSourceState = firstNonEmpty([env.BUILD_SOURCE_STATE, env.PIRATE_BUILD_SOURCE_STATE])
  const sourceState = requestedSourceState ?? (dirtySources ? "dirty" : "clean")
  const hotfixReasonSlug = firstNonEmpty([
    env.BUILD_HOTFIX_REASON_SLUG,
    env.PIRATE_BUILD_HOTFIX_REASON_SLUG,
  ])
  const patchSha256 = firstNonEmpty([env.BUILD_PATCH_SHA256, env.PIRATE_BUILD_PATCH_SHA256])

  if (!gitSha || !gitRef || !timestamp || !communityD1ShardTree || !sharedTree) {
    throw new Error("Missing build version metadata")
  }
  for (const [field, sha] of [
    ["BUILD_GIT_SHA", gitSha],
    ["BUILD_WEB_SHA", webSha],
    ["BUILD_CORE_SHA", coreSha],
  ] as const) {
    if (sha !== null && !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`${field} must be an exact lowercase 40-character Git SHA`)
    }
  }
  if (sourceState !== "clean" && sourceState !== "dirty") {
    throw new Error("BUILD_SOURCE_STATE must be clean or dirty")
  }
  if (sourceState === "dirty" && (
    !hotfixReasonSlug
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(hotfixReasonSlug)
    || !patchSha256
    || !/^[0-9a-f]{64}$/.test(patchSha256)
  )) {
    throw new Error("Dirty deploys require a normalized hotfix reason and lowercase patch SHA-256 digest")
  }
  if (sourceState === "clean" && (hotfixReasonSlug || patchSha256)) {
    throw new Error("Clean deploys must not include hotfix provenance")
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
    sourceState,
    hotfixReasonSlug,
    patchSha256,
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
    ["__PIRATE_BUILD_HOTFIX_REASON_SLUG__", metadata.hotfixReasonSlug],
    ["__PIRATE_BUILD_PATCH_SHA256__", metadata.patchSha256],
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
    defineString("__PIRATE_BUILD_SOURCE_STATE__", metadata.sourceState),
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
