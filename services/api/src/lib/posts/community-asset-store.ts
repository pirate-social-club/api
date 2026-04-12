import { createHash } from "node:crypto"
import type { Client, Transaction } from "@libsql/client"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Asset, MediaDescriptor, Post } from "../../types"

export type LockedDeliveryPayload = {
  kind: "song.locked_delivery.v1"
  version: 1
  encrypted_blob_ref: string
  encrypted_blob_hash: string | null
  encrypted_blob_size_bytes: number
  algorithm: "aes-256-gcm"
  iv_base64: string
  auth_tag_base64: string
  content_key_base64: string
  source_mime_type: string
  source_size_bytes: number | null
  source_content_hash: string | null
  source_storage_ref: string
}

type AssetRow = {
  asset_id: string
  community_id: string
  source_post_id: string
  song_artifact_bundle_id: string | null
  creator_user_id: string
  asset_kind: Asset["asset_kind"]
  rights_basis: Asset["rights_basis"]
  access_mode: Asset["access_mode"]
  primary_content_ref: string
  primary_content_hash: string | null
  preview_audio_json: string | null
  cover_art_json: string | null
  canvas_video_json: string | null
  publication_status: Asset["publication_status"]
  story_status: Asset["story_status"]
  story_error: string | null
  story_ip_id: string | null
  story_ip_nft_contract: string | null
  story_ip_nft_token_id: string | null
  story_publish_tx_ref: string | null
  story_publish_model: Asset["story_publish_model"]
  story_asset_version_id: string | null
  story_license_terms_id: string | null
  story_license_template: string | null
  story_royalty_policy: string | null
  story_derivative_registered_at: string | null
  story_revenue_token: string | null
  story_cdr_vault_uuid: number | null
  story_cdr_encrypted_cid: string | null
  story_cdr_allocate_tx_ref: string | null
  story_cdr_write_tx_ref: string | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_status: Asset["locked_delivery_status"]
  locked_delivery_ref: string | null
  locked_delivery_payload_json: string | null
  locked_delivery_error: string | null
  created_at: string
  updated_at: string
}

type AssetExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

function parseJson<T>(value: string | null): T | null {
  if (value == null) {
    return null
  }
  return JSON.parse(value) as T
}

