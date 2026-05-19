import type { QueryResultRow } from "../../sql-client"
import type { Env } from "../../../env"
import type { CommunityDatabaseBindingRepository, CommunityPostProjectionRepository, CommunityReadRepository } from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import { executeFirst } from "../../db-helpers"
import { authError, badRequestError, conflictError, notFoundError, paymentRequired } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { openCommunityDb } from "../community-db-factory"
import { enqueueCommunityJob } from "../jobs/store"
import {
  OWNER_OR_ADMIN_ROLE,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { rowValue } from "../../sql-row"
import { assertAcceptedLiveRoomGuestInvite } from "./guest-invites"
import { buildJacktripBlock, type LiveRoomJacktripBlock } from "./jacktrip"
import {
  attachLiveRoomViewerRuntime,
  attachLiveRoomRuntime,
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
  getHydratedLiveRoom,
  getLiveRoomRow,
  serializeLiveRoom,
  type LiveRoomExecutor,
} from "./store"
import { createCommunityListingInTransaction } from "../commerce/listing-service"
import {
  assertLiveRoomViewerSessionUid,
  assertPublicLiveRoomViewerSessionUid,
  deleteLiveRoomViewerSessions,
  normalizeLiveRoomViewerUid,
  recordLiveRoomViewerSession,
} from "./viewer-sessions"
import type { CommunityListing } from "../../../types"
import type {
  CreateLiveRoomRequest,
  GuestAttachRequest,
  HostAttachRequest,
  LiveRoom,
  LiveRoomAttachClientKind,
  LiveRoomStatus,
  LiveRoomViewerRenewRequest,
  PublishLiveRoomRequest,
} from "./types"

export type {
  CreateLiveRoomRequest,
  GuestAttachRequest,
  HostAttachRequest,
  LiveRoom,
  LiveRoomAccessMode,
  LiveRoomAttachClientKind,
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

const LIVE_ROOM_ATTACH_CLIENT_KINDS = new Set<LiveRoomAttachClientKind>([
  "web_host_console",
  "desktop_native",
  "android_native",
])

function normalizeLiveRoomAttachRequest(
  body: HostAttachRequest | GuestAttachRequest | null,
  message: string,
): { clientKind: LiveRoomAttachClientKind | null; refresh: boolean } {
  if (body == null) {
    return { clientKind: null, refresh: false }
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    throw badRequestError(message)
  }
  const clientKind = body.client_kind ?? null
  if (clientKind != null && !LIVE_ROOM_ATTACH_CLIENT_KINDS.has(clientKind)) {
    throw badRequestError("client_kind must be web_host_console, desktop_native, or android_native")
  }
  if (body.refresh != null && typeof body.refresh !== "boolean") {
    throw badRequestError("refresh must be a boolean")
  }
  return {
    clientKind,
    refresh: body.refresh ?? false,
  }
}

export type PublishLiveRoomResponse = {
  room: LiveRoom
  listing: CommunityListing
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

async function createLiveRoomInTransaction(input: {
  tx: LiveRoomExecutor
  userId: string
  communityId: string
  prepared: PreparedLiveRoomCreate
}): Promise<{
  room: LiveRoom
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
        store_url, store_label, event_start_at, live_started_at, ended_at, canceled_at,
        broadcast_ref, replay_status, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11, ?12,
        ?13, ?14, ?15, NULL, NULL, NULL,
        NULL, 'none', ?16, ?16
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
      input.prepared.storeUrl,
      input.prepared.storeLabel,
      input.prepared.eventStartAt,
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
    room: await getHydratedLiveRoom(input.tx, input.communityId, liveRoomId),
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
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const prepared = await createLiveRoomPreflight({
      client: db.client,
      userId: input.userId,
      communityId: input.communityId,
      body: input.body,
      userRepository: input.userRepository,
    })
    const tx = await db.client.transaction("write")
    let created: Awaited<ReturnType<typeof createLiveRoomInTransaction>> | null = null
    try {
      created = await createLiveRoomInTransaction({
        tx,
        userId: input.userId,
        communityId: input.communityId,
        prepared,
      })
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[live-rooms] rollback failed while creating live room", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
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
    return serializeLiveRoom(created.room)
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
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  const listingBody = input.body.listing
  if (!listingBody) {
    throw badRequestError("listing is required")
  }
  if (listingBody.asset?.trim() || listingBody.live_room?.trim()) {
    throw badRequestError("publish listing target is assigned by the server")
  }
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
    const tx = await db.client.transaction("write")
    let created: Awaited<ReturnType<typeof createLiveRoomInTransaction>> | null = null
    let listing: CommunityListing | null = null
    try {
      created = await createLiveRoomInTransaction({
        tx,
        userId: input.userId,
        communityId: input.communityId,
        prepared,
      })
      listing = await createCommunityListingInTransaction({
        env: input.env,
        userId: input.userId,
        communityId: input.communityId,
        body: {
          ...listingBody,
          asset: null,
          live_room: created.liveRoomId,
        },
        communityRepository: input.communityRepository,
        userRepository: input.userRepository,
        client: tx,
      })
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[live-rooms] rollback failed while publishing live room", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
    if (!created || !listing) {
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
    return {
      room: serializeLiveRoom(created.room),
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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

export async function viewerAttachLiveRoom(input: {
  env: Env
  userId: string
  communityId: string
  liveRoomId: string
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomViewerAttachResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  body?: HostAttachRequest | null
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomAttachResponse> {
  normalizeLiveRoomAttachRequest(input.body ?? null, "Invalid live room host attach payload")
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
      await db.client.execute({
        sql: `
          UPDATE live_rooms
          SET status = 'live',
              live_started_at = ?3,
              broadcast_ref = ?4,
              updated_at = ?5
          WHERE community_id = ?1 AND live_room_id = ?2 AND status = 'scheduled'
        `,
        args: [input.communityId, input.liveRoomId, Math.floor(Date.now() / 1000), runtime.runtime.room_runtime_id, nowIso()],
      })
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
  body?: GuestAttachRequest | null
  communityRepository: LiveRoomRepository
}): Promise<LiveRoomAttachResponse> {
  normalizeLiveRoomAttachRequest(input.body ?? null, "Invalid live room guest attach payload")
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const room = await getLiveRoomRow(db.client, input.communityId, input.liveRoomId)
    if (room.host_user_id !== input.userId) {
      throw notFoundError("Live room not found")
    }
    if (room.status === "live" || room.status === "ended") {
      throw conflictError("Live room cannot be canceled after it is live")
    }
    const now = nowIso()
    const tx = await db.client.transaction("write")
    try {
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
      const canceledRoom = await getHydratedLiveRoom(tx, input.communityId, input.liveRoomId)
      await tx.commit()
      return serializeLiveRoom(canceledRoom)
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[live-rooms] rollback failed while canceling live room", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
    const tx = await db.client.transaction("write")
    try {
      await tx.execute({
        sql: `
          UPDATE live_rooms
          SET status = 'ended',
              ended_at = ?3,
              updated_at = ?4
          WHERE community_id = ?1 AND live_room_id = ?2 AND status = 'live'
        `,
        args: [input.communityId, input.liveRoomId, runtime.ended_at, now],
      })
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
      const endedRoom = await getHydratedLiveRoom(tx, input.communityId, input.liveRoomId)
      await tx.commit()
      return serializeLiveRoom(endedRoom)
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[live-rooms] rollback failed while ending live room", rollbackError)
      }
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}
