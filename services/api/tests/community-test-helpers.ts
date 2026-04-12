import { createHash } from "node:crypto"
import { expect } from "bun:test"
import { createClient, type Client } from "@libsql/client"
import app from "../src/index"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { getCommunityPurchaseQuoteById } from "../src/lib/communities/community-purchase-quote-store"
import { createRightsReviewCase } from "../src/lib/posts/community-post-store"
import { getControlPlaneSongArtifactBundleRepository } from "../src/lib/posts/control-plane-song-artifact-repository"
import {
  buildStubSpacesRootPubkey,
  buildStubSpacesSignature,
} from "../src/lib/verification/spaces-verifier"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

export let communityRoutesCleanup: (() => Promise<void>) | null = null

export function requestJson(
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

export function requestBytes(
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

export async function withMockedAcrcloudIdentify<T>(
  responses: Array<unknown | Error>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch
  let responseIndex = 0
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === "https://identify-ap-southeast-1.acrcloud.com/v1/identify") {
      const next = responses[Math.min(responseIndex, Math.max(0, responses.length - 1))]
      responseIndex += 1
      if (next instanceof Error) {
        throw next
      }
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    }
    return originalFetch(input, init)
  }) as typeof globalThis.fetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

export async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
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

export async function prepareVerifiedNamespace(
  env: Env,
  accessToken: string,
  rootLabel = "PirateCommunityRoot",
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

export async function prepareVerifiedSpacesNamespace(
  env: Env,
  accessToken: string,
  rootLabel = "@pirate",
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

  const normalizedRootLabel = rootLabel.replace(/^@/, "").toLowerCase()
  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "spaces",
    root_label: rootLabel,
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as {
    namespace_verification_session_id: string
    challenge_payload?: { digest?: string | null } | null
  }
  const digest = namespaceBody.challenge_payload?.digest ?? null
  const rootPubkey = buildStubSpacesRootPubkey(normalizedRootLabel)
  const signature = buildStubSpacesSignature({
    digest: digest as string,
    rootPubkey,
  })
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {
      signature_payload: {
        signature,
        algorithm: "bip340_schnorr",
        signer_pubkey: rootPubkey,
        digest,
      },
    },
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
}

export async function completeUniqueHumanVerification(
  env: Env,
  accessToken: string,
  provider: "self" | "very" = "self",
): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider,
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  if (provider === "very") {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url === "https://verify.very.org/api/v1/verify") {
        return new Response(JSON.stringify({ status: "valid" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      }
      return originalFetch(input, init)
    }) as typeof globalThis.fetch
    try {
      await requestJson(
        `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
        { proof: "valid-very-proof" },
        env,
        accessToken,
      )
    } finally {
      globalThis.fetch = originalFetch
    }
    return
  }

  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
}

export async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
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

export async function setCommunityMembershipMode(
  communityDbRoot: string,
  communityId: string,
  membershipMode: "open" | "request" | "gated",
): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        UPDATE communities
        SET membership_mode = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [communityId, membershipMode, now],
    })
  } finally {
    client.close()
  }
}

export async function addCommunityRole(
  communityDbRoot: string,
  communityId: string,
  userId: string,
  role: "owner" | "admin" | "moderator",
): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_roles (
          role_assignment_id, community_id, user_id, role, status, granted_by_user_id, granted_at, revoked_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'active', ?3, ?5, NULL, ?5, ?5
        )
        ON CONFLICT(role_assignment_id) DO UPDATE SET
          status = excluded.status,
          granted_at = excluded.granted_at,
          revoked_at = excluded.revoked_at,
          updated_at = excluded.updated_at
      `,
      args: [`role_${communityId}_${userId}_${role}`, communityId, userId, role, now],
    })
  } finally {
    client.close()
  }
}

