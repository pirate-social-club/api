import type { QueryResultRow } from "../../sql-client"
import type { Env } from "../../../env"
import type { CommunityDatabaseBindingRepository, CommunityPostProjectionRepository, CommunityReadRepository } from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import { executeFirst } from "../../db-helpers"
import { authError, badRequestError, conflictError, notFoundError, paymentRequired } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { decodePublicUserId, publicId } from "../../public-ids"
import { withTransaction } from "../../transactions"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"
import { requireLiveCommunity } from "../community-status"
import { enqueueCommunityJob } from "../jobs/store"
import {
  OWNER_OR_ADMIN_ROLE,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { fetchSongArtifactBytes } from "../../song-artifacts/song-artifact-storage"
import { rowValue } from "../../sql-row"
import { assertAcceptedLiveRoomGuestInvite } from "./guest-invites"
import { buildJacktripBlock, type LiveRoomJacktripBlock } from "./jacktrip"
import {
  attachLiveRoomViewerRuntime,
  attachLiveRoomRuntime,
  buildAgoraBlock,
  endLiveRoomRuntime,
  renewLiveRoomViewerRuntime,
  revokeGuestLiveRoomRuntime,
  type LiveRoomRuntimeAttachResponse,
  type LiveRoomRuntimeViewerAttachResponse,
} from "./runtime"
import {
  canReadUnlistedLiveRoom,
  resolvePublicLiveRoomViewerAccess,
  resolveLiveRoomViewerAccess,
  serializeLiveRoomAccess,
  type LiveRoomAccessPayload,
} from "./access"
import {
  normalizeLiveRoomCreateRequest,
  type PreparedLiveRoomCreate,
} from "./create-input"
import {
  agoraCloudRecordingConfigFromEnv,
  queryAgoraCloudRecording,
  startAgoraCloudRecording,
  stopAgoraCloudRecording,
} from "./agora-cloud-recording"
import {
  fetchLiveRoomRecordingCaptureObject,
  ingestAgoraRecordingToPrivateStorage,
  selectAgoraRecordingObjectKey,
  serializeLiveRoomRecordingRawArtifactRef,
  type LiveRoomRecordingRawArtifactRef,
} from "./recording-ingest"
import {
  getLiveRoomRecording,
  markLiveRoomRecordingCaptured,
  markLiveRoomRecordingFailed,
  markLiveRoomRecordingIngested,
  markLiveRoomRecordingIngesting,
  markLiveRoomRecordingStarted,
  markLiveRoomRecordingStopRequested,
  recordLiveRoomRecordingStartRequested,
} from "./recordings"
import {
  createDraftLiveRoomReplayAsset,
  getLiveRoomReplayAsset,
  listLiveRoomReplayAllocations,
  markLiveRoomReplayAssetLockedDeliveryFailed,
  publishFreeLiveRoomReplayAsset,
  publishLockedIncludedTicketLiveRoomReplayAsset,
  publishLockedPaidLiveRoomReplayAsset,
  updateDraftLiveRoomReplayAsset,
  type LiveRoomReplayAllocation,
  type LiveRoomReplayAsset,
  type LiveRoomReplayAssetAccessMode,
} from "./replay-assets"
import { prepareIncludedTicketReplayDelivery } from "./locked-replay-delivery"
import {
  buildLockedDeliveryStoryCdrAccessPackage,
  type LockedDeliveryStoryCdrAccessPackage,
} from "../commerce/asset-delivery"
import {
  getActiveEntitlementForBuyer,
  resolvePrimaryWalletAddress,
} from "../commerce/shared"
import {
  getHydratedLiveRoom,
  getLiveRoomRow,
  serializeLiveRoom,
  type LiveRoomExecutor,
} from "./store"
import {
  hydrateCommunityListing,
  insertCommunityListingRow,
  prepareCommunityListingWrite,
} from "../commerce/listing-service"
import {
  assertLiveRoomViewerSessionUid,
  assertPublicLiveRoomViewerSessionUid,
  deleteLiveRoomViewerSessions,
  normalizeLiveRoomViewerUid,
  recordLiveRoomViewerSession,
} from "./viewer-sessions"
import type { CommunityListing, CreateCommunityListingRequest } from "../../../types"
import type {
  CreateLiveRoomRequest,
  LiveRoom,
  LiveRoomStatus,
  LiveRoomViewerRenewRequest,
  PublishLiveRoomRequest,
} from "./types"

export type {
  CreateLiveRoomRequest,
  LiveRoom,
  LiveRoomAccessMode,
  LiveRoomKind,
  LiveRoomRightsBasis,
  LiveRoomRightsStatus,
  LiveRoomSetlistStatus,
  LiveRoomStatus,
  LiveRoomViewerRenewRequest,
  LiveRoomVisibility,
  PublishLiveRoomRequest,
} from "./types"

export type LiveRoomAttachResponse = {
  room: LiveRoom
  runtime: LiveRoomRuntimeAttachResponse["runtime"]
  bridge: LiveRoomRuntimeAttachResponse["bridge"]
  agora: LiveRoomRuntimeAttachResponse["agora"]
  jacktrip: LiveRoomJacktripBlock
}

export type LiveRoomAccessResponse = {
  room: LiveRoom
  access: LiveRoomAccessPayload
}

export type LiveRoomViewerAttachResponse = {
  room: LiveRoom
  access: LiveRoomAccessPayload
  runtime: LiveRoomRuntimeViewerAttachResponse["runtime"]
  agora: LiveRoomRuntimeViewerAttachResponse["agora"]
}

export type LiveRoomReplayAccessResponse = {
  live_room: string
  replay_asset: string | null
  replay_listing: CommunityListing | null
  replay_status: string
  access_mode: LiveRoomReplayAssetAccessMode | null
  locked_delivery_status: LiveRoomReplayAsset["locked_delivery_status"] | null
  access_granted: boolean
  decision_reason:
    | "free"
    | "creator"
    | "moderator"
    | "purchase_entitlement"
    | "purchase_required"
    | "delivery_pending"
    | "not_published"
    | "not_available"
  delivery_kind: "primary_content_ref" | "story_cdr_ref" | null
  delivery_ref: string | null
  story_cdr_access: LockedDeliveryStoryCdrAccessPackage | null
}

export type PublishLiveRoomResponse = {
  room: LiveRoom
  listing: CommunityListing
}

export type LiveRoomRecordingDraftResponse = {
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

const AGORA_RECORDING_QUERY_MAX_ATTEMPTS = 6
const AGORA_RECORDING_QUERY_RETRY_DELAY_MS = 2_000

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

type LiveRoomRepository = CommunityReadRepository & CommunityDatabaseBindingRepository & CommunityPostProjectionRepository
type LiveRoomAnchorPost = {
  post_id: string
  community_id: string
  author_user_id: string
  authorship_mode: "human_direct"
  identity_mode: "public"
  post_type: "video"
  status: "published"
  visibility: "public"
  title: string
  body: string | null
  translation_policy: "machine_allowed"
  rights_basis: "none"
  analysis_state: "allow"
  content_safety_state: "safe"
  age_gate_policy: "none"
  created_at: string
  updated_at: string
}

async function requireSchedulePermission(client: LiveRoomExecutor, communityId: string, userId: string): Promise<void> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
    throw notFoundError("Community not found")
  }
}

