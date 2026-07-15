import { badRequestError } from "../errors"

export type SongRightsInvariantInput = {
  rightsBasis: string | null | undefined
  songMode: string | null | undefined
  upstreamAssetRefs: readonly string[] | null | undefined
}

export function songRightsInvariantFailure(input: SongRightsInvariantInput): string | null {
  if (input.songMode === "remix" && input.rightsBasis !== "derivative") {
    return "rights_basis must be derivative when song_mode is remix"
  }
  if (
    (input.songMode === "remix" || input.rightsBasis === "derivative")
    && !input.upstreamAssetRefs?.some((value) => value.trim())
  ) {
    return "upstream_asset_refs is required for remix or derivative song posts"
  }
  return null
}

export function assertSongRightsInvariant(input: SongRightsInvariantInput): void {
  const failure = songRightsInvariantFailure(input)
  if (failure) {
    throw badRequestError(failure)
  }
}