function toAssetRow(row: unknown): AssetRow {
  return {
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    rights_basis: requiredString(row, "rights_basis") as Asset["rights_basis"],
    access_mode: requiredString(row, "access_mode") as Asset["access_mode"],
    primary_content_ref: requiredString(row, "primary_content_ref"),
    primary_content_hash: stringOrNull(rowValue(row, "primary_content_hash")),
    preview_audio_json: stringOrNull(rowValue(row, "preview_audio_json")),
    cover_art_json: stringOrNull(rowValue(row, "cover_art_json")),
    canvas_video_json: stringOrNull(rowValue(row, "canvas_video_json")),
    publication_status: requiredString(row, "publication_status") as Asset["publication_status"],
    story_status: requiredString(row, "story_status") as Asset["story_status"],
    story_error: stringOrNull(rowValue(row, "story_error")),
    story_ip_id: stringOrNull(rowValue(row, "story_ip_id")),
    story_ip_nft_contract: stringOrNull(rowValue(row, "story_ip_nft_contract")),
    story_ip_nft_token_id: stringOrNull(rowValue(row, "story_ip_nft_token_id")),
    story_publish_tx_ref: stringOrNull(rowValue(row, "story_publish_tx_ref")),
    story_publish_model: requiredString(row, "story_publish_model") as Asset["story_publish_model"],
    story_asset_version_id: stringOrNull(rowValue(row, "story_asset_version_id")),
    story_license_terms_id: stringOrNull(rowValue(row, "story_license_terms_id")),
    story_license_template: stringOrNull(rowValue(row, "story_license_template")),
    story_royalty_policy: stringOrNull(rowValue(row, "story_royalty_policy")),
    story_derivative_registered_at: stringOrNull(rowValue(row, "story_derivative_registered_at")),
    story_revenue_token: stringOrNull(rowValue(row, "story_revenue_token")),
    story_cdr_vault_uuid: rowValue(row, "story_cdr_vault_uuid") == null ? null : Number(rowValue(row, "story_cdr_vault_uuid")),
    story_cdr_encrypted_cid: stringOrNull(rowValue(row, "story_cdr_encrypted_cid")),
    story_cdr_allocate_tx_ref: stringOrNull(rowValue(row, "story_cdr_allocate_tx_ref")),
    story_cdr_write_tx_ref: stringOrNull(rowValue(row, "story_cdr_write_tx_ref")),
    story_namespace: stringOrNull(rowValue(row, "story_namespace")),
    story_entitlement_token_id: stringOrNull(rowValue(row, "story_entitlement_token_id")),
    story_read_condition: stringOrNull(rowValue(row, "story_read_condition")),
    story_write_condition: stringOrNull(rowValue(row, "story_write_condition")),
    locked_delivery_status: requiredString(row, "locked_delivery_status") as Asset["locked_delivery_status"],
    locked_delivery_ref: stringOrNull(rowValue(row, "locked_delivery_ref")),
    locked_delivery_payload_json: stringOrNull(rowValue(row, "locked_delivery_payload_json")),
    locked_delivery_error: stringOrNull(rowValue(row, "locked_delivery_error")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function serializeAsset(row: AssetRow): Asset {
  const {
    preview_audio_json,
    cover_art_json,
    canvas_video_json,
    ...rest
  } = row
  return {
    ...rest,
    preview_audio: parseJson<MediaDescriptor>(preview_audio_json),
    cover_art: parseJson<MediaDescriptor>(cover_art_json),
    canvas_video: parseJson<MediaDescriptor>(canvas_video_json),
  }
}

function hashBytes32(value: string): string {
  return `0x${createHash("sha256").update(value).digest("hex")}`
}

async function getAssetById(client: AssetExecutor, assetId: string): Promise<Asset | null> {
  const result = await client.execute({
    sql: `
      SELECT asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id,
             asset_kind, rights_basis, access_mode, primary_content_ref, primary_content_hash,
             preview_audio_json, cover_art_json, canvas_video_json,
             publication_status, story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
             story_publish_tx_ref, story_publish_model, story_asset_version_id,
             story_license_terms_id, story_license_template, story_royalty_policy, story_derivative_registered_at, story_revenue_token,
             story_cdr_vault_uuid, story_cdr_encrypted_cid, story_cdr_allocate_tx_ref, story_cdr_write_tx_ref,
             story_namespace, story_entitlement_token_id, story_read_condition, story_write_condition,
             locked_delivery_status, locked_delivery_ref, locked_delivery_payload_json, locked_delivery_error,
             created_at, updated_at
      FROM assets
      WHERE asset_id = ?1
      LIMIT 1
    `,
    args: [assetId],
  })
  const row = result.rows[0]
  return row ? serializeAsset(toAssetRow(row)) : null
}

export async function listAssetsPendingStoryPublish(input: {
  client: AssetExecutor
  limit: number
  staleBefore?: string | null
}): Promise<Asset[]> {
  const result = await input.client.execute({
    sql: `
      SELECT asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id,
             asset_kind, rights_basis, access_mode, primary_content_ref, primary_content_hash,
             preview_audio_json, cover_art_json, canvas_video_json,
             publication_status, story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
             story_publish_tx_ref, story_publish_model, story_asset_version_id,
             story_license_terms_id, story_license_template, story_royalty_policy, story_derivative_registered_at, story_revenue_token,
             story_cdr_vault_uuid, story_cdr_encrypted_cid, story_cdr_allocate_tx_ref, story_cdr_write_tx_ref,
             story_namespace, story_entitlement_token_id, story_read_condition, story_write_condition,
             locked_delivery_status, locked_delivery_ref, locked_delivery_payload_json, locked_delivery_error,
             created_at, updated_at
      FROM assets
      WHERE (
        (
          story_status IN ('none', 'failed')
          AND publication_status IN ('draft', 'story_failed')
          AND (access_mode = 'public' OR locked_delivery_status = 'ready')
        )
        OR (
          ?2 IS NOT NULL
          AND story_status = 'requested'
          AND publication_status = 'story_requested'
          AND (access_mode = 'public' OR locked_delivery_status = 'ready')
          AND updated_at <= ?2
        )
      )
      ORDER BY created_at ASC, asset_id ASC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.trunc(input.limit)), input.staleBefore ?? null],
  })
  return result.rows.map((row) => serializeAsset(toAssetRow(row)))
}

export async function claimAssetForStoryPublish(input: {
  client: AssetExecutor
  assetId: string
  staleBefore?: string | null
  updatedAt: string
}): Promise<Asset | null> {
  const result = await input.client.execute({
    sql: `
      UPDATE assets
      SET publication_status = 'story_requested',
          story_status = 'requested',
          story_error = NULL,
          updated_at = ?2
      WHERE asset_id = ?1
        AND (
          (
            story_status IN ('none', 'failed')
            AND publication_status IN ('draft', 'story_failed')
            AND (access_mode = 'public' OR locked_delivery_status = 'ready')
          )
          OR (
            ?3 IS NOT NULL
            AND story_status = 'requested'
            AND publication_status = 'story_requested'
            AND (access_mode = 'public' OR locked_delivery_status = 'ready')
            AND updated_at <= ?3
          )
        )
    `,
    args: [input.assetId, input.updatedAt, input.staleBefore ?? null],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getAssetById(input.client, input.assetId)
}

export async function completeAssetStoryPublish(input: {
  client: AssetExecutor
  assetId: string
  storyIpId: string
  storyIpNftContract: string | null
  storyIpNftTokenId: string | null
  storyPublishTxRef: string | null
  storyPublishModel: Asset["story_publish_model"]
  updatedAt: string
}): Promise<Asset | null> {
  const result = await input.client.execute({
    sql: `
      UPDATE assets
      SET publication_status = 'story_published',
          story_status = 'published',
          story_error = NULL,
          story_ip_id = ?2,
          story_ip_nft_contract = ?3,
          story_ip_nft_token_id = ?4,
          story_publish_tx_ref = ?5,
          story_publish_model = ?6,
          updated_at = ?7
      WHERE asset_id = ?1
        AND story_status = 'requested'
        AND publication_status = 'story_requested'
    `,
    args: [
      input.assetId,
      input.storyIpId,
      input.storyIpNftContract,
      input.storyIpNftTokenId,
      input.storyPublishTxRef,
      input.storyPublishModel,
      input.updatedAt,
    ],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getAssetById(input.client, input.assetId)
}

export async function failAssetStoryPublish(input: {
  client: AssetExecutor
  assetId: string
  error: string
  updatedAt: string
}): Promise<Asset | null> {
  const result = await input.client.execute({
    sql: `
      UPDATE assets
      SET publication_status = 'story_failed',
          story_status = 'failed',
          story_error = ?2,
          updated_at = ?3
      WHERE asset_id = ?1
        AND story_status = 'requested'
        AND publication_status = 'story_requested'
    `,
    args: [input.assetId, input.error, input.updatedAt],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getAssetById(input.client, input.assetId)
}

export async function createSongAssetDraft(input: {
  client: AssetExecutor
  communityId: string
  sourcePostId: string
  songArtifactBundleId: string | null
  creatorUserId: string
  rightsBasis: Post["rights_basis"]
  accessMode: Asset["access_mode"]
  primaryMediaRef: MediaDescriptor
  previewAudio?: MediaDescriptor | null
  coverArt?: MediaDescriptor | null
  canvasVideo?: MediaDescriptor | null
  createdAt: string
}): Promise<Asset> {
  const assetId = makeId("ast")
  const storyAssetVersionId = hashBytes32(`asset:${assetId}`)
  const storyNamespace = hashBytes32(`community:${input.communityId}`)
  await input.client.execute({
    sql: `
      INSERT INTO assets (
        asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id,
        asset_kind, rights_basis, access_mode, primary_content_ref, primary_content_hash,
        preview_audio_json, cover_art_json, canvas_video_json,
        publication_status, story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
        story_publish_tx_ref, story_publish_model, story_asset_version_id,
        story_license_terms_id, story_license_template, story_royalty_policy, story_derivative_registered_at, story_revenue_token,
        story_cdr_vault_uuid, story_cdr_encrypted_cid, story_cdr_allocate_tx_ref, story_cdr_write_tx_ref,
        story_namespace, story_entitlement_token_id,
        story_read_condition, story_write_condition,
        locked_delivery_status, locked_delivery_ref, locked_delivery_payload_json, locked_delivery_error,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        'song_audio', ?6, ?7, ?8, ?9,
        ?10, ?11, ?12,
        'draft', 'none', NULL, NULL, NULL, NULL,
        NULL, 'pirate_v1', ?13,
        NULL, NULL, NULL, NULL, NULL,
        NULL, NULL, NULL, NULL,
        ?14, NULL,
        NULL, NULL,
        ?15, NULL, NULL, NULL,
        ?16, ?16
      )
    `,
    args: [
      assetId,
      input.communityId,
      input.sourcePostId,
      input.songArtifactBundleId,
      input.creatorUserId,
      input.rightsBasis ?? "none",
      input.accessMode,
      input.primaryMediaRef.storage_ref,
      input.primaryMediaRef.content_hash ?? null,
      input.previewAudio ? JSON.stringify(input.previewAudio) : null,
      input.coverArt ? JSON.stringify(input.coverArt) : null,
      input.canvasVideo ? JSON.stringify(input.canvasVideo) : null,
      storyAssetVersionId,
      storyNamespace,
      "none",
      input.createdAt,
    ],
  })

  const asset = await getAssetById(input.client, assetId)
  if (!asset) {
    throw internalError("Asset row is missing after insert")
  }
  return asset
}

export async function updateAssetRightsBasis(input: {
  client: AssetExecutor
  assetId: string
  rightsBasis: Post["rights_basis"]
  updatedAt: string
}): Promise<Asset | null> {
  await input.client.execute({
    sql: `
      UPDATE assets
      SET rights_basis = ?2,
          updated_at = ?3
      WHERE asset_id = ?1
    `,
    args: [input.assetId, input.rightsBasis ?? "none", input.updatedAt],
  })
  return await getAssetById(input.client, input.assetId)
}

export async function deleteAssetsBySourcePostId(input: {
  client: AssetExecutor
  sourcePostId: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      DELETE FROM assets
      WHERE source_post_id = ?1
    `,
    args: [input.sourcePostId],
  })
}

export async function getCommunityAssetById(input: {
  client: AssetExecutor
  assetId: string
}): Promise<Asset | null> {
  return await getAssetById(input.client, input.assetId)
}

export async function listAssetsPendingLockedDelivery(input: {
  client: AssetExecutor
  limit: number
  staleBefore?: string | null
}): Promise<Asset[]> {
  const result = await input.client.execute({
    sql: `
      SELECT asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id,
             asset_kind, rights_basis, access_mode, primary_content_ref, primary_content_hash,
             preview_audio_json, cover_art_json, canvas_video_json,
             publication_status, story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
             story_publish_tx_ref, story_publish_model, story_asset_version_id,
             story_license_terms_id, story_license_template, story_royalty_policy, story_derivative_registered_at, story_revenue_token,
             story_cdr_vault_uuid, story_cdr_encrypted_cid, story_cdr_allocate_tx_ref, story_cdr_write_tx_ref,
             story_namespace, story_entitlement_token_id, story_read_condition, story_write_condition,
             locked_delivery_status, locked_delivery_ref, locked_delivery_payload_json, locked_delivery_error,
             created_at, updated_at
      FROM assets
      WHERE access_mode = 'locked'
        AND (
          locked_delivery_status IN ('none', 'failed')
          OR (
            ?2 IS NOT NULL
            AND locked_delivery_status = 'requested'
            AND updated_at <= ?2
          )
        )
      ORDER BY created_at ASC, asset_id ASC
      LIMIT ?1
    `,
    args: [Math.max(1, Math.trunc(input.limit)), input.staleBefore ?? null],
  })
  return result.rows.map((row) => serializeAsset(toAssetRow(row)))
}

export async function claimAssetForLockedDelivery(input: {
  client: AssetExecutor
  assetId: string
  staleBefore?: string | null
  updatedAt: string
}): Promise<Asset | null> {
  const result = await input.client.execute({
    sql: `
      UPDATE assets
      SET locked_delivery_status = 'requested',
          locked_delivery_error = NULL,
          updated_at = ?2
      WHERE asset_id = ?1
        AND access_mode = 'locked'
        AND (
          locked_delivery_status IN ('none', 'failed')
          OR (
            ?3 IS NOT NULL
            AND locked_delivery_status = 'requested'
            AND updated_at <= ?3
          )
        )
    `,
    args: [input.assetId, input.updatedAt, input.staleBefore ?? null],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getAssetById(input.client, input.assetId)
}

export async function completeAssetLockedDelivery(input: {
  client: AssetExecutor
  assetId: string
  lockedDeliveryRef: string
  lockedDeliveryPayload: LockedDeliveryPayload | null
  storyCdrVaultUuid: number
  storyCdrEncryptedCid?: string | null
  storyCdrAllocateTxRef?: string | null
  storyCdrWriteTxRef?: string | null
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  updatedAt: string
}): Promise<Asset | null> {
  const result = await input.client.execute({
    sql: `
      UPDATE assets
      SET locked_delivery_status = 'ready',
          locked_delivery_ref = ?2,
          locked_delivery_payload_json = ?3,
          locked_delivery_error = NULL,
          story_cdr_vault_uuid = ?4,
          story_cdr_encrypted_cid = ?5,
          story_cdr_allocate_tx_ref = ?6,
          story_cdr_write_tx_ref = ?7,
          story_entitlement_token_id = ?8,
          story_read_condition = ?9,
          story_write_condition = ?10,
          updated_at = ?11
      WHERE asset_id = ?1
        AND access_mode = 'locked'
        AND locked_delivery_status = 'requested'
    `,
    args: [
      input.assetId,
      input.lockedDeliveryRef,
      input.lockedDeliveryPayload ? JSON.stringify(input.lockedDeliveryPayload) : null,
      input.storyCdrVaultUuid,
      input.storyCdrEncryptedCid ?? null,
      input.storyCdrAllocateTxRef ?? null,
      input.storyCdrWriteTxRef ?? null,
      input.storyEntitlementTokenId,
      input.storyReadCondition,
      input.storyWriteCondition,
      input.updatedAt,
    ],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getAssetById(input.client, input.assetId)
}

export async function failAssetLockedDelivery(input: {
  client: AssetExecutor
  assetId: string
  error: string
  updatedAt: string
}): Promise<Asset | null> {
  const result = await input.client.execute({
    sql: `
      UPDATE assets
      SET locked_delivery_status = 'failed',
          locked_delivery_payload_json = NULL,
          story_cdr_encrypted_cid = NULL,
          story_cdr_allocate_tx_ref = NULL,
          story_cdr_write_tx_ref = NULL,
          locked_delivery_error = ?2,
          updated_at = ?3
      WHERE asset_id = ?1
        AND access_mode = 'locked'
        AND locked_delivery_status = 'requested'
    `,
    args: [input.assetId, input.error, input.updatedAt],
  })
  if (result.rowsAffected === 0) {
    return null
  }
  return await getAssetById(input.client, input.assetId)
}

export async function getAssetLockedDeliveryPayloadById(input: {
  client: AssetExecutor
  assetId: string
}): Promise<LockedDeliveryPayload | null> {
  const result = await input.client.execute({
    sql: `
      SELECT locked_delivery_payload_json
      FROM assets
      WHERE asset_id = ?1
      LIMIT 1
    `,
    args: [input.assetId],
  })
  const row = result.rows[0]
  const raw = row ? stringOrNull(rowValue(row, "locked_delivery_payload_json")) : null
  return raw ? parseJson<LockedDeliveryPayload>(raw) : null
}

export async function createDerivativeLink(input: {
  client: AssetExecutor
  assetId: string
  upstreamAssetId: string
  relationshipType: "remix_of" | "references_song" | "inspired_by" | "samples"
  createdAt: string
}): Promise<void> {
  const linkId = makeId("adl")
  await input.client.execute({
    sql: `
      INSERT INTO asset_derivative_links (
        asset_derivative_link_id, asset_id, upstream_asset_id, relationship_type, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5)
    `,
    args: [linkId, input.assetId, input.upstreamAssetId, input.relationshipType, input.createdAt],
  })
}

export async function listDerivativeLinksForAsset(input: {
  client: AssetExecutor
  assetId: string
}): Promise<Array<{ asset_derivative_link_id: string; upstream_asset_id: string; relationship_type: string }>> {
  const result = await input.client.execute({
    sql: `
      SELECT asset_derivative_link_id, upstream_asset_id, relationship_type
      FROM asset_derivative_links
      WHERE asset_id = ?1
    `,
    args: [input.assetId],
  })
  return result.rows.map((row) => ({
    asset_derivative_link_id: requiredString(row, "asset_derivative_link_id"),
    upstream_asset_id: requiredString(row, "upstream_asset_id"),
    relationship_type: requiredString(row, "relationship_type"),
  }))
}