function assertAttachable(room: LiveRoom): void {
  if (room.status === "ended") {
    throw conflictError("Live room has ended")
  }
  if (room.status === "canceled") {
    throw conflictError("Live room has been canceled")
  }
  if (room.setlist.status !== "ready" && room.setlist.status !== "locked") {
    throw conflictError("Live room setlist must be ready before attach")
  }
  if (room.setlist.items.some((item) => item.blocking_rights_failure || item.rights_status === "blocked")) {
    throw conflictError("Live room has blocking rights failures")
  }
}

async function enqueueAnchorPostProjectionRetry(input: {
  client: LiveRoomExecutor
  communityId: string
  postId: string
  sourceCreatedAt: string
  createdAt: string
}): Promise<void> {
  try {
    await enqueueCommunityJob({
      client: input.client,
      communityId: input.communityId,
      jobType: "post_projection_sync",
      subjectType: "post",
      subjectId: input.postId,
      payloadJson: JSON.stringify({
        post_id: input.postId,
        source_created_at: input.sourceCreatedAt,
      }),
      createdAt: input.createdAt,
    })
  } catch (error) {
    console.error("[live-rooms] failed to enqueue anchor post projection retry", {
      communityId: input.communityId,
      postId: input.postId,
      error,
    })
  }
}

async function createLiveRoomPreflight(input: {
  client: LiveRoomExecutor
  userId: string
  communityId: string
  body: CreateLiveRoomRequest
  userRepository: UserRepository
}): Promise<PreparedLiveRoomCreate> {
  await requireSchedulePermission(input.client, input.communityId, input.userId)
  const prepared = normalizeLiveRoomCreateRequest({
    body: input.body,
    hostUserId: input.userId,
  })
  if (prepared.guestUserId) {
    const guest = await input.userRepository.getUserById(prepared.guestUserId)
    if (!guest) {
      throw notFoundError("Guest user not found")
    }
  }
  return prepared
}

