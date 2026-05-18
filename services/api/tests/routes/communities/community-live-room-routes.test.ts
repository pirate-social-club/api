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
})

afterEach(async () => {
  globalThis.fetch = originalFetch
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

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
      return new Response(null, { status: 200 })
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
      performer_allocations: Array<{ user: string; share_bps: number }>
      setlist: { status: string; items: Array<{ title: string; rights_basis: string; song_artifact_bundle: string | null }> }
    }
    expect(room.id.startsWith("lr_")).toBe(true)
    expect(room.object).toBe("live_room")
    expect(room.status).toBe("scheduled")
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

    const anchorPostResponse = await app.request(`http://pirate.test/posts/${room.anchor_post}`, {
      headers: { authorization: `Bearer ${owner.accessToken}` },
    }, ctx.env)
    expect(anchorPostResponse.status).toBe(200)
    const anchorPost = await json(anchorPostResponse) as {
      post: { anchor_live_room: string | null }
    }
    expect(anchorPost.post.anchor_live_room).toBe(room.id)
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
