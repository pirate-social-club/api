import { describe, expect, test } from "bun:test"
import { verifySongArtifactSourceContentHash } from "./song-artifact-preview-service"

const ABC_SHA256 = "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

describe("verifySongArtifactSourceContentHash", () => {
  test("accepts a digest derived from the downloaded source bytes", async () => {
    await expect(verifySongArtifactSourceContentHash({
      sourceBytes: new TextEncoder().encode("abc"),
      uploadContentHash: ABC_SHA256,
      bundleContentHash: ABC_SHA256,
    })).resolves.toBe(ABC_SHA256)
  })

  test("rejects client and bundle digests that do not match the downloaded bytes", async () => {
    await expect(verifySongArtifactSourceContentHash({
      sourceBytes: new TextEncoder().encode("abc"),
      uploadContentHash: `0x${"a".repeat(64)}`,
      bundleContentHash: ABC_SHA256,
    })).rejects.toThrow("Primary audio content hash does not match downloaded bytes")

    await expect(verifySongArtifactSourceContentHash({
      sourceBytes: new TextEncoder().encode("abc"),
      uploadContentHash: ABC_SHA256,
      bundleContentHash: null,
    })).rejects.toThrow("Primary audio content hash does not match downloaded bytes")
  })
})
