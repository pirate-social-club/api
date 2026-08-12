import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt } from "../communities/community-routes-test-helpers"
import { createOpenSongCommunity } from "../song-artifacts/song-artifact-locked-test-helpers"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function authHeaders(accessToken: string, contentType = "application/json"): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`,
    "content-type": contentType,
  }
}

describe("content blob routes", () => {
  test("keeps the route disabled without both the server flag and community allowlist", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "content-blob-disabled-fixture")
    const communityId = await createOpenSongCommunity(ctx.env, session.accessToken, "Content Blob Disabled Fixture")
    ctx.env.CONTENT_BLOB_UPLOADS_ENABLED = "true"

    const response = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs`,
      {
        method: "POST",
        headers: authHeaders(session.accessToken),
        body: JSON.stringify({
          validation_profile: "download_file_v1",
          declared_mime_type: "text/csv",
          upload_mode: "proxy",
        }),
      },
      ctx.env,
    )
    expect(response.status).toBe(404)
  })

  test("creates, uploads, and reads an owned blob without making it ready", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    ctx.env.CONTENT_BLOB_UPLOADS_ENABLED = "true"
    ctx.env.FILEBASE_S3_ACCESS_KEY = "fixture-access-key"
    ctx.env.FILEBASE_S3_SECRET_KEY = "fixture-secret-key"
    ctx.env.FILEBASE_MEDIA_BUCKET = "fixture-bucket"
    ctx.env.FILEBASE_S3_ENDPOINT = "https://s3.filebase.test"
    const session = await exchangeJwt(ctx.env, "content-blob-owner-fixture")
    const communityId = await createOpenSongCommunity(ctx.env, session.accessToken, "Content Blob Owner Fixture")
    ctx.env.CONTENT_BLOB_UPLOAD_COMMUNITY_IDS = communityId
    const bytes = new TextEncoder().encode("word,meaning\nship,vessel\n")
    let providerPutCount = 0

    globalThis.fetch = async (requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)
      if (request.method === "PUT" && request.url.startsWith("https://s3.filebase.test/")) {
        providerPutCount += 1
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafycontentblobfixture" },
        })
      }
      return await originalFetch(request)
    }

    const createdResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs`,
      {
        method: "POST",
        headers: authHeaders(session.accessToken),
        body: JSON.stringify({
          validation_profile: "download_file_v1",
          declared_filename: "words.csv",
          declared_mime_type: "text/csv",
          declared_size_bytes: bytes.byteLength,
          upload_mode: "proxy",
        }),
      },
      ctx.env,
    )
    expect(createdResponse.status).toBe(201)
    const created = await json(createdResponse) as {
      id: string
      status: string
      security_scan_state: string
      upload_url: string | null
      upload_session: { object_key: string; status: string }
    }
    expect(created.id).toStartWith("cbl_")
    expect(created.status).toBe("pending_upload")
    expect(created.security_scan_state).toBe("pending")
    expect(created.upload_url).toContain(`/content-blobs/${created.id}/content`)
    expect(created.upload_session.object_key).toBe(
      `content-blobs/${communityId}/${created.id}/payload`,
    )

    const uploadedResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs/${created.id}/content`,
      {
        method: "PUT",
        headers: authHeaders(session.accessToken, "application/octet-stream"),
        body: bytes,
      },
      ctx.env,
    )
    expect(uploadedResponse.status).toBe(200)
    const uploaded = await json(uploadedResponse) as {
      status: string
      security_scan_state: string
      verified_size_bytes: number
      verified_content_hash: string
      detected_mime_type: string | null
      upload_url: string | null
    }
    expect(uploaded.status).toBe("uploaded")
    expect(uploaded.security_scan_state).toBe("pending")
    expect(uploaded.detected_mime_type).toBeNull()
    expect(uploaded.verified_size_bytes).toBe(bytes.byteLength)
    expect(uploaded.verified_content_hash).toMatch(/^0x[a-f0-9]{64}$/)
    expect(uploaded.upload_url).toBeNull()

    const readResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs/${created.id}`,
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(readResponse.status).toBe(200)
    const read = await json(readResponse) as { id: string; status: string; security_scan_state: string }
    expect(read).toEqual(expect.objectContaining({
      id: created.id,
      status: "uploaded",
      security_scan_state: "pending",
    }))

    const mismatchIntentResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs`,
      {
        method: "POST",
        headers: authHeaders(session.accessToken),
        body: JSON.stringify({
          validation_profile: "download_file_v1",
          declared_filename: "mismatch.csv",
          declared_mime_type: "text/csv",
          declared_size_bytes: bytes.byteLength + 1,
          upload_mode: "proxy",
        }),
      },
      ctx.env,
    )
    expect(mismatchIntentResponse.status).toBe(201)
    const mismatchIntent = await json(mismatchIntentResponse) as { id: string }
    const mismatchUploadResponse = await app.request(
      `http://pirate.test/communities/${communityId}/content-blobs/${mismatchIntent.id}/content`,
      {
        method: "PUT",
        headers: authHeaders(session.accessToken, "application/octet-stream"),
        body: bytes,
      },
      ctx.env,
    )
    expect(mismatchUploadResponse.status).toBe(400)
    expect(providerPutCount).toBe(1)
  })
})
