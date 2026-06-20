import { describe, expect, test } from "bun:test"
import { readFilebaseCid } from "../../../src/lib/storage/filebase-cid"

describe("readFilebaseCid", () => {
  test("prefers the HEAD response CID header", async () => {
    const cid = await readFilebaseCid({
      response: new Response(null, {
        headers: { "x-amz-meta-cid": "bafyresponse" },
      }),
      headResponse: new Response(null, {
        headers: { "x-amz-meta-cid": "bafyhead" },
      }),
    })

    expect(cid).toBe("bafyhead")
  })

  test("reads the upload response CID header", async () => {
    const cid = await readFilebaseCid({
      response: new Response(null, {
        headers: { "x-amz-meta-cid": "bafyupload" },
      }),
    })

    expect(cid).toBe("bafyupload")
  })

  test("falls back to the CompleteMultipartUpload XML CID", async () => {
    const cid = await readFilebaseCid({
      response: new Response("<CompleteMultipartUploadResult><CID>QmMultipartCid</CID></CompleteMultipartUploadResult>"),
      readBodyXml: true,
    })

    expect(cid).toBe("QmMultipartCid")
  })

  test("does not consume the XML body unless requested", async () => {
    await expect(readFilebaseCid({
      response: new Response("<CompleteMultipartUploadResult><CID>QmMultipartCid</CID></CompleteMultipartUploadResult>"),
    })).rejects.toThrow("Filebase upload did not return an IPFS CID")
  })

  test("uses a caller-specific error message", async () => {
    await expect(readFilebaseCid({
      response: new Response(null),
      errorMessage: "custom cid missing",
    })).rejects.toThrow("custom cid missing")
  })

  test("throws when XML fallback has no CID", async () => {
    await expect(readFilebaseCid({
      response: new Response("<CompleteMultipartUploadResult><ETag>\"etag\"</ETag></CompleteMultipartUploadResult>"),
      readBodyXml: true,
    })).rejects.toThrow("Filebase upload did not return an IPFS CID")
  })
})