// Exported for buffer-safety regression tests (asserts the tx body is write-only).
export async function createLiveRoomInTransaction(input: {
  tx: LiveRoomExecutor
  userId: string
  communityId: string
  prepared: PreparedLiveRoomCreate
}): Promise<{
  anchorPost: LiveRoomAnchorPost
  liveRoomId: string
  createdAt: string
}> {
  const liveRoomId = makeId("lr")
  const anchorPostId = makeId("pst")
  const setlistId = makeId("lrs")
  const now = nowIso()
  const status: LiveRoomStatus = "scheduled"
  await input.tx.execute({
    sql: `
      INSERT INTO posts (
        post_id, community_id, author_user_id, identity_mode, anonymous_scope,
        anonymous_label, disclosed_qualifiers_json, label_id, post_type, status,
        song_mode, title, body, caption, lyrics, link_url, media_refs_json,
        song_artifact_bundle_id, source_language, translation_policy, rights_basis,
        asset_id, parent_post_id, analysis_state, analysis_result_ref,
        content_safety_state, age_gate_policy, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'public', NULL,
        NULL, NULL, NULL, 'video', 'published',
        NULL, ?4, ?5, NULL, NULL, NULL, NULL,
        NULL, NULL, 'machine_allowed', 'none',
        NULL, NULL, 'allow', NULL,
        'safe', 'none', ?6, ?6
      )
    `,
    args: [anchorPostId, input.communityId, input.userId, input.prepared.title, input.prepared.description, now],
  })
  await input.tx.execute({
    sql: `
      INSERT INTO live_rooms (
        live_room_id, community_id, anchor_post_id, host_user_id, guest_user_id,
        room_kind, status, access_mode, visibility, title, description, cover_ref,
        event_start_at, live_started_at, ended_at, canceled_at, broadcast_ref,
        recording_enabled, replay_status, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, NULL, NULL, NULL, NULL,
        ?14, 'none', ?15, ?15
      )
    `,
    args: [
      liveRoomId,
      input.communityId,
      anchorPostId,
      input.userId,
      input.prepared.guestUserId,
      input.prepared.roomKind,
      status,
      input.prepared.accessMode,
      input.prepared.visibility,
      input.prepared.title,
      input.prepared.description,
      input.prepared.coverRef,
      input.prepared.eventStartAt,
      input.prepared.recordingEnabled === true ? 1 : 0,
      now,
    ],
  })
  for (const allocation of input.prepared.allocations) {
    await input.tx.execute({
      sql: `
        INSERT INTO live_room_performer_allocations (
          allocation_id, live_room_id, community_id, user_id, role, share_bps, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
      args: [makeId("lra"), liveRoomId, input.communityId, allocation.userId, allocation.role, allocation.shareBps, now],
    })
  }
  await input.tx.execute({
    sql: `
      INSERT INTO live_room_setlists (
        setlist_id, live_room_id, community_id, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
    `,
    args: [setlistId, liveRoomId, input.communityId, input.prepared.setlist.status, now],
  })
  for (const [index, item] of input.prepared.setlist.items.entries()) {
    await input.tx.execute({
      sql: `
        INSERT INTO live_room_setlist_items (
          setlist_item_id, setlist_id, live_room_id, community_id, position,
          song_artifact_bundle_id, source_asset_ref, title, artist, rights_basis, license_ref,
          rights_status, blocking_rights_failure, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9, ?10, ?11,
          ?12, ?13, ?14, ?14
        )
      `,
      args: [
        makeId("lsi"),
        setlistId,
        liveRoomId,
        input.communityId,
        index,
        item.songArtifactBundleId,
        item.sourceAssetRef,
        item.title,
        item.artist,
        item.rightsBasis,
        item.licenseRef,
        item.rightsStatus,
        item.blockingRightsFailure ? 1 : 0,
        now,
      ],
    })
  }
  if (input.prepared.guestUserId) {
    await input.tx.execute({
      sql: `
        INSERT INTO live_room_guest_invites (
          guest_invite_id, live_room_id, community_id, guest_user_id, status,
          accepted_at, revoked_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'pending', NULL, NULL, ?5, ?5)
      `,
      args: [makeId("lgi"), liveRoomId, input.communityId, input.prepared.guestUserId, now],
    })
  }

  return {
    // No in-tx readback: a buffered D1 write tx can't hydrate the room back. Callers
    // read it via getHydratedLiveRoom(db.client, ...) AFTER commit.
    anchorPost: {
      post_id: anchorPostId,
      community_id: input.communityId,
      author_user_id: input.userId,
      authorship_mode: "human_direct",
      identity_mode: "public",
      post_type: "video",
      status: "published",
      visibility: "public",
      title: input.prepared.title,
      body: input.prepared.description,
      translation_policy: "machine_allowed",
      rights_basis: "none",
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
      created_at: now,
      updated_at: now,
    },
    liveRoomId,
    createdAt: now,
  }
}

async function recordLiveRoomAnchorPostProjection(input: {
  client: LiveRoomExecutor
  communityRepository: LiveRoomRepository
  communityId: string
  userId: string
  liveRoomId: string
  anchorPost: LiveRoomAnchorPost
  createdAt: string
}): Promise<void> {
  try {
    await input.communityRepository.recordCommunityPostProjection({
      communityId: input.communityId,
      sourcePostId: input.anchorPost.post_id,
      authorUserId: input.anchorPost.author_user_id ?? null,
      identityMode: input.anchorPost.identity_mode,
      postType: input.anchorPost.post_type,
      status: input.anchorPost.status,
      visibility: input.anchorPost.visibility,
      sourceCreatedAt: input.anchorPost.created_at,
      projectedPayloadJson: JSON.stringify(input.anchorPost),
      actorUserId: input.userId,
      createdAt: input.createdAt,
    })
  } catch (error) {
    console.error("[live-rooms] failed to record anchor post projection; queued retry", {
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      postId: input.anchorPost.post_id,
      error,
    })
    await enqueueAnchorPostProjectionRetry({
      client: input.client,
      communityId: input.communityId,
      postId: input.anchorPost.post_id,
      sourceCreatedAt: input.anchorPost.created_at,
      createdAt: nowIso(),
    })
  }
}

export async function createLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateLiveRoomRequest
  communityRepository: LiveRoomRepository
  userRepository: UserRepository
}): Promise<LiveRoom> {
  await requireLiveCommunity(input.communityRepository, input.communityId)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const prepared = await createLiveRoomPreflight({
      client: db.client,
      userId: input.userId,
      communityId: input.communityId,
      body: input.body,
      userRepository: input.userRepository,
    })
    const created = await withTransaction(db.client, "write", async (tx) => {
      return await createLiveRoomInTransaction({
        tx,
        userId: input.userId,
        communityId: input.communityId,
        prepared,
      })
    })
    if (!created) {
      throw notFoundError("Live room not found")
    }
    await recordLiveRoomAnchorPostProjection({
      client: db.client,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      liveRoomId: created.liveRoomId,
      anchorPost: created.anchorPost,
      createdAt: created.createdAt,
    })
    return serializeLiveRoom(await getHydratedLiveRoom(db.client, input.communityId, created.liveRoomId))
  } finally {
    db.close()
  }
}

export async function publishLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  body: PublishLiveRoomRequest
  communityRepository: LiveRoomRepository
  userRepository: UserRepository
}): Promise<PublishLiveRoomResponse> {
  await requireLiveCommunity(input.communityRepository, input.communityId)
  const listingBody = input.body.listing
  if (!listingBody) {
    throw badRequestError("listing is required")
  }
  if (listingBody.asset?.trim() || listingBody.live_room?.trim()) {
    throw badRequestError("publish listing target is assigned by the server")
  }
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const prepared = await createLiveRoomPreflight({
      client: db.client,
      userId: input.userId,
      communityId: input.communityId,
      body: input.body.room ?? {},
      userRepository: input.userRepository,
    })
    if (prepared.accessMode !== "paid") {
      throw badRequestError("publish requires a paid live room")
    }
    // Validate the listing and resolve every column value BEFORE opening the tx:
    // the routed D1 write tx buffers statements into one atomic batchWrite where
    // reads (membership/target/dup checks) can't run. The live-room target is
    // created in the same tx below — known-good by construction (host = this user,
    // brand new), so its id is supplied to the write-only insert after creation.
    const preparedListing = await prepareCommunityListingWrite({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      body: {
        ...listingBody,
        asset: null,
        live_room: null,
      },
      communityRepository: input.communityRepository,
      userRepository: input.userRepository,
      client: db.client,
      liveRoomTarget: "create-in-tx",
    })
    const created = await withTransaction(db.client, "write", async (tx) => {
      const createdRoom = await createLiveRoomInTransaction({
        tx,
        userId: input.userId,
        communityId: input.communityId,
        prepared,
      })
      // Write-only: insert the live room (above) and the listing as one atomic batch.
      await insertCommunityListingRow(tx, input.communityId, preparedListing, createdRoom.liveRoomId)
      return createdRoom
    })
    if (!created) {
      throw notFoundError("Live room not found")
    }
    await recordLiveRoomAnchorPostProjection({
      client: db.client,
      communityRepository: input.communityRepository,
      communityId: input.communityId,
      userId: input.userId,
      liveRoomId: created.liveRoomId,
      anchorPost: created.anchorPost,
      createdAt: created.createdAt,
    })
    // Hydrate the listing AFTER commit (buffer-safe readback on db.client).
    const listing = await hydrateCommunityListing(db.client, input.communityId, preparedListing.listingId)
    return {
      room: serializeLiveRoom(await getHydratedLiveRoom(db.client, input.communityId, created.liveRoomId)),
      listing,
    }
  } finally {
    db.close()
  }
}

export async function getLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoom> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isProducer = room.host_user === input.userId || room.guest_user === input.userId
    if (!isProducer && !hasCommunityRole(membership, ["owner", "admin", "moderator"]) && membership.membership_status !== "member") {
      throw notFoundError("Live room not found")
    }
    if (room.visibility === "unlisted" && !canReadUnlistedLiveRoom({ membership, room, userId: input.userId })) {
      throw notFoundError("Live room not found")
    }
    return serializeLiveRoom(room)
  } finally {
    db.close()
  }
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
        await withTransaction(db.client, "write", async (tx) => {
          await insertCommunityListingRow(tx, input.communityId, preparedListing)
          published = await publishLockedPaidLiveRoomReplayAsset({
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
          })
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

async function loadLiveRoomForAccess(
  client: LiveRoomExecutor,
  communityId: string,
  liveRoomId: string,
): Promise<LiveRoom> {
  return getHydratedLiveRoom(client, communityId, liveRoomId)
}

export async function getLiveRoomAccess(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomAccessResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const access = await resolveLiveRoomViewerAccess({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      userId: input.userId,
      loadRoom: loadLiveRoomForAccess,
    })
    if (access.decisionReason === "unlisted") {
      throw notFoundError("Live room not found")
    }
    return {
      room: serializeLiveRoom(access.room),
      access: serializeLiveRoomAccess(access),
    }
  } finally {
    db.close()
  }
}

function buildLiveRoomReplayContentPath(communityId: string, liveRoomId: string): string {
  return `/communities/${encodeURIComponent(communityId)}/live-rooms/${encodeURIComponent(liveRoomId)}/replay/content`
}

function buildPublicLiveRoomReplayContentPath(communityId: string, liveRoomId: string): string {
  return `/public-communities/${encodeURIComponent(communityId)}/live-rooms/${encodeURIComponent(liveRoomId)}/replay/content`
}

async function fetchReplayPrimaryContent(input: {
  env: Env
  primaryContentRef: string
  rangeHeader?: string | null
}): Promise<Response> {
  let parsed: Partial<LiveRoomRecordingRawArtifactRef>
  try {
    parsed = JSON.parse(input.primaryContentRef) as Partial<LiveRoomRecordingRawArtifactRef>
  } catch {
    throw notFoundError("Replay content not found")
  }
  if (!parsed.object_key?.trim()) {
    throw notFoundError("Replay content not found")
  }
  if (parsed.provider === "filebase") {
    return await fetchSongArtifactBytes({
      env: input.env,
      objectKey: parsed.object_key,
      rangeHeader: input.rangeHeader,
    })
  }
  if (parsed.provider === "agora_capture") {
    return await fetchLiveRoomRecordingCaptureObject({
      env: input.env,
      objectKey: parsed.object_key,
      rangeHeader: input.rangeHeader,
    })
  }
  throw notFoundError("Replay content not found")
}

async function buildReplayCdrAccessPackage(input: {
  env: Env
  asset: LiveRoomReplayAsset
  communityId: string
  liveRoomId: string
  userId: string
  userRepository: UserRepository
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
}): Promise<LockedDeliveryStoryCdrAccessPackage> {
  const callerWalletAddress = await resolvePrimaryWalletAddress({
    env: input.env,
    userRepository: input.userRepository,
    userId: input.userId,
  })
  return await buildLockedDeliveryStoryCdrAccessPackage({
    env: input.env,
    communityId: input.communityId,
    subjectId: input.asset.replay_asset_id,
    userId: input.userId,
    callerWalletAddress,
    decisionReason: input.decisionReason,
    storyCdrVaultUuid: input.asset.story_cdr_vault_uuid,
    storyNamespace: input.asset.story_namespace,
    storyEntitlementTokenId: input.asset.story_entitlement_token_id,
    storyReadCondition: input.asset.story_read_condition,
    lockedDeliverySecretJson: input.asset.locked_delivery_secret_json,
    ciphertextRef: buildLiveRoomReplayContentPath(input.communityId, input.liveRoomId),
    purchaseEntitlementProofMode: input.decisionReason === "purchase_entitlement" ? "signed" : "token_gate",
  })
}

export async function getLiveRoomReplayAccess(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
  userRepository: UserRepository
}): Promise<LiveRoomReplayAccessResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isProducer = room.host_user === input.userId || room.guest_user === input.userId
    const isModerator = hasCommunityRole(membership, ["owner", "admin", "moderator"])
    if (!isProducer && !isModerator && membership.membership_status !== "member") {
      throw notFoundError("Live room replay not found")
    }
    if (room.visibility === "unlisted" && !canReadUnlistedLiveRoom({ membership, room, userId: input.userId })) {
      throw notFoundError("Live room replay not found")
    }
    const asset = await getLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    if (!asset || asset.publication_status !== "published" || room.replay_status !== "published") {
      return {
        live_room: room.id,
        replay_asset: asset?.replay_asset_id ?? null,
        replay_listing: null,
        replay_status: room.replay_status,
        access_mode: asset?.access_mode ?? null,
        locked_delivery_status: asset?.locked_delivery_status ?? null,
        access_granted: false,
        decision_reason: asset ? "not_published" : "not_available",
        delivery_kind: null,
        delivery_ref: null,
        story_cdr_access: null,
      }
    }

    const replayListing = asset.access_mode === "paid" && room.replay_listing_id
      ? await hydrateCommunityListing(db.client, input.communityId, room.replay_listing_id)
      : null

    if (asset.access_mode === "free") {
      return {
        live_room: room.id,
        replay_asset: asset.replay_asset_id,
        replay_listing: null,
        replay_status: room.replay_status,
        access_mode: asset.access_mode,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: "free",
        delivery_kind: "primary_content_ref",
        delivery_ref: buildLiveRoomReplayContentPath(input.communityId, input.liveRoomId),
        story_cdr_access: null,
      }
    }

    if (asset.access_mode === "included_with_ticket" || asset.access_mode === "paid") {
      if (asset.locked_delivery_status !== "ready") {
        return {
          live_room: room.id,
          replay_asset: asset.replay_asset_id,
          replay_listing: replayListing,
          replay_status: room.replay_status,
          access_mode: asset.access_mode,
          locked_delivery_status: asset.locked_delivery_status,
          access_granted: false,
          decision_reason: "delivery_pending",
          delivery_kind: null,
          delivery_ref: null,
          story_cdr_access: null,
        }
      }
      if (isProducer || isModerator) {
        const decisionReason = isProducer ? "creator" : "moderator"
        return {
          live_room: room.id,
          replay_asset: asset.replay_asset_id,
          replay_listing: replayListing,
          replay_status: room.replay_status,
          access_mode: asset.access_mode,
          locked_delivery_status: asset.locked_delivery_status,
          access_granted: true,
          decision_reason: decisionReason,
          delivery_kind: "story_cdr_ref",
          delivery_ref: buildLiveRoomReplayContentPath(input.communityId, input.liveRoomId),
          story_cdr_access: await buildReplayCdrAccessPackage({
            env: input.env,
            asset,
            communityId: input.communityId,
            liveRoomId: input.liveRoomId,
            userId: input.userId,
            userRepository: input.userRepository,
            decisionReason,
          }),
        }
      }
      const entitlementTarget = asset.access_mode === "paid" ? asset.replay_asset_id : room.id
      const entitlement = await getActiveEntitlementForBuyer(db.client, input.communityId, input.userId, entitlementTarget)
      if (entitlement) {
        return {
          live_room: room.id,
          replay_asset: asset.replay_asset_id,
          replay_listing: replayListing,
          replay_status: room.replay_status,
          access_mode: asset.access_mode,
          locked_delivery_status: asset.locked_delivery_status,
          access_granted: true,
          decision_reason: "purchase_entitlement",
          delivery_kind: "story_cdr_ref",
          delivery_ref: buildLiveRoomReplayContentPath(input.communityId, input.liveRoomId),
          story_cdr_access: await buildReplayCdrAccessPackage({
            env: input.env,
            asset,
            communityId: input.communityId,
            liveRoomId: input.liveRoomId,
            userId: input.userId,
            userRepository: input.userRepository,
            decisionReason: "purchase_entitlement",
          }),
        }
      }
      return {
        live_room: room.id,
        replay_asset: asset.replay_asset_id,
        replay_listing: replayListing,
        replay_status: room.replay_status,
        access_mode: asset.access_mode,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: false,
        decision_reason: "purchase_required",
        delivery_kind: null,
        delivery_ref: null,
        story_cdr_access: null,
      }
    }

    return {
      live_room: room.id,
      replay_asset: asset.replay_asset_id,
      replay_listing: replayListing,
      replay_status: room.replay_status,
      access_mode: asset.access_mode,
      locked_delivery_status: asset.locked_delivery_status,
      access_granted: false,
      decision_reason: "purchase_required",
      delivery_kind: null,
      delivery_ref: null,
      story_cdr_access: null,
    }
  } finally {
    db.close()
  }
}

export async function fetchLiveRoomReplayContent(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
  userRepository: UserRepository
  rangeHeader?: string | null
}): Promise<Response> {
  const access = await getLiveRoomReplayAccess(input)
  if (!access.access_granted) {
    throw notFoundError("Live room replay content not found")
  }
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    if (!asset || asset.publication_status !== "published") {
      throw notFoundError("Live room replay content not found")
    }
    if (asset.access_mode === "included_with_ticket" || asset.access_mode === "paid") {
      if (!asset.locked_delivery_storage_ref) {
        throw notFoundError("Live room replay content not found")
      }
      return await fetchSongArtifactBytes({
        env: input.env,
        objectKey: asset.locked_delivery_storage_ref,
      })
    }
    return await fetchReplayPrimaryContent({
      env: input.env,
      primaryContentRef: asset.primary_content_ref,
      rangeHeader: input.rangeHeader,
    })
  } finally {
    db.close()
  }
}

export async function getPublicLiveRoomReplayAccess(input: {
  env: Env
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomReplayAccessResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    if (room.visibility !== "public") {
      throw notFoundError("Live room replay not found")
    }
    const asset = await getLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    if (!asset || asset.publication_status !== "published" || room.replay_status !== "published") {
      return {
        live_room: room.id,
        replay_asset: asset?.replay_asset_id ?? null,
        replay_listing: null,
        replay_status: room.replay_status,
        access_mode: asset?.access_mode ?? null,
        locked_delivery_status: asset?.locked_delivery_status ?? null,
        access_granted: false,
        decision_reason: asset ? "not_published" : "not_available",
        delivery_kind: null,
        delivery_ref: null,
        story_cdr_access: null,
      }
    }
    const replayListing = asset.access_mode === "paid" && room.replay_listing_id
      ? await hydrateCommunityListing(db.client, input.communityId, room.replay_listing_id)
      : null
    if (asset.access_mode !== "free") {
      return {
        live_room: room.id,
        replay_asset: asset.replay_asset_id,
        replay_listing: replayListing,
        replay_status: room.replay_status,
        access_mode: asset.access_mode,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: false,
        decision_reason: asset.locked_delivery_status === "ready" ? "purchase_required" : "delivery_pending",
        delivery_kind: null,
        delivery_ref: null,
        story_cdr_access: null,
      }
    }
    return {
      live_room: room.id,
      replay_asset: asset.replay_asset_id,
      replay_listing: null,
      replay_status: room.replay_status,
      access_mode: asset.access_mode,
      locked_delivery_status: asset.locked_delivery_status,
      access_granted: true,
      decision_reason: "free",
      delivery_kind: "primary_content_ref",
      delivery_ref: buildPublicLiveRoomReplayContentPath(input.communityId, input.liveRoomId),
      story_cdr_access: null,
    }
  } finally {
    db.close()
  }
}

export async function fetchPublicLiveRoomReplayContent(input: {
  env: Env
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
  rangeHeader?: string | null
}): Promise<Response> {
  const access = await getPublicLiveRoomReplayAccess(input)
  if (!access.access_granted || access.delivery_kind !== "primary_content_ref") {
    throw notFoundError("Live room replay content not found")
  }
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getLiveRoomReplayAsset({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
    })
    if (!asset || asset.publication_status !== "published" || asset.access_mode !== "free") {
      throw notFoundError("Live room replay content not found")
    }
    return await fetchReplayPrimaryContent({
      env: input.env,
      primaryContentRef: asset.primary_content_ref,
      rangeHeader: input.rangeHeader,
    })
  } finally {
    db.close()
  }
}

export async function viewerAttachLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomViewerAttachResponse> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const access = await resolveLiveRoomViewerAccess({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      userId: input.userId,
      loadRoom: loadLiveRoomForAccess,
    })
    const serializedAccess = serializeLiveRoomAccess(access)
    if (!access.allowed) {
      if (access.decisionReason === "purchase_required") {
        throw paymentRequired("Live room ticket required", { listing: serializedAccess.listing })
      }
      if (access.decisionReason === "membership_required") {
        throw authError("Authentication is required to join this live room")
      }
      if (access.decisionReason === "unlisted") {
        throw notFoundError("Live room not found")
      }
      throw conflictError("Live room is not available", { decision_reason: access.decisionReason })
    }
    let runtime: LiveRoomRuntimeViewerAttachResponse | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nextRuntime = attachLiveRoomViewerRuntime({
        env: input.env,
        room: access.room,
      })
      const recorded = await recordLiveRoomViewerSession(db.client, {
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
        userId: input.userId,
        uid: nextRuntime.agora.uid,
      })
      if (recorded) {
        runtime = nextRuntime
        break
      }
    }
    if (!runtime) {
      throw conflictError("Could not reserve live room viewer UID")
    }
    return {
      room: serializeLiveRoom(access.room),
      access: serializedAccess,
      runtime: runtime.runtime,
      agora: runtime.agora,
    }
  } finally {
    db.close()
  }
}

export async function viewerRenewLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  body: LiveRoomViewerRenewRequest
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomViewerAttachResponse> {
  const uid = normalizeLiveRoomViewerUid(input.body.uid)
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const access = await resolveLiveRoomViewerAccess({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      userId: input.userId,
      loadRoom: loadLiveRoomForAccess,
    })
    const serializedAccess = serializeLiveRoomAccess(access)
    if (!access.allowed) {
      if (access.decisionReason === "purchase_required") {
        throw paymentRequired("Live room ticket required", { listing: serializedAccess.listing })
      }
      if (access.decisionReason === "membership_required") {
        throw authError("Authentication is required to join this live room")
      }
      if (access.decisionReason === "unlisted") {
        throw notFoundError("Live room not found")
      }
      throw conflictError("Live room is not available", { decision_reason: access.decisionReason })
    }
    await assertLiveRoomViewerSessionUid(db.client, {
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      userId: input.userId,
      uid,
    })
    const runtime = renewLiveRoomViewerRuntime({
      env: input.env,
      room: access.room,
      uid,
    })
    return {
      room: serializeLiveRoom(access.room),
      access: serializedAccess,
      runtime: runtime.runtime,
      agora: runtime.agora,
    }
  } finally {
    db.close()
  }
}

export async function getPublicLiveRoomAccess(input: {
  env: Env
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomAccessResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const access = await resolvePublicLiveRoomViewerAccess({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      loadRoom: loadLiveRoomForAccess,
    })
    if (access.decisionReason === "unlisted") {
      throw notFoundError("Live room not found")
    }
    return {
      room: serializeLiveRoom(access.room),
      access: serializeLiveRoomAccess(access),
    }
  } finally {
    db.close()
  }
}

export async function publicViewerAttachLiveRoom(input: {
  env: Env
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomViewerAttachResponse> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const access = await resolvePublicLiveRoomViewerAccess({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      loadRoom: loadLiveRoomForAccess,
    })
    const serializedAccess = serializeLiveRoomAccess(access)
    if (!access.allowed) {
      if (access.decisionReason === "purchase_required") {
        throw paymentRequired("Live room ticket required", { listing: serializedAccess.listing })
      }
      if (access.decisionReason === "membership_required") {
        throw authError("Authentication is required to join this live room")
      }
      if (access.decisionReason === "unlisted") {
        throw notFoundError("Live room not found")
      }
      throw conflictError("Live room is not available", { decision_reason: access.decisionReason })
    }
    let runtime: LiveRoomRuntimeViewerAttachResponse | null = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nextRuntime = attachLiveRoomViewerRuntime({
        env: input.env,
        room: access.room,
      })
      const recorded = await recordLiveRoomViewerSession(db.client, {
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
        userId: `anon:${crypto.randomUUID()}`,
        uid: nextRuntime.agora.uid,
      })
      if (recorded) {
        runtime = nextRuntime
        break
      }
    }
    if (!runtime) {
      throw conflictError("Could not reserve live room viewer UID")
    }
    return {
      room: serializeLiveRoom(access.room),
      access: serializedAccess,
      runtime: runtime.runtime,
      agora: runtime.agora,
    }
  } finally {
    db.close()
  }
}

export async function publicViewerRenewLiveRoom(input: {
  env: Env
  communityId: string
  liveRoomId: string
  body: LiveRoomViewerRenewRequest
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomViewerAttachResponse> {
  const uid = normalizeLiveRoomViewerUid(input.body.uid)
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const access = await resolvePublicLiveRoomViewerAccess({
      client: db.client,
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      loadRoom: loadLiveRoomForAccess,
    })
    const serializedAccess = serializeLiveRoomAccess(access)
    if (!access.allowed) {
      if (access.decisionReason === "purchase_required") {
        throw paymentRequired("Live room ticket required", { listing: serializedAccess.listing })
      }
      if (access.decisionReason === "membership_required") {
        throw authError("Authentication is required to join this live room")
      }
      if (access.decisionReason === "unlisted") {
        throw notFoundError("Live room not found")
      }
      throw conflictError("Live room is not available", { decision_reason: access.decisionReason })
    }
    await assertPublicLiveRoomViewerSessionUid(db.client, {
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      uid,
    })
    const runtime = renewLiveRoomViewerRuntime({
      env: input.env,
      room: access.room,
      uid,
    })
    return {
      room: serializeLiveRoom(access.room),
      access: serializedAccess,
      runtime: runtime.runtime,
      agora: runtime.agora,
    }
  } finally {
    db.close()
  }
}

export async function hostAttachLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomAttachResponse> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    if (room.host_user !== input.userId) {
      throw notFoundError("Live room not found")
    }
    assertAttachable(room)
    const runtime = await attachLiveRoomRuntime({
      env: input.env,
      room,
      seat: "host",
    })
    if (room.status === "scheduled") {
      const now = nowIso()
      await withTransaction(db.client, "write", async (tx) => {
        await tx.execute({
          sql: `
            UPDATE live_rooms
            SET status = 'live',
                live_started_at = ?3,
                broadcast_ref = ?4,
                updated_at = ?5
            WHERE community_id = ?1 AND live_room_id = ?2 AND status = 'scheduled'
          `,
          args: [input.communityId, input.liveRoomId, Math.floor(Date.now() / 1000), runtime.runtime.room_runtime_id, now],
        })
        if (room.recording_enabled) {
          await recordLiveRoomRecordingStartRequested({
            client: tx,
            communityId: input.communityId,
            liveRoomId: input.liveRoomId,
            createdAt: now,
          })
        }
      })
      if (room.recording_enabled) {
        await startLiveRoomCloudRecording({
          env: input.env,
          client: db.client,
          communityId: input.communityId,
          room,
          channel: runtime.agora.channel,
        })
      }
    }
    const attachedRoom = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    return {
      room: serializeLiveRoom(attachedRoom),
      runtime: runtime.runtime,
      bridge: runtime.bridge,
      agora: runtime.agora,
      jacktrip: buildJacktripBlock(input.env, attachedRoom),
    }
  } finally {
    db.close()
  }
}

export async function guestAttachLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomAttachResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    if (room.guest_user !== input.userId) {
      throw notFoundError("Live room not found")
    }
    await assertAcceptedLiveRoomGuestInvite(db.client, {
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      guestUserId: input.userId,
    })
    if (room.status !== "live") {
      throw conflictError("Live room is not live")
    }
    assertAttachable(room)
    const runtime = await attachLiveRoomRuntime({
      env: input.env,
      room,
      seat: "guest",
    })
    return {
      room: serializeLiveRoom(room),
      runtime: runtime.runtime,
      bridge: runtime.bridge,
      agora: runtime.agora,
      jacktrip: buildJacktripBlock(input.env, room),
    }
  } finally {
    db.close()
  }
}

export async function cancelLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoom> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getLiveRoomRow(db.client, input.communityId, input.liveRoomId)
    if (room.host_user_id !== input.userId) {
      throw notFoundError("Live room not found")
    }
    if (room.status === "live" || room.status === "ended") {
      throw conflictError("Live room cannot be canceled after it is live")
    }
    const now = nowIso()
    await withTransaction(db.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          UPDATE live_rooms
          SET status = 'canceled',
              canceled_at = ?3,
              updated_at = ?4
          WHERE community_id = ?1 AND live_room_id = ?2
        `,
        args: [input.communityId, input.liveRoomId, Math.floor(Date.now() / 1000), now],
      })
      await deleteLiveRoomViewerSessions(tx, {
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
      })
    })
    // Hydrate AFTER commit — the buffered write tx can't read the room back.
    return serializeLiveRoom(await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId))
  } finally {
    db.close()
  }
}

