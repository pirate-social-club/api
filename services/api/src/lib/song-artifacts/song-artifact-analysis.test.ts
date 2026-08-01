import { afterEach, describe, expect, test } from "bun:test"
import { HttpError } from "../errors"
import { mockFetch } from "../../test-helpers/fetch"
import { analyzeSongBundle, evaluateLyricsModeration } from "./song-artifact-analysis"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const primaryAudioUpload = {
  id: "sau_primary",
  filename: "song.mp3",
  mime_type: "audio/mpeg",
  size_bytes: 3,
  storage_object_key: "songs/song.mp3",
} as never

function acrConfiguredEnv() {
  return {
    ACRCLOUD_ACCESS_KEY: "acr-key",
    ACRCLOUD_ACCESS_SECRET: "acr-secret",
    ACRCLOUD_HOST: "acrcloud.test",
    FILEBASE_S3_ACCESS_KEY: "filebase-key",
    FILEBASE_S3_SECRET_KEY: "filebase-secret",
    FILEBASE_MEDIA_BUCKET: "media-bucket",
    // Force the local-ffmpeg branch off in tests; with no extraction service
    // configured either, identification falls back to the full stored file.
    SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__",
  }
}

type AcrResponder = (attempt: number) => Response | Promise<Response>

function stubFetch(acrResponder: AcrResponder) {
  let acrCalls = 0
  const calls = { acr: () => acrCalls }
  globalThis.fetch = mockFetch(async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input)
    if (url.includes("acrcloud.test")) {
      acrCalls += 1
      return acrResponder(acrCalls)
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "audio/mpeg" },
    })
  })
  return calls
}

function acrJson(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
}

function audioIdentificationOf(result: { moderationResult?: Record<string, unknown> | null }) {
  return result.moderationResult?.audio_identification as {
    match_found?: boolean
    provider_result?: Record<string, unknown> | null
  } | undefined
}

async function expectProviderUnavailable(
  promise: Promise<unknown>,
  assert: (error: HttpError) => void,
) {
  await promise.then(
    () => {
      throw new Error("expected analyzeSongBundle to reject with provider_unavailable")
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(HttpError)
      expect((error as HttpError).code).toBe("provider_unavailable")
      assert(error as HttpError)
    },
  )
}

describe("song artifact analysis", () => {
  test("marks ACR identification as skipped when staging bypass is requested", async () => {
    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: {},
      lyrics: "",
      primaryAudioUpload: {
        id: "sau_instrumental",
        filename: "instrumental.mp3",
        mime_type: "audio/mpeg",
        size_bytes: 8,
        storage_object_key: "songs/instrumental.mp3",
      } as never,
      skipAcrIdentification: true,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationResult?.audio_identification).toEqual({
      provider: "acrcloud",
      skipped: true,
      acr_skipped_reason: "staging_bypass",
    })
    expect(result.alignmentStatus).toBe("completed")
    expect(result.timedLyrics).toBeNull()
    expect(result.moderationResult?.lyrics).toEqual({
      provider: "openrouter",
      skipped: true,
      skip_reason: "empty_lyrics",
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
    })
  })

  test("allows publication when ACR is not configured", async () => {
    const calls = stubFetch(() => acrJson({ status: { code: 0 } }))
    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: { SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__" },
      lyrics: "",
      primaryAudioUpload,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationStatus).toBe("failed")
    expect(result.moderationError).toBe("missing_configuration")
    expect(calls.acr()).toBe(0)
  })

  test("ACR no-result completes with no match", async () => {
    stubFetch(() => acrJson({ status: { msg: "No result", code: 1001, version: "1.0" } }))
    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationStatus).toBe("completed")
    expect(result.moderationError).toBeNull()
    expect(audioIdentificationOf(result)?.match_found).toBe(false)
  })
})

describe("song lyrics moderation provider failure semantics", () => {
  test("reserves enough completion budget for a strict classifier response", async () => {
    let maxCompletionTokens: unknown = null
    globalThis.fetch = mockFetch(async (_input, init) => {
      const requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      maxCompletionTokens = requestBody.max_completion_tokens
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ age_gate_rating: "safe", reason: "No mature content." }) } }],
      }), { headers: { "content-type": "application/json" } })
    })

    const result = await evaluateLyricsModeration({
      env: { OPENROUTER_API_KEY: "test-key" },
      lyrics: "ordinary song lyrics",
    })

    expect(maxCompletionTokens).toBe(500)
    expect(result.moderationStatus).toBe("completed")
    expect(result.contentSafetyState).toBe("safe")
    expect(result.ageGatePolicy).toBe("none")
  })

  test("treats a truncated classifier response as retryable provider unavailability", async () => {
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"age_gate_rating":"adult"' } }],
    }), { headers: { "content-type": "application/json" } }))

    await expectProviderUnavailable(
      evaluateLyricsModeration({
        env: { OPENROUTER_API_KEY: "test-key" },
        lyrics: "lyrics requiring a classifier verdict",
      }),
      (error) => {
        expect(error.retryable).toBe(true)
        expect(error.details?.reason).toBe("song_lyrics_classification_failed")
      },
    )
  })

  test("stops bundle analysis when lyrics classification has no verdict", async () => {
    globalThis.fetch = mockFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "" } }],
    }), { headers: { "content-type": "application/json" } }))

    await expectProviderUnavailable(
      analyzeSongBundle({
        communityId: "com_test",
        env: { OPENROUTER_API_KEY: "test-key" },
        lyrics: "lyrics requiring a classifier verdict",
        primaryAudioUpload,
        skipAcrIdentification: true,
      }),
      (error) => {
        expect(error.retryable).toBe(true)
        expect(error.details?.provider_error).toBe("invalid_response")
      },
    )
  })

  test("does not publish non-empty lyrics when the classifier is unconfigured", async () => {
    await expectProviderUnavailable(
      evaluateLyricsModeration({
        env: {},
        lyrics: "lyrics requiring a classifier verdict",
      }),
      (error) => {
        expect(error.retryable).toBe(true)
        expect(error.details?.provider_error).toBe("missing_configuration")
      },
    )
  })
})

