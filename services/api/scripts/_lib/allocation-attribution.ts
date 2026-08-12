const SOURCE_HEADER = "x-pirate-allocation-source"
const RUN_ID_HEADER = "x-pirate-allocation-run-id"

// Keep the source explicit: the fetch user-agent collapses every Node/Bun
// consumer into the same "node" bucket and cannot support capacity ranking.
export function allocationAttributionHeaders(
  source: string,
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const normalizedSource = source.trim()
  if (!normalizedSource) {
    throw new Error("allocation attribution source must be non-empty")
  }

  const runId = env.GITHUB_RUN_ID?.trim()
  return {
    [SOURCE_HEADER]: normalizedSource,
    ...(runId ? { [RUN_ID_HEADER]: runId } : {}),
  }
}
