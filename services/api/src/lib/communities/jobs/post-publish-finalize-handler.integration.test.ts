import { beforeEach, describe, expect, mock, test } from "bun:test"

import { providerUnavailable } from "../../errors"
import type { Post, SongArtifactBundle } from "../../../types"

const COMMUNITY_ID = "cmty_async"
const POST_ID = "post_async_song"
const ASSET_ID = "asset_async_song"

type State = {
  assetCalls: number
  bundle: SongArtifactBundle
  consumed: number
  listingDraft: Record<string, unknown> | null
  markedFailed: Array<{ failureCode: string; retryable: boolean }>
  markedPublished: number
  post: Post
  primaryUploadAvailable: boolean
  projectionPayloads: string[]
  projectionStatuses: string[]
  requestStatuses: string[]
  throwAssetError: boolean
  throwCatalogError: boolean
  throwListingError: boolean
}

function basePost(overrides: Partial<Post> = {}): Post {
  return {
    access_mode: "public",
    age_gate_policy: "none",
    analysis_state: "allow",
    anonymous_label: null,
    anonymous_scope: null,
    asset_id: ASSET_ID,
    author_user_id: "usr_artist",
    authorship_mode: "human_direct",
    body: null,
    caption: null,
    comments_locked: false,
    community_id: COMMUNITY_ID,
    content_safety_state: "safe",
    created_at: "2026-07-05T00:00:00.000Z",
    idempotency_key: "idem",
    identity_mode: "public",
    lyrics: "lyrics",
    media_refs: [],
    post_id: POST_ID,
    post_type: "song",
    rights_basis: "original",
    song_artifact_bundle_id: "bundle_1",
    song_mode: "original",
    status: "processing",
    title: "Async song",
    updated_at: "2026-07-05T00:00:00.000Z",
    upstream_asset_refs: [],
    visibility: "public",
    ...overrides,
  } as Post
}

function readyBundle(overrides: Partial<SongArtifactBundle> = {}): SongArtifactBundle {
  return {
    id: "sab_bundle_1",
    lyrics: "lyrics",
    moderation_result: {
      age_gate_policy: "none",
      analysis_state: "allow",
      content_safety_state: "safe",
    },
    preview_status: "completed",
    preview_window: null,
    primary_audio: {
      content_hash: "0xabc",
      duration_ms: 30_000,
      mime_type: "audio/wav",
      size_bytes: 1234,
      storage_ref: "r2://song.wav",
    },
    status: "ready",
    ...overrides,
  } as SongArtifactBundle
}

const state: State = {
  assetCalls: 0,
  bundle: readyBundle(),
  consumed: 0,
  listingDraft: null,
  markedFailed: [],
  markedPublished: 0,
  post: basePost(),
  primaryUploadAvailable: true,
  projectionPayloads: [],
  projectionStatuses: [],
  requestStatuses: [],
  throwAssetError: false,
  throwCatalogError: false,
  throwListingError: false,
}

const client = {
  execute: mock(async () => ({ rows: [] })),
}

mock.module("../community-read-access", () => ({
  openCommunityWriteClient: mock(async () => ({
    client,
    close: mock(() => {}),
  })),
}))

mock.module("../../posts/community-post-query-store", () => ({
  getPostById: mock(async () => state.post),
}))

mock.module("../../posts/community-post-mutation-store", () => ({
  assignPostAssetIdIfMissing: mock(async () => state.post),
  markPostPublished: mock(async (input: { analysisState: Post["analysis_state"]; contentSafetyState: Post["content_safety_state"]; ageGatePolicy: Post["age_gate_policy"] }) => {
    state.markedPublished += 1
    state.post = {
      ...state.post,
      age_gate_policy: input.ageGatePolicy,
      analysis_state: input.analysisState,
      content_safety_state: input.contentSafetyState,
      status: "published",
    }
    return state.post
  }),
  markPostPublishFailed: mock(async (input: { failureCode: string; retryable: boolean }) => {
    state.markedFailed.push({
      failureCode: input.failureCode,
      retryable: input.retryable,
    })
    state.post = {
      ...state.post,
      publish_failure_code: input.failureCode as never,
      publish_failure_retryable: input.retryable,
      status: "failed",
    }
    return state.post
  }),
}))

mock.module("../../posts/community-post-publish-request-store", () => ({
  getPostPublishRequest: mock(async () => ({
    listing_draft_json: state.listingDraft ? JSON.stringify(state.listingDraft) : null,
    publish_options_json: "{}",
  })),
  markPostPublishRequestStatus: mock(async (input: { status: string }) => {
    state.requestStatuses.push(input.status)
  }),
}))

mock.module("../../runtime-deps", () => ({
  getControlPlaneClient: mock(() => ({})),
}))

mock.module("../../song-artifacts/song-artifact-analysis", () => ({
  analyzeSongBundle: mock(async () => {
    throw new Error("analysis should not run for ready bundle")
  }),
}))

mock.module("../../song-artifacts/song-artifact-post-resolution-service", () => ({
  consumeSongPostBundle: mock(async () => {
    state.consumed += 1
    if (state.throwCatalogError) {
      throw new Error("catalog sync unavailable")
    }
  }),
}))

mock.module("../../song-artifacts/song-artifact-repository", () => ({
  finalizeSongArtifactBundle: mock(async () => readyBundle()),
  findUploadedSongArtifactByStorageRef: mock(async () => state.primaryUploadAvailable ? { id: "sau_1" } : null),
  getSongArtifactBundle: mock(async () => state.bundle),
}))

mock.module("../commerce/listing-service", () => ({
  createCommunityListingInTransaction: mock(async () => {
    if (state.throwListingError) {
      throw new Error("listing failed")
    }
    return {}
  }),
}))

