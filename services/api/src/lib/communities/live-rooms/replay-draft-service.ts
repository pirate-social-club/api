import type { Env } from "../../../env"
import type { CreateCommunityListingRequest } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { badRequestError, conflictError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { decodePublicUserId, publicId } from "../../public-ids"
import { withTransaction } from "../../transactions"
import {
  insertCommunityListingRow,
  prepareCommunityListingWrite,
} from "../commerce/listing-service"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import {
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { prepareIncludedTicketReplayDelivery } from "./locked-replay-delivery"
import { type LiveRoomRecordingRawArtifactRef } from "./recording-ingest"
import { getLiveRoomRecording } from "./recordings"
import {
  getLiveRoomReplayAsset,
  listLiveRoomReplayAllocations,
  markLiveRoomReplayAssetLockedDeliveryFailed,
  publishFreeLiveRoomReplayAsset,
  publishLockedIncludedTicketLiveRoomReplayAsset,
  publishLockedPaidLiveRoomReplayAsset,
  savePreparedLockedLiveRoomReplayDelivery,
  updateDraftLiveRoomReplayAsset,
  type LiveRoomReplayAllocation,
  type LiveRoomReplayAsset,
  type LiveRoomReplayAssetAccessMode,
} from "./replay-assets"
import { getHydratedLiveRoom } from "./store"
import type { LiveRoom } from "./types"

type LiveRoomRepository = CommunityReadRepository & CommunityDatabaseBindingRepository & CommunityPostProjectionRepository

type LiveRoomRecordingDraftResponse = {
  object: "live_room_replay_draft"
  live_room: string
  recording_enabled: boolean
  replay_status: string
  status: "not_recorded" | "processing" | "ready" | "published" | "failed"
  replay_asset: null | SerializedReplayAsset
  recording: null | {
    id: string
    provider: "agora"
    status: string
    failure_reason: string | null
    raw_artifact: null | {
      provider: "filebase" | "agora_capture"
      ipfs_cid: string | null
      mime_type: string
      size_bytes: number
    }
  }
}

type LiveRoomRecordingDraftRawArtifact = NonNullable<NonNullable<LiveRoomRecordingDraftResponse["recording"]>["raw_artifact"]>
type SerializedReplayAsset = {
  id: string
  object: "live_room_replay_asset"
  publication_status: string
  title: string
  caption: string | null
  duration_ms: number | null
  preview_ref: string | null
  access_mode: string
  locked_delivery_status: string
  published_at: string | null
  allocations: Array<{
    id: string
    participant_user: string | null
    external_party_ref: string | null
    role: string
    share_bps: number
    rights_basis: string
    approval_status: string
  }>
}


export type PublishLiveRoomReplayDraftRequest = {
  access_mode?: LiveRoomReplayAssetAccessMode
  listing?: CreateCommunityListingRequest | null
}

export type UpdateLiveRoomReplayDraftRequest = {
  title?: string | null
  caption?: string | null
  preview_ref?: string | null
  access_mode?: LiveRoomReplayAssetAccessMode | null
  allocations?: Array<{
    participant_user?: string | null
    external_party_ref?: string | null
    role?: string | null
    share_bps?: number | null
  }> | null
}

type NormalizedReplayDraftUpdate = {
  title?: string
  caption?: string | null
  previewRef?: string | null
  accessMode?: LiveRoomReplayAssetAccessMode
  allocations?: Array<{
    participantUserId: string | null
    externalPartyRef: string | null
    role: string
    shareBps: number
  }>
}


export async function getLiveRoomRecordingDraft(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomRecordingDraftResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isProducer = room.host_user === input.userId || room.guest_user === input.userId
    if (!isProducer && !hasCommunityRole(membership, ["owner", "admin", "moderator"])) {
      throw notFoundError("Live room recording draft not found")
    }
    const recording = await getLiveRoomRecording({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    const replayAsset = await getLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    const replayAllocations = replayAsset
      ? await listLiveRoomReplayAllocations({
          client: db.client,
          communityId: input.communityId,
          replayAssetId: replayAsset.replay_asset_id,
        })
      : []
    const status = recordingDraftStatus({ room, recording, replayAsset })
    return {
      object: "live_room_replay_draft",
      live_room: room.id,
      recording_enabled: room.recording_enabled,
      replay_status: room.replay_status,
      status,
      replay_asset: replayAsset ? serializeReplayAsset(replayAsset, replayAllocations) : null,
      recording: recording
        ? {
            id: recording.recording_id,
            provider: recording.provider,
            status: recording.status,
            failure_reason: recording.failure_reason,
            raw_artifact: safeRawArtifact(recording.raw_artifact_ref),
          }
        : null,
    }
  } finally {
    db.close()
  }
}

export async function updateLiveRoomReplayDraft(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  body?: UpdateLiveRoomReplayDraftRequest
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomRecordingDraftResponse> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isProducer = room.host_user === input.userId || room.guest_user === input.userId
    if (!isProducer && !hasCommunityRole(membership, ["owner", "admin", "moderator"])) {
      throw notFoundError("Live room replay draft not found")
    }
    if (room.replay_status !== "review_pending") {
      throw conflictError("Replay draft is not editable")
    }
    const patch = normalizeReplayDraftUpdate(input.body ?? {})
    const updated = await updateDraftLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      now: nowIso(),
      ...patch,
    })
    if (!updated) {
      throw conflictError("Replay draft is missing or not editable")
    }
    return await getLiveRoomRecordingDraft({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      communityRepository: input.communityRepository,
    })
  } finally {
    db.close()
  }
}