export async function insertCommunityListing(input: {
  communityDbRoot: string
  communityId: string
  listingId: string
  createdByUserId: string
  assetId?: string | null
  liveRoomId?: string | null
  status?: "draft" | "active" | "paused" | "archived"
  priceUsd: string
  regionalPricingEnabled?: boolean
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO listings (
          listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
          regional_pricing_policy_json, donation_enabled, donation_partner_id_snapshot, donation_share_pct,
          created_by_user_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'fixed_price', ?5, ?6,
          ?7, 0, NULL, NULL,
          ?8, ?9, ?9
        )
        ON CONFLICT(listing_id) DO UPDATE SET
          asset_id = excluded.asset_id,
          live_room_id = excluded.live_room_id,
          status = excluded.status,
          price_usd = excluded.price_usd,
          created_by_user_id = excluded.created_by_user_id,
          updated_at = excluded.updated_at
      `,
      args: [
        input.listingId,
        input.communityId,
        input.assetId ?? null,
        input.liveRoomId ?? null,
        input.status ?? "active",
        input.priceUsd,
        input.regionalPricingEnabled ? JSON.stringify({ enabled: true, policy_scope: "community_active" }) : null,
        input.createdByUserId,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

export async function readPurchaseQuoteRow(input: {
  communityDbRoot: string
  communityId: string
  quoteId: string
}): Promise<{
  quote_id: string
  status: string
  community_id: string
  listing_id: string
  buyer_user_id: string
  route_policy_compliant: number
  route_live_available: number | null
  policy_origin: string
  pricing_tier: string | null
  pricing_policy_version: string | null
  verification_snapshot_ref: string | null
} | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT quote_id, community_id, status, listing_id, buyer_user_id, route_policy_compliant, route_live_available, policy_origin,
               pricing_tier, pricing_policy_version, verification_snapshot_ref
        FROM purchase_quotes
        WHERE community_id = ?1
          AND quote_id = ?2
        LIMIT 1
      `,
      args: [input.communityId, input.quoteId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      quote_id: String(row.quote_id),
      community_id: String(row.community_id),
      status: String(row.status),
      listing_id: String(row.listing_id),
      buyer_user_id: String(row.buyer_user_id),
      route_policy_compliant: Number(row.route_policy_compliant),
      route_live_available: row.route_live_available == null ? null : Number(row.route_live_available),
      policy_origin: String(row.policy_origin),
      pricing_tier: row.pricing_tier == null ? null : String(row.pricing_tier),
      pricing_policy_version: row.pricing_policy_version == null ? null : String(row.pricing_policy_version),
      verification_snapshot_ref: row.verification_snapshot_ref == null ? null : String(row.verification_snapshot_ref),
    }
  } finally {
    client.close()
  }
}

export async function readAssetRow(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
}): Promise<{
  asset_id: string
  source_post_id: string
  song_artifact_bundle_id: string | null
  asset_kind: string
  rights_basis: string
  access_mode: string
  primary_content_ref: string
  primary_content_hash: string | null
  preview_audio_json: string | null
  cover_art_json: string | null
  canvas_video_json: string | null
  publication_status: string
  story_status: string
  story_cdr_vault_uuid: number | null
  story_cdr_encrypted_cid: string | null
  story_entitlement_token_id: string | null
  locked_delivery_status: string
  locked_delivery_ref: string | null
  locked_delivery_payload_json: string | null
} | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT asset_id, source_post_id, song_artifact_bundle_id, asset_kind, rights_basis, access_mode,
               primary_content_ref, primary_content_hash, preview_audio_json, cover_art_json, canvas_video_json,
               publication_status, story_status, story_cdr_vault_uuid, story_cdr_encrypted_cid, story_entitlement_token_id,
               locked_delivery_status, locked_delivery_ref, locked_delivery_payload_json
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
      song_artifact_bundle_id: row.song_artifact_bundle_id == null ? null : String(row.song_artifact_bundle_id),
      asset_kind: String(row.asset_kind),
      rights_basis: String(row.rights_basis),
      access_mode: String(row.access_mode),
      primary_content_ref: String(row.primary_content_ref),
      primary_content_hash: row.primary_content_hash == null ? null : String(row.primary_content_hash),
      preview_audio_json: row.preview_audio_json == null ? null : String(row.preview_audio_json),
      cover_art_json: row.cover_art_json == null ? null : String(row.cover_art_json),
      canvas_video_json: row.canvas_video_json == null ? null : String(row.canvas_video_json),
      publication_status: String(row.publication_status),
      story_status: String(row.story_status),
      story_cdr_vault_uuid: row.story_cdr_vault_uuid == null ? null : Number(row.story_cdr_vault_uuid),
      story_cdr_encrypted_cid: row.story_cdr_encrypted_cid == null ? null : String(row.story_cdr_encrypted_cid),
      story_entitlement_token_id: row.story_entitlement_token_id == null ? null : String(row.story_entitlement_token_id),
      locked_delivery_status: String(row.locked_delivery_status),
      locked_delivery_ref: row.locked_delivery_ref == null ? null : String(row.locked_delivery_ref),
      locked_delivery_payload_json: row.locked_delivery_payload_json == null ? null : String(row.locked_delivery_payload_json),
    }
  } finally {
    client.close()
  }
}

