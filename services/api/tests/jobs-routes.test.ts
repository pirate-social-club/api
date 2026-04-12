import { createHash } from "node:crypto"
import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { getUserRepository } from "../src/lib/auth/repositories"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { getControlPlaneCommunityRepository } from "../src/lib/communities/control-plane-community-repository"
import { getControlPlaneSongArtifactBundleRepository } from "../src/lib/posts/control-plane-song-artifact-repository"
import { createPost } from "../src/lib/posts/post-service"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(
  url: string,
  body: unknown,
  env: Env,
  token?: string,
  method = "POST",
): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

function requestBytes(
  url: string,
  body: Uint8Array,
  env: Env,
  token?: string,
  method = "PUT",
  contentType = "application/octet-stream",
): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": contentType,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body as unknown as BodyInit,
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return { accessToken: body.access_token, userId: body.user.user_id }
}

async function resetBundleModerationForReplay(input: {
  env: Env
  bundleId: string
}): Promise<void> {
  const client = createClient({
    url: String(input.env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    await client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET moderation_status = 'pending',
            moderation_error = NULL,
            moderation_result_ref = NULL,
            moderation_result_json = NULL,
            updated_at = ?2
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [input.bundleId, new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

async function prepareVerifiedNamespace(
  env: Env,
  accessToken: string,
  rootLabel = "PirateSongsRoot",
): Promise<string> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: rootLabel,
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
}

function buildUploadBytes(seed: string): Uint8Array {
  return new TextEncoder().encode(seed)
}

function buildWavBytes(durationMs: number, sampleRate = 8_000): Uint8Array {
  const channelCount = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const frameCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const dataSize = frameCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  let offset = 0

  function writeAscii(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset, value.charCodeAt(index))
      offset += 1
    }
  }

  writeAscii("RIFF")
  view.setUint32(offset, 36 + dataSize, true)
  offset += 4
  writeAscii("WAVE")
  writeAscii("fmt ")
  view.setUint32(offset, 16, true)
  offset += 4
  view.setUint16(offset, 1, true)
  offset += 2
  view.setUint16(offset, channelCount, true)
  offset += 2
  view.setUint32(offset, sampleRate, true)
  offset += 4
  view.setUint32(offset, sampleRate * channelCount * bytesPerSample, true)
  offset += 4
  view.setUint16(offset, channelCount * bytesPerSample, true)
  offset += 2
  view.setUint16(offset, bitsPerSample, true)
  offset += 2
  writeAscii("data")
  view.setUint32(offset, dataSize, true)
  offset += 4

  for (let frame = 0; frame < frameCount; frame += 1) {
    const sample = Math.round(Math.sin((frame / sampleRate) * 2 * Math.PI * 220) * 0x3fff)
    view.setInt16(offset, sample, true)
    offset += 2
  }

  return new Uint8Array(buffer)
}

function buildSongMediaRef(storageRef: string, overrides: Record<string, unknown> = {}) {
  return {
    storage_ref: storageRef,
    mime_type: "audio/mpeg",
    duration_ms: 30_000,
    ...overrides,
  }
}

type UploadedSongArtifact = {
  song_artifact_upload_id: string
  status: "pending_upload" | "uploaded" | "failed"
  size_bytes: number | null
  content_hash: string | null
  storage_ref: string
}

async function createCompletedSongArtifactUpload(input: {
  env: Env
  accessToken: string
  communityId: string
  artifactKind: "primary_audio" | "cover_art" | "preview_audio" | "canvas_video" | "instrumental_audio" | "vocal_audio"
  mimeType: string
  filename?: string
  bytes: Uint8Array
}): Promise<UploadedSongArtifact> {
  const sizeBytes = input.bytes.byteLength
  const contentHash = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`

  const createResponse = await requestJson(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads`,
    {
      artifact_kind: input.artifactKind,
      mime_type: input.mimeType,
      filename: input.filename ?? null,
      size_bytes: sizeBytes,
      content_hash: contentHash,
    },
    input.env,
    input.accessToken,
  )
  expect(createResponse.status).toBe(201)
  const created = await json(createResponse) as UploadedSongArtifact

  const uploadResponse = await requestBytes(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads/${created.song_artifact_upload_id}/content`,
    input.bytes,
    input.env,
    input.accessToken,
    "PUT",
    input.mimeType,
  )
  expect(uploadResponse.status).toBe(200)
  return await json(uploadResponse) as UploadedSongArtifact
}

async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
        ON CONFLICT(membership_id) DO UPDATE SET
          status = excluded.status,
          joined_at = excluded.joined_at,
          left_at = excluded.left_at,
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

async function readAssetRow(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
}): Promise<{
  asset_id: string
  source_post_id: string
  access_mode: string
  publication_status: string
  story_status: string
  story_error: string | null
  story_ip_id: string | null
  story_ip_nft_contract: string | null
  story_ip_nft_token_id: string | null
  story_publish_tx_ref: string | null
  story_publish_model: string
  story_asset_version_id: string | null
  story_cdr_vault_uuid: number | null
  story_cdr_encrypted_cid: string | null
  story_cdr_allocate_tx_ref: string | null
  story_cdr_write_tx_ref: string | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_status: string
  locked_delivery_ref: string | null
  locked_delivery_payload_json: string | null
  locked_delivery_error: string | null
} | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT asset_id, source_post_id, access_mode, publication_status, story_status, story_error, story_ip_id,
               story_ip_nft_contract, story_ip_nft_token_id, story_publish_tx_ref, story_publish_model, story_asset_version_id, story_cdr_vault_uuid, story_cdr_encrypted_cid,
               story_cdr_allocate_tx_ref, story_cdr_write_tx_ref, story_namespace,
               story_entitlement_token_id, story_read_condition, story_write_condition,
               locked_delivery_status, locked_delivery_ref, locked_delivery_payload_json, locked_delivery_error
        FROM assets
        WHERE asset_id = ?1
        LIMIT 1
      `,
      args: [input.assetId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      asset_id: String(row.asset_id),
      source_post_id: String(row.source_post_id),
      access_mode: String(row.access_mode),
      publication_status: String(row.publication_status),
      story_status: String(row.story_status),
      story_error: row.story_error == null ? null : String(row.story_error),
      story_ip_id: row.story_ip_id == null ? null : String(row.story_ip_id),
      story_ip_nft_contract: row.story_ip_nft_contract == null ? null : String(row.story_ip_nft_contract),
      story_ip_nft_token_id: row.story_ip_nft_token_id == null ? null : String(row.story_ip_nft_token_id),
      story_publish_tx_ref: row.story_publish_tx_ref == null ? null : String(row.story_publish_tx_ref),
      story_publish_model: String(row.story_publish_model),
      story_asset_version_id: row.story_asset_version_id == null ? null : String(row.story_asset_version_id),
      story_cdr_vault_uuid: row.story_cdr_vault_uuid == null ? null : Number(row.story_cdr_vault_uuid),
      story_cdr_encrypted_cid: row.story_cdr_encrypted_cid == null ? null : String(row.story_cdr_encrypted_cid),
      story_cdr_allocate_tx_ref: row.story_cdr_allocate_tx_ref == null ? null : String(row.story_cdr_allocate_tx_ref),
      story_cdr_write_tx_ref: row.story_cdr_write_tx_ref == null ? null : String(row.story_cdr_write_tx_ref),
      story_namespace: row.story_namespace == null ? null : String(row.story_namespace),
      story_entitlement_token_id: row.story_entitlement_token_id == null ? null : String(row.story_entitlement_token_id),
      story_read_condition: row.story_read_condition == null ? null : String(row.story_read_condition),
      story_write_condition: row.story_write_condition == null ? null : String(row.story_write_condition),
      locked_delivery_status: String(row.locked_delivery_status),
      locked_delivery_ref: row.locked_delivery_ref == null ? null : String(row.locked_delivery_ref),
      locked_delivery_payload_json: row.locked_delivery_payload_json == null ? null : String(row.locked_delivery_payload_json),
      locked_delivery_error: row.locked_delivery_error == null ? null : String(row.locked_delivery_error),
    }
  } finally {
    client.close()
  }
}

async function setPrimaryWalletAttachment(
  env: Env,
  userId: string,
  walletAddress: string,
): Promise<void> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const walletAttachmentId = `wal_${userId}`
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
          source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'eip155:1315', ?3, ?3,
          'test', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
        ON CONFLICT(wallet_attachment_id) DO UPDATE SET
          wallet_address_normalized = excluded.wallet_address_normalized,
          wallet_address_display = excluded.wallet_address_display,
          is_primary = 1,
          status = 'active',
          detached_at = NULL,
          updated_at = excluded.updated_at
      `,
      args: [walletAttachmentId, userId, walletAddress, now],
    })

    await client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, walletAttachmentId, now],
    })
  } finally {
    client.close()
  }
}

async function setAssetStoryPublishInputs(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
  storyCdrVaultUuid: number
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        UPDATE assets
        SET story_cdr_vault_uuid = ?2,
            story_entitlement_token_id = ?3,
            story_read_condition = ?4,
            story_write_condition = ?5,
            updated_at = ?6
        WHERE asset_id = ?1
      `,
      args: [
        input.assetId,
        input.storyCdrVaultUuid,
        input.storyEntitlementTokenId,
        input.storyReadCondition,
        input.storyWriteCondition,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

function encodeEntitlementClassResult(input: {
  assetVersionId: string
  cdrVaultUuid: number
  active: boolean
  exists: boolean
}): string {
  const assetVersionId = input.assetVersionId.replace(/^0x/, "").padStart(64, "0")
  const cdrVaultUuid = BigInt(input.cdrVaultUuid).toString(16).padStart(64, "0")
  const active = (input.active ? 1n : 0n).toString(16).padStart(64, "0")
  const exists = (input.exists ? 1n : 0n).toString(16).padStart(64, "0")
  return `0x${assetVersionId}${cdrVaultUuid}${active}${exists}`
}

async function countSongRowsByBundle(input: {
  communityDbRoot: string
  communityId: string
  bundleId: string
}): Promise<{ postCount: number; assetCount: number }> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const postResult = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM posts
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [input.bundleId],
    })
    const assetResult = await client.execute({
      sql: `
        SELECT COUNT(*) AS count
        FROM assets
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [input.bundleId],
    })
    return {
      postCount: Number(postResult.rows[0]?.count ?? 0),
      assetCount: Number(assetResult.rows[0]?.count ?? 0),
    }
  } finally {
    client.close()
  }
}

async function readProjectionRow(input: {
  env: Env
  postId: string
}): Promise<{
  source_post_id: string
  status: string
  projected_payload_json: string
} | null> {
  const client = createClient({
    url: String(input.env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT source_post_id, status, projected_payload_json
        FROM community_post_projections
        WHERE source_post_id = ?1
        LIMIT 1
      `,
      args: [input.postId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      source_post_id: String(row.source_post_id),
      status: String(row.status),
      projected_payload_json: String(row.projected_payload_json),
    }
  } finally {
    client.close()
  }
}

