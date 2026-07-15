import { describe, expect, mock, test } from "bun:test"

import { assertSongAssetRightsReadyForListing } from "./listing-service"

function songAsset() {
  return {
    asset_kind: "song_audio",
    source_post_id: "post_song",
  } as never
}

describe("assertSongAssetRightsReadyForListing", () => {
  test("rejects a legacy remix asset whose source post claims original rights", async () => {
    const client = {
      execute: mock(async () => ({
        rows: [{
          song_mode: "remix",
          rights_basis: "original",
          upstream_asset_refs_json: null,
        }],
      })),
    }

    await expect(assertSongAssetRightsReadyForListing({
      client: client as never,
      communityId: "com_test",
      asset: songAsset(),
    })).rejects.toThrow(/rights_basis must be derivative/)
  })

  test("accepts a derivative remix with upstream evidence", async () => {
    const client = {
      execute: mock(async () => ({
        rows: [{
          song_mode: "remix",
          rights_basis: "derivative",
          upstream_asset_refs_json: JSON.stringify(["story:asset:ast_parent"]),
        }],
      })),
    }

    await expect(assertSongAssetRightsReadyForListing({
      client: client as never,
      communityId: "com_test",
      asset: songAsset(),
    })).resolves.toBeUndefined()
  })
})
