import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { json, createRouteTestContext, resetRuntimeCaches } from "../../helpers"
import { createOpenSongCommunity } from "./song-artifact-locked-test-helpers"
import { exchangeJwt, requestJson } from "./song-artifact-test-helpers"

const CONTENT_HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const PART_ETAGS = [
  "\"11111111111111111111111111111111\"",
  "\"22222222222222222222222222222222\"",
  "\"33333333333333333333333333333333\"",
]
const VIDEO_SIZE_BYTES = 25 * 1024 * 1024

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

function installMultipartFilebaseMock(input: {
  uploadId?: string
  cid?: string
  contentLength?: number
  contentType?: string
} = {}): { completeBodies: string[]; abortUrls: string[] } {
  const uploadId = input.uploadId ?? "filebase-upload-1"
  const cid = input.cid ?? "QmMultipartRouteCid"
  const contentLength = input.contentLength ?? VIDEO_SIZE_BYTES
  const contentType = input.contentType ?? "video/mp4"
  const completeBodies: string[] = []
  const abortUrls: string[] = []

  ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)
    if (!request.url.startsWith("https://s3.filebase.test/")) {
      return await originalFetch(request)
    }

    const url = new URL(request.url)
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      return new Response(
        `<InitiateMultipartUploadResult><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      )
    }

    if (request.method === "POST" && url.searchParams.get("uploadId") === uploadId) {
      completeBodies.push(await request.text())
      return new Response(
        `<CompleteMultipartUploadResult><ETag>"multipart-etag"</ETag><CID>${cid}</CID></CompleteMultipartUploadResult>`,
        { status: 200, headers: { "content-type": "application/xml" } },
      )
    }

    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": String(contentLength),
          "content-type": contentType,
          "etag": "\"multipart-etag\"",
          "x-amz-meta-cid": cid,
        },
      })
    }

    if (request.method === "DELETE" && url.searchParams.get("uploadId") === uploadId) {
      abortUrls.push(request.url)
      return new Response(null, { status: 204 })
    }

    return new Response(`unexpected Filebase request: ${request.method} ${request.url}`, { status: 500 })
  }

  return { completeBodies, abortUrls }
}

async function createMultipartRouteSetup() {
  const filebase = installMultipartFilebaseMock()
  const ctx = await createRouteTestContext({
    FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
    FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
    FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
    FILEBASE_MEDIA_BUCKET: "pirate-media",
    PIRATE_API_PUBLIC_ORIGIN: "http://pirate.test",
  })
  cleanup = ctx.cleanup

  const owner = await exchangeJwt(ctx.env, "multipart-route-owner")
  const communityId = await createOpenSongCommunity(ctx.env, owner.accessToken, "Multipart Route Club")
  return { ...ctx, owner, communityId, filebase }
}

async function createMultipartIntent(input: Awaited<ReturnType<typeof createMultipartRouteSetup>>) {
  const response = await requestJson(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads`,
    {
      upload_mode: "direct_multipart",
      artifact_kind: "primary_video",
      mime_type: "video/mp4",
      filename: "large.mp4",
      size_bytes: VIDEO_SIZE_BYTES,
      content_hash: CONTENT_HASH,
    },
    input.env,
    input.owner.accessToken,
  )
  expect(response.status).toBe(201)
  return await json(response) as {
    id: string
    status: string
    upload_session: {
      id: string
      upload_id: string
      part_size_bytes: number
      total_parts: number
      expires_at: string
      sign_part_url: string
      complete: string
      abort: string
    }
  }
}

