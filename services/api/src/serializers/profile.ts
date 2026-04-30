import type { PublicProfileResolution } from "../lib/auth/repositories"
import type { GlobalHandle, HandleUpgradeQuote, Profile } from "../types"

// Profile repositories still return contract-shaped resources. Keep route-level
// ownership explicit while the domain/repository split moves behind this facade.
export function serializeProfile(profile: Profile): Profile {
  return profile
}

export function serializeGlobalHandle(handle: GlobalHandle): GlobalHandle {
  return handle
}

export function serializeHandleUpgradeQuote(quote: HandleUpgradeQuote): HandleUpgradeQuote {
  return quote
}

export function serializePublicProfileResolution(resolution: PublicProfileResolution): PublicProfileResolution {
  return resolution
}