describe("song artifact ACR provider failure semantics", () => {
  test("transport abort raises retryable provider unavailability, not review_required", async () => {
    const calls = stubFetch(() => {
      throw new DOMException("The operation was aborted", "AbortError")
    })

    await expectProviderUnavailable(
      analyzeSongBundle({
        communityId: "com_test",
        env: acrConfiguredEnv(),
        lyrics: "",
        primaryAudioUpload,
      }),
      (error) => {
        expect(error.retryable).toBe(true)
      },
    )
    // The identify call is retried in-process before giving up.
    expect(calls.acr()).toBe(2)
  })

  test("a transient failure recovers on the in-process retry", async () => {
    const calls = stubFetch((attempt) => {
      if (attempt === 1) {
        throw new DOMException("The operation was aborted", "AbortError")
      }
      return acrJson({ status: { msg: "No result", code: 1001, version: "1.0" } })
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationStatus).toBe("completed")
    expect(calls.acr()).toBe(2)
  })

  test("ACR file-too-large status is a provider failure, not a silent pass", async () => {
    stubFetch(() => acrJson({
      status: { msg: "the file you upload is too large", code: 3016 },
    }))

    await expectProviderUnavailable(
      analyzeSongBundle({
        communityId: "com_test",
        env: acrConfiguredEnv(),
        lyrics: "",
        primaryAudioUpload,
      }),
      (error) => {
        expect(error.details?.provider_error).toBe("acr_status_3016")
      },
    )
  })

  test("ACR http failure raises provider unavailability", async () => {
    stubFetch(() => new Response("upstream broke", { status: 502 }))

    await expectProviderUnavailable(
      analyzeSongBundle({
        communityId: "com_test",
        env: acrConfiguredEnv(),
        lyrics: "",
        primaryAudioUpload,
      }),
      (error) => {
        expect(error.details?.provider_error).toBe("http_502")
      },
    )
  })

  test("ACR cannot-fingerprint status stays a definitive no-match", async () => {
    stubFetch(() => acrJson({ status: { msg: "Can't generate fingerprint", code: 2004 } }))

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationStatus).toBe("completed")
    expect(audioIdentificationOf(result)?.match_found).toBe(false)
  })
})

describe("song artifact ACR sample extraction", () => {
  function extractionEnv() {
    return {
      ...acrConfiguredEnv(),
      SONG_PREVIEW_SERVICE_URL: "http://localhost:9999",
      SONG_PREVIEW_SHARED_SECRET: "preview-secret",
    }
  }

  test("identifies from the extracted window instead of the full file", async () => {
    const sampleBytes = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])
    let identifiedSampleBytes: string | null = null
    let fullFileFetches = 0
    globalThis.fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      if (request.url.includes("/extract-audio-sample")) {
        return new Response(JSON.stringify({
          kind: "sample",
          sample_base64: btoa(String.fromCharCode(...sampleBytes)),
        }), { headers: { "content-type": "application/json" } })
      }
      if (request.url.includes("acrcloud.test")) {
        const form = await request.formData()
        identifiedSampleBytes = String(form.get("sample_bytes"))
        return acrJson({ status: { msg: "No result", code: 1001 } })
      }
      fullFileFetches += 1
      return new Response(new Uint8Array([1, 2, 3]))
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: extractionEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(result.analysisState).toBe("allow")
    expect(identifiedSampleBytes).toBe(String(sampleBytes.byteLength))
    expect(fullFileFetches).toBe(0)
  })

  test("falls back to the full file when extraction fails", async () => {
    let acrSampleBytes: string | null = null
    globalThis.fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      if (request.url.includes("/extract-audio-sample")) {
        return new Response("extraction exploded", { status: 500 })
      }
      if (request.url.includes("acrcloud.test")) {
        const form = await request.formData()
        acrSampleBytes = String(form.get("sample_bytes"))
        return acrJson({ status: { msg: "No result", code: 1001 } })
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "audio/mpeg" },
      })
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: extractionEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(result.analysisState).toBe("allow")
    expect(result.moderationStatus).toBe("completed")
    expect(acrSampleBytes).toBe("3")
  })
})

describe("song artifact ACR custom-bucket match semantics", () => {
  function stubFetchForAcrMetadata(metadata: Record<string, unknown>) {
    stubFetch(() => acrJson({ metadata }))
  }

  test("untagged custom bucket match still counts as a catalog match", async () => {
    stubFetchForAcrMetadata({
      custom_files: [
        { acr_id: "acr_1", user_defined: { source: "pirate", song_artifact_bundle_id: "sab_1" } },
      ],
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(audioIdentificationOf(result)?.match_found).toBe(true)
    expect(result.analysisState).toBe("allow_with_required_reference")
  })

  test("video-audio custom bucket matches do not count as a catalog match", async () => {
    stubFetchForAcrMetadata({
      custom_files: [
        // Nested and flattened user_defined shapes are both tolerated.
        { acr_id: "acr_vid_nested", user_defined: { content_type: "video_audio" } },
        { acr_id: "acr_vid_flat", content_type: "video_audio" },
      ],
    })

    const result = await analyzeSongBundle({
      communityId: "com_test",
      env: acrConfiguredEnv(),
      lyrics: "",
      primaryAudioUpload,
    })

    expect(audioIdentificationOf(result)?.match_found).toBe(false)
    expect(result.analysisState).toBe("allow")
  })
})