export async function publishLiveRoomReplayDraft(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  body?: PublishLiveRoomReplayDraftRequest
  communityRepository: LiveRoomRepository
  userRepository: UserRepository
}): Promise<LiveRoomRecordingDraftResponse> {
  const accessMode = input.body?.access_mode == null
    ? "free"
    : normalizeReplayDraftAccessMode(input.body.access_mode)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isProducer = room.host_user === input.userId || room.guest_user === input.userId
    if (!isProducer && !hasCommunityRole(membership, ["owner", "admin", "moderator"])) {
      throw notFoundError("Live room replay draft not found")
    }
    if (room.replay_status !== "review_pending") {
      throw conflictError("Replay draft is not ready to publish")
    }
    const asset = await getLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    if (!asset || asset.publication_status !== "draft") {
      throw conflictError("Replay draft is missing or not publishable")
    }
    const now = nowIso()
    let published: LiveRoomReplayAsset | null = null
    if (accessMode === "free") {
      published = await publishFreeLiveRoomReplayAsset({
        client: db.client,
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
        now,
      })
    } else if (accessMode === "included_with_ticket") {
      if (room.access_mode !== "paid") {
        throw badRequestError("included_with_ticket replay requires a paid live room")
      }
      if (asset.access_mode !== "included_with_ticket") {
        throw badRequestError("Replay draft access_mode must be included_with_ticket before publishing")
      }
      const recording = await getLiveRoomRecording({
        client: db.client,
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
      })
      if (!recording || recording.status !== "captured" || !recording.raw_artifact_ref?.trim()) {
        throw conflictError("Replay recording is not ready for locked delivery")
      }
      try {
        const lockedDelivery = await prepareIncludedTicketReplayDelivery({
          env: input.env,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAsset: asset,
          rawArtifactRefJson: recording.raw_artifact_ref,
        })
        await savePreparedLockedLiveRoomReplayDelivery({
          client: db.client,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAssetId: asset.replay_asset_id,
          lockedDeliveryStorageRef: lockedDelivery.lockedDeliveryStorageRef,
          lockedDeliveryMetadataJson: lockedDelivery.lockedDeliveryMetadataJson,
          storyCdrVaultUuid: lockedDelivery.storyCdrVaultUuid,
          storyNamespace: lockedDelivery.storyNamespace,
          storyEntitlementTokenId: lockedDelivery.storyEntitlementTokenId,
          storyReadCondition: lockedDelivery.storyReadCondition,
          storyWriteCondition: lockedDelivery.storyWriteCondition,
          now,
        })
        published = await publishLockedIncludedTicketLiveRoomReplayAsset({
          client: db.client,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAssetId: asset.replay_asset_id,
          lockedDeliveryStorageRef: lockedDelivery.lockedDeliveryStorageRef,
          lockedDeliveryMetadataJson: lockedDelivery.lockedDeliveryMetadataJson,
          storyCdrVaultUuid: lockedDelivery.storyCdrVaultUuid,
          storyNamespace: lockedDelivery.storyNamespace,
          storyEntitlementTokenId: lockedDelivery.storyEntitlementTokenId,
          storyReadCondition: lockedDelivery.storyReadCondition,
          storyWriteCondition: lockedDelivery.storyWriteCondition,
          now,
        })
      } catch (error) {
        await markLiveRoomReplayAssetLockedDeliveryFailed({
          client: db.client,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAssetId: asset.replay_asset_id,
          error: lockedReplayPublishErrorMessage(error),
          now,
        })
        throw error
      }
    } else {
      if (asset.access_mode !== "paid") {
        throw badRequestError("Replay draft access_mode must be paid before publishing")
      }
      if (!input.body?.listing) {
        throw badRequestError("Paid replay publishing requires a replay listing")
      }
      const recording = await getLiveRoomRecording({
        client: db.client,
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
      })
      if (!recording || recording.status !== "captured" || !recording.raw_artifact_ref?.trim()) {
        throw conflictError("Replay recording is not ready for locked delivery")
      }
      const preparedListing = await prepareCommunityListingWrite({
        env: input.env,
        userId: input.userId,
        communityId: input.communityId,
        body: {
          ...input.body.listing,
          asset: null,
          live_room: null,
          replay_asset: asset.replay_asset_id,
        } as CreateCommunityListingRequest,
        communityRepository: input.communityRepository,
        userRepository: input.userRepository,
        client: db.client,
      })
      try {
        const lockedDelivery = await prepareIncludedTicketReplayDelivery({
          env: input.env,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAsset: asset,
          rawArtifactRefJson: recording.raw_artifact_ref,
        })
        await savePreparedLockedLiveRoomReplayDelivery({
          client: db.client,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAssetId: asset.replay_asset_id,
          lockedDeliveryStorageRef: lockedDelivery.lockedDeliveryStorageRef,
          lockedDeliveryMetadataJson: lockedDelivery.lockedDeliveryMetadataJson,
          storyCdrVaultUuid: lockedDelivery.storyCdrVaultUuid,
          storyNamespace: lockedDelivery.storyNamespace,
          storyEntitlementTokenId: lockedDelivery.storyEntitlementTokenId,
          storyReadCondition: lockedDelivery.storyReadCondition,
          storyWriteCondition: lockedDelivery.storyWriteCondition,
          now,
        })
        await withTransaction(db.client, "write", async (tx) => {
          await insertCommunityListingRow(tx, input.communityId, preparedListing)
          await publishLockedPaidLiveRoomReplayAsset({
            client: tx,
            communityId: input.communityId,
            liveRoomId: input.liveRoomId,
            replayAssetId: asset.replay_asset_id,
            replayListingId: preparedListing.listingId,
            lockedDeliveryStorageRef: lockedDelivery.lockedDeliveryStorageRef,
            lockedDeliveryMetadataJson: lockedDelivery.lockedDeliveryMetadataJson,
            storyCdrVaultUuid: lockedDelivery.storyCdrVaultUuid,
            storyNamespace: lockedDelivery.storyNamespace,
            storyEntitlementTokenId: lockedDelivery.storyEntitlementTokenId,
            storyReadCondition: lockedDelivery.storyReadCondition,
            storyWriteCondition: lockedDelivery.storyWriteCondition,
            now,
            hydrate: false,
          })
        })
        published = await getLiveRoomReplayAsset({
          client: db.client,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
        })
      } catch (error) {
        await markLiveRoomReplayAssetLockedDeliveryFailed({
          client: db.client,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          replayAssetId: asset.replay_asset_id,
          error: lockedReplayPublishErrorMessage(error),
          now,
        })
        throw error
      }
    }
    if (!published) {
      throw conflictError("Replay draft is missing or not publishable")
    }
    return await getLiveRoomRecordingDraft({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      communityRepository: input.communityRepository,
    })
  } finally {
    db.close()
  }
}

function lockedReplayPublishErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "Locked replay delivery publish failed"
  return message
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[redacted]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 1000)
}

function normalizeReplayDraftUpdate(body: UpdateLiveRoomReplayDraftRequest): NormalizedReplayDraftUpdate {
  const patch: NormalizedReplayDraftUpdate = {}
  if (Object.prototype.hasOwnProperty.call(body, "title")) {
    patch.title = requireReplayDraftTitle(body.title)
  }
  if (Object.prototype.hasOwnProperty.call(body, "caption")) {
    patch.caption = optionalReplayDraftCaption(body.caption)
  }
  if (Object.prototype.hasOwnProperty.call(body, "preview_ref")) {
    patch.previewRef = optionalReplayDraftString(body.preview_ref, "preview_ref")
  }
  if (Object.prototype.hasOwnProperty.call(body, "access_mode")) {
    patch.accessMode = normalizeReplayDraftAccessMode(body.access_mode)
  }
  if (Object.prototype.hasOwnProperty.call(body, "allocations")) {
    patch.allocations = normalizeReplayDraftAllocations(body.allocations)
  }
  return patch
}

function optionalReplayDraftString(value: unknown, field: string): string | null {
  if (value == null) return null
  if (typeof value !== "string") {
    throw badRequestError(`${field} must be a string`)
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function requireReplayDraftTitle(value: unknown): string {
  const title = optionalReplayDraftString(value, "title")
  if (!title) {
    throw badRequestError("title is required")
  }
  if (title.length > 140) {
    throw badRequestError("title must be 140 characters or fewer")
  }
  return title
}

function optionalReplayDraftCaption(value: unknown): string | null {
  const caption = optionalReplayDraftString(value, "caption")
  if (caption && caption.length > 2000) {
    throw badRequestError("caption must be 2000 characters or fewer")
  }
  return caption
}

function normalizeReplayDraftAccessMode(value: unknown): LiveRoomReplayAssetAccessMode {
  if (value === "free" || value === "included_with_ticket" || value === "paid") {
    return value
  }
  throw badRequestError("access_mode must be free, included_with_ticket, or paid")
}

function normalizeReplayDraftAllocations(value: unknown): Array<{
  participantUserId: string | null
  externalPartyRef: string | null
  role: string
  shareBps: number
}> {
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequestError("allocations must include at least one row")
  }
  const allocations = value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw badRequestError("allocation must be an object")
    }
    const record = entry as NonNullable<UpdateLiveRoomReplayDraftRequest["allocations"]>[number]
    const participantUser = optionalReplayDraftString(record.participant_user, "allocation participant_user")
    const participantUserId = participantUser ? decodePublicUserId(participantUser) : null
    if (participantUser && (!participantUserId || !/^usr_[a-zA-Z0-9]+$/.test(participantUserId))) {
      throw badRequestError("allocation participant_user must be a Pirate user id")
    }
    const externalPartyRef = optionalReplayDraftString(record.external_party_ref, "allocation external_party_ref")
    if (!participantUserId && !externalPartyRef) {
      throw badRequestError("allocation must include participant_user or external_party_ref")
    }
    const role = optionalReplayDraftString(record.role, "allocation role") ?? "rightsholder"
    if (role.length > 64) {
      throw badRequestError("allocation role must be 64 characters or fewer")
    }
    const shareBps = Number(record.share_bps)
    if (!Number.isInteger(shareBps) || shareBps <= 0 || shareBps > 10000) {
      throw badRequestError("allocation share_bps must be between 1 and 10000")
    }
    return {
      participantUserId,
      externalPartyRef,
      role,
      shareBps,
    }
  })
  const totalBps = allocations.reduce((sum, allocation) => sum + allocation.shareBps, 0)
  if (totalBps !== 10000) {
    throw badRequestError("allocations must sum to 10000 bps")
  }
  return allocations
}

