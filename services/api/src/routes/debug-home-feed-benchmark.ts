export const HOME_FEED_BENCHMARK_MAX_COMMUNITIES = 16

export function parseHomeFeedBenchmarkCommunityIds(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const communityIds = [...new Set(
    value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )]
  if (
    communityIds.length === 0
    || communityIds.length > HOME_FEED_BENCHMARK_MAX_COMMUNITIES
    || communityIds.some((communityId) => !/^com_[A-Za-z0-9]+$/u.test(communityId))
  ) {
    return null
  }
  return communityIds
}
