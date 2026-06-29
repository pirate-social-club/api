import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import type { QueryResultRow } from "../../sql-client"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { LiveRoomExecutor } from "./store"

export type LiveRoomReplayAssetAccessMode = "free" | "included_with_ticket" | "paid"
export type LiveRoomReplayAssetPublicationStatus = "draft" | "published" | "failed"

export type LiveRoomReplayAsset = {
  replay_asset_id: string
  community_id: string
  live_room_id: string
  source_recording_id: string
  publication_status: LiveRoomReplayAssetPublicationStatus
  title: string
  caption: string | null
  duration_ms: number | null
  preview_ref: string | null
  access_mode: LiveRoomReplayAssetAccessMode
  primary_content_ref: string
  locked_delivery_status: "none" | "requested" | "ready" | "failed"
  locked_delivery_storage_ref: string | null
  story_cdr_vault_uuid: string | null
  locked_delivery_secret_json: string | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_error: string | null
  published_at: string | null
  created_at: string
  updated_at: string
}

export type LiveRoomReplayAllocation = {
  allocation_id: string
  replay_asset_id: string
  community_id: string
  participant_user_id: string | null
  external_party_ref: string | null
  role: string
  share_bps: number
  rights_basis: string
  approval_status: "pending" | "approved" | "rejected"
}

export async function getLiveRoomReplayAsset(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
}): Promise<LiveRoomReplayAsset | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT replay_asset_id, community_id, live_room_id, source_recording_id,
             publication_status, title, caption, duration_ms, preview_ref,
             access_mode, primary_content_ref, locked_delivery_status,
             locked_delivery_storage_ref, story_cdr_vault_uuid,
             locked_delivery_secret_json, story_namespace, story_entitlement_token_id,
             story_read_condition, story_write_condition, locked_delivery_error,
             published_at,
             created_at, updated_at
      FROM live_room_replay_assets
      WHERE community_id = ?1
        AND live_room_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.liveRoomId],
  }) as QueryResultRow | null
  return row ? rowToReplayAsset(row) : null
}

export async function getLiveRoomReplayAssetById(input: {
  client: LiveRoomExecutor
  communityId: string
  replayAssetId: string
}): Promise<LiveRoomReplayAsset | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT replay_asset_id, community_id, live_room_id, source_recording_id,
             publication_status, title, caption, duration_ms, preview_ref,
             access_mode, primary_content_ref, locked_delivery_status,
             locked_delivery_storage_ref, story_cdr_vault_uuid,
             locked_delivery_secret_json, story_namespace, story_entitlement_token_id,
             story_read_condition, story_write_condition, locked_delivery_error,
             published_at,
             created_at, updated_at
      FROM live_room_replay_assets
      WHERE community_id = ?1
        AND replay_asset_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.replayAssetId],
  }) as QueryResultRow | null
  return row ? rowToReplayAsset(row) : null
}

export async function listLiveRoomReplayAllocations(input: {
  client: LiveRoomExecutor
  communityId: string
  replayAssetId: string
}): Promise<LiveRoomReplayAllocation[]> {
  const result = await input.client.execute({
    sql: `
      SELECT allocation_id, replay_asset_id, community_id, participant_user_id,
             external_party_ref, role, share_bps, rights_basis, approval_status
      FROM live_room_replay_allocations
      WHERE community_id = ?1
        AND replay_asset_id = ?2
      ORDER BY CASE role WHEN 'host' THEN 0 WHEN 'guest' THEN 1 ELSE 2 END,
               allocation_id ASC
    `,
    args: [input.communityId, input.replayAssetId],
  })
  return result.rows.map((row) => rowToReplayAllocation(row as QueryResultRow))
}

