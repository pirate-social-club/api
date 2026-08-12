import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { app } from "../../../src/index"
import type { ContentSecurityScanMessage } from "../../../src/lib/content-security/content-security-types"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt } from "../communities/community-routes-test-helpers"
import { createOpenSongCommunity } from "../song-artifacts/song-artifact-locked-test-helpers"

let cleanup: (() => Promise<void>) | null = null
setDefaultTimeout(15_000)

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
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
    ctx.env.CONTENT_SOURCE_BROKER_SHARED_SECRET = "fixture-broker-secret"
    ctx.env.CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED = "true"
    ctx.env.CONTENT_SECURITY_SCAN_PROFILE = "clamav-text-v1"
    const scanMessages: ContentSecurityScanMessage[] = []
    ctx.env.CONTENT_SECURITY_SCAN_QUEUE = {
      metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }),
      send: async (message) => {
        scanMessages.push(message)
        return { metadata: { metrics: { backlogCount: 1, backlogBytes: 32 } } }
      },
      sendBatch: async () => ({ metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }),
    }
    const releaseNow = "2026-08-13T00:00:00.000Z"
    await ctx.client.execute({
      sql: `
        INSERT INTO content_security_scanner_releases (
          scanner_release_id, security_scan_profile, status, source_revision,
          runtime_lock_sha256, base_image_digest, engine_image_digest, engine_version,
          signature_version, signature_date, definition_digest, deployed_image_digest,
          sbom_ref, corpus_evidence_ref, created_at, activated_at
        ) VALUES (
          'csr_route_fixture', 'clamav-text-v1', 'active', 'revision-fixture',
          ?1, ?2, ?3, '1.5.4', 'signatures-fixture', ?4, ?5, ?6,
          'sbom-fixture', 'corpus-fixture', ?4, ?4
        )
      `,
      args: [
        "a".repeat(64),
        `sha256:${"b".repeat(64)}`,
        `sha256:${"c".repeat(64)}`,
        releaseNow,
        "d".repeat(64),
        `sha256:${"e".repeat(64)}`,
      ],
    })
    const session = await exchangeJwt(ctx.env, "content-blob-owner-fixture")
    const communityId = await createOpenSongCommunity(ctx.env, session.accessToken, "Content Blob Owner Fixture")
    ctx.env.CONTENT_BLOB_UPLOAD_COMMUNITY_IDS = communityId
    const bytes = new TextEncoder().encode("word,meaning\nship,vessel\n")
    let brokerPutCount = 0
    ctx.env.CONTENT_SOURCE_BROKER = {
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init)
        brokerPutCount += 1
        expect(request.headers.get("authorization")).toBe("Bearer fixture-broker-secret")
        const contentBlobId = new URL(request.url).pathname.split("/").at(-1)
        return Response.json({
          object: "content_source_object",
          content_blob: contentBlobId,
          status: "stored",
          storage_namespace: "content-source/v1",
          storage_object_key: `content-source/v1/${contentBlobId}`,
          size_bytes: Number(request.headers.get("x-content-size")),
          content_sha256: request.headers.get("x-content-sha256"),
        }, { status: 201 })
      },
      connect: () => { throw new Error("not implemented") },
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
      upload_session: { status: string }
    }
    expect(created.id).toStartWith("cbl_")
    expect(created.status).toBe("pending_upload")
    expect(created.security_scan_state).toBe("pending")
    expect(created.upload_url).toContain(`/content-blobs/${created.id}/content`)
    expect(JSON.stringify(created)).not.toContain("content-source/v1")

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
    expect(scanMessages).toEqual([{
      schema_version: 1,
      scan_job_id: expect.stringMatching(/^csj_/),
    }])
    const scanJobs = await ctx.client.execute({
      sql: `
        SELECT scan_job_id, content_blob_id, status, expected_content_hash, expected_size_bytes
        FROM content_security_scan_jobs
        WHERE content_blob_id = ?1
      `,
      args: [created.id],
    })
    expect(scanJobs.rows).toEqual([expect.objectContaining({
      scan_job_id: scanMessages[0]?.scan_job_id,
      content_blob_id: created.id,
      status: "queued",
      expected_content_hash: uploaded.verified_content_hash,
      expected_size_bytes: bytes.byteLength,
    })])

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
    expect(brokerPutCount).toBe(1)
  })
})