mock.module("../commerce/shared", () => ({
  getListingRowByAssetId: mock(async () => null),
}))

mock.module("../commerce/service", () => ({
  createSongAssetForPost: mock(async () => {
    state.assetCalls += 1
    if (state.throwAssetError) {
      throw providerUnavailable(
        "Story registration is temporarily unavailable, so this asset was not published. Please try again in a few minutes.",
        {
          reason: "story_royalty_registration_failed",
          story_error_class: "transient",
        },
        true,
      )
    }
    return {
      asset_id: ASSET_ID,
      locked_delivery_status: "none",
    }
  }),
}))

mock.module("../../auth/repositories", () => ({
  getUserRepository: mock(() => ({})),
}))

mock.module("./store", () => ({
  enqueueCommunityJob: mock(async () => ({})),
}))

const { runPostPublishFinalize } = await import("./post-publish-finalize-handler")

function handlerInput() {
  return {
    communityRepository: {
      updateCommunityPostProjectionPayload: mock(async (input: { projectedPayloadJson: string }) => {
        state.projectionPayloads.push(input.projectedPayloadJson)
      }),
      updateCommunityPostProjectionStatus: mock(async (input: { status: string }) => {
        state.projectionStatuses.push(input.status)
      }),
    },
    env: {},
    job: {
      community_id: COMMUNITY_ID,
      payload_json: JSON.stringify({ post_id: POST_ID }),
      subject_id: POST_ID,
    },
  } as never
}

beforeEach(() => {
  state.assetCalls = 0
  state.bundle = readyBundle()
  state.consumed = 0
  state.listingDraft = null
  state.markedFailed = []
  state.markedPublished = 0
  state.post = basePost()
  state.primaryUploadAvailable = true
  state.projectionPayloads = []
  state.projectionStatuses = []
  state.requestStatuses = []
  state.throwAssetError = false
  state.throwCatalogError = false
  state.throwListingError = false
})

async function expectFinalizeFailure(expected: {
  assetCalls?: number
  code: string
  consumed?: number
  retryable: boolean
}) {
  await expect(runPostPublishFinalize(handlerInput())).resolves.toBe(`failed:post_publish_finalize:${POST_ID}`)
  expect(state.markedFailed).toEqual([{ failureCode: expected.code, retryable: expected.retryable }])
  expect(state.markedPublished).toBe(0)
  expect(state.assetCalls).toBe(expected.assetCalls ?? 0)
  expect(state.consumed).toBe(expected.consumed ?? 0)
  expect(state.projectionStatuses).toEqual(["failed"])
}

describe("runPostPublishFinalize integration", () => {
  test("publishes a processing song post after asset finalize succeeds", async () => {
    await expect(runPostPublishFinalize(handlerInput())).resolves.toBe(POST_ID)

    expect(state.assetCalls).toBe(1)
    expect(state.consumed).toBe(1)
    expect(state.markedFailed).toEqual([])
    expect(state.markedPublished).toBe(1)
    expect(state.requestStatuses).toEqual(["running", "succeeded"])
    expect(state.projectionStatuses).toEqual(["published"])
    expect(JSON.parse(state.projectionPayloads[0] ?? "{}")).toMatchObject({
      post_id: POST_ID,
      status: "published",
    })
  })

  test("does not silently publish repeated failed Story registration retries", async () => {
    state.throwAssetError = true

    await expect(runPostPublishFinalize(handlerInput())).resolves.toBe(`failed:post_publish_finalize:${POST_ID}`)
    state.post = basePost({ status: "processing" })
    await expect(runPostPublishFinalize(handlerInput())).resolves.toBe(`failed:post_publish_finalize:${POST_ID}`)

    expect(state.assetCalls).toBe(2)
    expect(state.consumed).toBe(0)
    expect(state.markedPublished).toBe(0)
    expect(state.markedFailed).toEqual([
      { failureCode: "story_royalty_registration_failed", retryable: true },
      { failureCode: "story_royalty_registration_failed", retryable: true },
    ])
    expect(state.projectionStatuses).toEqual(["failed", "failed"])
  })

  test("fails terminal request-time text moderation before asset creation", async () => {
    state.post = basePost({ analysis_state: "review_required" })

    await expectFinalizeFailure({
      code: "text_moderation_blocked",
      retryable: false,
    })
  })

  test.each([
    ["blocked bundle analysis", "blocked", "song_analysis_blocked"],
    ["review-required bundle analysis", "review_required", "song_analysis_review_required"],
    ["required derivative reference", "allow_with_required_reference", "song_rights_reference_required"],
  ] as const)("%s fails terminally before asset creation", async (_label, analysisState, failureCode) => {
    state.bundle = readyBundle({
      moderation_result: {
        age_gate_policy: "none",
        analysis_state: analysisState,
        content_safety_state: "safe",
      },
    })

    await expectFinalizeFailure({
      code: failureCode,
      retryable: false,
    })
  })

  test("fails retryably when deferred analysis cannot find the uploaded primary audio", async () => {
    state.bundle = readyBundle({ status: "validating" })
    state.primaryUploadAvailable = false

    await expectFinalizeFailure({
      code: "provider_unavailable",
      retryable: true,
    })
  })

  test("fails terminally when server-side listing creation fails after asset creation", async () => {
    state.listingDraft = {
      price_cents: 499,
      regional_pricing_enabled: false,
      status: "active",
    }
    state.throwListingError = true

    await expectFinalizeFailure({
      assetCalls: 1,
      code: "listing_creation_failed",
      retryable: false,
    })
  })

  test("fails retryably when catalog sync fails after asset creation", async () => {
    state.throwCatalogError = true

    await expectFinalizeFailure({
      assetCalls: 1,
      code: "catalog_sync_failed",
      consumed: 1,
      retryable: true,
    })
  })
})