export async function readMediaAnalysisRow(input: {
  communityDbRoot: string
  communityId: string
  analysisResultId: string
}): Promise<{
  media_analysis_result_id: string
  outcome: string
  content_safety_state: string
  acrcloud_music_match_json: string | null
  acrcloud_custom_match_json: string | null
  resolved_at: string | null
} | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT media_analysis_result_id, outcome, content_safety_state,
               acrcloud_music_match_json, acrcloud_custom_match_json, resolved_at
        FROM media_analysis_results
        WHERE media_analysis_result_id = ?1
        LIMIT 1
      `,
      args: [input.analysisResultId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      media_analysis_result_id: String(row.media_analysis_result_id),
      outcome: String(row.outcome),
      content_safety_state: String(row.content_safety_state),
      acrcloud_music_match_json: row.acrcloud_music_match_json == null ? null : String(row.acrcloud_music_match_json),
      acrcloud_custom_match_json: row.acrcloud_custom_match_json == null ? null : String(row.acrcloud_custom_match_json),
      resolved_at: row.resolved_at == null ? null : String(row.resolved_at),
    }
  } finally {
    client.close()
  }
}

export async function countDerivativeLinks(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
}): Promise<number> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS link_count
        FROM asset_derivative_links
        WHERE asset_id = ?1
      `,
      args: [input.assetId],
    })
    return Number(result.rows[0]?.link_count ?? 0)
  } finally {
    client.close()
  }
}

export async function countRightsReviewCases(input: {
  communityDbRoot: string
  communityId: string
  subjectId: string
}): Promise<number> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS case_count
        FROM rights_review_cases
        WHERE community_id = ?1
          AND subject_id = ?2
      `,
      args: [input.communityId, input.subjectId],
    })
    return Number(result.rows[0]?.case_count ?? 0)
  } finally {
    client.close()
  }
}

export async function insertOpenRightsReviewCase(input: {
  communityDbRoot: string
  communityId: string
  subjectId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO rights_review_cases (
          rights_review_case_id, subject_type, subject_id, community_id, status, trigger_source,
          analysis_result_ref, submitted_evidence_refs_json, resolution, resolver_user_id,
          created_at, updated_at, resolved_at
        ) VALUES (
          ?1, 'asset', ?2, ?3, 'open', 'acrcloud_match',
          NULL, NULL, NULL, NULL,
          ?4, ?4, NULL
        )
      `,
      args: [`rrc_test_${input.subjectId}`, input.subjectId, input.communityId, now],
    })
  } finally {
    client.close()
  }
}

