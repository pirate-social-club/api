import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import type { Env } from "../../../src/types"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"
import { setCommunityCommerceBuyerFundingVerifierForTests } from "../../../src/lib/communities/commerce/funding-proof-service"
import { badRequestError } from "../../../src/lib/errors"
import { setStoryCdrUploaderForTests } from "../../../src/lib/story/story-cdr"
import { setStoryRuntimeFundingAssertionForTests } from "../../../src/lib/story/story-runtime-funding"
import { setStoryAccessProofSignerForTests } from "../../../src/lib/story/story-access-proof-service"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

const routedCheckoutQuoteFields = {
  funding_asset: {
    asset_symbol: "USDC",
    chain_namespace: "eip155",
    chain_id: 84532,
    display_name: "USDC on Base Sepolia",
  },
  source_chain: {
    chain_namespace: "eip155",
    chain_id: 84532,
    display_name: "Base Sepolia",
  },
  route_provider: "pirate_checkout",
  client_estimated_slippage_bps: 0,
  client_estimated_hop_count: 1,
}

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
  setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
    txRef: input.fundingTxRef,
    fromAddress: input.buyerAddress,
    toAddress: input.quote.funding_destination_address ?? "0x5000000000000000000000000000000000000005",
    tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    amountAtomic: String(BigInt(Math.round(input.quote.final_price_usd * 1_000_000))),
    chainRef: "eip155:84532",
  }))
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  setCommunityCommerceBuyerFundingVerifierForTests(null)
  setStoryCdrUploaderForTests(null)
  setStoryRuntimeFundingAssertionForTests(null)
  setStoryAccessProofSignerForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function makeSilentWavBytes(durationSeconds = 1): Uint8Array {
  const sampleRate = 8000
  const channelCount = 1
  const bytesPerSample = 2
  const sampleCount = sampleRate * durationSeconds
  const dataSize = sampleCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index))
    }
  }

  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)

  return new Uint8Array(buffer)
}

function installSongArtifactProviderStubs(): void {
  const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()

  ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    if (request.url === "https://openrouter.test/api/v1/chat/completions") {
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              age_gate_rating: "safe",
              reason: "clean lyrics",
            }),
          },
        }],
      })
    }

    if (request.url === "https://acrcloud.test/v1/identify") {
      return Response.json({
        status: { code: 0, msg: "Success" },
        metadata: { music: [] },
      })
    }

    if (request.url === "https://console-v2.acrcloud.test/api/buckets/30358/files") {
      return Response.json({
        data: {
          id: 52,
          acr_id: "acr_live_room_song",
          state: 0,
        },
      })
    }

    if (request.url === "https://elevenlabs.test/forced-alignment") {
      return Response.json({
        provider: "elevenlabs",
        segments: [{
          start_ms: 0,
          end_ms: 900,
          text: "Live line",
        }],
      })
    }

    if (request.url.startsWith("http://pirate.test/")) {
      return await originalFetch(request)
    }

    if (!request.url.startsWith("https://s3.filebase.test/")) {
      return new Response(`unstubbed external call: ${request.url}`, { status: 500 })
    }

    if (request.method === "PUT") {
      storedObjects.set(request.url, {
        body: new Uint8Array(await request.arrayBuffer()),
        contentType: request.headers.get("content-type") || "application/octet-stream",
      })
      return new Response(null, {
        status: 200,
        headers: { "x-amz-meta-cid": "bafyliveroomsongartifactcid" },
      })
    }

    if (request.method === "GET") {
      const stored = storedObjects.get(request.url)
      if (!stored) {
        return new Response("missing", { status: 404 })
      }
      return new Response(stored.body.slice().buffer, {
        status: 200,
        headers: {
          "content-type": stored.contentType,
          "content-length": String(stored.body.byteLength),
        },
      })
    }

    return new Response("unexpected method", { status: 500 })
  }
}

async function createSongArtifactBundleForLiveRoom(input: {
  env: Env
  accessToken: string
  communityId: string
}): Promise<{ id: string; title: string }> {
  const audioBytes = makeSilentWavBytes()
  const uploadIntent = await requestJson(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads`,
    {
      artifact_kind: "primary_audio",
      mime_type: "audio/wav",
      filename: "live-room-song.wav",
      size_bytes: audioBytes.byteLength,
    },
    input.env,
    input.accessToken,
  )
  expect(uploadIntent.status).toBe(201)
  const uploadIntentBody = await json(uploadIntent) as { id: string }

  const uploadContent = await app.request(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/octet-stream",
      },
      body: Buffer.from(audioBytes),
    },
    input.env,
  )
  expect(uploadContent.status).toBe(200)

  const bundleCreate = await requestJson(
    `http://pirate.test/communities/${input.communityId}/song-artifacts`,
    {
      primary_audio: {
        song_artifact_upload: uploadIntentBody.id,
      },
      title: "Live Room Song",
      lyrics: "Live line",
    },
    input.env,
    input.accessToken,
  )
  expect(bundleCreate.status).toBe(201)
  return await json(bundleCreate) as { id: string; title: string }
}

async function createTestCommunity(input: {
  env: Env
  accessToken: string
}): Promise<string> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: "Live Room Test Community",
    membership_mode: "request",
    handle_policy: { policy_template: "standard" },
  }, input.env, input.accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { id: string } }
  return body.community.id.replace(/^com_/, "")
}

async function insertTestWalletAttachment(input: {
  client: Awaited<ReturnType<typeof createRouteTestContext>>["client"]
  userId: string
  walletAttachmentId: string
  walletAddress?: string
}): Promise<void> {
  const now = new Date().toISOString()
  const address = input.walletAddress ?? "0x7000000000000000000000000000000000000007"
  await input.client.execute({
    sql: `
      INSERT INTO wallet_attachments (
        wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
        source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, 'eip155', ?3, ?4,
        'test', ?5, 'external', 0, 'active', ?6, NULL, ?6, ?6
      )
    `,
    args: [
      input.walletAttachmentId,
      input.userId,
      address.toLowerCase(),
      address,
      `test|${input.userId}|${input.walletAttachmentId}`,
      now,
    ],
  })
}

function readySoloRoomBody() {
  return {
    title: "Friday Set",
    room_kind: "solo",
    access_mode: "free",
    visibility: "public",
    performer_allocations: [
      { role: "host", user: "", share_bps: 10000 },
    ],
    setlist: {
      status: "ready",
      items: [
        {
          song_artifact_bundle: undefined as string | undefined,
          source_asset_ref: undefined as string | undefined,
          title: "Opening Song",
          artist: "Pirate Band",
          rights_basis: "original",
          rights_status: "ready",
        },
      ],
    },
  }
}

async function postLiveRoom(input: {
  env: Env
  accessToken: string
  communityId: string
  body: Record<string, unknown>
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/live-rooms`,
    input.body,
    input.env,
    input.accessToken,
  )
}

async function postPublishLiveRoom(input: {
  env: Env
  accessToken: string
  communityId: string
  body: Record<string, unknown>
}): Promise<Response> {
  return requestJson(
    `http://pirate.test/communities/${input.communityId}/live-rooms/publish`,
    input.body,
    input.env,
    input.accessToken,
  )
}

async function readAtomicPublishRowCounts(input: {
  communityDbRoot: string
  communityId: string
}): Promise<{ liveRooms: number; posts: number; listings: number }> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT
          (SELECT COUNT(*) FROM live_rooms) AS live_rooms,
          (SELECT COUNT(*) FROM posts) AS posts,
          (SELECT COUNT(*) FROM listings) AS listings
      `,
      args: [],
    })
    const row = result.rows[0] ?? {}
    return {
      liveRooms: Number(row.live_rooms ?? 0),
      posts: Number(row.posts ?? 0),
      listings: Number(row.listings ?? 0),
    }
  } finally {
    client.close()
  }
}

async function countLiveRoomViewerSessions(input: {
  communityDbRoot: string
  communityId: string
  liveRoomId: string
}): Promise<number> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM live_room_viewer_sessions
        WHERE community_id = ?1
          AND live_room_id = ?2
      `,
      args: [input.communityId, input.liveRoomId],
    })
    return Number(result.rows[0]?.count ?? 0)
  } finally {
    client.close()
  }
}

async function readLiveRoomRecordingRows(input: {
  communityDbRoot: string
  communityId: string
  liveRoomId: string
}): Promise<Array<{
  status: string
  provider: string
  provider_resource_id: string | null
  provider_session_id: string | null
  stopped_at: number | null
  raw_artifact_ref: string | null
  failure_reason: string | null
}>> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT status, provider, provider_resource_id, provider_session_id, stopped_at, raw_artifact_ref, failure_reason
        FROM live_room_recordings
        WHERE community_id = ?1
          AND live_room_id = ?2
        ORDER BY created_at ASC
      `,
      args: [input.communityId, input.liveRoomId],
    })
    return result.rows.map((row) => ({
      status: String(row.status),
      provider: String(row.provider),
      provider_resource_id: row.provider_resource_id == null ? null : String(row.provider_resource_id),
      provider_session_id: row.provider_session_id == null ? null : String(row.provider_session_id),
      stopped_at: row.stopped_at == null ? null : Number(row.stopped_at),
      raw_artifact_ref: row.raw_artifact_ref == null ? null : String(row.raw_artifact_ref),
      failure_reason: row.failure_reason == null ? null : String(row.failure_reason),
    }))
  } finally {
    client.close()
  }
}

async function readLiveRoomReplayAssetRows(input: {
  communityDbRoot: string
  communityId: string
  liveRoomId: string
}): Promise<Array<{
  replay_asset_id: string
  publication_status: string
  access_mode: string
  locked_delivery_status: string
  locked_delivery_storage_ref: string | null
  locked_delivery_secret_json: string | null
  story_cdr_vault_uuid: string | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_error: string | null
}>> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT replay_asset_id, publication_status, access_mode, locked_delivery_status,
               locked_delivery_storage_ref, locked_delivery_secret_json,
               story_cdr_vault_uuid, story_namespace, story_entitlement_token_id,
               story_read_condition, story_write_condition, locked_delivery_error
        FROM live_room_replay_assets
        WHERE community_id = ?1
          AND live_room_id = ?2
        ORDER BY created_at ASC
      `,
      args: [input.communityId, input.liveRoomId],
    })
    return result.rows.map((row) => ({
      replay_asset_id: String(row.replay_asset_id),
      publication_status: String(row.publication_status),
      access_mode: String(row.access_mode),
      locked_delivery_status: String(row.locked_delivery_status),
      locked_delivery_storage_ref: row.locked_delivery_storage_ref == null ? null : String(row.locked_delivery_storage_ref),
      locked_delivery_secret_json: row.locked_delivery_secret_json == null ? null : String(row.locked_delivery_secret_json),
      story_cdr_vault_uuid: row.story_cdr_vault_uuid == null ? null : String(row.story_cdr_vault_uuid),
      story_namespace: row.story_namespace == null ? null : String(row.story_namespace),
      story_entitlement_token_id: row.story_entitlement_token_id == null ? null : String(row.story_entitlement_token_id),
      story_read_condition: row.story_read_condition == null ? null : String(row.story_read_condition),
      story_write_condition: row.story_write_condition == null ? null : String(row.story_write_condition),
      locked_delivery_error: row.locked_delivery_error == null ? null : String(row.locked_delivery_error),
    }))
  } finally {
    client.close()
  }
}