export async function createDraftLiveRoomReplayAsset(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  sourceRecordingId: string
  title: string
  primaryContentRef: string
  now: string
}): Promise<LiveRoomReplayAsset> {
  const existing = await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
  if (existing) {
    return existing
  }

  const replayAssetId = makeId("lra")
  await input.client.execute({
    sql: `
      INSERT INTO live_room_replay_assets (
        replay_asset_id, community_id, live_room_id, source_recording_id,
        publication_status, title, caption, duration_ms, preview_ref, access_mode,
        primary_content_ref, locked_delivery_status, locked_delivery_storage_ref,
        story_cdr_vault_uuid, locked_delivery_secret_json, story_namespace,
        story_entitlement_token_id, story_read_condition, story_write_condition,
        locked_delivery_error, published_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        'draft', ?5, NULL, NULL, NULL, 'free',
        ?6, 'none', NULL,
        NULL, NULL, NULL,
        NULL, NULL, NULL,
        NULL, NULL, ?7, ?7
      )
    `,
    args: [
      replayAssetId,
      input.communityId,
      input.liveRoomId,
      input.sourceRecordingId,
      input.title,
      input.primaryContentRef,
      input.now,
    ],
  })
  await input.client.execute({
    sql: `
      UPDATE live_rooms
      SET replay_asset_id = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_asset_id IS NULL
    `,
    args: [input.communityId, input.liveRoomId, replayAssetId, input.now],
  })
  await copyLiveAllocationsToReplay({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
    replayAssetId,
    now: input.now,
  })
  const created = await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
  if (!created) {
    throw new Error("Replay asset was not created")
  }
  return created
}

export async function publishFreeLiveRoomReplayAsset(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  now: string
}): Promise<LiveRoomReplayAsset | null> {
  const asset = await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
  if (!asset || asset.access_mode !== "free") {
    return null
  }
  await input.client.execute({
    sql: `
      UPDATE live_room_replay_assets
      SET publication_status = 'published',
          published_at = COALESCE(published_at, ?4),
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_asset_id = ?3
        AND publication_status = 'draft'
    `,
    args: [input.communityId, input.liveRoomId, asset.replay_asset_id, input.now],
  })
  await input.client.execute({
    sql: `
      UPDATE live_rooms
      SET replay_status = 'published',
          replay_asset_id = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_status = 'review_pending'
    `,
    args: [input.communityId, input.liveRoomId, asset.replay_asset_id, input.now],
  })
  return await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
}

export async function publishLockedIncludedTicketLiveRoomReplayAsset(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  replayAssetId: string
  lockedDeliveryStorageRef: string
  lockedDeliveryMetadataJson: string
  storyCdrVaultUuid: number
  storyNamespace: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  now: string
}): Promise<LiveRoomReplayAsset | null> {
  await input.client.execute({
    sql: `
      UPDATE live_room_replay_assets
      SET publication_status = 'published',
          access_mode = 'included_with_ticket',
          locked_delivery_status = 'ready',
          locked_delivery_storage_ref = ?4,
          locked_delivery_secret_json = ?5,
          story_cdr_vault_uuid = ?6,
          story_namespace = ?7,
          story_entitlement_token_id = ?8,
          story_read_condition = ?9,
          story_write_condition = ?10,
          locked_delivery_error = NULL,
          published_at = COALESCE(published_at, ?11),
          updated_at = ?11
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_asset_id = ?3
        AND publication_status = 'draft'
        AND access_mode = 'included_with_ticket'
    `,
    args: [
      input.communityId,
      input.liveRoomId,
      input.replayAssetId,
      input.lockedDeliveryStorageRef,
      input.lockedDeliveryMetadataJson,
      String(input.storyCdrVaultUuid),
      input.storyNamespace,
      input.storyEntitlementTokenId,
      input.storyReadCondition,
      input.storyWriteCondition,
      input.now,
    ],
  })
  await input.client.execute({
    sql: `
      UPDATE live_rooms
      SET replay_status = 'published',
          replay_asset_id = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_status = 'review_pending'
    `,
    args: [input.communityId, input.liveRoomId, input.replayAssetId, input.now],
  })
  return await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
}