export async function readProjectionStatus(input: {
  client: Client
  postId: string
}): Promise<string | null> {
  const result = await input.client.execute({
    sql: `
      SELECT status
      FROM community_post_projections
      WHERE source_post_id = ?1
        AND projection_version = 1
      LIMIT 1
    `,
    args: [input.postId],
  })
  return result.rows[0]?.status == null ? null : String(result.rows[0]?.status)
}

export async function setPostStatus(input: {
  communityDbRoot: string
  communityId: string
  postId: string
  status: "draft" | "published" | "hidden"
  analysisState?: "pending" | "allow" | "allow_with_required_reference" | "review_required" | "blocked"
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        UPDATE posts
        SET status = ?3,
            analysis_state = ?4,
            updated_at = ?5
        WHERE community_id = ?1
          AND post_id = ?2
      `,
      args: [
        input.communityId,
        input.postId,
        input.status,
        input.analysisState ?? (input.status === "hidden" ? "blocked" : "allow"),
        now,
      ],
    })
  } finally {
    client.close()
  }
}

export async function setAssetCdrFields(input: {
  communityDbRoot: string
  communityId: string
  assetId: string
  vaultUuid: number
  encryptedCid: string
  clearLocalPayload?: boolean
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    await client.execute({
      sql: `
        UPDATE assets
        SET story_cdr_vault_uuid = ?2,
            story_cdr_encrypted_cid = ?3,
            locked_delivery_payload_json = CASE WHEN ?4 THEN NULL ELSE locked_delivery_payload_json END,
            updated_at = ?5
        WHERE asset_id = ?1
      `,
      args: [input.assetId, input.vaultUuid, input.encryptedCid, input.clearLocalPayload ? 1 : 0, new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

export async function expirePurchaseQuote(input: {
  communityDbRoot: string
  communityId: string
  quoteId: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    await client.execute({
      sql: `
        UPDATE purchase_quotes
        SET expires_at = '2000-01-01T00:00:00.000Z'
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.quoteId],
    })
  } finally {
    client.close()
  }
}

async function readPurchaseRow(input: {
  communityDbRoot: string
  communityId: string
  purchaseId: string
}): Promise<{
  purchase_id: string
  listing_id: string
  buyer_user_id: string
  settlement_wallet_attachment_id: string
  settlement_tx_ref: string
} | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT purchase_id, listing_id, buyer_user_id, settlement_wallet_attachment_id, settlement_tx_ref
        FROM purchases
        WHERE community_id = ?1
          AND purchase_id = ?2
        LIMIT 1
      `,
      args: [input.communityId, input.purchaseId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      purchase_id: String(row.purchase_id),
      listing_id: String(row.listing_id),
      buyer_user_id: String(row.buyer_user_id),
      settlement_wallet_attachment_id: String(row.settlement_wallet_attachment_id),
      settlement_tx_ref: String(row.settlement_tx_ref),
    }
  } finally {
    client.close()
  }
}

async function readPurchaseEntitlementRow(input: {
  communityDbRoot: string
  communityId: string
  purchaseId: string
}): Promise<{
  purchase_id: string
  entitlement_kind: string
  target_ref: string
  status: string
} | null> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT purchase_id, entitlement_kind, target_ref, status
        FROM purchase_entitlements
        WHERE community_id = ?1
          AND purchase_id = ?2
        LIMIT 1
      `,
      args: [input.communityId, input.purchaseId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }
    return {
      purchase_id: String(row.purchase_id),
      entitlement_kind: String(row.entitlement_kind),
      target_ref: String(row.target_ref),
      status: String(row.status),
    }
  } finally {
    client.close()
  }
}