describe("jobs routes", () => {
  afterEach(async () => {
    resetRuntimeCaches()
    if (cleanup) {
      await cleanup()
      cleanup = null
    }
  })

  test("internal song enrichment drain populates translation alignment and moderation bundle artifacts", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "en",
                  translations: {
                    en: ["Sail through the night", "Hold the line"],
                    es: ["Navega por la noche", "Mantén la línea"],
                    "pt-BR": ["Navegue pela noite", "Segure a linha"],
                    ru: ["Плыви сквозь ночь", "Держи курс"],
                    tr: ["Gece boyunca yelken aç", "Hattı koru"],
                    ar: ["أبحر عبر الليل", "تمسك بالخط"],
                    hi: ["रात में पार निकलो", "लाइन थामे रखो"],
                    id: ["Berlayar menembus malam", "Pertahankan garis"],
                    ja: ["夜を越えて進め", "列を保て"],
                    ko: ["밤을 가르며 항해해", "선을 지켜"],
                    "zh-Hans": ["驶过长夜", "守住航线"],
                    "zh-Hant": ["駛過長夜", "守住航線"],
                    vi: ["Lướt qua đêm tối", "Giữ vững hàng ngũ"],
                  },
                  moderation: {
                    sexualContent: "mild",
                    sexualMinors: false,
                    selfHarm: false,
                    violence: false,
                    hateOrHarassment: false,
                    reviewRequired: true,
                    blocked: false,
                    summary: "Contains mild suggestive language but no blocked sexual content.",
                  },
                  coverArtModeration: null,
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://api.elevenlabs.io/v1/forced-alignment") {
        return new Response(JSON.stringify({
          words: [
            { text: "Sail", start: 0.0, end: 0.4, loss: 0.02 },
            { text: "through", start: 0.4, end: 0.8, loss: 0.01 },
            { text: "the", start: 0.8, end: 0.95, loss: 0.01 },
            { text: "night", start: 0.95, end: 1.3, loss: 0.03 },
            { text: "\n", start: 1.3, end: 1.3, loss: 0 },
            { text: "Hold", start: 1.5, end: 1.9, loss: 0.02 },
            { text: "the", start: 1.9, end: 2.1, loss: 0.01 },
            { text: "line", start: 2.1, end: 2.5, loss: 0.02 },
          ],
          loss: 0.02,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        OPENROUTER_API_KEY: "test-openrouter-key",
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-enrichment-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken)

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Worker Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-worker.mp3",
        bytes: buildUploadBytes("song-worker-audio"),
      })

      const lyrics = "Sail through the night\nHold the line"
      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics,
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as {
        song_artifact_bundle_id: string
        translation_status: string
        alignment_status: string
        moderation_status: string
      }
      expect(bundleCreateBody.translation_status).toBe("pending")
      expect(bundleCreateBody.alignment_status).toBe("pending")
      expect(bundleCreateBody.moderation_status).toBe("pending")

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Worker Song",
          caption: "Song awaiting async enrichment moderation.",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-enrichment-post",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as {
        post_id: string
        status: string
        analysis_state: string
      }
      expect(createSongBody.status).toBe("published")
      expect(createSongBody.analysis_state).toBe("allow")

      const drain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(drain.status).toBe(200)
      const drainBody = await json(drain) as {
        claimed_count: number
        processed_count: number
        translation_completed_count: number
        alignment_completed_count: number
        moderation_completed_count: number
      }
      expect(drainBody.claimed_count).toBe(1)
      expect(drainBody.processed_count).toBe(1)
      expect(drainBody.translation_completed_count).toBe(1)
      expect(drainBody.alignment_completed_count).toBe(1)
      expect(drainBody.moderation_completed_count).toBe(1)

      const bundleRead = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(bundleRead.status).toBe(200)
      const bundleReadBody = await json(bundleRead) as {
        translation_status: string
        translated_lyrics_ref: string | null
        translated_lyrics: {
          detected_source_language: string | null
          translations: Record<string, Array<{ text: string }>>
        } | null
        alignment_status: string
        timed_lyrics_ref: string | null
        timed_lyrics: {
          lines: Array<{ start_ms: number | null; end_ms: number | null }>
        } | null
        moderation_status: string
        moderation_result_ref: string | null
        moderation_result: {
          sexual_content: string
          review_required: boolean
          blocked: boolean
          summary: string
        } | null
      }
      expect(bundleReadBody.translation_status).toBe("completed")
      expect(bundleReadBody.translated_lyrics_ref).toBe(`pirate://song-artifact-bundles/${bundleCreateBody.song_artifact_bundle_id}/translated-lyrics`)
      expect(bundleReadBody.translated_lyrics?.detected_source_language).toBe("en")
      const translatedLocales = Object.keys(bundleReadBody.translated_lyrics?.translations || {})
      expect(translatedLocales.length > 0).toBe(true)
      const firstTranslatedLocale = translatedLocales[0] ?? ""
      expect(Boolean(bundleReadBody.translated_lyrics?.translations[firstTranslatedLocale]?.[0]?.text)).toBe(true)

      expect(bundleReadBody.alignment_status).toBe("completed")
      expect(bundleReadBody.timed_lyrics_ref).toBe(`pirate://song-artifact-bundles/${bundleCreateBody.song_artifact_bundle_id}/timed-lyrics`)
      expect(bundleReadBody.timed_lyrics?.lines[0]?.start_ms).toBe(0)
      expect(bundleReadBody.timed_lyrics?.lines[1]?.end_ms).toBe(2500)

      expect(bundleReadBody.moderation_status).toBe("completed")
      expect(bundleReadBody.moderation_result_ref).toBe(`pirate://song-artifact-bundles/${bundleCreateBody.song_artifact_bundle_id}/moderation`)
      expect(bundleReadBody.moderation_result?.sexual_content).toBe("mild")
      expect(bundleReadBody.moderation_result?.review_required).toBe(true)
      expect(bundleReadBody.moderation_result?.blocked).toBe(false)
      expect((bundleReadBody.moderation_result?.summary || "").includes("mild suggestive")).toBe(true)

      const readPost = await app.request(
        `http://pirate.test/posts/${createSongBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(readPost.status).toBe(200)
      const readPostBody = await json(readPost) as {
        post: {
          status: string
          analysis_state: string
          analysis_result_ref: string | null
          content_safety_state: string
          age_gate_policy: string
        }
      }
      expect(readPostBody.post.status).toBe("hidden")
      expect(readPostBody.post.analysis_state).toBe("review_required")
      expect(readPostBody.post.analysis_result_ref).toMatch(/^mar_/)
      expect(readPostBody.post.content_safety_state).toBe("sensitive")
      expect(readPostBody.post.age_gate_policy).toBe("none")

      const otherMember = await exchangeJwt(ctx.env, "song-enrichment-other-member")
      await addCommunityMember(ctx.communityDbRoot, communityCreateBody.community.community_id, otherMember.userId)
      const deniedRead = await app.request(
        `http://pirate.test/posts/${createSongBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${otherMember.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(deniedRead.status).toBe(404)

      const feed = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(feed.status).toBe(200)
      const feedBody = await json(feed) as {
        items: Array<{ post_id: string }>
      }
      expect(feedBody.items.some((item) => item.post_id === createSongBody.post_id)).toBe(false)

      const moderationCases = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(moderationCases.status).toBe(200)
      const moderationCasesBody = await json(moderationCases) as {
        items: Array<{
          moderation_case_id: string
          post_id: string
          opened_by: string
          queue_scope: string
          priority: string
        }>
      }
      expect(moderationCasesBody.items).toHaveLength(1)
      expect(moderationCasesBody.items[0]?.post_id).toBe(createSongBody.post_id)
      expect(moderationCasesBody.items[0]?.opened_by).toBe("platform_analysis")
      expect(moderationCasesBody.items[0]?.queue_scope).toBe("community")
      expect(moderationCasesBody.items[0]?.priority).toBe("medium")

      const moderationCaseDetail = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases/${moderationCasesBody.items[0]?.moderation_case_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(moderationCaseDetail.status).toBe(200)
      const moderationCaseDetailBody = await json(moderationCaseDetail) as {
        reports: Array<unknown>
        signals: Array<{ signal_type: string; analysis_result_ref: string | null }>
      }
      expect(moderationCaseDetailBody.reports).toHaveLength(0)
      expect(moderationCaseDetailBody.signals.length > 0).toBe(true)
      expect(moderationCaseDetailBody.signals.every((signal) => signal.analysis_result_ref != null)).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song enrichment drain hides blocked adult song posts and applies age gating", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "en",
                  translations: {
                    en: ["line one"],
                    es: ["línea uno"],
                    "pt-BR": ["linha um"],
                    ru: ["строка один"],
                    tr: ["satır bir"],
                    ar: ["السطر الأول"],
                    hi: ["पंक्ति एक"],
                    id: ["baris satu"],
                    ja: ["1行目"],
                    ko: ["첫 줄"],
                    "zh-Hans": ["第一行"],
                    "zh-Hant": ["第一行"],
                    vi: ["dòng một"],
                  },
                  moderation: {
                    sexualContent: "graphic",
                    sexualMinors: true,
                    selfHarm: false,
                    violence: false,
                    hateOrHarassment: false,
                    reviewRequired: true,
                    blocked: true,
                    summary: "Blocked for sexual content involving minors.",
                  },
                  coverArtModeration: null,
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://api.elevenlabs.io/v1/forced-alignment") {
        return new Response(JSON.stringify({
          words: [
            { text: "line", start: 0.0, end: 0.4, loss: 0.02 },
            { text: "one", start: 0.4, end: 0.8, loss: 0.02 },
          ],
          loss: 0.02,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        OPENROUTER_API_KEY: "test-openrouter-key",
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-enrichment-blocked-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongsBlockedRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Blocked Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-blocked.mp3",
        bytes: buildUploadBytes("song-blocked-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "line one",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Blocked Worker Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-enrichment-post-blocked",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { post_id: string }

      const drain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(drain.status).toBe(200)

      const readPost = await app.request(
        `http://pirate.test/posts/${createSongBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(readPost.status).toBe(200)
      const readPostBody = await json(readPost) as {
        post: {
          status: string
          analysis_state: string
          content_safety_state: string
          age_gate_policy: string
        }
      }
      expect(readPostBody.post.status).toBe("hidden")
      expect(readPostBody.post.analysis_state).toBe("blocked")
      expect(readPostBody.post.content_safety_state).toBe("adult")
      expect(readPostBody.post.age_gate_policy).toBe("18_plus")

      const moderationCases = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/moderation-cases`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(moderationCases.status).toBe(200)
      const moderationCasesBody = await json(moderationCases) as {
        items: Array<{
          moderation_case_id: string
          queue_scope: string
          priority: string
          opened_by: string
        }>
      }
      expect(moderationCasesBody.items).toHaveLength(1)
      expect(moderationCasesBody.items[0]?.queue_scope).toBe("platform")
      expect(moderationCasesBody.items[0]?.priority).toBe("high")
      expect(moderationCasesBody.items[0]?.opened_by).toBe("platform_analysis")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song enrichment drain age-gates songs for adult cover art even when lyrics are safe", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "en",
                  translations: {
                    en: ["line one"],
                    es: ["línea uno"],
                    "pt-BR": ["linha um"],
                    ru: ["строка один"],
                    tr: ["satır bir"],
                    ar: ["السطر الأول"],
                    hi: ["पंक्ति एक"],
                    id: ["baris satu"],
                    ja: ["1行目"],
                    ko: ["첫 줄"],
                    "zh-Hans": ["第一行"],
                    "zh-Hant": ["第一行"],
                    vi: ["dòng một"],
                  },
                  moderation: {
                    sexualContent: "none",
                    sexualMinors: false,
                    selfHarm: false,
                    violence: false,
                    hateOrHarassment: false,
                    reviewRequired: false,
                    blocked: false,
                    summary: "Lyrics are safe.",
                  },
                  coverArtModeration: {
                    sexualContent: "adult",
                    sexualMinors: false,
                    reviewRequired: true,
                    blocked: false,
                    summary: "Cover art contains adult sexual content.",
                  },
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://api.elevenlabs.io/v1/forced-alignment") {
        return new Response(JSON.stringify({
          words: [
            { text: "line", start: 0.0, end: 0.4, loss: 0.02 },
            { text: "one", start: 0.4, end: 0.8, loss: 0.02 },
          ],
          loss: 0.02,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        OPENROUTER_API_KEY: "test-openrouter-key",
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-enrichment-cover-art-adult-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongsCoverAdultRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Cover Adult Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-cover-adult.mp3",
        bytes: buildUploadBytes("song-cover-adult-audio"),
      })
      const uploadedCoverArt = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "cover_art",
        mimeType: "image/png",
        filename: "song-cover-adult.png",
        bytes: buildUploadBytes("song-cover-adult-image"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "line one",
          cover_art: {
            storage_ref: uploadedCoverArt.storage_ref,
            mime_type: "image/png",
            size_bytes: uploadedCoverArt.size_bytes ?? 1024,
            content_hash: uploadedCoverArt.content_hash ?? "sha256:cover-art-adult",
            width: 1000,
            height: 1000,
          },
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Cover Adult Worker Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-enrichment-post-cover-adult",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { post_id: string }

      const drain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(drain.status).toBe(200)

      const readPost = await app.request(
        `http://pirate.test/posts/${createSongBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(readPost.status).toBe(200)
      const readPostBody = await json(readPost) as {
        post: {
          status: string
          analysis_state: string
          content_safety_state: string
          age_gate_policy: string
        }
      }
      expect(readPostBody.post.status).toBe("hidden")
      expect(readPostBody.post.analysis_state).toBe("review_required")
      expect(readPostBody.post.content_safety_state).toBe("adult")
      expect(readPostBody.post.age_gate_policy).toBe("18_plus")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song enrichment drain does not overwrite a previously moderated song post on replay", async () => {
    let openRouterCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        openRouterCalls += 1
        if (openRouterCalls === 1) {
          return new Response(JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    detectedSourceLanguage: "en",
                    translations: {
                      en: ["first line"],
                    },
                    moderation: {
                      sexualContent: "mild",
                      sexualMinors: false,
                      selfHarm: false,
                      violence: false,
                      hateOrHarassment: false,
                      reviewRequired: true,
                      blocked: false,
                      summary: "First moderation requires review.",
                    },
                    coverArtModeration: null,
                  }),
                },
              },
            ],
          }), {
            headers: { "content-type": "application/json" },
          })
        }

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "en",
                  translations: {
                    en: ["first line"],
                  },
                  moderation: {
                    sexualContent: "graphic",
                    sexualMinors: true,
                    selfHarm: false,
                    violence: false,
                    hateOrHarassment: false,
                    reviewRequired: true,
                    blocked: true,
                    summary: "Second moderation would block, but must not overwrite the post.",
                  },
                  coverArtModeration: null,
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://api.elevenlabs.io/v1/forced-alignment") {
        return new Response(JSON.stringify({
          words: [
            { text: "first", start: 0.0, end: 0.4, loss: 0.01 },
            { text: "line", start: 0.4, end: 0.8, loss: 0.01 },
          ],
          loss: 0.01,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        OPENROUTER_API_KEY: "test-openrouter-key",
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-enrichment-replay-guard-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongReplayGuardRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Replay Guard Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-replay-guard.mp3",
        bytes: buildUploadBytes("song-replay-guard-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "first line",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Replay Guard Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-enrichment-post-replay-guard",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { post_id: string }

      const firstDrain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(firstDrain.status).toBe(200)

      const firstRead = await app.request(
        `http://pirate.test/posts/${createSongBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(firstRead.status).toBe(200)
      const firstReadBody = await json(firstRead) as {
        post: {
          status: string
          analysis_state: string
          content_safety_state: string
          age_gate_policy: string
        }
      }
      expect(firstReadBody.post.status).toBe("hidden")
      expect(firstReadBody.post.analysis_state).toBe("review_required")
      expect(firstReadBody.post.content_safety_state).toBe("sensitive")
      expect(firstReadBody.post.age_gate_policy).toBe("none")

      await resetBundleModerationForReplay({
        env: ctx.env,
        bundleId: bundleCreateBody.song_artifact_bundle_id,
      })

      const secondDrain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(secondDrain.status).toBe(200)

      const secondRead = await app.request(
        `http://pirate.test/posts/${createSongBody.post_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(secondRead.status).toBe(200)
      const secondReadBody = await json(secondRead) as {
        post: {
          status: string
          analysis_state: string
          content_safety_state: string
          age_gate_policy: string
        }
      }
      expect(secondReadBody.post.status).toBe("hidden")
      expect(secondReadBody.post.analysis_state).toBe("review_required")
      expect(secondReadBody.post.content_safety_state).toBe("sensitive")
      expect(secondReadBody.post.age_gate_policy).toBe("none")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song enrichment drain retries failed translation and moderation work", async () => {
    let openRouterCalls = 0
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        openRouterCalls += 1
        if (openRouterCalls === 1) {
          return new Response(JSON.stringify({
            error: {
              message: "temporary upstream failure",
            },
          }), {
            status: 500,
            headers: { "content-type": "application/json" },
          })
        }

        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "en",
                  translations: {
                    en: ["Retry line"],
                    es: ["Línea de reintento"],
                    "pt-BR": ["Linha de nova tentativa"],
                    ru: ["Повторная строка"],
                    tr: ["Yeniden deneme satırı"],
                    ar: ["سطر إعادة المحاولة"],
                    hi: ["पुनः प्रयास पंक्ति"],
                    id: ["Baris percobaan ulang"],
                    ja: ["再試行の行"],
                    ko: ["재시도 줄"],
                    "zh-Hans": ["重试行"],
                    "zh-Hant": ["重試行"],
                    vi: ["Dòng thử lại"],
                  },
                  moderation: {
                    sexualContent: "none",
                    sexualMinors: false,
                    selfHarm: false,
                    violence: false,
                    hateOrHarassment: false,
                    reviewRequired: false,
                    blocked: false,
                    summary: "Safe lyrics after retry.",
                  },
                  coverArtModeration: null,
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://api.elevenlabs.io/v1/forced-alignment") {
        return new Response(JSON.stringify({
          words: [
            { text: "Retry", start: 0.0, end: 0.5, loss: 0.01 },
            { text: "line", start: 0.5, end: 0.9, loss: 0.01 },
          ],
          loss: 0.01,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        OPENROUTER_API_KEY: "test-openrouter-key",
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-enrichment-retry-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongRetryRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Retry Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-retry.mp3",
        bytes: buildUploadBytes("song-retry-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "Retry line",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const firstDrain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(firstDrain.status).toBe(200)
      const firstDrainBody = await json(firstDrain) as {
        translation_failed_count: number
        moderation_failed_count: number
        alignment_completed_count: number
      }
      expect(firstDrainBody.translation_failed_count).toBe(1)
      expect(firstDrainBody.moderation_failed_count).toBe(1)
      expect(firstDrainBody.alignment_completed_count).toBe(1)

      const bundleAfterFailure = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(bundleAfterFailure.status).toBe(200)
      const bundleAfterFailureBody = await json(bundleAfterFailure) as {
        translation_status: string
        alignment_status: string
        moderation_status: string
      }
      expect(bundleAfterFailureBody.translation_status).toBe("failed")
      expect(bundleAfterFailureBody.alignment_status).toBe("completed")
      expect(bundleAfterFailureBody.moderation_status).toBe("failed")

      const secondDrain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(secondDrain.status).toBe(200)
      const secondDrainBody = await json(secondDrain) as {
        claimed_count: number
        translation_completed_count: number
        moderation_completed_count: number
      }
      expect(secondDrainBody.claimed_count).toBe(1)
      expect(secondDrainBody.translation_completed_count).toBe(1)
      expect(secondDrainBody.moderation_completed_count).toBe(1)

      const bundleAfterRetry = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(bundleAfterRetry.status).toBe(200)
      const bundleAfterRetryBody = await json(bundleAfterRetry) as {
        translation_status: string
        moderation_status: string
        translated_lyrics_ref: string | null
        moderation_result_ref: string | null
      }
      expect(bundleAfterRetryBody.translation_status).toBe("completed")
      expect(bundleAfterRetryBody.moderation_status).toBe("completed")
      expect(bundleAfterRetryBody.translated_lyrics_ref).toBe(`pirate://song-artifact-bundles/${bundleCreateBody.song_artifact_bundle_id}/translated-lyrics`)
      expect(bundleAfterRetryBody.moderation_result_ref).toBe(`pirate://song-artifact-bundles/${bundleCreateBody.song_artifact_bundle_id}/moderation`)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song enrichment drain reclaims stale processing bundles", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://openrouter.ai/api/v1/chat/completions") {
        return new Response(JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  detectedSourceLanguage: "en",
                  translations: {
                    en: ["Stale line"],
                    es: ["Línea antigua"],
                    "pt-BR": ["Linha antiga"],
                    ru: ["Устаревшая строка"],
                    tr: ["Eski satır"],
                    ar: ["سطر قديم"],
                    hi: ["पुरानी पंक्ति"],
                    id: ["Baris lama"],
                    ja: ["古い行"],
                    ko: ["오래된 줄"],
                    "zh-Hans": ["旧行"],
                    "zh-Hant": ["舊行"],
                    vi: ["Dòng cũ"],
                  },
                  moderation: {
                    sexualContent: "none",
                    sexualMinors: false,
                    selfHarm: false,
                    violence: false,
                    hateOrHarassment: false,
                    reviewRequired: false,
                    blocked: false,
                    summary: "Recovered stale bundle.",
                  },
                  coverArtModeration: null,
                }),
              },
            },
          ],
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://api.elevenlabs.io/v1/forced-alignment") {
        return new Response(JSON.stringify({
          words: [
            { text: "Stale", start: 0.0, end: 0.4, loss: 0.02 },
            { text: "line", start: 0.4, end: 0.8, loss: 0.02 },
          ],
          loss: 0.02,
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        OPENROUTER_API_KEY: "test-openrouter-key",
        ELEVENLABS_API_KEY: "test-elevenlabs-key",
        SONG_ENRICHMENT_STALE_AFTER_SECONDS: "60",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-enrichment-stale-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongStaleRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Stale Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-stale.mp3",
        bytes: buildUploadBytes("song-stale-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "Stale line",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      await ctx.client.execute({
        sql: `
          UPDATE song_artifact_bundles
          SET translation_status = 'processing',
              alignment_status = 'processing',
              moderation_status = 'processing',
              updated_at = ?2
          WHERE song_artifact_bundle_id = ?1
        `,
        args: [
          bundleCreateBody.song_artifact_bundle_id,
          "2000-01-01T00:00:00.000Z",
        ],
      })

      const drain = await app.request(
        "http://pirate.test/jobs/internal/song-enrichments/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(drain.status).toBe(200)
      const drainBody = await json(drain) as {
        claimed_count: number
        translation_completed_count: number
        alignment_completed_count: number
        moderation_completed_count: number
      }
      expect(drainBody.claimed_count).toBe(1)
      expect(drainBody.translation_completed_count).toBe(1)
      expect(drainBody.alignment_completed_count).toBe(1)
      expect(drainBody.moderation_completed_count).toBe(1)

      const bundleRead = await app.request(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(bundleRead.status).toBe(200)
      const bundleReadBody = await json(bundleRead) as {
        translation_status: string
        alignment_status: string
        moderation_status: string
      }
      expect(bundleReadBody.translation_status).toBe("completed")
      expect(bundleReadBody.alignment_status).toBe("completed")
      expect(bundleReadBody.moderation_status).toBe("completed")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song preview drain derives preview audio for pending bundles", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-preview-drain-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongPreviewDrainRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Preview Drain Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: "song-preview-drain.wav",
      bytes: buildWavBytes(45_000),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          mime_type: "audio/wav",
          duration_ms: 45_000,
        }),
        preview_window: {
          start_ms: 5_000,
          duration_ms: 30_000,
        },
        lyrics: "Preview worker lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as {
      song_artifact_bundle_id: string
      preview_status: string
    }
    expect(bundleCreateBody.preview_status).toBe("pending")

    const drain = await app.request(
      "http://pirate.test/jobs/internal/song-previews/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      claimed_count: number
      processed_count: number
      preview_completed_count: number
      preview_failed_count: number
    }
    expect(drainBody.claimed_count).toBe(1)
    expect(drainBody.processed_count).toBe(1)
    expect(drainBody.preview_completed_count).toBe(1)
    expect(drainBody.preview_failed_count).toBe(0)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      preview_status: string
      preview_error: string | null
      preview_audio: { storage_ref: string; clip_start_ms?: number | null; clip_duration_ms?: number | null } | null
    }
    expect(bundleReadBody.preview_status).toBe("completed")
    expect(bundleReadBody.preview_error).toBeNull()
    expect(bundleReadBody.preview_audio?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
    expect(bundleReadBody.preview_audio?.clip_start_ms).toBe(5_000)
    expect(bundleReadBody.preview_audio?.clip_duration_ms).toBe(30_000)
  })

  test("internal song preview drain retries failed preview work", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-preview-retry-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongPreviewRetryRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Preview Retry Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: "song-preview-retry.wav",
      bytes: buildWavBytes(45_000),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          mime_type: "audio/wav",
          duration_ms: 45_000,
        }),
        preview_window: {
          start_ms: 2_000,
          duration_ms: 30_000,
        },
        lyrics: "Preview retry lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    await ctx.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET primary_audio_json = ?2,
            updated_at = ?3
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        bundleCreateBody.song_artifact_bundle_id,
        JSON.stringify({
          ...buildSongMediaRef("ipfs://local-song-artifact-upload/missing-preview-source", {
            mime_type: "audio/wav",
            duration_ms: 45_000,
          }),
        }),
        new Date().toISOString(),
      ],
    })

    const firstDrain = await app.request(
      "http://pirate.test/jobs/internal/song-previews/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(firstDrain.status).toBe(200)
    const firstDrainBody = await json(firstDrain) as {
      preview_completed_count: number
      preview_failed_count: number
    }
    expect(firstDrainBody.preview_completed_count).toBe(0)
    expect(firstDrainBody.preview_failed_count).toBe(1)

    await ctx.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET primary_audio_json = ?2,
            updated_at = ?3
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        bundleCreateBody.song_artifact_bundle_id,
        JSON.stringify(buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          mime_type: "audio/wav",
          duration_ms: 45_000,
          size_bytes: uploadedPrimaryAudio.size_bytes,
          content_hash: uploadedPrimaryAudio.content_hash,
        })),
        new Date().toISOString(),
      ],
    })

    const secondDrain = await app.request(
      "http://pirate.test/jobs/internal/song-previews/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(secondDrain.status).toBe(200)
    const secondDrainBody = await json(secondDrain) as {
      claimed_count: number
      preview_completed_count: number
      preview_failed_count: number
    }
    expect(secondDrainBody.claimed_count).toBe(1)
    expect(secondDrainBody.preview_completed_count).toBe(1)
    expect(secondDrainBody.preview_failed_count).toBe(0)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      preview_status: string
      preview_error: string | null
      preview_audio: { storage_ref: string } | null
    }
    expect(bundleReadBody.preview_status).toBe("completed")
    expect(bundleReadBody.preview_error).toBeNull()
    expect(bundleReadBody.preview_audio?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
  })

  test("internal song preview drain reclaims stale processing bundles", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
      SONG_PREVIEW_STALE_AFTER_SECONDS: "60",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-preview-stale-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongPreviewStaleRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Preview Stale Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: "song-preview-stale.wav",
      bytes: buildWavBytes(25_000),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: buildSongMediaRef(uploadedPrimaryAudio.storage_ref, {
          mime_type: "audio/wav",
          duration_ms: 25_000,
        }),
        lyrics: "Preview stale lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    await ctx.client.execute({
      sql: `
        UPDATE song_artifact_bundles
        SET preview_status = 'processing',
            updated_at = ?2
        WHERE song_artifact_bundle_id = ?1
      `,
      args: [
        bundleCreateBody.song_artifact_bundle_id,
        "2000-01-01T00:00:00.000Z",
      ],
    })

    const drain = await app.request(
      "http://pirate.test/jobs/internal/song-previews/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      claimed_count: number
      preview_completed_count: number
      preview_failed_count: number
    }
    expect(drainBody.claimed_count).toBe(1)
    expect(drainBody.preview_completed_count).toBe(1)
    expect(drainBody.preview_failed_count).toBe(0)

    const bundleRead = await app.request(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts/${bundleCreateBody.song_artifact_bundle_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(bundleRead.status).toBe(200)
    const bundleReadBody = await json(bundleRead) as {
      preview_status: string
      preview_audio: { storage_ref: string; clip_start_ms?: number | null; clip_duration_ms?: number | null } | null
    }
    expect(bundleReadBody.preview_status).toBe("completed")
    expect(bundleReadBody.preview_audio?.storage_ref).not.toBe(uploadedPrimaryAudio.storage_ref)
    expect(bundleReadBody.preview_audio?.clip_start_ms).toBe(0)
    expect(bundleReadBody.preview_audio?.clip_duration_ms).toBe(25_000)
  })

  test("internal song asset drain publishes draft song assets to story", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-asset-story-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetStoryRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Asset Story Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-story.mp3",
      bytes: buildUploadBytes("song-story-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics: "Asset draft lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Story Asset Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "song-asset-story-post",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as {
      post_id: string
      asset_id: string | null
    }
    expect(Boolean(createSongBody.asset_id)).toBe(true)

    const drain = await app.request(
      "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      claimed_count: number
      processed_count: number
      published_count: number
      failed_count: number
    }
    expect(drainBody.claimed_count).toBe(1)
    expect(drainBody.processed_count).toBe(1)
    expect(drainBody.published_count).toBe(1)
    expect(drainBody.failed_count).toBe(0)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.asset_id).toBe(createSongBody.asset_id)
    expect(assetRow?.source_post_id).toBe(createSongBody.post_id)
    expect(assetRow?.publication_status).toBe("story_published")
    expect(assetRow?.story_status).toBe("published")
    expect(assetRow?.story_ip_id).toBe(`pirate-story-${createSongBody.asset_id}`)
    expect(assetRow?.story_ip_nft_contract).toBeNull()
    expect(assetRow?.story_ip_nft_token_id).toBeNull()
    expect(assetRow?.story_publish_tx_ref).toBeNull()
    expect(assetRow?.story_publish_model).toBe("pirate_v1")
    expect(assetRow?.story_error).toBeNull()
    expect(assetRow?.locked_delivery_status).toBe("none")
  })

  test("internal locked delivery drain prepares locked song assets before Story publish", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-asset-locked-delivery-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongLockedDeliveryRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Locked Delivery Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-locked-story.mp3",
      bytes: buildUploadBytes("song-locked-story-audio"),
    })
    const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "preview_audio",
      mimeType: "audio/mpeg",
      filename: "song-locked-preview.mp3",
      bytes: buildUploadBytes("song-locked-preview-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        preview_audio: {
          ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
          size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
          content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
        },
        lyrics: "Locked delivery lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Locked Story Asset Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "song-asset-locked-delivery-post",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as { asset_id: string | null }
    expect(Boolean(createSongBody.asset_id)).toBe(true)

    const storyBeforeDelivery = await app.request(
      "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(storyBeforeDelivery.status).toBe(200)
    const storyBeforeDeliveryBody = await json(storyBeforeDelivery) as {
      claimed_count: number
      published_count: number
    }
    expect(storyBeforeDeliveryBody.claimed_count).toBe(0)
    expect(storyBeforeDeliveryBody.published_count).toBe(0)

    const deliveryDrain = await app.request(
      "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(deliveryDrain.status).toBe(200)
    const deliveryDrainBody = await json(deliveryDrain) as {
      claimed_count: number
      ready_count: number
      failed_count: number
    }
    expect(deliveryDrainBody.claimed_count).toBe(1)
    expect(deliveryDrainBody.ready_count).toBe(1)
    expect(deliveryDrainBody.failed_count).toBe(0)

    const assetAfterDelivery = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetAfterDelivery?.access_mode).toBe("locked")
    expect(assetAfterDelivery?.locked_delivery_status).toBe("ready")
    expect(assetAfterDelivery?.locked_delivery_ref?.startsWith("pirate-cdr://assets/")).toBe(true)
    expect(assetAfterDelivery?.locked_delivery_payload_json).not.toBeNull()
    expect(assetAfterDelivery?.story_cdr_vault_uuid != null).toBe(true)
    expect(assetAfterDelivery?.story_entitlement_token_id != null).toBe(true)
    expect(assetAfterDelivery?.story_read_condition).toBe("0x1b5340517389bd91316ee7ac866b16f2e9387e96")
    expect(assetAfterDelivery?.story_write_condition).toBe("0x82c30cf9524ad83c8a67e6b855d9c286c89586b3")
    const lockedPayload = JSON.parse(String(assetAfterDelivery?.locked_delivery_payload_json || "{}")) as {
      encrypted_blob_ref?: string
      source_storage_ref?: string
      content_key_base64?: string
      iv_base64?: string
      auth_tag_base64?: string
    }
    expect(lockedPayload.encrypted_blob_ref).toMatch(/^ipfs:\/\/local-song-artifact-upload\//)
    expect(lockedPayload.source_storage_ref).toBe(uploadedPrimaryAudio.storage_ref)
    expect(Boolean(lockedPayload.content_key_base64)).toBe(true)
    expect(Boolean(lockedPayload.iv_base64)).toBe(true)
    expect(Boolean(lockedPayload.auth_tag_base64)).toBe(true)

    await setPrimaryWalletAttachment(ctx.env, session.userId, "0xaF8344Ee86785b762170690Dc838098F7c5b2Fcb")
    const storyAfterDelivery = await app.request(
      "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(storyAfterDelivery.status).toBe(200)
    const storyAfterDeliveryBody = await json(storyAfterDelivery) as {
      claimed_count: number
      published_count: number
      failed_count: number
    }
    expect(storyAfterDeliveryBody.claimed_count).toBe(1)
    expect(storyAfterDeliveryBody.published_count).toBe(1)
    expect(storyAfterDeliveryBody.failed_count).toBe(0)

    const finalAssetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(finalAssetRow?.publication_status).toBe("story_published")
    expect(finalAssetRow?.story_status).toBe("published")
    expect(finalAssetRow?.locked_delivery_status).toBe("ready")
  })

  test("internal locked delivery drain writes the recovery payload to the configured CDR adapter", async () => {
    const originalFetch = globalThis.fetch
    let cdrWriteBody: Record<string, unknown> | null = null
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://cdr.test/v1/locked-assets/write") {
        cdrWriteBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
        return new Response(JSON.stringify({
          delivery_ref: "cdr://vaults/77/assets/locked-song-1",
        }), {
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        STORY_CDR_API_BASE_URL: "https://cdr.test",
        STORY_CDR_API_KEY: "cdr-api-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-asset-cdr-writer-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongCdrWriterRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song CDR Writer Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-cdr-writer.mp3",
        bytes: buildUploadBytes("song-cdr-writer-audio"),
      })
      const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "preview_audio",
        mimeType: "audio/mpeg",
        filename: "song-cdr-writer-preview.mp3",
        bytes: buildUploadBytes("song-cdr-writer-preview-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          preview_audio: {
            ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
            size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
            content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
          },
          lyrics: "CDR writer lyrics",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
          title: "Locked CDR Writer Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-asset-cdr-writer-post",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { asset_id: string | null }
      expect(Boolean(createSongBody.asset_id)).toBe(true)

      const deliveryDrain = await app.request(
        "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(deliveryDrain.status).toBe(200)
      const deliveryDrainBody = await json(deliveryDrain) as {
        claimed_count: number
        ready_count: number
        failed_count: number
      }
      expect(deliveryDrainBody.claimed_count).toBe(1)
      expect(deliveryDrainBody.ready_count).toBe(1)
      expect(deliveryDrainBody.failed_count).toBe(0)

      const assetAfterDelivery = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
      })
      expect(assetAfterDelivery?.locked_delivery_status).toBe("ready")
      expect(assetAfterDelivery?.locked_delivery_ref).toBe("cdr://vaults/77/assets/locked-song-1")
      const typedCdrWriteBody = cdrWriteBody as {
        story_asset_version_id?: string
        story_namespace?: string
        recovery_payload?: {
          encrypted_blob_ref?: string
          content_key_base64?: string
        }
      } | null
      expect(cdrWriteBody).toMatchObject({
        asset_id: createSongBody.asset_id!,
        community_id: communityCreateBody.community.community_id,
        cdr_vault_uuid: assetAfterDelivery?.story_cdr_vault_uuid,
        entitlement_token_id: assetAfterDelivery?.story_entitlement_token_id,
        read_condition: "0x1b5340517389bd91316ee7ac866b16f2e9387e96",
        write_condition: "0x82c30cf9524ad83c8a67e6b855d9c286c89586b3",
      })
      expect(typedCdrWriteBody?.story_asset_version_id).toMatch(/^0x[a-f0-9]{64}$/)
      expect(typedCdrWriteBody?.story_namespace).toMatch(/^0x[a-f0-9]{64}$/)
      expect(typedCdrWriteBody?.recovery_payload?.encrypted_blob_ref).toMatch(/^ipfs:\/\//)
      expect(typedCdrWriteBody?.recovery_payload?.content_key_base64).toEqual(expect.any(String))
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal locked delivery drain marks the asset failed when the configured CDR adapter write fails", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://cdr.test/v1/locked-assets/write") {
        return new Response(JSON.stringify({
          error: "cdr_unavailable",
        }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        STORY_CDR_API_BASE_URL: "https://cdr.test",
        STORY_CDR_API_KEY: "cdr-api-key",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-asset-cdr-write-fail-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongCdrWriteFailRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song CDR Write Fail Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-cdr-write-fail.mp3",
        bytes: buildUploadBytes("song-cdr-write-fail-audio"),
      })
      const uploadedPreviewAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "preview_audio",
        mimeType: "audio/mpeg",
        filename: "song-cdr-write-fail-preview.mp3",
        bytes: buildUploadBytes("song-cdr-write-fail-preview-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          preview_audio: {
            ...buildSongMediaRef(uploadedPreviewAudio.storage_ref),
            size_bytes: uploadedPreviewAudio.size_bytes ?? 1024,
            content_hash: uploadedPreviewAudio.content_hash ?? buildSongMediaRef(uploadedPreviewAudio.storage_ref).content_hash,
          },
          lyrics: "CDR write failure lyrics",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          access_mode: "locked",
          title: "Locked CDR Write Failure Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-asset-cdr-write-fail-post",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { asset_id: string | null }
      expect(Boolean(createSongBody.asset_id)).toBe(true)

      const deliveryDrain = await app.request(
        "http://pirate.test/jobs/internal/song-locked-deliveries/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(deliveryDrain.status).toBe(200)
      const deliveryDrainBody = await json(deliveryDrain) as {
        claimed_count: number
        ready_count: number
        failed_count: number
      }
      expect(deliveryDrainBody.claimed_count).toBe(1)
      expect(deliveryDrainBody.ready_count).toBe(0)
      expect(deliveryDrainBody.failed_count).toBe(1)

      const assetAfterDelivery = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
      })
      expect(assetAfterDelivery?.locked_delivery_status).toBe("failed")
      expect(assetAfterDelivery?.locked_delivery_ref).toBeNull()
      expect(assetAfterDelivery?.locked_delivery_error).toContain("story_cdr_write_http_error:503")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song asset drain prefers Lit publish even when a direct publish key is also configured", async () => {
    const originalFetch = globalThis.fetch
    let entitlementClassResult = encodeEntitlementClassResult({
      assetVersionId: "0x".padEnd(66, "0"),
      cdrVaultUuid: 0,
      active: false,
      exists: false,
    })
    let publishNonce = 0
    let gatewayFetchCalled = false
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.startsWith("https://psc.myfilebase.com/ipfs/")) {
        gatewayFetchCalled = true
      }

      if (url === "https://api.dev.litprotocol.com/core/v1/lit_action") {
        return new Response(JSON.stringify({
          response: JSON.stringify({
            signerAddress: "0x7f969455cFe240927F1ACe4E23000685Ad224dA7",
            serializedTx: "0xdeadbeef",
          }),
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://rpc.ankr.com/story_aeneid_testnet") {
        const body = JSON.parse(String(init?.body || "{}")) as { method?: string; params?: Array<{ to?: string } | string> }
        if (body.method === "eth_call") {
          const request = body.params?.[0]
          const to = typeof request === "object" && request ? String(request.to || "").toLowerCase() : ""
          if (to === "0x77319b4031e6ef1250907aa00018b8b1c67a244b") {
            return new Response(JSON.stringify({
              result: "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678",
            }), {
              headers: { "content-type": "application/json" },
            })
          }
          return new Response(JSON.stringify({
            result: entitlementClassResult,
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (body.method === "eth_getTransactionCount") {
          const currentNonce = publishNonce
          publishNonce += 1
          return new Response(JSON.stringify({
            result: `0x${currentNonce.toString(16)}`,
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (body.method === "eth_sendRawTransaction") {
          return new Response(JSON.stringify({
            result: "0x1111111111111111111111111111111111111111111111111111111111111111",
          }), {
            headers: { "content-type": "application/json" },
          })
        }
        if (body.method === "eth_getTransactionReceipt") {
          return new Response(JSON.stringify({
            result: {
              status: "0x1",
            },
          }), {
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        LIT_CHIPOTLE_OPERATOR_API_KEY: "lit-usage-key",
        STORY_SONG_IP_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
        STORY_PUBLISH_OPERATOR_PRIVATE_KEY: "direct-key-should-not-be-used",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-asset-story-lit-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetStoryLitRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Asset Story Lit Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-story-lit.mp3",
        bytes: buildUploadBytes("song-story-lit-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "Asset lit publish lyrics",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Story Asset Lit Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-asset-story-post-lit",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as {
        asset_id: string | null
      }
      expect(Boolean(createSongBody.asset_id)).toBe(true)

      await setPrimaryWalletAttachment(ctx.env, session.userId, "0xaF8344Ee86785b762170690Dc838098F7c5b2Fcb")
      await setAssetStoryPublishInputs({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
        storyCdrVaultUuid: 77,
        storyEntitlementTokenId: "123456789",
        storyReadCondition: "0x1b5340517389bd91316ee7ac866b16f2e9387e96",
        storyWriteCondition: "0x4c9bfc96d7092b590d497a191826c3da2277c34b",
      })
      const preparedAsset = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
      })
      entitlementClassResult = encodeEntitlementClassResult({
        assetVersionId: preparedAsset?.story_asset_version_id || "0x".padEnd(66, "0"),
        cdrVaultUuid: 77,
        active: true,
        exists: true,
      })

      const drain = await app.request(
        "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(drain.status).toBe(200)
      const drainBody = await json(drain) as {
        claimed_count: number
        processed_count: number
        published_count: number
        failed_count: number
      }
      expect(drainBody.claimed_count).toBe(1)
      expect(drainBody.processed_count).toBe(1)
      expect(drainBody.published_count).toBe(1)
      expect(drainBody.failed_count).toBe(0)

      const assetRow = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
      })
      expect(assetRow?.publication_status).toBe("story_published")
      expect(assetRow?.story_status).toBe("published")
      expect(assetRow?.story_ip_id).toBe("0x1234567890AbcdEF1234567890aBcdef12345678")
      expect(assetRow?.story_ip_nft_contract).toBe("0x1111111111111111111111111111111111111111")
      expect(assetRow?.story_ip_nft_token_id).toBe(BigInt(String(assetRow?.story_asset_version_id)).toString())
      expect(assetRow?.story_publish_tx_ref).toBe("0x1111111111111111111111111111111111111111111111111111111111111111")
      expect(assetRow?.story_publish_model).toBe("story_ip_v1")
      expect(assetRow?.story_cdr_vault_uuid).toBe(77)
      expect(assetRow?.story_entitlement_token_id).toBe("123456789")
      expect(assetRow?.story_namespace?.startsWith("0x")).toBe(true)
      expect(assetRow?.story_read_condition).toBe("0x1b5340517389bd91316ee7ac866b16f2e9387e96")
      expect(assetRow?.story_write_condition).toBe("0x4c9bfc96d7092b590d497a191826c3da2277c34b")
      expect(assetRow?.story_error).toBeNull()
      expect(gatewayFetchCalled).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song asset drain fails before broadcast when the entitlement class is not configured onchain", async () => {
    const originalFetch = globalThis.fetch
    let litApiCalled = false
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://api.dev.litprotocol.com/core/v1/lit_action") {
        litApiCalled = true
        return new Response(JSON.stringify({
          response: JSON.stringify({
            signerAddress: "0x7f969455cFe240927F1ACe4E23000685Ad224dA7",
            serializedTx: "0xdeadbeef",
          }),
        }), {
          headers: { "content-type": "application/json" },
        })
      }

      if (url === "https://rpc.ankr.com/story_aeneid_testnet") {
        const body = JSON.parse(String(init?.body || "{}")) as { method?: string }
        if (body.method === "eth_call") {
          return new Response(JSON.stringify({
            result: encodeEntitlementClassResult({
              assetVersionId: "0x".padEnd(66, "0"),
              cdrVaultUuid: 0,
              active: false,
              exists: false,
            }),
          }), {
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input as never, init)
    }) as typeof globalThis.fetch

    try {
      const ctx = await createRouteTestContext({
        INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
        LIT_CHIPOTLE_OPERATOR_API_KEY: "lit-usage-key",
        STORY_SONG_IP_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
      })
      cleanup = ctx.cleanup

      const session = await exchangeJwt(ctx.env, "song-asset-story-lit-class-missing-author")
      const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetStoryLitClassMissingRoot")

      const communityCreate = await requestJson("http://pirate.test/communities", {
        display_name: "Pirate Song Asset Story Lit Class Missing Club",
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }, ctx.env, session.accessToken)
      expect(communityCreate.status).toBe(202)
      const communityCreateBody = await json(communityCreate) as {
        community: { community_id: string }
      }

      const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
        env: ctx.env,
        accessToken: session.accessToken,
        communityId: communityCreateBody.community.community_id,
        artifactKind: "primary_audio",
        mimeType: "audio/mpeg",
        filename: "song-story-lit-class-missing.mp3",
        bytes: buildUploadBytes("song-story-lit-class-missing-audio"),
      })

      const bundleCreate = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
        {
          primary_audio: {
            ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
            size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
            content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
          },
          lyrics: "Asset lit class missing publish inputs lyrics",
        },
        ctx.env,
        session.accessToken,
      )
      expect(bundleCreate.status).toBe(201)
      const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

      const createSong = await requestJson(
        `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
        {
          post_type: "song",
          identity_mode: "public",
          song_mode: "original",
          rights_basis: "original",
          title: "Story Asset Lit Class Missing Song",
          song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
          idempotency_key: "song-asset-story-post-lit-class-missing",
        },
        ctx.env,
        session.accessToken,
      )
      expect(createSong.status).toBe(201)
      const createSongBody = await json(createSong) as { asset_id: string | null }
      expect(Boolean(createSongBody.asset_id)).toBe(true)

      await setPrimaryWalletAttachment(ctx.env, session.userId, "0xaF8344Ee86785b762170690Dc838098F7c5b2Fcb")
      await setAssetStoryPublishInputs({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
        storyCdrVaultUuid: 77,
        storyEntitlementTokenId: "123456789",
        storyReadCondition: "0x1b5340517389bd91316ee7ac866b16f2e9387e96",
        storyWriteCondition: "0x4c9bfc96d7092b590d497a191826c3da2277c34b",
      })

      const drain = await app.request(
        "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
        {
          method: "POST",
          headers: {
            authorization: "Bearer internal-song-job-token",
          },
        },
        ctx.env,
      )
      expect(drain.status).toBe(200)
      const drainBody = await json(drain) as {
        published_count: number
        failed_count: number
      }
      expect(drainBody.published_count).toBe(0)
      expect(drainBody.failed_count).toBe(1)
      expect(litApiCalled).toBe(false)

      const assetRow = await readAssetRow({
        communityDbRoot: ctx.communityDbRoot,
        communityId: communityCreateBody.community.community_id,
        assetId: createSongBody.asset_id!,
      })
      expect(assetRow?.publication_status).toBe("story_failed")
      expect(assetRow?.story_status).toBe("failed")
      expect(assetRow?.story_error).toBe("story_entitlement_class_not_configured")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("internal song asset drain fails closed when Lit publish inputs are missing", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
      LIT_CHIPOTLE_OPERATOR_API_KEY: "lit-usage-key",
      STORY_SONG_IP_TOKEN_ADDRESS: "0x1111111111111111111111111111111111111111",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-asset-story-lit-missing-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetStoryLitMissingRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Asset Story Lit Missing Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-story-lit-missing.mp3",
      bytes: buildUploadBytes("song-story-lit-missing-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics: "Asset lit missing publish inputs lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Story Asset Lit Missing Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "song-asset-story-post-lit-missing",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as { asset_id: string | null }
    expect(Boolean(createSongBody.asset_id)).toBe(true)

    await setPrimaryWalletAttachment(ctx.env, session.userId, "0xaF8344Ee86785b762170690Dc838098F7c5b2Fcb")

    const drain = await app.request(
      "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      published_count: number
      failed_count: number
    }
    expect(drainBody.published_count).toBe(0)
    expect(drainBody.failed_count).toBe(1)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.publication_status).toBe("story_failed")
    expect(assetRow?.story_status).toBe("failed")
    expect(assetRow?.story_ip_id).toBeNull()
    expect(assetRow?.story_publish_tx_ref).toBeNull()
    expect(assetRow?.story_error).toBe("story_cdr_vault_uuid_missing")
  })

  test("internal song asset drain marks story failures on assets", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
      STORY_PUBLISH_FORCE_FAIL: "true",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-asset-story-failure-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetStoryFailRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Asset Story Fail Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-story-fail.mp3",
      bytes: buildUploadBytes("song-story-fail-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics: "Asset draft failure lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Story Asset Fail Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "song-asset-story-post-fail",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as { asset_id: string | null }
    expect(Boolean(createSongBody.asset_id)).toBe(true)

    const drain = await app.request(
      "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      published_count: number
      failed_count: number
    }
    expect(drainBody.published_count).toBe(0)
    expect(drainBody.failed_count).toBe(1)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.publication_status).toBe("story_failed")
    expect(assetRow?.story_status).toBe("failed")
    expect(assetRow?.story_ip_id).toBeNull()
    expect(assetRow?.story_error).toBe("story_publish_forced_failure")
  })

  test("internal song asset drain reclaims stale requested assets", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
      SONG_ASSET_STORY_STALE_AFTER_SECONDS: "60",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-asset-story-stale-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongAssetStoryStaleRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Asset Story Stale Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-story-stale.mp3",
      bytes: buildUploadBytes("song-story-stale-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics: "Asset stale reclaim lyrics",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const createSong = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Story Asset Stale Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "song-asset-story-post-stale",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createSong.status).toBe(201)
    const createSongBody = await json(createSong) as { asset_id: string | null }
    expect(Boolean(createSongBody.asset_id)).toBe(true)

    const client = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.community_id),
    })
    try {
      await client.execute({
        sql: `
          UPDATE assets
          SET publication_status = 'story_requested',
              story_status = 'requested',
              updated_at = ?2
          WHERE asset_id = ?1
        `,
        args: [createSongBody.asset_id!, "2000-01-01T00:00:00.000Z"],
      })
    } finally {
      client.close()
    }

    const drain = await app.request(
      "http://pirate.test/jobs/internal/song-assets/drain?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      claimed_count: number
      published_count: number
      failed_count: number
    }
    expect(drainBody.claimed_count).toBe(1)
    expect(drainBody.published_count).toBe(1)
    expect(drainBody.failed_count).toBe(0)

    const assetRow = await readAssetRow({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      assetId: createSongBody.asset_id!,
    })
    expect(assetRow?.publication_status).toBe("story_published")
    expect(assetRow?.story_status).toBe("published")
    expect(assetRow?.story_ip_id).toBe(`pirate-story-${createSongBody.asset_id}`)
    expect(assetRow?.story_ip_nft_contract).toBeNull()
    expect(assetRow?.story_ip_nft_token_id).toBeNull()
    expect(assetRow?.story_publish_model).toBe("pirate_v1")
  })

  test("createPost rolls back local song rows and restores bundle when projection recording fails", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "song-create-rollback-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateSongRollbackRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song Rollback Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const uploadedPrimaryAudio = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      artifactKind: "primary_audio",
      mimeType: "audio/mpeg",
      filename: "song-rollback.mp3",
      bytes: buildUploadBytes("song-rollback-audio"),
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/song-artifacts`,
      {
        primary_audio: {
          ...buildSongMediaRef(uploadedPrimaryAudio.storage_ref),
          size_bytes: uploadedPrimaryAudio.size_bytes ?? 1024,
          content_hash: uploadedPrimaryAudio.content_hash ?? buildSongMediaRef(uploadedPrimaryAudio.storage_ref).content_hash,
        },
        lyrics: "Rollback line",
      },
      ctx.env,
      session.accessToken,
    )
    expect(bundleCreate.status).toBe(201)
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const userRepository = getUserRepository(ctx.env)
    const songArtifactRepository = getControlPlaneSongArtifactBundleRepository(ctx.env)
    const baseCommunityRepository = getControlPlaneCommunityRepository(ctx.env)
    const failingCommunityRepository = new Proxy(baseCommunityRepository, {
      get(target, prop, receiver) {
        if (prop === "recordCommunityPostProjection") {
          return async () => {
            throw new Error("projection_record_failed")
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    }) as typeof baseCommunityRepository

    await expect(createPost({
      env: ctx.env,
      bearerToken: session.accessToken,
      communityId: communityCreateBody.community.community_id,
      body: {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        title: "Rollback Song",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: "song-rollback-post",
      },
      userRepository,
      communityRepository: failingCommunityRepository,
      songArtifactRepository,
    })).rejects.toThrow("projection_record_failed")

    const bundle = await songArtifactRepository.getSongArtifactBundleById(bundleCreateBody.song_artifact_bundle_id)
    expect(bundle?.status).toBe("ready")

    const counts = await countSongRowsByBundle({
      communityDbRoot: ctx.communityDbRoot,
      communityId: communityCreateBody.community.community_id,
      bundleId: bundleCreateBody.song_artifact_bundle_id,
    })
    expect(counts.postCount).toBe(0)
    expect(counts.assetCount).toBe(0)
  })

  test("internal community post projection reconcile updates stale projections and recreates missing ones", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "internal-song-job-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "projection-reconcile-author")
    const namespaceVerificationId = await prepareVerifiedNamespace(ctx.env, session.accessToken, "PirateProjectionReconcileRoot")

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Projection Reconcile Club",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { community_id: string }
    }

    const createPostResponse = await requestJson(
      `http://pirate.test/communities/${communityCreateBody.community.community_id}/posts`,
      {
        post_type: "text",
        identity_mode: "public",
        title: "Projection Reconcile Post",
        body: "This post will drift from its projection.",
        idempotency_key: "projection-reconcile-post",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createPostResponse.status).toBe(201)
    const createPostBody = await json(createPostResponse) as { post_id: string }

    const communityClient = createClient({
      url: buildLocalCommunityDbUrl(ctx.communityDbRoot, communityCreateBody.community.community_id),
    })
    try {
      await communityClient.execute({
        sql: `
          UPDATE posts
          SET status = 'hidden',
              analysis_state = 'review_required',
              content_safety_state = 'sensitive',
              updated_at = ?2
          WHERE post_id = ?1
        `,
        args: [createPostBody.post_id, new Date().toISOString()],
      })
    } finally {
      communityClient.close()
    }

    const firstReconcile = await app.request(
      "http://pirate.test/jobs/internal/community-post-projections/reconcile?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(firstReconcile.status).toBe(200)
    const firstReconcileBody = await json(firstReconcile) as {
      reconciled_count: number
      created_count: number
      updated_count: number
    }
    expect(firstReconcileBody.reconciled_count).toBe(1)
    expect(firstReconcileBody.created_count).toBe(0)
    expect(firstReconcileBody.updated_count).toBe(1)

    const updatedProjection = await readProjectionRow({
      env: ctx.env,
      postId: createPostBody.post_id,
    })
    expect(updatedProjection?.status).toBe("hidden")
    expect(JSON.parse(updatedProjection?.projected_payload_json || "{}").analysis_state).toBe("review_required")

    await ctx.client.execute({
      sql: `
        DELETE FROM community_post_projections
        WHERE source_post_id = ?1
      `,
      args: [createPostBody.post_id],
    })

    const secondReconcile = await app.request(
      "http://pirate.test/jobs/internal/community-post-projections/reconcile?limit=1",
      {
        method: "POST",
        headers: {
          authorization: "Bearer internal-song-job-token",
        },
      },
      ctx.env,
    )
    expect(secondReconcile.status).toBe(200)
    const secondReconcileBody = await json(secondReconcile) as {
      reconciled_count: number
      created_count: number
      updated_count: number
    }
    expect(secondReconcileBody.reconciled_count).toBe(1)
    expect(secondReconcileBody.created_count).toBe(1)
    expect(secondReconcileBody.updated_count).toBe(0)

    const recreatedProjection = await readProjectionRow({
      env: ctx.env,
      postId: createPostBody.post_id,
    })
    expect(recreatedProjection?.source_post_id).toBe(createPostBody.post_id)
    expect(recreatedProjection?.status).toBe("hidden")
    expect(JSON.parse(recreatedProjection?.projected_payload_json || "{}").post_id).toBe(createPostBody.post_id)
  })
})