export async function acceptLiveRoomGuestInvite(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoom> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getLiveRoomRow(db.client, input.communityId, input.liveRoomId)
    if (room.guest_user_id !== input.userId) {
      throw notFoundError("Live room not found")
    }
    if (room.status === "canceled" || room.status === "ended") {
      throw conflictError("Live room guest invite cannot be accepted")
    }
    const current = await executeFirst(db.client, {
      sql: `
        SELECT status
        FROM live_room_guest_invites
        WHERE community_id = ?1 AND live_room_id = ?2 AND guest_user_id = ?3
        LIMIT 1
      `,
      args: [input.communityId, input.liveRoomId, input.userId],
    }) as QueryResultRow | null
    const status = rowValue(current, "status")
    if (status === "revoked") {
      throw conflictError("Live room guest invite is not active")
    }
    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE live_room_guest_invites
        SET status = 'accepted',
            accepted_at = ?4,
            revoked_at = NULL,
            updated_at = ?5
        WHERE community_id = ?1
          AND live_room_id = ?2
          AND guest_user_id = ?3
          AND status IN ('pending', 'accepted')
      `,
      args: [input.communityId, input.liveRoomId, input.userId, Math.floor(Date.now() / 1000), now],
    })
    return serializeLiveRoom(await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId))
  } finally {
    db.close()
  }
}

export async function revokeLiveRoomGuestInvite(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoom> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    if (room.host_user !== input.userId && room.guest_user !== input.userId) {
      throw notFoundError("Live room not found")
    }
    if (!room.guest_user) {
      throw conflictError("Live room has no guest invite")
    }
    if (room.status === "ended" || room.status === "canceled") {
      throw conflictError("Live room guest invite cannot be revoked")
    }
    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE live_room_guest_invites
        SET status = 'revoked',
            revoked_at = ?4,
            updated_at = ?5
        WHERE community_id = ?1
          AND live_room_id = ?2
          AND guest_user_id = ?3
          AND status IN ('pending', 'accepted')
      `,
      args: [input.communityId, input.liveRoomId, room.guest_user, Math.floor(Date.now() / 1000), now],
    })
    if (room.status === "live") {
      await revokeGuestLiveRoomRuntime({
        env: input.env,
        room,
      })
    }
    return serializeLiveRoom(await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId))
  } finally {
    db.close()
  }
}