async function setVerifiedUserNationality(input: {
  client: Client
  userId: string
  countryCode: string
}): Promise<void> {
  const capabilities = buildDefaultVerificationCapabilities()
  const verifiedAt = new Date().toISOString()
  const countryCode = input.countryCode.trim().toUpperCase()
  capabilities.unique_human = {
    state: "verified",
    provider: "self",
    proof_type: "unique_human",
    mechanism: "session_complete",
    verified_at: verifiedAt,
  }
  capabilities.nationality = {
    state: "verified",
    value: countryCode,
    provider: "self",
    proof_type: "nationality",
    mechanism: "zk-nationality",
    verified_at: verifiedAt,
  }

  await input.client.execute({
    sql: `
      UPDATE users
      SET verification_state = 'verified',
          capability_provider = 'self',
          verification_capabilities_json = ?2,
          nationality = ?3,
          verified_at = ?4,
          updated_at = ?4
      WHERE user_id = ?1
    `,
    args: [input.userId, JSON.stringify(capabilities), countryCode, verifiedAt],
  })
}

export function buildSongMediaRef(storageRef: string, overrides: Record<string, unknown> = {}) {
  return {
    storage_ref: storageRef,
    mime_type: "audio/mpeg",
    duration_ms: 30_000,
    ...overrides,
  }
}

type UploadedSongArtifact = {
  song_artifact_upload_id: string
  community_id: string
  uploader_user_id: string
  artifact_kind: "primary_audio" | "cover_art" | "preview_audio" | "canvas_video" | "instrumental_audio" | "vocal_audio"
  status: "pending_upload" | "uploaded" | "failed"
  storage_ref: string
  mime_type: string
  filename: string | null
  size_bytes: number | null
  content_hash: string | null
  storage_provider: "filebase" | "local_stub" | null
  storage_bucket: string | null
  storage_object_key: string | null
  storage_endpoint: string | null
  gateway_url: string | null
  upload_url: string
}

export function buildUploadBytes(seed: string): Uint8Array {
  return new TextEncoder().encode(seed)
}

function buildWavBytes(durationMs: number, sampleRate = 8_000): Uint8Array {
  const channelCount = 1
  const bytesPerSample = 2
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const dataSize = sampleCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
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

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const offset = 44 + (sampleIndex * bytesPerSample)
    const amplitude = Math.round(Math.sin((sampleIndex / sampleRate) * 2 * Math.PI * 440) * 0x1fff)
    view.setInt16(offset, amplitude, true)
  }

  return new Uint8Array(buffer)
}

export async function createCompletedSongArtifactUpload(input: {
  env: Env
  accessToken: string
  communityId: string
  artifactKind: UploadedSongArtifact["artifact_kind"]
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
  expect(created.status).toBe("pending_upload")
  expect(created.size_bytes).toBe(sizeBytes)
  expect(created.content_hash).toBe(contentHash)

  const uploadResponse = await requestBytes(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads/${created.song_artifact_upload_id}/content`,
    input.bytes,
    input.env,
    input.accessToken,
    "PUT",
    input.mimeType,
  )
  expect(uploadResponse.status).toBe(200)
  const uploaded = await json(uploadResponse) as UploadedSongArtifact
  expect(uploaded.status).toBe("uploaded")
  expect(uploaded.size_bytes).toBe(sizeBytes)
  expect(uploaded.content_hash).toBe(contentHash)
  return uploaded
}

export async function setPassportWalletScore(
  env: Env,
  userId: string,
  input: {
    score: number
    scoreThreshold: number
    passingScore: boolean
  },
): Promise<void> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const capabilities = buildDefaultVerificationCapabilities()
    capabilities.wallet_score = {
      state: "verified",
      provider: "passport",
      proof_type: "wallet_score",
      mechanism: "stamps-api-v2",
      verified_at: new Date().toISOString(),
      score: input.score,
      score_threshold: input.scoreThreshold,
      passing_score: input.passingScore,
      last_score_timestamp: new Date().toISOString(),
      expiration_timestamp: null,
      stamps: null,
    }

    await client.execute({
      sql: `
        UPDATE users
        SET verification_capabilities_json = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, JSON.stringify(capabilities), new Date().toISOString()],
    })
  } finally {
    client.close()
  }
}

export async function setPrimaryWalletAttachment(
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
          ?1, ?2, 'eip155:84532', ?3, ?3,
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
