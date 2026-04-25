import type { CommunityRepository } from "./db-community-repository"

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function toAsciiRootLabel(value: string): string {
  if (!value || value.includes(".") || /^[\x00-\x7F]+$/u.test(value)) {
    return value
  }

  try {
    const hostname = new URL(`http://${value}.invalid`).hostname
    return hostname.endsWith(".invalid") ? hostname.slice(0, -".invalid".length) : value
  } catch {
    return value
  }
}

export function communityIdentifierCandidates(communityIdentifier: string): string[] {
  const candidates: string[] = []
  const add = (candidate: string) => {
    const normalized = candidate.trim()
    if (normalized && !candidates.includes(normalized)) {
      candidates.push(normalized)
    }
  }

  add(communityIdentifier)
  add(safeDecodeURIComponent(communityIdentifier))

  for (const candidate of [...candidates]) {
    const normalized = candidate.normalize("NFKC").toLowerCase()
    add(normalized)

    if (normalized.startsWith("@")) {
      const rootLabel = normalized.slice(1)
      const asciiRootLabel = toAsciiRootLabel(rootLabel)
      if (asciiRootLabel !== rootLabel) {
        add(`@${asciiRootLabel}`)
      }
    }
  }

  return candidates
}

export async function resolveCommunityIdentifier(
  communityRepository: CommunityRepository,
  communityIdentifier: string,
): Promise<string | null> {
  for (const candidate of communityIdentifierCandidates(communityIdentifier)) {
    const byId = await communityRepository.getCommunityById(candidate)
    if (byId) {
      return byId.community_id
    }

    const byRouteSlug = await communityRepository.getCommunityByRouteSlug(candidate)
    if (byRouteSlug) {
      return byRouteSlug.community_id
    }
  }

  return null
}