async function readLiveRoomCommerceRow(input: {
  communityDbRoot: string
  communityId: string
  liveRoomId: string
}): Promise<{
  replay_listing_id: string | null
}> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const result = await client.execute({
      sql: `
        SELECT replay_listing_id
        FROM live_rooms
        WHERE community_id = ?1
          AND live_room_id = ?2
        LIMIT 1
      `,
      args: [input.communityId, input.liveRoomId],
    })
    const row = result.rows[0]
    return {
      replay_listing_id: row?.replay_listing_id == null ? null : String(row.replay_listing_id),
    }
  } finally {
    client.close()
  }
}

async function setLiveRoomRecordingEnabledRaw(input: {
  communityDbRoot: string
  communityId: string
  liveRoomId: string
  recordingEnabled: 0 | 1 | null
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    await client.execute({
      sql: `
        UPDATE live_rooms
        SET recording_enabled = ?3
        WHERE community_id = ?1
          AND live_room_id = ?2
      `,
      args: [input.communityId, input.liveRoomId, input.recordingEnabled],
    })
  } finally {
    client.close()
  }
}

async function insertSyntheticLiveRoomViewerSession(input: {
  communityDbRoot: string
  communityId: string
  liveRoomId: string
  viewerUserId: string
  agoraUid: number
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })
  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO live_room_viewer_sessions (
          community_id, live_room_id, viewer_user_id, agora_uid, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?5
        )
      `,
      args: [input.communityId, input.liveRoomId, input.viewerUserId, input.agoraUid, now],
    })
  } finally {
    client.close()
  }
}

async function createDeviceAccessToken(input: {
  env: Env
  authorizingAccessToken: string
  scope: string
}): Promise<string> {
  const authorize = await requestJson("http://pirate.test/oauth/device_authorize", {
    client_id: "freedom-desktop",
    scope: input.scope,
  }, input.env)
  expect(authorize.status).toBe(200)
  const authorizeBody = await json(authorize) as { device_code: string; user_code: string }

  const verify = await requestJson("http://pirate.test/oauth/device/verify", {
    user_code: authorizeBody.user_code,
  }, input.env, input.authorizingAccessToken)
  expect(verify.status).toBe(200)

  const token = await requestJson("http://pirate.test/oauth/device/token", {
    client_id: "freedom-desktop",
    device_code: authorizeBody.device_code,
  }, input.env)
  expect(token.status).toBe(200)
  const tokenBody = await json(token) as { access_token: string }
  return tokenBody.access_token
}

describe("community live-room routes", () => {
  test("owner creates a ready live room with setlist and allocations", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`
    body.setlist.items[0]!.song_artifact_bundle = "sab_sab_livebundle"

    const response = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(response.status).toBe(201)
    const room = await json(response) as {
      id: string
      object: string
      status: string
      anchor_post: string
      host_user: string
      recording_enabled: boolean
      performer_allocations: Array<{ user: string; share_bps: number }>
      setlist: { status: string; items: Array<{ title: string; rights_basis: string; song_artifact_bundle: string | null }> }
    }
    expect(room.id.startsWith("lr_")).toBe(true)
    expect(room.object).toBe("live_room")
    expect(room.status).toBe("scheduled")
    expect(room.recording_enabled).toBe(false)
    expect(room.anchor_post.startsWith("pst_")).toBe(true)
    expect(room.host_user).toBe(`usr_${owner.userId}`)
    expect(room.performer_allocations[0]?.user).toBe(`usr_${owner.userId}`)
    expect(room.performer_allocations[0]?.share_bps).toBe(10000)
    expect(room.setlist.status).toBe("ready")
    expect(room.setlist.items[0]?.title).toBe("Opening Song")
    expect(room.setlist.items[0]?.rights_basis).toBe("original")
    expect(room.setlist.items[0]?.song_artifact_bundle).toBe("sab_sab_livebundle")

    const readResponse = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(readResponse.status).toBe(200)
    const readRoom = await json(readResponse) as { recording_enabled: boolean }
    expect(readRoom.recording_enabled).toBe(false)

    await setLiveRoomRecordingEnabledRaw({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
      recordingEnabled: null,
    })
    const legacyNullRead = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(legacyNullRead.status).toBe(200)
    const legacyNullRoom = await json(legacyNullRead) as { recording_enabled: boolean }
    expect(legacyNullRoom.recording_enabled).toBe(false)

    const anchorPostResponse = await app.request(`http://pirate.test/posts/${room.anchor_post}`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    }, ctx.env)
    expect(anchorPostResponse.status).toBe(200)
    const anchorPost = await json(anchorPostResponse) as {
      post: { anchor_live_room: string | null }
    }
    expect(anchorPost.post.anchor_live_room).toBe(room.id)
  })

  test("owner creates live rooms with explicit recording preference", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-recording-pref-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })

    const recordedBody = readySoloRoomBody()
    recordedBody.performer_allocations[0].user = `usr_${owner.userId}`
    const recorded = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: { ...recordedBody, recording_enabled: true },
    })
    expect(recorded.status).toBe(201)
    const recordedRoom = await json(recorded) as { id: string; recording_enabled: boolean }
    expect(recordedRoom.recording_enabled).toBe(true)

    const notRecordedBody = readySoloRoomBody()
    notRecordedBody.title = "Unrecorded Friday Set"
    notRecordedBody.performer_allocations[0].user = `usr_${owner.userId}`
    const notRecorded = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: { ...notRecordedBody, recording_enabled: false },
    })
    expect(notRecorded.status).toBe(201)
    const notRecordedRoom = await json(notRecorded) as { id: string; recording_enabled: boolean }
    expect(notRecordedRoom.recording_enabled).toBe(false)
  })

  test("owner creates a live room setlist with a Story source asset ref", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-story-source-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`
    body.setlist.items[0]!.source_asset_ref = "story:asset:ast_live_story_source"
    body.setlist.items[0]!.song_artifact_bundle = undefined
    body.setlist.items[0]!.title = "Story Source Song"

    const response = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(response.status).toBe(201)
    const room = await json(response) as {
      id: string
      setlist: {
        items: Array<{
          song_artifact_bundle: string | null
          source_asset_ref: string | null
          title: string
        }>
      }
    }
    expect(room.setlist.items[0]?.song_artifact_bundle).toBeNull()
    expect(room.setlist.items[0]?.source_asset_ref).toBe("story:asset:asset_ast_live_story_source")
    expect(room.setlist.items[0]?.title).toBe("Story Source Song")

    const read = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(read.status).toBe(200)
    const readBody = await json(read) as {
      setlist: { items: Array<{ source_asset_ref: string | null }> }
    }
    expect(readBody.setlist.items[0]?.source_asset_ref).toBe("story:asset:asset_ast_live_story_source")
  })

  test("publishes paid live room and ticket listing in one transaction", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-publish-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.access_mode = "paid"
    body.performer_allocations[0].user = `usr_${owner.userId}`

    const response = await postPublishLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: {
        room: body,
        listing: {
          price_cents: 1500,
          regional_pricing_enabled: false,
          status: "active",
        },
      },
    })
    expect(response.status).toBe(201)
    const published = await json(response) as {
      room: { id: string; access_mode: string; anchor_post: string }
      listing: { id: string; asset: string | null; live_room: string | null; price_cents: number }
    }
    expect(published.room.access_mode).toBe("paid")
    expect(published.listing.asset).toBeNull()
    expect(published.listing.live_room).toBe(published.room.id)
    expect(published.listing.price_cents).toBe(1500)

    const anchorPostResponse = await app.request(`http://pirate.test/posts/${published.room.anchor_post}`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    }, ctx.env)
    expect(anchorPostResponse.status).toBe(200)

    const beforeFailure = await readAtomicPublishRowCounts({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    const failingRoom = readySoloRoomBody()
    failingRoom.access_mode = "paid"
    failingRoom.title = "Regional Pricing Rollback Set"
    failingRoom.performer_allocations[0].user = `usr_${owner.userId}`
    const failed = await postPublishLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: {
        room: failingRoom,
        listing: {
          price_cents: 1700,
          regional_pricing_enabled: true,
          status: "active",
        },
      },
    })
    expect(failed.status).toBe(400)
    const afterFailure = await readAtomicPublishRowCounts({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    expect(afterFailure).toEqual(beforeFailure)
  })

  test("paid live-room listing propagates live-room ticket entitlement", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-ticket-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.access_mode = "paid"
    body.performer_allocations[0].user = `usr_${owner.userId}`

    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string; access_mode: string }
    expect(room.access_mode).toBe("paid")

    const missingRoomListing = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        live_room: "lr_missing_live_room",
        price_cents: 1200,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(missingRoomListing.status).toBe(404)

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        live_room: room.id,
        price_cents: 1200,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as {
      id: string
      asset: string | null
      live_room: string | null
      price_cents: number
    }
    expect(listingBody.asset).toBeNull()
    expect(listingBody.live_room).toBe(room.id)
    expect(listingBody.price_cents).toBe(1200)

    const duplicateListing = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        live_room: room.id,
        price_cents: 1500,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(duplicateListing.status).toBe(400)

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as {
      id: string
      asset: string | null
      live_room: string | null
      final_price_cents: number
      settlement_mode: string
    }
    expect(quoteBody.asset).toBeNull()
    expect(quoteBody.live_room).toBe(room.id)
    expect(quoteBody.final_price_cents).toBe(1200)
    expect(quoteBody.settlement_mode).toBe("delivery_only_story_settlement")

    const accessBeforePurchase = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/access`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(accessBeforePurchase.status).toBe(200)
    const accessBeforePurchaseBody = await json(accessBeforePurchase) as {
      access: { allowed: boolean; decision_reason: string | null; listing: string | null }
    }
    expect(accessBeforePurchaseBody.access.allowed).toBe(false)
    expect(accessBeforePurchaseBody.access.decision_reason).toBe("purchase_required")
    expect(accessBeforePurchaseBody.access.listing).toBe(listingBody.id)

    const publicAccessBeforePurchase = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/access`,
      {},
      ctx.env,
    )
    expect(publicAccessBeforePurchase.status).toBe(200)
    const publicAccessBeforePurchaseBody = await json(publicAccessBeforePurchase) as {
      access: { allowed: boolean; decision_reason: string | null; listing: string | null }
    }
    expect(publicAccessBeforePurchaseBody.access.allowed).toBe(false)
    expect(publicAccessBeforePurchaseBody.access.decision_reason).toBe("purchase_required")
    expect(publicAccessBeforePurchaseBody.access.listing).toBe(listingBody.id)

    const publicViewerAttachBeforePurchase = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      { method: "POST" },
      ctx.env,
    )
    expect(publicViewerAttachBeforePurchase.status).toBe(402)

    await insertTestWalletAttachment({
      client: ctx.client,
      userId: owner.userId,
      walletAttachmentId: "wal_live_room_ticket",
    })

    const viewerAttachBeforePurchase = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerAttachBeforePurchase.status).toBe(402)

    const purchaseSettle = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quoteBody.id,
        settlement_wallet_attachment: "wal_live_room_ticket",
        funding_tx_ref: "0xfunding-live-room-ticket",
        settlement_tx_ref: "tx-live-room-ticket",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(purchaseSettle.status).toBe(201)
    const purchaseBody = await json(purchaseSettle) as {
      asset: string | null
      live_room: string | null
      entitlement_kind: string
      entitlement_target_ref: string
      purchase_entitlement: string
      settlement_tx_ref: string
    }
    expect(purchaseBody.asset).toBeNull()
    expect(purchaseBody.live_room).toBe(room.id)
    expect(purchaseBody.entitlement_kind).toBe("live_room_access")
    expect(purchaseBody.entitlement_target_ref).toBe(room.id)
    expect(purchaseBody.settlement_tx_ref).toBe("tx-live-room-ticket")

    const hostAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(hostAttach.status).toBe(200)

    const viewerAttachAfterPurchase = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerAttachAfterPurchase.status).toBe(200)
    const viewerAttachAfterPurchaseBody = await json(viewerAttachAfterPurchase) as {
      access: { allowed: boolean; purchase_entitlement: string | null }
      runtime: { seat: string }
      agora: { configured: boolean }
    }
    expect(viewerAttachAfterPurchaseBody.access.allowed).toBe(true)
    expect(viewerAttachAfterPurchaseBody.access.purchase_entitlement).toBe(purchaseBody.purchase_entitlement)
    expect(viewerAttachAfterPurchaseBody.runtime.seat).toBe("viewer")
    expect(viewerAttachAfterPurchaseBody.agora.configured).toBe(false)
  })

  test("paid live-room ticket rejects settlement when funding proof fails", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-ticket-funding-reject-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.access_mode = "paid"
    body.performer_allocations[0].user = `usr_${owner.userId}`

    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        live_room: room.id,
        price_cents: 1200,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(listingCreate.status).toBe(201)
    const listingBody = await json(listingCreate) as { id: string }

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing: listingBody.id,
        ...routedCheckoutQuoteFields,
      },
      ctx.env,
      owner.accessToken,
    )
    expect(quoteCreate.status).toBe(201)
    const quoteBody = await json(quoteCreate) as { id: string }

    // Override the funding verifier to reject — simulates an unverified/fake funding tx.
    setCommunityCommerceBuyerFundingVerifierForTests(async () => {
      throw badRequestError("Funding transaction did not deliver enough USDC to the checkout operator")
    })

    await insertTestWalletAttachment({
      client: ctx.client,
      userId: owner.userId,
      walletAttachmentId: "wal_live_room_ticket_reject",
    })

    const rejectedSettlement = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote: quoteBody.id,
        settlement_wallet_attachment: "wal_live_room_ticket_reject",
        funding_tx_ref: "0xfake-funding",
        settlement_tx_ref: "tx-fake-settlement",
      },
      ctx.env,
      owner.accessToken,
    )
    expect(rejectedSettlement.status).toBe(400)
    const rejectBody = await json(rejectedSettlement) as { code: string; message: string }
    expect(rejectBody.message).toContain("Funding transaction did not deliver enough USDC")

    // Restore the default verifier for subsequent tests.
    setCommunityCommerceBuyerFundingVerifierForTests(async (input) => ({
      txRef: input.fundingTxRef,
      fromAddress: input.buyerAddress,
      toAddress: input.quote.funding_destination_address ?? "0x5000000000000000000000000000000000000005",
      tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
      amountAtomic: String(BigInt(Math.round(input.quote.final_price_usd * 1_000_000))),
      chainRef: "eip155:84532",
    }))

    // Verify no entitlement was granted — the viewer still can't attach.
    const viewerAttachAfterRejection = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerAttachAfterRejection.status).toBe(402)
  })

  test("free live-room viewer attach returns Agora subscriber credentials", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    ctx.env.AGORA_APP_ID = "0123456789abcdef0123456789abcdef"
    ctx.env.AGORA_APP_CERTIFICATE = "abcdef0123456789abcdef0123456789"

    const owner = await exchangeJwt(ctx.env, "live-room-free-viewer-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const viewer = await exchangeJwt(ctx.env, "live-room-free-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const intruder = await exchangeJwt(ctx.env, "live-room-free-viewer-renew-intruder")
    await completeUniqueHumanVerification(ctx.env, intruder.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const joinViewer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      viewer.accessToken,
    )
    expect(joinViewer.status).toBe(200)
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, viewer.userId)
    const joinIntruder = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      intruder.accessToken,
    )
    expect(joinIntruder.status).toBe(200)
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, intruder.userId)

    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const hostAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(hostAttach.status).toBe(200)

    const access = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/access`,
      {
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      },
      ctx.env,
    )
    expect(access.status).toBe(200)
    const accessBody = await json(access) as {
      access: { allowed: boolean; decision_reason: string | null; access_mode: string; listing: string | null }
    }
    expect(accessBody.access.allowed).toBe(true)
    expect(accessBody.access.decision_reason).toBeNull()
    expect(accessBody.access.access_mode).toBe("free")
    expect(accessBody.access.listing).toBeNull()

    const publicAccess = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/access`,
      {},
      ctx.env,
    )
    expect(publicAccess.status).toBe(200)
    const publicAccessBody = await json(publicAccess) as {
      access: { allowed: boolean; decision_reason: string | null; access_mode: string; listing: string | null }
    }
    expect(publicAccessBody.access.allowed).toBe(true)
    expect(publicAccessBody.access.decision_reason).toBeNull()
    expect(publicAccessBody.access.access_mode).toBe("free")
    expect(publicAccessBody.access.listing).toBeNull()

    const viewerAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerAttach.status).toBe(200)
    const viewerAttachBody = await json(viewerAttach) as {
      runtime: { seat: string }
      agora: { app_id: string | null; channel: string; uid: number; token: string | null; token_expires_at: number | null; configured: boolean }
    }
    expect(viewerAttachBody.runtime.seat).toBe("viewer")
    expect(viewerAttachBody.agora.app_id).toBe(ctx.env.AGORA_APP_ID)
    expect(viewerAttachBody.agora.configured).toBe(true)
    expect(viewerAttachBody.agora.token).toMatch(/^007/)
    await expect(countLiveRoomViewerSessions({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })).resolves.toBe(1)

    const viewerRenew = await requestJson(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_renew`,
      { uid: viewerAttachBody.agora.uid },
      ctx.env,
      viewer.accessToken,
    )
    expect(viewerRenew.status).toBe(200)
    const viewerRenewBody = await json(viewerRenew) as {
      runtime: { seat: string }
      agora: { app_id: string | null; channel: string; uid: number; token: string | null; token_expires_at: number | null; configured: boolean }
    }
    expect(viewerRenewBody.runtime.seat).toBe("viewer")
    expect(viewerRenewBody.agora.uid).toBe(viewerAttachBody.agora.uid)
    expect(viewerRenewBody.agora.channel).toBe(viewerAttachBody.agora.channel)
    expect(viewerRenewBody.agora.configured).toBe(true)
    expect(viewerRenewBody.agora.token).toMatch(/^007/)
    expect(viewerRenewBody.agora.token_expires_at ?? 0).toBeGreaterThanOrEqual(viewerAttachBody.agora.token_expires_at ?? 0)

    const publicViewerAttach = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      { method: "POST" },
      ctx.env,
    )
    expect(publicViewerAttach.status).toBe(200)
    const publicViewerAttachBody = await json(publicViewerAttach) as {
      runtime: { seat: string }
      agora: { app_id: string | null; channel: string; uid: number; token: string | null; token_expires_at: number | null; configured: boolean }
    }
    expect(publicViewerAttachBody.runtime.seat).toBe("viewer")
    expect(publicViewerAttachBody.agora.app_id).toBe(ctx.env.AGORA_APP_ID)
    expect(publicViewerAttachBody.agora.configured).toBe(true)
    expect(publicViewerAttachBody.agora.token).toMatch(/^007/)
    await expect(countLiveRoomViewerSessions({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })).resolves.toBe(2)

    const publicViewerRenew = await requestJson(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_renew`,
      { uid: publicViewerAttachBody.agora.uid },
      ctx.env,
    )
    expect(publicViewerRenew.status).toBe(200)
    const publicViewerRenewBody = await json(publicViewerRenew) as {
      runtime: { seat: string }
      agora: { channel: string; uid: number; token: string | null; configured: boolean }
    }
    expect(publicViewerRenewBody.runtime.seat).toBe("viewer")
    expect(publicViewerRenewBody.agora.uid).toBe(publicViewerAttachBody.agora.uid)
    expect(publicViewerRenewBody.agora.channel).toBe(publicViewerAttachBody.agora.channel)
    expect(publicViewerRenewBody.agora.configured).toBe(true)
    expect(publicViewerRenewBody.agora.token).toMatch(/^007/)

    const publicWrongUid = publicViewerAttachBody.agora.uid === 0xffffffff ? 0 : publicViewerAttachBody.agora.uid + 1
    const publicViewerRenewWrongUid = await requestJson(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_renew`,
      { uid: publicWrongUid },
      ctx.env,
    )
    expect(publicViewerRenewWrongUid.status).toBe(404)

    const wrongUid = viewerAttachBody.agora.uid === 0xffffffff ? 0 : viewerAttachBody.agora.uid + 1
    const viewerRenewWrongUid = await requestJson(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_renew`,
      { uid: wrongUid },
      ctx.env,
      viewer.accessToken,
    )
    expect(viewerRenewWrongUid.status).toBe(404)

    const intruderRenew = await requestJson(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_renew`,
      { uid: viewerAttachBody.agora.uid },
      ctx.env,
      intruder.accessToken,
    )
    expect(intruderRenew.status).toBe(404)

    const end = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(end.status).toBe(200)
    await expect(countLiveRoomViewerSessions({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })).resolves.toBe(0)
  })

  test("public viewer attach rejects gated live rooms while members can watch", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    ctx.env.AGORA_APP_ID = "0123456789abcdef0123456789abcdef"
    ctx.env.AGORA_APP_CERTIFICATE = "abcdef0123456789abcdef0123456789"

    const owner = await exchangeJwt(ctx.env, "live-room-gated-public-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const viewer = await exchangeJwt(ctx.env, "live-room-gated-member-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const joinViewer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      viewer.accessToken,
    )
    expect(joinViewer.status).toBe(200)
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, viewer.userId)

    const body = readySoloRoomBody()
    body.access_mode = "gated"
    body.performer_allocations[0].user = `usr_${owner.userId}`
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const hostAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(hostAttach.status).toBe(200)

    const publicAccess = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/access`,
      {},
      ctx.env,
    )
    expect(publicAccess.status).toBe(200)
    const publicAccessBody = await json(publicAccess) as {
      access: { allowed: boolean; decision_reason: string | null; access_mode: string }
    }
    expect(publicAccessBody.access.allowed).toBe(false)
    expect(publicAccessBody.access.decision_reason).toBe("membership_required")
    expect(publicAccessBody.access.access_mode).toBe("gated")

    const publicAttach = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      { method: "POST" },
      ctx.env,
    )
    expect(publicAttach.status).toBe(401)

    const publicRenew = await requestJson(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_renew`,
      { uid: 1234 },
      ctx.env,
    )
    expect(publicRenew.status).toBe(401)

    const memberAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      },
      ctx.env,
    )
    expect(memberAttach.status).toBe(200)
    const memberAttachBody = await json(memberAttach) as {
      runtime: { seat: string }
      agora: { configured: boolean; token: string | null }
    }
    expect(memberAttachBody.runtime.seat).toBe("viewer")
    expect(memberAttachBody.agora.configured).toBe(true)
    expect(memberAttachBody.agora.token).toMatch(/^007/)
  })

  test("unlisted live rooms are hidden from ordinary members", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-unlisted-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const viewer = await exchangeJwt(ctx.env, "live-room-unlisted-viewer")
    await completeUniqueHumanVerification(ctx.env, viewer.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const joinViewer = await requestJson(
      `http://pirate.test/communities/${communityId}/join`,
      {},
      ctx.env,
      viewer.accessToken,
    )
    expect(joinViewer.status).toBe(200)
    await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, viewer.userId)

    const body = readySoloRoomBody()
    body.visibility = "unlisted"
    body.performer_allocations[0].user = `usr_${owner.userId}`
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const ownerRead = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(ownerRead.status).toBe(200)

    const viewerRead = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerRead.status).toBe(404)

    const viewerAccess = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/access`,
      {
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerAccess.status).toBe(404)

    const publicAccess = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/access`,
      {},
      ctx.env,
    )
    expect(publicAccess.status).toBe(404)

    const viewerAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${viewer.accessToken}` },
      },
      ctx.env,
    )
    expect(viewerAttach.status).toBe(404)

    const publicAttach = await app.request(
      `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/viewer_attach`,
      { method: "POST" },
      ctx.env,
    )
    expect(publicAttach.status).toBe(404)
  })

  test("cancel clears any viewer sessions for the room", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-cancel-session-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }
    await insertSyntheticLiveRoomViewerSession({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
      viewerUserId: "usr_synthetic_cancel_viewer",
      agoraUid: 1234,
    })
    await expect(countLiveRoomViewerSessions({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })).resolves.toBe(1)

    const cancel = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(cancel.status).toBe(200)
    await expect(countLiveRoomViewerSessions({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })).resolves.toBe(0)
  })

  test("owner uploads a song artifact and uses it in a live room setlist", async () => {
    installSongArtifactProviderStubs()
    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_BASE_URL: "https://openrouter.test/api/v1",
      OPENROUTER_MODEL: "google/gemini-3.1-flash-lite-preview",
      ACRCLOUD_ACCESS_KEY: "test-acrcloud-access",
      ACRCLOUD_ACCESS_SECRET: "test-acrcloud-secret",
      ACRCLOUD_HOST: "acrcloud.test",
      ACRCLOUD_PERSONAL_ACCESS_TOKEN: "test-acrcloud-pat",
      ACRCLOUD_BUCKET_ID: "30358",
      ACRCLOUD_CONSOLE_BASE_URL: "https://console-v2.acrcloud.test/api",
      ELEVENLABS_API_KEY: "test-elevenlabs-key",
      ELEVENLABS_FORCE_ALIGNMENT_URL: "https://elevenlabs.test/forced-alignment",
      PIRATE_API_PUBLIC_ORIGIN: "http://pirate.test",
      SONG_PREVIEW_FFMPEG_BIN: "__test_passthrough__",
    })
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-song-picker-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const songBundle = await createSongArtifactBundleForLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
    })
    const pickerSearch = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts?q=Live&limit=10`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(pickerSearch.status).toBe(200)
    const pickerSearchBody = await json(pickerSearch) as {
      items: Array<{ id: string; title: string; primary_audio: { duration_ms?: number | null } }>
      next_cursor: string | null
    }
    expect(pickerSearchBody.next_cursor).toBeNull()
    expect(pickerSearchBody.items.map((item) => item.id)).toContain(songBundle.id)
    expect(pickerSearchBody.items.find((item) => item.id === songBundle.id)?.title).toBe("Live Room Song")

    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`
    body.setlist.items[0]!.song_artifact_bundle = songBundle.id
    body.setlist.items[0]!.title = songBundle.title
    body.setlist.items[0]!.artist = "Live Room Artist"
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as {
      id: string
      setlist: { items: Array<{ song_artifact_bundle: string | null; title: string; artist: string | null }> }
    }
    expect(room.setlist.items[0]?.song_artifact_bundle).toBe(songBundle.id)
    expect(room.setlist.items[0]?.title).toBe("Live Room Song")
    expect(room.setlist.items[0]?.artist).toBe("Live Room Artist")

    const read = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(read.status).toBe(200)
    const readBody = await json(read) as {
      setlist: { items: Array<{ song_artifact_bundle: string | null }> }
    }
    expect(readBody.setlist.items[0]?.song_artifact_bundle).toBe(songBundle.id)

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(200)
    const attachBody = await json(attach) as {
      room: { status: string; setlist: { items: Array<{ song_artifact_bundle: string | null }> } }
      runtime: { status: string }
    }
    expect(attachBody.room.status).toBe("live")
    expect(attachBody.runtime.status).toBe("attached")
    expect(attachBody.room.setlist.items[0]?.song_artifact_bundle).toBe(songBundle.id)
  })

  test("scoped device tokens cannot use live-room attach or song picker without required scopes", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-scoped-device-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`

    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }
    const profileOnlyToken = await createDeviceAccessToken({
      env: ctx.env,
      authorizingAccessToken: owner.accessToken,
      scope: "profile:read",
    })

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${profileOnlyToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(403)
    expect(await json(attach)).toMatchObject({
      code: "eligibility_failed",
      message: "Insufficient OAuth scope",
      details: { required_scope: "live_room:attach" },
    })

    const picker = await app.request(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        headers: { authorization: `Bearer ${profileOnlyToken}` },
      },
      ctx.env,
    )
    expect(picker.status).toBe(403)
    expect(await json(picker)).toMatchObject({
      code: "eligibility_failed",
      message: "Insufficient OAuth scope",
      details: { required_scope: "song_artifacts:read" },
    })
  })

  test("create requires owner or admin schedule permission", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-owner-permission")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const other = await exchangeJwt(ctx.env, "live-room-non-owner")
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = other.userId

    const response = await postLiveRoom({
      env: ctx.env,
      accessToken: other.accessToken,
      communityId,
      body,
    })
    expect(response.status).toBe(404)
  })

  test("create validates setlist and allocation invariants", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-owner-validation")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })

    const missingSetlist = readySoloRoomBody()
    missingSetlist.performer_allocations[0].user = owner.userId
    missingSetlist.setlist.items = []
    const missingSetlistResponse = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: missingSetlist,
    })
    expect(missingSetlistResponse.status).toBe(400)

    const badAllocation = readySoloRoomBody()
    badAllocation.performer_allocations[0].user = owner.userId
    badAllocation.performer_allocations[0].share_bps = 9000
    const badAllocationResponse = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: badAllocation,
    })
    expect(badAllocationResponse.status).toBe(400)

    const duetWithoutGuest = {
      ...readySoloRoomBody(),
      room_kind: "duet",
      performer_allocations: [
        { role: "host", user: owner.userId, share_bps: 5000 },
        { role: "guest", user: owner.userId, share_bps: 5000 },
      ],
    }
    const duetWithoutGuestResponse = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: duetWithoutGuest,
    })
    expect(duetWithoutGuestResponse.status).toBe(400)

    const missingLicenseRef = readySoloRoomBody()
    missingLicenseRef.performer_allocations[0].user = owner.userId
    missingLicenseRef.setlist.items[0]!.rights_basis = "licensed"
    const missingLicenseRefResponse = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: missingLicenseRef,
    })
    expect(missingLicenseRefResponse.status).toBe(400)

    const invalidSongArtifactBundle = readySoloRoomBody()
    invalidSongArtifactBundle.performer_allocations[0].user = owner.userId
    invalidSongArtifactBundle.setlist.items[0]!.song_artifact_bundle = "trk_fallback"
    const invalidSongArtifactBundleResponse = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: invalidSongArtifactBundle,
    })
    expect(invalidSongArtifactBundleResponse.status).toBe(400)
  })

  test("host attach is idempotent and cancel after live fails", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-host-attach")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const guest = await exchangeJwt(ctx.env, "live-room-host-guest")
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = {
      ...readySoloRoomBody(),
      room_kind: "duet",
      guest_user: guest.userId,
      performer_allocations: [
        { role: "host", user: owner.userId, share_bps: 5000 },
        { role: "guest", user: guest.userId, share_bps: 5000 },
      ],
    }
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(200)
    const attachBody = await json(attach) as {
      room: { status: string }
      runtime: { status: string }
      bridge: { ticket: string }
      agora: { channel: string; uid: number; token: string | null; token_expires_at: number | null; configured: boolean }
      jacktrip: { required: boolean; configured: boolean; server: string | null; port: number; linux_audio_setup_recommended: boolean }
    }
    expect(attachBody.room.status).toBe("live")
    expect(attachBody.runtime.status).toBe("attached")
    expect(attachBody.bridge.ticket).toMatch(/^[a-f0-9]{48}$/)
    expect(attachBody.agora.channel).toMatch(/^pirate-live-lr_/)
    expect(typeof attachBody.agora.uid).toBe("number")
    expect(attachBody.agora.token).toBeNull()
    expect(attachBody.agora.token_expires_at).toBeNull()
    expect(attachBody.agora.configured).toBe(false)
    expect(attachBody.jacktrip.required).toBe(true)
    expect(attachBody.jacktrip.configured).toBe(false)
    expect(attachBody.jacktrip.server).toBeNull()
    expect(attachBody.jacktrip.port).toBe(4464)
    expect(attachBody.jacktrip.linux_audio_setup_recommended).toBe(true)

    const attachAgain = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attachAgain.status).toBe(200)
    const attachAgainBody = await json(attachAgain) as {
      room: { status: string }
      bridge: { ticket: string }
      agora: { uid: number }
    }
    expect(attachAgainBody.room.status).toBe("live")
    expect(attachAgainBody.bridge.ticket).toBe(attachBody.bridge.ticket)
    expect(attachAgainBody.agora.uid).toBe(attachBody.agora.uid)

    const guestEnd = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(guestEnd.status).toBe(404)

    const cancel = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/cancel`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(cancel.status).toBe(409)

    const end = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(end.status).toBe(200)
    const endBody = await json(end) as { status: string; ended_at: number }
    expect(endBody.status).toBe("ended")
    expect(typeof endBody.ended_at).toBe("number")

    const attachAfterEnd = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attachAfterEnd.status).toBe(409)
  })

  test("recording-enabled rooms start and stop Agora cloud recording", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    Object.assign(ctx.env, {
      AGORA_APP_ID: "0123456789abcdef0123456789abcdef",
      AGORA_APP_CERTIFICATE: "abcdef0123456789abcdef0123456789",
      AGORA_CLOUD_RECORDING_BASE_URL: "https://agora-recording.test",
      AGORA_CLOUD_RECORDING_CUSTOMER_KEY: "customer-key",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "2",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "1",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
      AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX: "pirate/live",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture-storage.test",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
      FILEBASE_S3_ENDPOINT: "https://filebase.test",
      FILEBASE_S3_REGION: "us-east-1",
      FILEBASE_MEDIA_BUCKET: "media",
      FILEBASE_S3_ACCESS_KEY: "filebase-access",
      FILEBASE_S3_SECRET_KEY: "filebase-secret",
    })
    const originalFetch = globalThis.fetch
    const agoraRequests: Array<{ url: string; body: Record<string, unknown> | null }> = []
    const storageRequests: string[] = []
    const filebaseObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = url instanceof Request ? url.url : String(url)
      if (href.startsWith("https://capture-storage.test/")) {
        storageRequests.push(href)
        return new Response(new TextEncoder().encode("captured recording"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })
      }
      if (href.startsWith("https://filebase.test/")) {
        storageRequests.push(href)
        const request = url instanceof Request ? url : new Request(url, init)
        if (request.method === "PUT") {
          filebaseObjects.set(href, {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") || "application/octet-stream",
          })
          return new Response("", {
            status: 200,
            headers: { "x-amz-meta-cid": "bafy-live-room-recording" },
          })
        }
        if (request.method === "GET") {
          const stored = filebaseObjects.get(href)
          if (!stored) {
            return new Response("missing", { status: 404 })
          }
          return new Response(stored.body.slice().buffer, {
            status: 200,
            headers: {
              "content-length": String(stored.body.byteLength),
              "content-type": stored.contentType,
            },
          })
        }
        return new Response("unexpected filebase method", { status: 500 })
      }
      if (!href.startsWith("https://agora-recording.test/")) {
        return await originalFetch(url, init)
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null
      agoraRequests.push({ url: href, body })
      if (href.endsWith("/acquire")) {
        return Response.json({ resourceId: "resource-live-room" })
      }
      if (href.endsWith("/start")) {
        return Response.json({ resourceId: "resource-live-room", sid: "sid-live-room" })
      }
      if (href.endsWith("/stop")) {
        return Response.json({
          resourceId: "resource-live-room",
          sid: "sid-live-room",
          serverResponse: {
            fileListMode: "json",
            fileList: [{ fileName: "pirate/live/replay.mp4" }],
          },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const owner = await exchangeJwt(ctx.env, "live-room-recording-lifecycle")
      await completeUniqueHumanVerification(ctx.env, owner.accessToken)
      const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
      const body = readySoloRoomBody()
      body.performer_allocations[0].user = `usr_${owner.userId}`

      const create = await postLiveRoom({
        env: ctx.env,
        accessToken: owner.accessToken,
        communityId,
        body: { ...body, recording_enabled: true },
      })
      expect(create.status).toBe(201)
      const room = await json(create) as { id: string; recording_enabled: boolean; replay_status: string }
      expect(room.recording_enabled).toBe(true)
      expect(room.replay_status).toBe("none")

      expect(await readLiveRoomRecordingRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })).toEqual([])

      const attach = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(attach.status).toBe(200)
      expect(await readLiveRoomRecordingRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })).toEqual([{
        provider: "agora",
        provider_resource_id: "resource-live-room",
        provider_session_id: "sid-live-room",
        status: "recording",
        stopped_at: null,
        raw_artifact_ref: null,
        failure_reason: null,
      }])
      const processingDraft = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/recording-draft`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(processingDraft.status).toBe(200)
      expect(await json(processingDraft)).toMatchObject({
        object: "live_room_replay_draft",
        live_room: room.id,
        recording_enabled: true,
        replay_status: "none",
        status: "processing",
        replay_asset: null,
        recording: {
          provider: "agora",
          status: "recording",
          raw_artifact: null,
        },
      })

      const attachAgain = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(attachAgain.status).toBe(200)
      expect(await readLiveRoomRecordingRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })).toHaveLength(1)

      const end = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(end.status).toBe(200)
      const ended = await json(end) as { ended_at: number; replay_status: string; status: string }
      expect(ended.status).toBe("ended")
      expect(ended.replay_status).toBe("review_pending")
      const recordingRows = await readLiveRoomRecordingRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })
      expect(recordingRows).toHaveLength(1)
      expect(recordingRows[0]).toMatchObject({
        provider: "agora",
        provider_resource_id: "resource-live-room",
        provider_session_id: "sid-live-room",
        status: "captured",
        stopped_at: ended.ended_at,
        failure_reason: null,
      })
      expect(recordingRows[0]?.raw_artifact_ref).toContain("\"provider\":\"filebase\"")
      expect(recordingRows[0]?.raw_artifact_ref).toContain("\"ipfs_cid\":\"bafy-live-room-recording\"")
      const readyDraft = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(readyDraft.status).toBe(200)
      expect(await json(readyDraft)).toMatchObject({
        object: "live_room_replay_draft",
        live_room: room.id,
        recording_enabled: true,
        replay_status: "review_pending",
        status: "ready",
        replay_asset: {
          object: "live_room_replay_asset",
          publication_status: "draft",
          title: body.title,
          access_mode: "free",
          locked_delivery_status: "none",
          allocations: [
            {
              participant_user: `usr_${owner.userId}`,
              role: "host",
              share_bps: 10000,
              rights_basis: "performer_default",
              approval_status: "approved",
            },
          ],
        },
        recording: {
          provider: "agora",
          status: "captured",
          raw_artifact: {
            provider: "filebase",
            ipfs_cid: "bafy-live-room-recording",
            mime_type: "video/mp4",
            size_bytes: "captured recording".length,
          },
        },
      })
      const updateDraft = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Edited replay title",
            caption: "Clean board mix from the late set.",
            access_mode: "free",
            allocations: [
              {
                participant_user: `usr_${owner.userId}`,
                role: "host",
                share_bps: 8500,
              },
              {
                external_party_ref: "wallet:0x1111111111111111111111111111111111111111",
                role: "venue",
                share_bps: 1500,
              },
            ],
          }),
        },
        ctx.env,
      )
      expect(updateDraft.status).toBe(200)
      expect(await json(updateDraft)).toMatchObject({
        replay_status: "review_pending",
        status: "ready",
        replay_asset: {
          publication_status: "draft",
          title: "Edited replay title",
          caption: "Clean board mix from the late set.",
          access_mode: "free",
          allocations: [
            {
              participant_user: `usr_${owner.userId}`,
              external_party_ref: null,
              role: "host",
              share_bps: 8500,
              rights_basis: "host_draft",
              approval_status: "approved",
            },
            {
              participant_user: null,
              external_party_ref: "wallet:0x1111111111111111111111111111111111111111",
              role: "venue",
              share_bps: 1500,
              rights_basis: "host_draft",
              approval_status: "approved",
            },
          ],
        },
      })
      const publish = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft/publish`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_mode: "free" }),
        },
        ctx.env,
      )
      expect(publish.status).toBe(200)
      expect(await json(publish)).toMatchObject({
        replay_status: "published",
        status: "published",
        replay_asset: {
          publication_status: "published",
          title: "Edited replay title",
          access_mode: "free",
        },
      })
      const publishedRoom = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(publishedRoom.status).toBe(200)
      const publishedRoomBody = await json(publishedRoom) as { replay_status: string; replay_asset_id: string | null }
      expect(publishedRoomBody.replay_status).toBe("published")
      expect(publishedRoomBody.replay_asset_id).toMatch(/^lra_/)
      const replayAccess = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(replayAccess.status).toBe(200)
      const replayAccessBody = await json(replayAccess) as {
        access_granted: boolean
        access_mode: string
        decision_reason: string
        delivery_kind: string
        delivery_ref: string
        replay_asset: string
        replay_status: string
        story_cdr_access: unknown
      }
      expect(replayAccessBody).toMatchObject({
        access_granted: true,
        access_mode: "free",
        decision_reason: "free",
        delivery_kind: "primary_content_ref",
        replay_asset: publishedRoomBody.replay_asset_id,
        replay_status: "published",
        story_cdr_access: null,
      })
      expect(replayAccessBody.delivery_ref).toBe(`/communities/${communityId}/live-rooms/${room.id}/replay/content`)

      const replayContent = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/content`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(replayContent.status).toBe(200)
      expect(replayContent.headers.get("content-type")).toContain("video/mp4")
      expect(await replayContent.text()).toBe("captured recording")

      const publicReplayAccess = await app.request(
        `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {},
        ctx.env,
      )
      expect(publicReplayAccess.status).toBe(200)
      const publicReplayAccessBody = await json(publicReplayAccess) as {
        access_granted: boolean
        access_mode: string
        decision_reason: string
        delivery_kind: string
        delivery_ref: string
        story_cdr_access: unknown
      }
      expect(publicReplayAccessBody).toMatchObject({
        access_granted: true,
        access_mode: "free",
        decision_reason: "free",
        delivery_kind: "primary_content_ref",
        story_cdr_access: null,
      })
      expect(publicReplayAccessBody.delivery_ref).toBe(`/public-communities/${communityId}/live-rooms/${room.id}/replay/content`)

      const publicReplayContent = await app.request(
        `http://pirate.test/public-communities/${communityId}/live-rooms/${room.id}/replay/content`,
        {},
        ctx.env,
      )
      expect(publicReplayContent.status).toBe(200)
      expect(publicReplayContent.headers.get("content-type")).toContain("video/mp4")
      expect(await publicReplayContent.text()).toBe("captured recording")
      expect(agoraRequests.map((request) => request.url)).toEqual([
        "https://agora-recording.test/v1/apps/0123456789abcdef0123456789abcdef/cloud_recording/acquire",
        "https://agora-recording.test/v1/apps/0123456789abcdef0123456789abcdef/cloud_recording/resourceid/resource-live-room/mode/mix/start",
        "https://agora-recording.test/v1/apps/0123456789abcdef0123456789abcdef/cloud_recording/resourceid/resource-live-room/sid/sid-live-room/mode/mix/stop",
      ])
      expect(storageRequests[0]).toContain("https://capture-storage.test/capture-bucket/pirate/live/replay.mp4")
      expect(storageRequests[1]).toContain("https://filebase.test/media/livestream-recordings/")
      expect(storageRequests[1]).toContain("/replay.mp4")
      expect(storageRequests[2]).toBe(storageRequests[1])
      expect(storageRequests[3]).toBe(storageRequests[1])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("recording ingest failure marks the replay failed without creating a replay asset", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    Object.assign(ctx.env, {
      AGORA_APP_ID: "0123456789abcdef0123456789abcdef",
      AGORA_APP_CERTIFICATE: "abcdef0123456789abcdef0123456789",
      AGORA_CLOUD_RECORDING_BASE_URL: "https://agora-recording.test",
      AGORA_CLOUD_RECORDING_CUSTOMER_KEY: "customer-key",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "2",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "1",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
      AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX: "pirate/live",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture-storage.test",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
      FILEBASE_S3_ENDPOINT: "https://filebase.test",
      FILEBASE_S3_REGION: "us-east-1",
      FILEBASE_MEDIA_BUCKET: "media",
      FILEBASE_S3_ACCESS_KEY: "filebase-access",
      FILEBASE_S3_SECRET_KEY: "filebase-secret",
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = url instanceof Request ? url.url : String(url)
      if (href.startsWith("https://capture-storage.test/")) {
        return new Response(new TextEncoder().encode("captured recording"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })
      }
      if (href.startsWith("https://filebase.test/")) {
        return new Response("filebase down", { status: 503 })
      }
      if (!href.startsWith("https://agora-recording.test/")) {
        return await originalFetch(url, init)
      }
      if (href.endsWith("/acquire")) {
        return Response.json({ resourceId: "resource-live-room" })
      }
      if (href.endsWith("/start")) {
        return Response.json({ resourceId: "resource-live-room", sid: "sid-live-room" })
      }
      if (href.endsWith("/stop")) {
        return Response.json({
          resourceId: "resource-live-room",
          sid: "sid-live-room",
          serverResponse: {
            fileListMode: "json",
            fileList: [{ fileName: "pirate/live/replay.mp4" }],
          },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const owner = await exchangeJwt(ctx.env, "live-room-recording-ingest-failure")
      await completeUniqueHumanVerification(ctx.env, owner.accessToken)
      const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
      const body = readySoloRoomBody()
      body.performer_allocations[0].user = `usr_${owner.userId}`

      const create = await postLiveRoom({
        env: ctx.env,
        accessToken: owner.accessToken,
        communityId,
        body: { ...body, recording_enabled: true },
      })
      expect(create.status).toBe(201)
      const room = await json(create) as { id: string }

      const attach = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(attach.status).toBe(200)

      const end = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(end.status).toBe(200)
      const ended = await json(end) as { replay_status: string; replay_asset_id: string | null; status: string }
      expect(ended.status).toBe("ended")
      expect(ended.replay_status).toBe("failed")
      expect(ended.replay_asset_id).toBeNull()

      const recordingRows = await readLiveRoomRecordingRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })
      expect(recordingRows).toHaveLength(1)
      expect(recordingRows[0]).toMatchObject({
        provider: "agora",
        provider_resource_id: "resource-live-room",
        provider_session_id: "sid-live-room",
        status: "failed",
        raw_artifact_ref: null,
      })
      expect(recordingRows[0]?.failure_reason).toContain("Filebase object upload failed with status 503")

      const replayAssets = await readLiveRoomReplayAssetRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })
      expect(replayAssets).toEqual([])

      const draft = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(draft.status).toBe(200)
      expect(await json(draft)).toMatchObject({
        object: "live_room_replay_draft",
        live_room: room.id,
        replay_status: "failed",
        status: "failed",
        replay_asset: null,
        recording: {
          provider: "agora",
          status: "failed",
          raw_artifact: null,
        },
      })

      const publish = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft/publish`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_mode: "free" }),
        },
        ctx.env,
      )
      expect(publish.status).toBe(409)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("recording start configuration failure keeps live attach usable and fails replay", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-recording-start-failure")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = `usr_${owner.userId}`

    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body: { ...body, recording_enabled: true },
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string; recording_enabled: boolean; replay_status: string }
    expect(room.recording_enabled).toBe(true)
    expect(room.replay_status).toBe("none")

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(200)
    const attachBody = await json(attach) as { room: { status: string; replay_status: string }; runtime: { seat: string } }
    expect(attachBody.runtime.seat).toBe("host")
    expect(attachBody.room.status).toBe("live")
    expect(attachBody.room.replay_status).toBe("none")

    const recordingRowsAfterAttach = await readLiveRoomRecordingRows({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })
    expect(recordingRowsAfterAttach).toHaveLength(1)
    expect(recordingRowsAfterAttach[0]).toMatchObject({
      provider: "agora",
      provider_resource_id: null,
      provider_session_id: null,
      raw_artifact_ref: null,
      status: "failed",
    })
    expect(recordingRowsAfterAttach[0]?.failure_reason).toContain("missing_agora_cloud_recording_configuration")

    const processingDraft = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/recording-draft`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(processingDraft.status).toBe(200)
    expect(await json(processingDraft)).toMatchObject({
      object: "live_room_replay_draft",
      live_room: room.id,
      recording_enabled: true,
      replay_status: "none",
      status: "failed",
      replay_asset: null,
      recording: {
        provider: "agora",
        status: "failed",
        raw_artifact: null,
      },
    })

    const end = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(end.status).toBe(200)
    const ended = await json(end) as { replay_status: string; replay_asset_id: string | null; status: string }
    expect(ended.status).toBe("ended")
    expect(ended.replay_status).toBe("failed")
    expect(ended.replay_asset_id).toBeNull()

    const replayAssets = await readLiveRoomReplayAssetRows({
      communityDbRoot: ctx.communityDbRoot,
      communityId,
      liveRoomId: room.id,
    })
    expect(replayAssets).toEqual([])

    const readyDraft = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft`,
      {
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(readyDraft.status).toBe(200)
    expect(await json(readyDraft)).toMatchObject({
      object: "live_room_replay_draft",
      live_room: room.id,
      replay_status: "failed",
      status: "failed",
      replay_asset: null,
      recording: {
        provider: "agora",
        status: "failed",
        raw_artifact: null,
      },
    })
  })

  test("paid recording replay publishes as included-with-ticket locked delivery", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const compositeReadConditionAddress = "0x9999999999999999999999999999999999999999"
    Object.assign(ctx.env, {
      AGORA_APP_ID: "0123456789abcdef0123456789abcdef",
      AGORA_APP_CERTIFICATE: "abcdef0123456789abcdef0123456789",
      AGORA_CLOUD_RECORDING_BASE_URL: "https://agora-recording.test",
      AGORA_CLOUD_RECORDING_CUSTOMER_KEY: "customer-key",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "2",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "1",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
      AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX: "pirate/live",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture-storage.test",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
      FILEBASE_S3_ENDPOINT: "https://filebase.test",
      FILEBASE_S3_REGION: "us-east-1",
      FILEBASE_MEDIA_BUCKET: "media",
      FILEBASE_S3_ACCESS_KEY: "filebase-access",
      FILEBASE_S3_SECRET_KEY: "filebase-secret",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x1000000000000000000000000000000000000000000000000000000000000001",
      STORY_OPERATOR_PRIVATE_KEY: "0x2000000000000000000000000000000000000000000000000000000000000002",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_COMPOSITE_READ_CONDITION_ADDRESS: compositeReadConditionAddress,
    })
    const originalFetch = globalThis.fetch
    const storageObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    const cdrUploads: Array<{
      readConditionAddr: string
      writeConditionAddr: string
      readConditionData: string
      accessAuxData: string | undefined
    }> = []
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async (input) => {
      cdrUploads.push({
        readConditionAddr: input.readConditionAddr,
        writeConditionAddr: input.writeConditionAddr,
        readConditionData: input.readConditionData,
        accessAuxData: input.accessAuxData,
      })
      return {
        cdrVaultUuid: 9090,
        writerAddress: "0x0000000000000000000000000000000000000cd1",
        txHashes: {
          allocate: "0xalloc-replay",
          write: "0xwrite-replay",
        },
      }
    })
    setStoryAccessProofSignerForTests(async (input) => ({
      digest: "0xd1e570000000000000000000000000000000000000000000000000000000001",
      signature: `0x${"11".repeat(65)}` as `0x${string}`,
      signerAddress: "0x0000000000000000000000000000000000000acc",
      proof: {
        vaultUuid: input.vaultUuid,
        caller: input.callerAddress,
        accessRef: input.accessRef,
        scope: input.scope === "asset.owner"
          ? "0xb8c1a2b531e7c9d996686b1cc6dcd49d2d7037be365b6d380ebaf489440d4f18"
          : "0x2e3cf0f4f202b4d5d9581a50ca154fd30d982d3e5b85f49252f774117e2a1f7c",
        expiry: input.expiry,
        namespace: input.namespace,
      },
    }))
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init)
      const href = request.url
      if (href.startsWith("https://capture-storage.test/")) {
        return new Response(new TextEncoder().encode("paid captured recording"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })
      }
      if (href.startsWith("https://filebase.test/")) {
        const objectKey = new URL(href).pathname.replace(/^\/media\//, "")
        if (request.method === "PUT") {
          storageObjects.set(objectKey, {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") ?? "application/octet-stream",
          })
          return new Response("", {
            status: 200,
            headers: {
              "x-amz-meta-cid": objectKey.startsWith("locked-replays/")
                ? "bafy-locked-live-room-replay"
                : "bafy-paid-live-room-recording",
            },
          })
        }
        if (request.method === "GET") {
          const stored = storageObjects.get(objectKey)
          if (!stored) {
            return new Response(`missing object ${objectKey}`, { status: 404 })
          }
          const body = stored.body.buffer.slice(
            stored.body.byteOffset,
            stored.body.byteOffset + stored.body.byteLength,
          ) as ArrayBuffer
          return new Response(body, {
            status: 200,
            headers: { "content-type": stored.contentType },
          })
        }
      }
      if (!href.startsWith("https://agora-recording.test/")) {
        return await originalFetch(request)
      }
      if (href.endsWith("/acquire")) {
        return Response.json({ resourceId: "resource-paid-live-room" })
      }
      if (href.endsWith("/start")) {
        return Response.json({ resourceId: "resource-paid-live-room", sid: "sid-paid-live-room" })
      }
      if (href.endsWith("/stop")) {
        return Response.json({
          resourceId: "resource-paid-live-room",
          sid: "sid-paid-live-room",
          serverResponse: {
            fileListMode: "json",
            fileList: [{ fileName: "pirate/live/paid-replay.mp4" }],
          },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const owner = await exchangeJwt(ctx.env, "live-room-included-replay-owner")
      await completeUniqueHumanVerification(ctx.env, owner.accessToken)
      const buyer = await exchangeJwt(ctx.env, "live-room-included-replay-buyer")
      await completeUniqueHumanVerification(ctx.env, buyer.accessToken)
      const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
      await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)
      const body = readySoloRoomBody()
      body.access_mode = "paid"
      body.performer_allocations[0].user = `usr_${owner.userId}`

      const create = await postLiveRoom({
        env: ctx.env,
        accessToken: owner.accessToken,
        communityId,
        body: { ...body, recording_enabled: true },
      })
      expect(create.status).toBe(201)
      const room = await json(create) as { id: string; access_mode: string }
      expect(room.access_mode).toBe("paid")

      const listingCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/listings`,
        {
          live_room: room.id,
          price_cents: 1200,
          regional_pricing_enabled: false,
          status: "active",
        },
        ctx.env,
        owner.accessToken,
      )
      expect(listingCreate.status).toBe(201)
      const listingBody = await json(listingCreate) as { id: string }
      const quoteCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/purchase-quotes`,
        {
          listing: listingBody.id,
          ...routedCheckoutQuoteFields,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(quoteCreate.status).toBe(201)
      const quoteBody = await json(quoteCreate) as { id: string }
      await insertTestWalletAttachment({
        client: ctx.client,
        userId: buyer.userId,
        walletAttachmentId: "wal_live_room_included_replay_buyer",
        walletAddress: "0x7100000000000000000000000000000000000007",
      })
      const purchaseSettle = await requestJson(
        `http://pirate.test/communities/${communityId}/purchase-settlements`,
        {
          quote: quoteBody.id,
          settlement_wallet_attachment: "wal_live_room_included_replay_buyer",
          funding_tx_ref: "0xfunding-included-replay",
          settlement_tx_ref: "tx-included-replay",
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(purchaseSettle.status).toBe(201)

      const attach = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(attach.status).toBe(200)

      const end = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(end.status).toBe(200)
      expect(await json(end)).toMatchObject({
        status: "ended",
        replay_status: "review_pending",
      })

      const updateDraft = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_mode: "included_with_ticket" }),
        },
        ctx.env,
      )
      expect(updateDraft.status).toBe(200)
      expect(await json(updateDraft)).toMatchObject({
        replay_asset: {
          publication_status: "draft",
          access_mode: "included_with_ticket",
        },
      })

      const publish = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft/publish`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_mode: "included_with_ticket" }),
        },
        ctx.env,
      )
      expect(publish.status).toBe(200)
      expect(await json(publish)).toMatchObject({
        replay_status: "published",
        status: "published",
        replay_asset: {
          publication_status: "published",
          access_mode: "included_with_ticket",
          locked_delivery_status: "ready",
        },
      })

      const replayAssets = await readLiveRoomReplayAssetRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })
      expect(replayAssets).toHaveLength(1)
      expect(replayAssets[0]).toMatchObject({
        publication_status: "published",
        access_mode: "included_with_ticket",
        locked_delivery_status: "ready",
        story_cdr_vault_uuid: "9090",
        story_read_condition: compositeReadConditionAddress,
        locked_delivery_error: null,
      })
      expect(replayAssets[0]?.locked_delivery_storage_ref).toMatch(/^locked-replays\//)
      expect(replayAssets[0]?.locked_delivery_secret_json).toContain("\"mime_type\":\"video/mp4\"")
      expect(replayAssets[0]?.story_namespace).toMatch(/^0x[a-f0-9]{64}$/)
      expect(replayAssets[0]?.story_entitlement_token_id).toMatch(/^[0-9]+$/)
      expect(replayAssets[0]?.story_write_condition).toMatch(/^0x[a-fA-F0-9]{40}$/)
      expect(cdrUploads).toHaveLength(1)
      expect(cdrUploads[0]?.readConditionAddr).toBe(compositeReadConditionAddress)
      expect(cdrUploads[0]?.accessAuxData).toBe("0x")
      expect(cdrUploads[0]?.readConditionData).toMatch(/^0x[a-fA-F0-9]+$/)
      expect([...storageObjects.keys()].some((key) => key.startsWith("livestream-recordings/"))).toBe(true)
      expect([...storageObjects.keys()].some((key) => key.startsWith("locked-replays/"))).toBe(true)

      const hostReplayAccess = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(hostReplayAccess.status).toBe(200)
      const hostReplayAccessBody = await json(hostReplayAccess) as {
        access_granted: boolean
        decision_reason: string
        delivery_kind: string
        story_cdr_access: {
          access_aux_data_hex: string
          access_proof: Record<string, unknown>
          access_scope: string
        }
      }
      expect(hostReplayAccessBody.access_granted).toBe(true)
      expect(hostReplayAccessBody.decision_reason).toBe("creator")
      expect(hostReplayAccessBody.delivery_kind).toBe("story_cdr_ref")
      expect(hostReplayAccessBody.story_cdr_access.access_scope).toBe("asset.owner")
      expect(hostReplayAccessBody.story_cdr_access.access_aux_data_hex).toMatch(/^0x[a-fA-F0-9]+$/)
      expect(hostReplayAccessBody.story_cdr_access.access_aux_data_hex).not.toBe("0x")
      expect(hostReplayAccessBody.story_cdr_access.access_proof.mode).toBeUndefined()
      expect(hostReplayAccessBody.story_cdr_access.access_proof.signature).toMatch(/^0x[a-fA-F0-9]+$/)

      const replayAccess = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {
          headers: { authorization: `Bearer ${buyer.accessToken}` },
        },
        ctx.env,
      )
      expect(replayAccess.status).toBe(200)
      const replayAccessBody = await json(replayAccess) as {
        access_granted: boolean
        decision_reason: string
        delivery_kind: string
        delivery_ref: string
        story_cdr_access: {
          access_aux_data_hex: string
          access_proof: Record<string, unknown>
          access_scope: string
          ciphertext_ref: string
          mime_type: string
          vault_uuid: number
        }
      }
      expect(replayAccessBody.access_granted).toBe(true)
      expect(replayAccessBody.decision_reason).toBe("purchase_entitlement")
      expect(replayAccessBody.delivery_kind).toBe("story_cdr_ref")
      expect(replayAccessBody.story_cdr_access.access_aux_data_hex).toMatch(/^0x[a-fA-F0-9]+$/)
      expect(replayAccessBody.story_cdr_access.access_aux_data_hex).not.toBe("0x")
      expect(replayAccessBody.story_cdr_access.access_scope).toBe("asset.share")
      expect(replayAccessBody.story_cdr_access.ciphertext_ref).toBe(replayAccessBody.delivery_ref)
      expect(replayAccessBody.story_cdr_access.mime_type).toBe("video/mp4")
      expect(replayAccessBody.story_cdr_access.vault_uuid).toBe(9090)

      const replayContent = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/content`,
        {
          headers: { authorization: `Bearer ${buyer.accessToken}` },
        },
        ctx.env,
      )
      expect(replayContent.status).toBe(200)
      expect(replayContent.headers.get("content-type")).toContain("application/octet-stream")
      expect((await replayContent.arrayBuffer()).byteLength).toBeGreaterThan(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("recording replay can publish as a separately paid replay listing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const compositeReadConditionAddress = "0x9999999999999999999999999999999999999999"
    Object.assign(ctx.env, {
      AGORA_APP_ID: "0123456789abcdef0123456789abcdef",
      AGORA_APP_CERTIFICATE: "abcdef0123456789abcdef0123456789",
      AGORA_CLOUD_RECORDING_BASE_URL: "https://agora-recording.test",
      AGORA_CLOUD_RECORDING_CUSTOMER_KEY: "customer-key",
      AGORA_CLOUD_RECORDING_CUSTOMER_SECRET: "customer-secret",
      AGORA_CLOUD_RECORDING_STORAGE_VENDOR: "2",
      AGORA_CLOUD_RECORDING_STORAGE_REGION: "1",
      AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
      AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
      AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
      AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX: "pirate/live",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture-storage.test",
      AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
      FILEBASE_S3_ENDPOINT: "https://filebase.test",
      FILEBASE_S3_REGION: "us-east-1",
      FILEBASE_MEDIA_BUCKET: "media",
      FILEBASE_S3_ACCESS_KEY: "filebase-access",
      FILEBASE_S3_SECRET_KEY: "filebase-secret",
      STORY_CONTRACT_OWNER_PRIVATE_KEY: "0x1000000000000000000000000000000000000000000000000000000000000001",
      STORY_OPERATOR_PRIVATE_KEY: "0x2000000000000000000000000000000000000000000000000000000000000002",
      STORY_CDR_WRITER_PRIVATE_KEY: "0x3000000000000000000000000000000000000000000000000000000000000003",
      STORY_COMPOSITE_READ_CONDITION_ADDRESS: compositeReadConditionAddress,
    })
    const originalFetch = globalThis.fetch
    const storageObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    setStoryRuntimeFundingAssertionForTests(async () => {})
    setStoryCdrUploaderForTests(async () => ({
      cdrVaultUuid: 9191,
      writerAddress: "0x0000000000000000000000000000000000000cd1",
      txHashes: {
        allocate: "0xalloc-paid-replay",
        write: "0xwrite-paid-replay",
      },
    }))
    setStoryAccessProofSignerForTests(async (input) => ({
      digest: "0xd1e570000000000000000000000000000000000000000000000000000000002",
      signature: `0x${"22".repeat(65)}` as `0x${string}`,
      signerAddress: "0x0000000000000000000000000000000000000acc",
      proof: {
        vaultUuid: input.vaultUuid,
        caller: input.callerAddress,
        accessRef: input.accessRef,
        scope: input.scope === "asset.owner"
          ? "0xb8c1a2b531e7c9d996686b1cc6dcd49d2d7037be365b6d380ebaf489440d4f18"
          : "0x2e3cf0f4f202b4d5d9581a50ca154fd30d982d3e5b85f49252f774117e2a1f7c",
        expiry: input.expiry,
        namespace: input.namespace,
      },
    }))
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const request = url instanceof Request ? url : new Request(url, init)
      const href = request.url
      if (href.startsWith("https://capture-storage.test/")) {
        return new Response(new TextEncoder().encode("separately paid captured replay"), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })
      }
      if (href.startsWith("https://filebase.test/")) {
        const objectKey = new URL(href).pathname.replace(/^\/media\//, "")
        if (request.method === "PUT") {
          storageObjects.set(objectKey, {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get("content-type") ?? "application/octet-stream",
          })
          return new Response("", {
            status: 200,
            headers: {
              "x-amz-meta-cid": objectKey.startsWith("locked-replays/")
                ? "bafy-paid-replay-locked"
                : "bafy-paid-replay-raw",
            },
          })
        }
        if (request.method === "GET") {
          const stored = storageObjects.get(objectKey)
          if (!stored) {
            return new Response(`missing object ${objectKey}`, { status: 404 })
          }
          return new Response(stored.body.slice().buffer, {
            status: 200,
            headers: { "content-type": stored.contentType },
          })
        }
      }
      if (!href.startsWith("https://agora-recording.test/")) {
        return await originalFetch(request)
      }
      if (href.endsWith("/acquire")) {
        return Response.json({ resourceId: "resource-paid-replay" })
      }
      if (href.endsWith("/start")) {
        return Response.json({ resourceId: "resource-paid-replay", sid: "sid-paid-replay" })
      }
      if (href.endsWith("/stop")) {
        return Response.json({
          resourceId: "resource-paid-replay",
          sid: "sid-paid-replay",
          serverResponse: {
            fileListMode: "json",
            fileList: [{ fileName: "pirate/live/paid-replay.mp4" }],
          },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const owner = await exchangeJwt(ctx.env, "live-room-paid-replay-owner")
      await completeUniqueHumanVerification(ctx.env, owner.accessToken)
      const buyer = await exchangeJwt(ctx.env, "live-room-paid-replay-buyer")
      await completeUniqueHumanVerification(ctx.env, buyer.accessToken)
      const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
      await addCommunityMember(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT), communityId, buyer.userId)
      const body = readySoloRoomBody()
      body.performer_allocations[0].user = `usr_${owner.userId}`

      const create = await postLiveRoom({
        env: ctx.env,
        accessToken: owner.accessToken,
        communityId,
        body: { ...body, recording_enabled: true },
      })
      expect(create.status).toBe(201)
      const room = await json(create) as { id: string }

      const attach = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(attach.status).toBe(200)

      const end = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/end`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(end.status).toBe(200)

      const updateDraft = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft`,
        {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ access_mode: "paid" }),
        },
        ctx.env,
      )
      expect(updateDraft.status).toBe(200)

      const publish = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay-draft/publish`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${owner.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            access_mode: "paid",
            listing: {
              price_cents: 700,
              regional_pricing_enabled: false,
              status: "active",
            },
          }),
        },
        ctx.env,
      )
      expect(publish.status).toBe(200)
      expect(await json(publish)).toMatchObject({
        replay_status: "published",
        status: "published",
        replay_asset: {
          publication_status: "published",
          access_mode: "paid",
          locked_delivery_status: "ready",
        },
      })

      const commerceRow = await readLiveRoomCommerceRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })
      expect(commerceRow.replay_listing_id).toMatch(/^lst_/)
      const replayAssets = await readLiveRoomReplayAssetRows({
        communityDbRoot: ctx.communityDbRoot,
        communityId,
        liveRoomId: room.id,
      })
      const replayAssetId = replayAssets[0]?.replay_asset_id
      expect(replayAssetId).toMatch(/^lra_/)
      const lockedReplayObjectKey = replayAssets[0]?.locked_delivery_storage_ref
      expect(lockedReplayObjectKey).toMatch(/^locked-replays\//)
      if (!lockedReplayObjectKey) {
        throw new Error("paid replay did not store locked replay object key")
      }
      const lockedReplayObject = storageObjects.get(lockedReplayObjectKey)
      if (!lockedReplayObject) {
        throw new Error(`paid replay locked object was not uploaded: ${lockedReplayObjectKey}`)
      }

      const hostReplayAccess = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {
          headers: { authorization: `Bearer ${owner.accessToken}` },
        },
        ctx.env,
      )
      expect(hostReplayAccess.status).toBe(200)
      const hostReplayAccessBody = await json(hostReplayAccess) as {
        access_granted: boolean
        decision_reason: string
        story_cdr_access: {
          access_aux_data_hex: string
          access_proof: Record<string, unknown>
          access_scope: string
        }
      }
      expect(hostReplayAccessBody.access_granted).toBe(true)
      expect(hostReplayAccessBody.decision_reason).toBe("creator")
      expect(hostReplayAccessBody.story_cdr_access.access_scope).toBe("asset.owner")
      expect(hostReplayAccessBody.story_cdr_access.access_aux_data_hex).toMatch(/^0x[a-fA-F0-9]+$/)
      expect(hostReplayAccessBody.story_cdr_access.access_aux_data_hex).not.toBe("0x")
      expect(hostReplayAccessBody.story_cdr_access.access_proof.mode).toBeUndefined()
      expect(hostReplayAccessBody.story_cdr_access.access_proof.signature).toMatch(/^0x[a-fA-F0-9]+$/)

      const accessBeforePurchase = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {
          headers: { authorization: `Bearer ${buyer.accessToken}` },
        },
        ctx.env,
      )
      expect(accessBeforePurchase.status).toBe(200)
      expect(await json(accessBeforePurchase)).toMatchObject({
        access_granted: false,
        decision_reason: "purchase_required",
        access_mode: "paid",
        replay_asset: replayAssetId,
        replay_listing: {
          id: `lst_${commerceRow.replay_listing_id}`,
          replay_asset: replayAssetId,
          price_cents: 700,
        },
      })

      const quoteCreate = await requestJson(
        `http://pirate.test/communities/${communityId}/purchase-quotes`,
        {
          listing: `lst_${commerceRow.replay_listing_id}`,
          ...routedCheckoutQuoteFields,
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(quoteCreate.status).toBe(201)
      const quoteBody = await json(quoteCreate) as {
        id: string
        replay_asset: string
        allocation_snapshot: Array<{ recipient_type: string; recipient_ref: string | null; share_bps: number }>
      }
      expect(quoteBody.replay_asset).toBe(replayAssetId)
      expect(quoteBody.allocation_snapshot).toEqual([
        expect.objectContaining({
          recipient_type: "performer",
          recipient_ref: owner.userId,
          share_bps: 10000,
        }),
      ])

      await insertTestWalletAttachment({
        client: ctx.client,
        userId: buyer.userId,
        walletAttachmentId: "wal_live_room_paid_replay_buyer",
        walletAddress: "0x7200000000000000000000000000000000000007",
      })
      const purchaseSettle = await requestJson(
        `http://pirate.test/communities/${communityId}/purchase-settlements`,
        {
          quote: quoteBody.id,
          settlement_wallet_attachment: "wal_live_room_paid_replay_buyer",
          funding_tx_ref: "0xfunding-paid-replay",
          settlement_tx_ref: "",
        },
        ctx.env,
        buyer.accessToken,
      )
      expect(purchaseSettle.status).toBe(201)
      expect(await json(purchaseSettle)).toMatchObject({
        replay_asset: replayAssetId,
        entitlement_kind: "replay_access",
        entitlement_target_ref: replayAssetId,
      })

      const replayAccess = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/access`,
        {
          headers: { authorization: `Bearer ${buyer.accessToken}` },
        },
        ctx.env,
      )
      expect(replayAccess.status).toBe(200)
      const replayAccessBody = await json(replayAccess) as {
        access_granted: boolean
        decision_reason: string
        story_cdr_access: {
          access_aux_data_hex: string
          access_scope: string
          vault_uuid: number
        }
      }
      expect(replayAccessBody.access_granted).toBe(true)
      expect(replayAccessBody.decision_reason).toBe("purchase_entitlement")
      expect(replayAccessBody.story_cdr_access.access_scope).toBe("asset.share")
      expect(replayAccessBody.story_cdr_access.access_aux_data_hex).toMatch(/^0x[a-fA-F0-9]+$/)
      expect(replayAccessBody.story_cdr_access.vault_uuid).toBe(9191)

      const replayContent = await app.request(
        `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/replay/content`,
        {
          headers: { authorization: `Bearer ${buyer.accessToken}` },
        },
        ctx.env,
      )
      expect(replayContent.status).toBe(200)
      expect(replayContent.headers.get("content-type")).toContain("application/octet-stream")
      const replayContentBytes = new Uint8Array(await replayContent.arrayBuffer())
      expect(Array.from(replayContentBytes)).toEqual(Array.from(lockedReplayObject.body))
      expect(new TextDecoder().decode(replayContentBytes)).not.toBe("separately paid captured replay")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("host attach resolves configured JackTrip endpoint for duet rooms", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    ctx.env.LIVE_ROOM_JACKTRIP_HOST_TEMPLATE = "jt-{room}.pirate.test"
    ctx.env.LIVE_ROOM_JACKTRIP_PORT = "4477"
    ctx.env.LIVE_ROOM_JACKTRIP_BIND_PORT = "4488"
    ctx.env.LIVE_ROOM_JACKTRIP_QUALITY = "3"
    ctx.env.LIVE_ROOM_JACKTRIP_BUFFER_STRATEGY = "2"
    ctx.env.LIVE_ROOM_JACKTRIP_LINUX_AUDIO_SETUP_RECOMMENDED = "false"

    const owner = await exchangeJwt(ctx.env, "live-room-jacktrip-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const guest = await exchangeJwt(ctx.env, "live-room-jacktrip-guest")
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = {
      ...readySoloRoomBody(),
      room_kind: "duet",
      guest_user: guest.userId,
      performer_allocations: [
        { role: "host", user: owner.userId, share_bps: 5000 },
        { role: "guest", user: guest.userId, share_bps: 5000 },
      ],
    }
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(200)
    const attachBody = await json(attach) as {
      jacktrip: {
        required: boolean
        configured: boolean
        server: string | null
        port: number | null
        bind_port: number | null
        quality: string
        buffer_strategy: string
        linux_audio_setup_recommended: boolean
      }
    }
    expect(attachBody.jacktrip.required).toBe(true)
    expect(attachBody.jacktrip.configured).toBe(true)
    expect(attachBody.jacktrip.server).toBe(`jt-${room.id}.pirate.test`)
    expect(attachBody.jacktrip.port).toBe(4477)
    expect(attachBody.jacktrip.bind_port).toBe(4488)
    expect(attachBody.jacktrip.quality).toBe("3")
    expect(attachBody.jacktrip.buffer_strategy).toBe("2")
    expect(attachBody.jacktrip.linux_audio_setup_recommended).toBe(false)
  })

  test("host attach returns Agora broadcaster token when Agora is configured", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    ctx.env.AGORA_APP_ID = "0123456789abcdef0123456789abcdef"
    ctx.env.AGORA_APP_CERTIFICATE = "abcdef0123456789abcdef0123456789"
    ctx.env.LIVE_ROOM_AGORA_TOKEN_TTL_SECONDS = "900"

    const owner = await exchangeJwt(ctx.env, "live-room-host-agora-token")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = owner.userId
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(200)
    const attachBody = await json(attach) as {
      agora: { app_id: string | null; token: string | null; token_expires_at: number | null; configured: boolean }
    }
    expect(attachBody.agora.app_id).toBe(ctx.env.AGORA_APP_ID)
    expect(attachBody.agora.configured).toBe(true)
    expect(attachBody.agora.token).toMatch(/^007/)
    expect(attachBody.agora.token_expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  test("non-member guest can read and accept invite before attaching", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-guest-invite-owner")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const guest = await exchangeJwt(ctx.env, "live-room-guest-invite-guest")
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = {
      ...readySoloRoomBody(),
      room_kind: "duet",
      guest_user: guest.userId,
      performer_allocations: [
        { role: "host", user: owner.userId, share_bps: 5000 },
        { role: "guest", user: guest.userId, share_bps: 5000 },
      ],
    }
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const pendingGuestRoom = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}`,
      {
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(pendingGuestRoom.status).toBe(200)

    const pendingGuestAccess = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/access`,
      {
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(pendingGuestAccess.status).toBe(200)
    const pendingGuestAccessBody = await json(pendingGuestAccess) as {
      access: { guest_invite_status: string | null; decision_reason: string | null }
    }
    expect(pendingGuestAccessBody.access.guest_invite_status).toBe("pending")
    expect(pendingGuestAccessBody.access.decision_reason).toBe("not_live")

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(409)

    const accept = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_accept`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(accept.status).toBe(200)

    const acceptedGuestAccess = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/access`,
      {
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(acceptedGuestAccess.status).toBe(200)
    const acceptedGuestAccessBody = await json(acceptedGuestAccess) as {
      access: { guest_invite_status: string | null; decision_reason: string | null }
    }
    expect(acceptedGuestAccessBody.access.guest_invite_status).toBe("accepted")
    expect(acceptedGuestAccessBody.access.decision_reason).toBe("not_live")

    const attachBeforeHost = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(attachBeforeHost.status).toBe(409)

    const hostAttach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(hostAttach.status).toBe(200)

    const attachAfterAccept = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(attachAfterAccept.status).toBe(200)
    const attachAfterAcceptBody = await json(attachAfterAccept) as {
      runtime: { seat: string }
      bridge: { ticket: string }
    }
    expect(attachAfterAcceptBody.runtime.seat).toBe("guest")
    expect(attachAfterAcceptBody.bridge.ticket).toMatch(/^[a-f0-9]{48}$/)

    const attachAgain = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(attachAgain.status).toBe(200)
    const attachAgainBody = await json(attachAgain) as { bridge: { ticket: string } }
    expect(attachAgainBody.bridge.ticket).not.toBe(attachAfterAcceptBody.bridge.ticket)

    const revoke = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(revoke.status).toBe(200)

    const attachAfterRevoke = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/guest_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${guest.accessToken}` },
      },
      ctx.env,
    )
    expect(attachAfterRevoke.status).toBe(409)
  })

  test("host attach rejects draft setlists and blocking rights failures", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "live-room-host-attach-blocked")
    await completeUniqueHumanVerification(ctx.env, owner.accessToken)
    const communityId = await createTestCommunity({ env: ctx.env, accessToken: owner.accessToken })
    const body = readySoloRoomBody()
    body.performer_allocations[0].user = owner.userId
    body.setlist.status = "draft"
    const create = await postLiveRoom({
      env: ctx.env,
      accessToken: owner.accessToken,
      communityId,
      body,
    })
    expect(create.status).toBe(201)
    const room = await json(create) as { id: string }

    const attach = await app.request(
      `http://pirate.test/communities/${communityId}/live-rooms/${room.id}/host_attach`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${owner.accessToken}` },
      },
      ctx.env,
    )
    expect(attach.status).toBe(409)
  })
})
