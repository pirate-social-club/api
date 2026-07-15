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
    attempt_id: "cja_test",
    lease_expires_at: "2026-01-01T00:02:00.000Z",
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

  test("ends the job instead of retrying when the bundle fails hash verification", async () => {
    const updates = capturePreviewFailureUpdates()
    let previewRequests = 0
    globalThis.fetch = (async (): Promise<Response> => {
      previewRequests += 1
      return Response.json({
        code: "song_content_hash_mismatch",
        message: "Primary audio content hash does not match downloaded bytes",
      }, { status: 422 })
    }) as typeof globalThis.fetch
    const errors: string[] = []
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = spyOn(console, "error").mockImplementation((message) => {
      errors.push(String(message))
    })

    // Returning a "failed:" result (rather than throwing) is what stops the runner
    // from burning every remaining attempt on a fault that can never succeed.
    const result = await runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE_URL: "https://preview.example/preview",
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
        CONTROL_PLANE_DATABASE_URL: "file::memory:",
      } as Env,
      job: testJob({
        payload_json: JSON.stringify({ song_artifact_bundle: "sab_payload" }),
      }),
      communityRepository: {} as never,
    })

    expect(result).toBe("failed:song_content_hash_mismatch")
    expect(previewRequests).toBe(1)
    expect(updates).toHaveLength(1)
    expect(updates[0]!.previewStatus).toBe("failed")
    expect(updates[0]!.previewError).toContain("song_content_hash_mismatch")

    const mismatchEvents = errors
      .map((entry) => JSON.parse(entry) as { event?: string })
      .filter((entry) => entry.event === "song_preview.content_hash_mismatch")
    expect(mismatchEvents).toHaveLength(1)

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  test("raises an ops alert for the mismatch, not just a log line", async () => {
    capturePreviewFailureUpdates()
    const alertPayloads: unknown[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("https://ops.example/")) {
        alertPayloads.push(JSON.parse(String(init?.body ?? "{}")) as unknown)
        return Response.json({ ok: true })
      }
      return Response.json({
        code: "song_content_hash_mismatch",
        message: "Primary audio content hash does not match downloaded bytes",
      }, { status: 422 })
    }) as typeof globalThis.fetch
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})

    const result = await runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE_URL: "https://preview.example/preview",
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
        CONTROL_PLANE_DATABASE_URL: "file::memory:",
        OPS_ALERT_WEBHOOK_URL: "https://ops.example/hook",
      } as Env,
      job: testJob({ payload_json: JSON.stringify({ song_artifact_bundle: "sab_payload" }) }),
      communityRepository: {} as never,
    })

    expect(result).toBe("failed:song_content_hash_mismatch")
    // Without this the mismatch is "alertable" but nothing actually alerts on it.
    expect(alertPayloads).toHaveLength(1)
    const alert = JSON.stringify(alertPayloads[0])
    expect(alert).toContain("song_content_hash_mismatch")
    // An alert that omits which community and which bundle is not actionable.
    expect(alert).toContain("com_test")
    expect(alert).toContain("sab_payload")
    expect(alert).toContain("HIGH")

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  test("a failing alert sink does not turn a terminal mismatch into a retry", async () => {
    capturePreviewFailureUpdates()
    globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input instanceof Request ? input.url : input)
      if (url.startsWith("https://ops.example/")) throw new Error("alert sink down")
      return Response.json({ code: "song_content_hash_mismatch" }, { status: 422 })
    }) as typeof globalThis.fetch
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})

    const result = await runSongPreviewGenerate({
      env: {
        SONG_PREVIEW_SERVICE_URL: "https://preview.example/preview",
        SONG_PREVIEW_SHARED_SECRET: "shared-secret",
        CONTROL_PLANE_DATABASE_URL: "file::memory:",
        OPS_ALERT_WEBHOOK_URL: "https://ops.example/hook",
      } as Env,
      job: testJob({ payload_json: JSON.stringify({ song_artifact_bundle: "sab_payload" }) }),
      communityRepository: {} as never,
    })

    expect(result).toBe("failed:song_content_hash_mismatch")

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })
})