export async function publishLockedPaidLiveRoomReplayAsset(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  replayAssetId: string
  replayListingId: string
  lockedDeliveryStorageRef: string
  lockedDeliveryMetadataJson: string
  storyCdrVaultUuid: number
  storyNamespace: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  now: string
}): Promise<LiveRoomReplayAsset | null> {
  await input.client.execute({
    sql: `
      UPDATE live_room_replay_assets
      SET publication_status = 'published',
          access_mode = 'paid',
          locked_delivery_status = 'ready',
          locked_delivery_storage_ref = ?4,
          locked_delivery_secret_json = ?5,
          story_cdr_vault_uuid = ?6,
          story_namespace = ?7,
          story_entitlement_token_id = ?8,
          story_read_condition = ?9,
          story_write_condition = ?10,
          locked_delivery_error = NULL,
          published_at = COALESCE(published_at, ?11),
          updated_at = ?11
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_asset_id = ?3
        AND publication_status = 'draft'
        AND access_mode = 'paid'
    `,
    args: [
      input.communityId,
      input.liveRoomId,
      input.replayAssetId,
      input.lockedDeliveryStorageRef,
      input.lockedDeliveryMetadataJson,
      String(input.storyCdrVaultUuid),
      input.storyNamespace,
      input.storyEntitlementTokenId,
      input.storyReadCondition,
      input.storyWriteCondition,
      input.now,
    ],
  })
  await input.client.execute({
    sql: `
      UPDATE live_rooms
      SET replay_status = 'published',
          replay_asset_id = ?3,
          replay_listing_id = ?4,
          updated_at = ?5
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_status = 'review_pending'
    `,
    args: [input.communityId, input.liveRoomId, input.replayAssetId, input.replayListingId, input.now],
  })
  return await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
}

export async function updateDraftLiveRoomReplayAsset(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  now: string
  title?: string
  caption?: string | null
  previewRef?: string | null
  accessMode?: LiveRoomReplayAssetAccessMode
  allocations?: Array<{
    participantUserId: string | null
    externalPartyRef: string | null
    role: string
    shareBps: number
    rightsBasis?: string
    approvalStatus?: LiveRoomReplayAllocation["approval_status"]
  }>
}): Promise<LiveRoomReplayAsset | null> {
  const asset = await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
  if (!asset || asset.publication_status !== "draft") {
    return null
  }

  await input.client.execute({
    sql: `
      UPDATE live_room_replay_assets
      SET title = COALESCE(?4, title),
          caption = CASE WHEN ?5 IS NULL THEN caption ELSE ?6 END,
          preview_ref = CASE WHEN ?7 IS NULL THEN preview_ref ELSE ?8 END,
          access_mode = COALESCE(?9, access_mode),
          updated_at = ?10
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_asset_id = ?3
        AND publication_status = 'draft'
    `,
    args: [
      input.communityId,
      input.liveRoomId,
      asset.replay_asset_id,
      input.title ?? null,
      Object.prototype.hasOwnProperty.call(input, "caption") ? 1 : null,
      input.caption ?? null,
      Object.prototype.hasOwnProperty.call(input, "previewRef") ? 1 : null,
      input.previewRef ?? null,
      input.accessMode ?? null,
      input.now,
    ],
  })

  if (input.allocations) {
    await input.client.execute({
      sql: `
        DELETE FROM live_room_replay_allocations
        WHERE community_id = ?1
          AND replay_asset_id = ?2
      `,
      args: [input.communityId, asset.replay_asset_id],
    })
    for (const allocation of input.allocations) {
      await input.client.execute({
        sql: `
          INSERT INTO live_room_replay_allocations (
            allocation_id, replay_asset_id, community_id, participant_user_id,
            external_party_ref, role, share_bps, rights_basis, approval_status,
            created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4,
            ?5, ?6, ?7, ?8, ?9,
            ?10, ?10
          )
        `,
        args: [
          makeId("lral"),
          asset.replay_asset_id,
          input.communityId,
          allocation.participantUserId,
          allocation.externalPartyRef,
          allocation.role,
          allocation.shareBps,
          allocation.rightsBasis ?? "host_draft",
          allocation.approvalStatus ?? "approved",
          input.now,
        ],
      })
    }
  }

  return await getLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
  })
}

