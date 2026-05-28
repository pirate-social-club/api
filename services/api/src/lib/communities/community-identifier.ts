import type { CommunityReadRepository } from "./db-community-repository"
import type { CommunityRow } from "../auth/auth-db-rows"
import { decodePublicCommunityId } from "../public-ids"

type CommunityIdentifierRepository = Pick<CommunityReadRepository, "getCommunityById" | "getCommunityByRouteSlug"> & {
  getCommunityByIdentifierCandidates?: (candidates: string[]) => Promise<CommunityRow | null>
}

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
    add(decodePublicCommunityId(candidate))

    const normalized = candidate.normalize("NFKC").toLowerCase()
    add(normalized)
    add(decodePublicCommunityId(normalized))

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
  communityRepository: CommunityIdentifierRepository,
  communityIdentifier: string,
): Promise<string | null> {
  const candidates = communityIdentifierCandidates(communityIdentifier)
  const byCandidates = await communityRepository.getCommunityByIdentifierCandidates?.(candidates)
  if (byCandidates) {
    return byCandidates.community_id
  }

  for (const candidate of candidates) {
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
