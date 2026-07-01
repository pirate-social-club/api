import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HttpError } from "../../../src/lib/errors"
import {
  computeMultipartPartPlan,
  DIRECT_MULTIPART_MAX_BYTES,
  reapStaleMultipartSongArtifactUploads,
} from "../../../src/lib/song-artifacts/song-artifact-upload-session-service"
import { createSongArtifactUploadIntent } from "../../../src/lib/song-artifacts/song-artifact-repository"
import { createSongArtifactUploadSession } from "../../../src/lib/song-artifacts/song-artifact-upload-session-repository"
import { createRouteTestContext, mockFetch, resetRuntimeCaches } from "../../helpers"

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

async function createReaperSetup() {
  const abortUrls: string[] = []
  globalThis.fetch = mockFetch(async (requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)
    if (request.method === "DELETE" && new URL(request.url).hostname.endsWith("filebase.test")) {
      abortUrls.push(request.url)
      return new Response(null, { status: 204 })
    }
    return await originalFetch(request)
  })

  const setup = await createRouteTestContext({
    FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
    FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
    FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
    FILEBASE_MEDIA_BUCKET: "pirate-media",
  })
  cleanup = setup.cleanup
  const now = "2026-06-05T12:00:00.000Z"

  await setup.client.execute({
    sql: `
      INSERT INTO users (
        user_id, verification_state, verification_capabilities_json, created_at, updated_at
      ) VALUES (?1, 'verified', '{}', ?2, ?2)
    `,
    args: ["usr_reaper_owner", now],
  })
  await setup.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status,
        provisioning_state, transfer_state, created_at, updated_at
      ) VALUES (?1, ?2, 'Reaper Test', 'open', 'active', 'active', 'none', ?3, ?3)
    `,
    args: ["cmt_reaper", "usr_reaper_owner", now],
  })

  await createSongArtifactUploadIntent({
    client: setup.client,
    communityId: "cmt_reaper",
    userId: "usr_reaper_owner",
    songArtifactUploadId: "sau_reaper_video",
    storageRef: "https://pirate.test/communities/com_cmt_reaper/song-artifact-uploads/sau_sau_reaper_video/content",
    body: {
      artifact_kind: "primary_video",
      mime_type: "video/mp4",
      filename: "stale.mp4",
      size_bytes: 25 * 1024 * 1024,
      content_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    createdAt: now,
  })
  await createSongArtifactUploadSession({
    client: setup.client,
    session: {
      songArtifactUploadSessionId: "saus_reaper_1",
      communityId: "cmt_reaper",
      songArtifactUploadId: "sau_reaper_video",
      uploaderUserId: "usr_reaper_owner",
      status: "parts_uploading",
      uploadMode: "direct_multipart",
      objectKey: "song-artifacts/cmt_reaper/primary_video/sau_reaper_video.mp4",
      filebaseUploadId: "filebase-reaper-upload",
      partSizeBytes: 10 * 1024 * 1024,
      totalParts: 3,
      declaredSizeBytes: 25 * 1024 * 1024,
      declaredMimeType: "video/mp4",
      declaredContentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      bucket: "pirate-media",
      storageEndpoint: "https://s3.filebase.test",
      expiresAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2026-06-05T10:00:00.000Z",
      updatedAt: "2026-06-05T10:00:00.000Z",
    },
  })

  return { ...setup, abortUrls }
}

describe("song artifact upload session service", () => {
  test("plans direct multipart uploads with 10 MB parts", () => {
    expect(computeMultipartPartPlan(1)).toEqual({
      partSizeBytes: 10 * 1024 * 1024,
      totalParts: 1,
    })
    expect(computeMultipartPartPlan(25 * 1024 * 1024)).toEqual({
      partSizeBytes: 10 * 1024 * 1024,
      totalParts: 3,
    })
  })

  test("rejects empty direct multipart uploads", () => {
    expect(() => computeMultipartPartPlan(0)).toThrow(HttpError)
  })

  test("rejects direct multipart uploads above the product cap", () => {
    expect(() => computeMultipartPartPlan(DIRECT_MULTIPART_MAX_BYTES)).not.toThrow()
    expect(() => computeMultipartPartPlan(DIRECT_MULTIPART_MAX_BYTES + 1)).toThrow("Direct multipart uploads are currently limited to 2GB")
  })

  test("reaps stale multipart sessions idempotently", async () => {
    const setup = await createReaperSetup()

    const first = await reapStaleMultipartSongArtifactUploads({
      env: setup.env,
      communityId: "cmt_reaper",
      limit: 10,
    })
    expect(first).toEqual({ scanned: 1, aborted: 1 })
    expect(setup.abortUrls.length).toBe(1)

    const rows = await setup.client.execute({
      sql: `
        SELECT sau.status AS upload_status, saus.status AS session_status
        FROM song_artifact_uploads sau
        JOIN song_artifact_upload_sessions saus
          ON saus.song_artifact_upload_id = sau.song_artifact_upload_id
        WHERE saus.song_artifact_upload_session_id = 'saus_reaper_1'
      `,
    })
    expect(rows.rows[0]?.upload_status).toBe("cancelled")
    expect(rows.rows[0]?.session_status).toBe("aborted")

    const second = await reapStaleMultipartSongArtifactUploads({
      env: setup.env,
      communityId: "cmt_reaper",
      limit: 10,
    })
    expect(second).toEqual({ scanned: 0, aborted: 0 })
    expect(setup.abortUrls.length).toBe(1)
  }, 15_000)
})