async function copyLiveAllocationsToReplay(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  replayAssetId: string
  now: string
}): Promise<void> {
  const result = await input.client.execute({
    sql: `
      SELECT user_id, role, share_bps
      FROM live_room_performer_allocations
      WHERE community_id = ?1
        AND live_room_id = ?2
      ORDER BY CASE role WHEN 'host' THEN 0 ELSE 1 END
    `,
    args: [input.communityId, input.liveRoomId],
  })
  for (const row of result.rows) {
    await input.client.execute({
      sql: `
        INSERT INTO live_room_replay_allocations (
          allocation_id, replay_asset_id, community_id, participant_user_id,
          external_party_ref, role, share_bps, rights_basis, approval_status,
          created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4,
          NULL, ?5, ?6, 'performer_default', 'approved',
          ?7, ?7
        )
      `,
      args: [
        makeId("lral"),
        input.replayAssetId,
        input.communityId,
        requiredString(row as QueryResultRow, "user_id"),
        requiredString(row as QueryResultRow, "role"),
        Number(rowValue(row as QueryResultRow, "share_bps") ?? 0),
        input.now,
      ],
    })
  }
}

function rowToReplayAsset(row: QueryResultRow): LiveRoomReplayAsset {
  return {
    replay_asset_id: requiredString(row, "replay_asset_id"),
    community_id: requiredString(row, "community_id"),
    live_room_id: requiredString(row, "live_room_id"),
    source_recording_id: requiredString(row, "source_recording_id"),
    publication_status: requiredString(row, "publication_status") as LiveRoomReplayAssetPublicationStatus,
    title: requiredString(row, "title"),
    caption: stringOrNull(rowValue(row, "caption")),
    duration_ms: numberOrNull(rowValue(row, "duration_ms")),
    preview_ref: stringOrNull(rowValue(row, "preview_ref")),
    access_mode: requiredString(row, "access_mode") as LiveRoomReplayAssetAccessMode,
    primary_content_ref: requiredString(row, "primary_content_ref"),
    locked_delivery_status: requiredString(row, "locked_delivery_status") as LiveRoomReplayAsset["locked_delivery_status"],
    locked_delivery_storage_ref: stringOrNull(rowValue(row, "locked_delivery_storage_ref")),
    story_cdr_vault_uuid: stringOrNull(rowValue(row, "story_cdr_vault_uuid")),
    locked_delivery_secret_json: stringOrNull(rowValue(row, "locked_delivery_secret_json")),
    story_namespace: stringOrNull(rowValue(row, "story_namespace")),
    story_entitlement_token_id: stringOrNull(rowValue(row, "story_entitlement_token_id")),
    story_read_condition: stringOrNull(rowValue(row, "story_read_condition")),
    story_write_condition: stringOrNull(rowValue(row, "story_write_condition")),
    locked_delivery_error: stringOrNull(rowValue(row, "locked_delivery_error")),
    published_at: stringOrNull(rowValue(row, "published_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function rowToReplayAllocation(row: QueryResultRow): LiveRoomReplayAllocation {
  return {
    allocation_id: requiredString(row, "allocation_id"),
    replay_asset_id: requiredString(row, "replay_asset_id"),
    community_id: requiredString(row, "community_id"),
    participant_user_id: stringOrNull(rowValue(row, "participant_user_id")),
    external_party_ref: stringOrNull(rowValue(row, "external_party_ref")),
    role: requiredString(row, "role"),
    share_bps: Number(rowValue(row, "share_bps") ?? 0),
    rights_basis: requiredString(row, "rights_basis"),
    approval_status: requiredString(row, "approval_status") as LiveRoomReplayAllocation["approval_status"],
  }
}