export async function endLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoom> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId)
    if (room.host_user !== input.userId) {
      throw notFoundError("Live room not found")
    }
    if (room.status !== "live") {
      throw conflictError("Live room is not live")
    }
    const runtime = await endLiveRoomRuntime({
      env: input.env,
      room,
    })
    const now = nowIso()
    await withTransaction(db.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          UPDATE live_rooms
          SET status = 'ended',
              ended_at = ?3,
              replay_status = CASE
                WHEN EXISTS (
                  SELECT 1 FROM live_room_recordings
                  WHERE community_id = ?1 AND live_room_id = ?2 AND status = 'failed'
                ) THEN 'failed'
                WHEN EXISTS (
                  SELECT 1 FROM live_room_recordings
                  WHERE community_id = ?1 AND live_room_id = ?2 AND status IN ('starting', 'recording', 'stopping', 'captured', 'ingesting')
                ) THEN 'processing'
                ELSE replay_status
              END,
              updated_at = ?4
          WHERE community_id = ?1 AND live_room_id = ?2 AND status = 'live'
        `,
        args: [input.communityId, input.liveRoomId, runtime.ended_at, now],
      })
      if (room.recording_enabled) {
        await markLiveRoomRecordingStopRequested({
          client: tx,
          communityId: input.communityId,
          liveRoomId: input.liveRoomId,
          stoppedAt: runtime.ended_at,
          updatedAt: now,
        })
      }
      await tx.execute({
        sql: `
          UPDATE live_room_guest_invites
          SET status = 'revoked',
              revoked_at = ?3,
              updated_at = ?4
          WHERE community_id = ?1
            AND live_room_id = ?2
            AND status IN ('pending', 'accepted')
        `,
        args: [input.communityId, input.liveRoomId, runtime.ended_at, now],
      })
      await deleteLiveRoomViewerSessions(tx, {
        communityId: input.communityId,
        liveRoomId: input.liveRoomId,
      })
    })
    if (room.recording_enabled) {
      await stopLiveRoomCloudRecording({
        env: input.env,
        client: db.client,
        communityId: input.communityId,
        room,
        channel: `pirate-live-${room.id}`,
        stoppedAt: runtime.ended_at,
      })
    }
    // Hydrate AFTER commit — the buffered write tx can't read the room back.
    return serializeLiveRoom(await getHydratedLiveRoom(db.client, input.communityId, input.liveRoomId))
  } finally {
    db.close()
  }
}

async function startLiveRoomCloudRecording(input: {
  env: Env
  client: LiveRoomExecutor
  communityId: string
  room: LiveRoom
  channel: string
}): Promise<void> {
  const config = agoraCloudRecordingConfigFromEnv(input.env)
  if (!config) {
    await markLiveRoomRecordingFailed({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      failureReason: "missing_agora_cloud_recording_configuration",
      updatedAt: nowIso(),
    })
    return
  }
  const uid = liveRoomRecordingAgoraUid(input.room.id)
  const recorderAgora = buildAgoraBlock({
    env: input.env,
    channel: input.channel,
    uid,
  })
  try {
    const started = await startAgoraCloudRecording({
      config,
      recording: {
        cname: input.channel,
        uid: String(uid),
        token: recorderAgora.token ?? "",
      },
    })
    await markLiveRoomRecordingStarted({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      resourceId: started.resourceId,
      sessionId: started.sid,
      startedAt: Math.floor(Date.now() / 1000),
      updatedAt: nowIso(),
    })
  } catch (error) {
    await markLiveRoomRecordingFailed({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      failureReason: error instanceof Error ? error.message : String(error),
      updatedAt: nowIso(),
    })
  }
}

async function stopLiveRoomCloudRecording(input: {
  env: Env
  client: LiveRoomExecutor
  communityId: string
  room: LiveRoom
  channel: string
  stoppedAt: number
}): Promise<void> {
  const recording = await getLiveRoomRecording({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.room.id,
  })
  if (!recording || recording.status === "failed" || recording.status === "captured") {
    return
  }
  const config = agoraCloudRecordingConfigFromEnv(input.env)
  if (!config) {
    await failLiveRoomRecordingAndReplay({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      reason: "missing_agora_cloud_recording_configuration",
    })
    return
  }
  if (!recording.provider_resource_id || !recording.provider_session_id) {
    await failLiveRoomRecordingAndReplay({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      reason: "missing_agora_cloud_recording_session",
    })
    return
  }
  try {
    const stopped = await stopAgoraCloudRecording({
      config,
      cname: input.channel,
      uid: String(liveRoomRecordingAgoraUid(input.room.id)),
      resourceId: recording.provider_resource_id,
      sid: recording.provider_session_id,
    })
    await markLiveRoomRecordingCaptured({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      stoppedAt: input.stoppedAt,
      updatedAt: nowIso(),
    })
    await enqueueCommunityJob({
      client: input.client,
      communityId: input.communityId,
      jobType: "live_room_recording_ingest",
      subjectType: "live_room",
      subjectId: input.room.id,
      payloadJson: JSON.stringify({
        agora_stop_response: stopped.serverResponse,
      }),
      createdAt: nowIso(),
    })
  } catch (error) {
    await failLiveRoomRecordingAndReplay({
      client: input.client,
      communityId: input.communityId,
      liveRoomId: input.room.id,
      reason: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function ingestCapturedLiveRoomRecording(input: {
  env: Env
  client: LiveRoomExecutor
  communityId: string
  room: LiveRoom
  agoraStopResponse: Record<string, unknown> | null
}): Promise<void> {
  const recording = await getLiveRoomRecording({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.room.id,
  })
  if (
    !recording
    || recording.raw_artifact_ref
    || (recording.status !== "captured" && recording.status !== "ingesting")
  ) {
    return
  }
  const now = nowIso()
  await markLiveRoomRecordingIngesting({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.room.id,
    updatedAt: now,
  })
  const agoraRecordingResponse = await resolveAgoraRecordingResponseForIngest({
    env: input.env,
    recording,
    initialResponse: input.agoraStopResponse,
  })
  const rawArtifact = await ingestAgoraRecordingToPrivateStorage({
    env: input.env,
    communityId: input.communityId,
    liveRoomId: input.room.id,
    recordingId: recording.recording_id,
    agoraStopResponse: agoraRecordingResponse,
  })
  const rawArtifactRef = serializeLiveRoomRecordingRawArtifactRef(rawArtifact)
  await markLiveRoomRecordingIngested({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.room.id,
    rawArtifactRef,
    updatedAt: nowIso(),
  })
  await createDraftLiveRoomReplayAsset({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.room.id,
    sourceRecordingId: recording.recording_id,
    title: input.room.title,
    primaryContentRef: rawArtifactRef,
    now: nowIso(),
  })
  await input.client.execute({
    sql: `
      UPDATE live_rooms
      SET replay_status = 'review_pending',
          updated_at = ?3
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_status = 'processing'
    `,
    args: [input.communityId, input.room.id, nowIso()],
  })
}

async function resolveAgoraRecordingResponseForIngest(input: {
  env: Env
  recording: Awaited<ReturnType<typeof getLiveRoomRecording>>
  initialResponse: Record<string, unknown> | null
}): Promise<Record<string, unknown> | null> {
  if (selectAgoraRecordingObjectKey(input.initialResponse)) {
    return input.initialResponse
  }
  const config = agoraCloudRecordingConfigFromEnv(input.env)
  if (!config || !input.recording?.provider_resource_id || !input.recording.provider_session_id) {
    return input.initialResponse
  }
  let lastResponse: Record<string, unknown> | null = input.initialResponse
  let lastError: unknown = null
  for (let attempt = 0; attempt < AGORA_RECORDING_QUERY_MAX_ATTEMPTS; attempt += 1) {
    try {
      const queried = await queryAgoraCloudRecording({
        config,
        resourceId: input.recording.provider_resource_id,
        sid: input.recording.provider_session_id,
      })
      lastResponse = queried
      if (selectAgoraRecordingObjectKey(queried)) {
        return queried
      }
    } catch (error) {
      lastError = error
    }
    if (attempt < AGORA_RECORDING_QUERY_MAX_ATTEMPTS - 1) {
      await sleep(AGORA_RECORDING_QUERY_RETRY_DELAY_MS)
    }
  }
  if (lastError && !lastResponse) {
    throw lastError
  }
  return lastResponse
}

export async function failLiveRoomRecordingAndReplay(input: {
  client: LiveRoomExecutor
  communityId: string
  liveRoomId: string
  reason: string
}): Promise<void> {
  const now = nowIso()
  await markLiveRoomRecordingFailed({
    client: input.client,
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
    failureReason: input.reason,
    updatedAt: now,
  })
  await input.client.execute({
    sql: `
      UPDATE live_rooms
      SET replay_status = 'failed',
          updated_at = ?3
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND replay_status IN ('processing', 'review_pending', 'failed')
    `,
    args: [input.communityId, input.liveRoomId, now],
  })
}

function liveRoomRecordingAgoraUid(liveRoomId: string): number {
  let hash = 2166136261
  for (let index = 0; index < liveRoomId.length; index += 1) {
    hash ^= liveRoomId.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) || 1
}
