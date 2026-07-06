export type BuildVersionMetadata = {
  gitRef: string
  gitSha: string
  timestamp: string
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

  if (!gitSha || !gitRef || !timestamp) {
    throw new Error("Missing build version metadata")
  }

  return {
    gitRef,
    gitSha,
    timestamp,
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
  ]
}