describe("song artifact multipart routes", () => {
  test("creates a direct multipart upload session and signs part URLs", async () => {
    const setup = await createMultipartRouteSetup()
    const intent = await createMultipartIntent(setup)

    expect(intent.status).toBe("pending_upload")
    expect(intent.upload_session.upload_id).toBe("filebase-upload-1")
    expect(intent.upload_session.part_size_bytes).toBe(10 * 1024 * 1024)
    expect(intent.upload_session.total_parts).toBe(3)

    const oldExpiry = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    await setup.client.execute({
      sql: `
        UPDATE song_artifact_upload_sessions
        SET expires_at = ?1
        WHERE song_artifact_upload_session_id = ?2
      `,
      args: [oldExpiry, intent.upload_session.id],
    })

    const signed = await app.request(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/parts/1/signed-url`,
      { headers: { authorization: `Bearer ${setup.owner.accessToken}` } },
      setup.env,
    )
    expect(signed.status).toBe(200)
    const signedBody = await json(signed) as { url: string; part_number: number; part_size_bytes: number }
    const signedUrl = new URL(signedBody.url)
    expect(signedUrl.searchParams.get("uploadId")).toBe("filebase-upload-1")
    expect(signedUrl.searchParams.get("partNumber")).toBe("1")
    expect(signedUrl.searchParams.get("X-Amz-Signature")).toBeTruthy()
    expect(signedBody.part_number).toBe(1)
    expect(signedBody.part_size_bytes).toBe(10 * 1024 * 1024)

    const session = await setup.client.execute({
      sql: `
        SELECT expires_at
        FROM song_artifact_upload_sessions
        WHERE song_artifact_upload_session_id = ?1
      `,
      args: [intent.upload_session.id],
    })
    expect(new Date(String(session.rows[0]?.expires_at)).getTime()).toBeGreaterThan(new Date(oldExpiry).getTime())
  })

  test("rejects invalid or expired part signing requests", async () => {
    const setup = await createMultipartRouteSetup()
    const intent = await createMultipartIntent(setup)

    const invalidZero = await app.request(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/parts/0/signed-url`,
      { headers: { authorization: `Bearer ${setup.owner.accessToken}` } },
      setup.env,
    )
    expect(invalidZero.status).toBe(400)

    const invalidTooHigh = await app.request(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/parts/4/signed-url`,
      { headers: { authorization: `Bearer ${setup.owner.accessToken}` } },
      setup.env,
    )
    expect(invalidTooHigh.status).toBe(400)

    await setup.client.execute({
      sql: `
        UPDATE song_artifact_upload_sessions
        SET expires_at = '2026-01-01T00:00:00.000Z'
        WHERE song_artifact_upload_session_id = ?1
      `,
      args: [intent.upload_session.id],
    })
    const expired = await app.request(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/parts/1/signed-url`,
      { headers: { authorization: `Bearer ${setup.owner.accessToken}` } },
      setup.env,
    )
    expect(expired.status).toBe(410)

    const rows = await setup.client.execute({
      sql: `
        SELECT sau.status AS upload_status, saus.status AS session_status
        FROM song_artifact_uploads sau
        JOIN song_artifact_upload_sessions saus
          ON saus.song_artifact_upload_id = sau.song_artifact_upload_id
        WHERE saus.song_artifact_upload_session_id = ?1
      `,
      args: [intent.upload_session.id],
    })
    expect(rows.rows[0]?.upload_status).toBe("cancelled")
    expect(rows.rows[0]?.session_status).toBe("aborted")
  })

  test("completes a direct multipart upload and marks the canonical upload uploaded", async () => {
    const setup = await createMultipartRouteSetup()
    const intent = await createMultipartIntent(setup)

    const complete = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/complete`,
      {
        upload_id: intent.upload_session.upload_id,
        parts: PART_ETAGS.map((etag, index) => ({ part_number: index + 1, etag })),
        content_hash: CONTENT_HASH,
      },
      setup.env,
      setup.owner.accessToken,
    )
    expect(complete.status).toBe(200)
    const completeBody = await json(complete) as { status: string; ipfs_cid: string | null; content_hash: string }
    expect(completeBody.status).toBe("uploaded")
    expect(completeBody.ipfs_cid).toBe("QmMultipartRouteCid")
    expect(completeBody.content_hash).toBe(CONTENT_HASH)
    expect(setup.filebase.completeBodies[0]).toContain("<PartNumber>3</PartNumber>")

    const rows = await setup.client.execute({
      sql: `
        SELECT sau.status AS upload_status, saus.status AS session_status
        FROM song_artifact_uploads sau
        JOIN song_artifact_upload_sessions saus
          ON saus.song_artifact_upload_id = sau.song_artifact_upload_id
        WHERE saus.song_artifact_upload_session_id = ?1
      `,
      args: [intent.upload_session.id],
    })
    expect(rows.rows[0]?.upload_status).toBe("uploaded")
    expect(rows.rows[0]?.session_status).toBe("uploaded")
  })

  test("rejects malformed multipart completion payloads", async () => {
    const setup = await createMultipartRouteSetup()
    const intent = await createMultipartIntent(setup)

    const wrongUploadId = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/complete`,
      {
        upload_id: "wrong-upload-id",
        parts: PART_ETAGS.map((etag, index) => ({ part_number: index + 1, etag })),
        content_hash: CONTENT_HASH,
      },
      setup.env,
      setup.owner.accessToken,
    )
    expect(wrongUploadId.status).toBe(400)

    const wrongPartCount = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/complete`,
      {
        upload_id: intent.upload_session.upload_id,
        parts: PART_ETAGS.slice(0, 2).map((etag, index) => ({ part_number: index + 1, etag })),
        content_hash: CONTENT_HASH,
      },
      setup.env,
      setup.owner.accessToken,
    )
    expect(wrongPartCount.status).toBe(400)

    const badEtag = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/complete`,
      {
        upload_id: intent.upload_session.upload_id,
        parts: [
          { part_number: 1, etag: "\"not-hex\"" },
          { part_number: 2, etag: PART_ETAGS[1] },
          { part_number: 3, etag: PART_ETAGS[2] },
        ],
        content_hash: CONTENT_HASH,
      },
      setup.env,
      setup.owner.accessToken,
    )
    expect(badEtag.status).toBe(400)

    const mismatchHash = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${intent.id}/sessions/${intent.upload_session.id}/complete`,
      {
        upload_id: intent.upload_session.upload_id,
        parts: PART_ETAGS.map((etag, index) => ({ part_number: index + 1, etag })),
        content_hash: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      setup.env,
      setup.owner.accessToken,
    )
    expect(mismatchHash.status).toBe(400)
  })

  test("aborts a direct multipart upload and rejects abort after upload", async () => {
    const setup = await createMultipartRouteSetup()
    const abortedIntent = await createMultipartIntent(setup)

    const abort = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${abortedIntent.id}/sessions/${abortedIntent.upload_session.id}/abort`,
      {},
      setup.env,
      setup.owner.accessToken,
    )
    expect(abort.status).toBe(200)
    expect(setup.filebase.abortUrls.length).toBe(1)

    const abortedRows = await setup.client.execute({
      sql: `
        SELECT sau.status AS upload_status, saus.status AS session_status
        FROM song_artifact_uploads sau
        JOIN song_artifact_upload_sessions saus
          ON saus.song_artifact_upload_id = sau.song_artifact_upload_id
        WHERE saus.song_artifact_upload_session_id = ?1
      `,
      args: [abortedIntent.upload_session.id],
    })
    expect(abortedRows.rows[0]?.upload_status).toBe("cancelled")
    expect(abortedRows.rows[0]?.session_status).toBe("aborted")

    const uploadedIntent = await createMultipartIntent(setup)
    const complete = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${uploadedIntent.id}/sessions/${uploadedIntent.upload_session.id}/complete`,
      {
        upload_id: uploadedIntent.upload_session.upload_id,
        parts: PART_ETAGS.map((etag, index) => ({ part_number: index + 1, etag })),
        content_hash: CONTENT_HASH,
      },
      setup.env,
      setup.owner.accessToken,
    )
    expect(complete.status).toBe(200)

    const abortUploaded = await requestJson(
      `http://pirate.test/communities/${setup.communityId}/song-artifact-uploads/${uploadedIntent.id}/sessions/${uploadedIntent.upload_session.id}/abort`,
      {},
      setup.env,
      setup.owner.accessToken,
    )
    expect(abortUploaded.status).toBe(409)
  })
})
