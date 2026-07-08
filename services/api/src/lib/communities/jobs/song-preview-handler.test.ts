import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../../env"
import type { CommunityJobRow } from "./store"
import {
  runSongPreviewGenerate,
  setCompletedPreviewPostSyncerForTests,
  setSongPreviewFailureUpdaterForTests,
} from "./song-preview-handler"

const originalFetch = globalThis.fetch

type PreviewFailureUpdate = {
  communityId: string
  songArtifactBundleId: string
  previewAudio: unknown
  previewStatus: string
  previewError: string | null
}

function testJob(overrides: Partial<CommunityJobRow> = {}): CommunityJobRow {
  return {
    job_id: "cjb_test",
    community_id: "com_test",
    job_type: "song_preview_generate",
    subject_type: "song_artifact_bundle",
    subject_id: "sab_subject",
    status: "running",
    payload_json: null,
    result_ref: null,
    error_code: null,
    attempt_count: 1,
    available_at: null,
    last_checkpoint: null,
    last_checkpoint_at: null,
    attempt_started_at: null,
    attempt_deadline_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setCompletedPreviewPostSyncerForTests(null)
  setSongPreviewFailureUpdaterForTests(null)
})

function capturePreviewFailureUpdates(): PreviewFailureUpdate[] {
  const updates: PreviewFailureUpdate[] = []
  setSongPreviewFailureUpdaterForTests(async (input) => {
    updates.push({
      communityId: input.communityId,
      songArtifactBundleId: input.songArtifactBundleId,
      previewAudio: input.previewAudio,
      previewStatus: input.previewStatus,
      previewError: input.previewError,
    })
    return {
      preview_audio: input.previewAudio,
      preview_status: input.previewStatus,
      preview_error: input.previewError,
    } as never
  })
  return updates
}

function captureCompletedPreviewPostSyncs(): string[] {
  const syncedBundleIds: string[] = []
  setCompletedPreviewPostSyncerForTests(async (_input, songArtifactBundleId) => {
    syncedBundleIds.push(songArtifactBundleId)
  })
  return syncedBundleIds
}

describe("runSongPreviewGenerate", () => {
  test("forwards configured preview jobs to the song preview service", async () => {
    const syncedBundleIds = captureCompletedPreviewPostSyncs()
    const requests: Array<{
      url: string
      authorization: string | null
      body: unknown
    }> = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: JSON.parse(await request.text()) as unknown,
      })
      return Response.json({ storage_ref: "https://gateway.example/ipfs/preview" })
    }) as unknown as typeof fetch

    const result = await runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE_URL: "http://127.0.0.1:8795",
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
      } as Env,
      job: testJob({
        payload_json: JSON.stringify({
          song_artifact_bundle: "sab_payload",
          primary_audio_content_hash: "0xabc",
        }),
      }),
      communityRepository: {} as never,
    })

    expect(result).toBe("https://gateway.example/ipfs/preview")
    expect(syncedBundleIds).toEqual(["sab_payload"])
    expect(requests).toEqual([{
      url: "http://127.0.0.1:8795/preview",
      authorization: "Bearer shared-secret",
      body: {
        community_id: "com_test",
        song_artifact_bundle: "sab_payload",
        primary_audio_content_hash: "0xabc",
      },
    }])
  })

  test("falls back to subject id when the payload omits bundle id", async () => {
    const syncedBundleIds = captureCompletedPreviewPostSyncs()
    let requestBody: unknown = null
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = _input instanceof Request ? _input : new Request(_input, init)
      requestBody = JSON.parse(await request.text()) as unknown
      return Response.json({ storage_ref: "storage-ref" })
    }) as unknown as typeof fetch

    await runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE_URL: "http://localhost:8795/preview",
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
      } as Env,
      job: testJob(),
      communityRepository: {} as never,
    })

    expect(requestBody).toEqual({
      community_id: "com_test",
      song_artifact_bundle: "sab_subject",
      primary_audio_content_hash: null,
    })
    expect(syncedBundleIds).toEqual(["sab_subject"])
  })

  test("can use a Worker service binding instead of a public service URL", async () => {
    const syncedBundleIds = captureCompletedPreviewPostSyncs()
    const requests: Array<{
      url: string
      authorization: string | null
      body: unknown
    }> = []
    const serviceBinding = {
      fetch: async (request: Request): Promise<Response> => {
        requests.push({
          url: request.url,
          authorization: request.headers.get("authorization"),
          body: JSON.parse(await request.text()) as unknown,
        })
        return Response.json({ storage_ref: "service-binding-storage-ref" })
      },
    } as Fetcher

    const result = await runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE: serviceBinding,
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
      } as Env,
      job: testJob(),
      communityRepository: {} as never,
    })

    expect(result).toBe("service-binding-storage-ref")
    expect(syncedBundleIds).toEqual(["sab_subject"])
    expect(requests).toEqual([{
      url: "https://song-preview-service.internal/preview",
      authorization: "Bearer shared-secret",
      body: {
        community_id: "com_test",
        song_artifact_bundle: "sab_subject",
        primary_audio_content_hash: null,
      },
    }])
  })

  test("requires a shared secret before calling the song preview service", async () => {
    let called = false
    const updates = capturePreviewFailureUpdates()
    const serviceBinding = {
      fetch: async (_request: Request): Promise<Response> => {
        called = true
        return Response.json({ storage_ref: "should-not-run" })
      },
    } as Fetcher

    await expect(runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE: serviceBinding,
        CONTROL_PLANE_DATABASE_URL: "file::memory:",
      } as Env,
      job: testJob(),
      communityRepository: {} as never,
    })).rejects.toThrow("Song preview service shared secret is not configured")
    expect(called).toBe(false)
    expect(updates).toEqual([{
      communityId: "com_test",
      songArtifactBundleId: "sab_subject",
      previewAudio: null,
      previewStatus: "failed",
      previewError: "Song preview service shared secret is not configured",
    }])
  })

  test("propagates service failures so the runner can retry the job", async () => {
    const updates = capturePreviewFailureUpdates()
    globalThis.fetch = (async (): Promise<Response> => {
      return Response.json({ code: "preview_generation_failed" }, { status: 502 })
    }) as typeof globalThis.fetch
    const warnings: string[] = []
    const warnSpy = spyOn(console, "warn").mockImplementation((message) => {
      warnings.push(String(message))
    })

    await expect(runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE_URL: "https://preview.example/preview",
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
        CONTROL_PLANE_DATABASE_URL: "file::memory:",
      } as Env,
      job: testJob({
        payload_json: JSON.stringify({
          song_artifact_bundle: "sab_payload",
        }),
      }),
      communityRepository: {} as never,
    })).rejects.toThrow("Song preview service rejected the request")
    expect(updates).toEqual([{
      communityId: "com_test",
      songArtifactBundleId: "sab_payload",
      previewAudio: null,
      previewStatus: "failed",
      previewError: "Song preview service rejected the request (status=502 body={\"code\":\"preview_generation_failed\"})",
    }])
    expect(warnings).toHaveLength(1)
    expect(JSON.parse(warnings[0]!) as unknown).toMatchObject({
      community_id: "com_test",
      details: {
        body: "{\"code\":\"preview_generation_failed\"}",
        status: 502,
      },
      error: "Song preview service rejected the request",
      event: "song_preview.remote.failed",
      job_id: "cjb_test",
      service: "api",
      song_artifact_bundle: "sab_payload",
    })
    warnSpy.mockRestore()
  })
})