function recordingDraftStatus(input: {
  room: LiveRoom
  recording: Awaited<ReturnType<typeof getLiveRoomRecording>>
  replayAsset: LiveRoomReplayAsset | null
}): LiveRoomRecordingDraftResponse["status"] {
  if (!input.room.recording_enabled && !input.recording) {
    return "not_recorded"
  }
  if (!input.recording) {
    return "processing"
  }
  if (input.recording.status === "failed" || input.room.replay_status === "failed") {
    return "failed"
  }
  if (input.replayAsset?.locked_delivery_status === "failed") {
    return "failed"
  }
  if (input.room.replay_status === "published") {
    return "published"
  }
  if (input.recording.raw_artifact_ref && input.room.replay_status === "review_pending") {
    return "ready"
  }
  return "processing"
}

function safeRawArtifact(rawArtifactRef: string | null): LiveRoomRecordingDraftRawArtifact | null {
  if (!rawArtifactRef) {
    return null
  }
  let parsed: Partial<LiveRoomRecordingRawArtifactRef>
  try {
    parsed = JSON.parse(rawArtifactRef) as Partial<LiveRoomRecordingRawArtifactRef>
  } catch {
    return null
  }
  if (
    (parsed.provider !== "filebase" && parsed.provider !== "agora_capture")
    || typeof parsed.mime_type !== "string"
    || typeof parsed.size_bytes !== "number"
  ) {
    return null
  }
  if (parsed.provider === "filebase" && typeof parsed.ipfs_cid !== "string") {
    return null
  }
  return {
    provider: parsed.provider,
    ipfs_cid: parsed.ipfs_cid ?? null,
    mime_type: parsed.mime_type,
    size_bytes: parsed.size_bytes,
  }
}


function serializeReplayAsset(asset: LiveRoomReplayAsset, allocations: LiveRoomReplayAllocation[]): SerializedReplayAsset {
  return {
    id: asset.replay_asset_id,
    object: "live_room_replay_asset",
    publication_status: asset.publication_status,
    title: asset.title,
    caption: asset.caption,
    duration_ms: asset.duration_ms,
    preview_ref: asset.preview_ref,
    access_mode: asset.access_mode,
    locked_delivery_status: asset.locked_delivery_status,
    published_at: asset.published_at,
    allocations: allocations.map((allocation) => ({
      id: allocation.allocation_id,
      participant_user: allocation.participant_user_id ? publicId(allocation.participant_user_id, "usr") : null,
      external_party_ref: allocation.external_party_ref,
      role: allocation.role,
      share_bps: allocation.share_bps,
      rights_basis: allocation.rights_basis,
      approval_status: allocation.approval_status,
    })),
  }
}

