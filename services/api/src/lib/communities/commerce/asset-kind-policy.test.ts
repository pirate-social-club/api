import { describe, expect, test } from "bun:test"
import {
  assertPrimaryPayloadMatchesPolicy,
  getAssetKindPolicy,
} from "./asset-kind-policy"

describe("asset kind policy registry", () => {
  test("defines every supported kind explicitly", () => {
    expect(getAssetKindPolicy("song_audio").deliveryBehavior).toBe("audio")
    expect(getAssetKindPolicy("video_file").deliveryBehavior).toBe("video")
    expect(getAssetKindPolicy("download_file")).toMatchObject({
      primaryPayloadFormat: "opaque_file_v1",
      deliveryBehavior: "download",
      supportsDerivatives: false,
      paidAccess: "locked_only",
    })
    expect(getAssetKindPolicy("learning_deck")).toMatchObject({
      primaryPayloadFormat: "learning_deck_package_v1",
      deliveryBehavior: "app_native",
      supportsDerivatives: false,
      paidAccess: "locked_only",
    })
  })

  test("fails closed for unknown kinds instead of defaulting to song", () => {
    expect(() => getAssetKindPolicy("executable_file")).toThrow("Unsupported asset kind")
  })

  test("rejects payload metadata that does not match the selected policy", () => {
    expect(() => assertPrimaryPayloadMatchesPolicy({
      assetKind: "download_file",
      payload: {
        delivery_behavior: "app_native",
        display_filename: "data.csv",
        mime_type: "text/csv",
        size_bytes: 12,
        content_hash: "sha256:payload",
        payload_format: "opaque_file_v1",
      },
    })).toThrow("delivery behavior")
  })
})
