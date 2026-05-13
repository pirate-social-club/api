import type { Client, QueryResultRow } from "../../sql-client"
import type { Env } from "../../../env"
import type { CommunityDatabaseBindingRepository, CommunityPostProjectionRepository, CommunityReadRepository } from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import { executeFirst } from "../../db-helpers"
import { badRequestError, conflictError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { openCommunityDb } from "../community-db-factory"
import { enqueueCommunityJob } from "../jobs/store"
import {
  OWNER_OR_ADMIN_ROLE,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { requiredString, rowValue, stringOrNull, numberOrNull } from "../../sql-row"
import { getPostById } from "../../posts/community-post-store"
import {
  attachLiveRoomRuntime,
  endLiveRoomRuntime,
  revokeGuestLiveRoomRuntime,
  type LiveRoomRuntimeAttachResponse,
} from "./runtime"
import { decodePublicAssetId, decodePublicSongArtifactBundleId, decodePublicUserId, publicId } from "../../public-ids"

export type LiveRoomKind = "solo" | "duet"
export type LiveRoomStatus = "scheduled" | "live" | "ended" | "canceled"
export type LiveRoomAccessMode = "free" | "gated" | "paid"
export type LiveRoomVisibility = "public" | "unlisted"
export type LiveRoomSetlistStatus = "draft" | "ready" | "locked"
export type LiveRoomRightsBasis = "original" | "licensed" | "cover" | "public_domain" | "unknown"
export type LiveRoomRightsStatus = "pending" | "ready" | "blocked"

export type CreateLiveRoomRequest = {
  title?: string | null
  description?: string | null
  room_kind?: LiveRoomKind | null
  access_mode?: LiveRoomAccessMode | null
  visibility?: LiveRoomVisibility | null
  guest_user?: string | null
  event_start_at?: number | null
  cover_ref?: string | null
  performer_allocations?: Array<{
    user?: string | null
    role?: "host" | "guest" | null
    share_bps?: number | null
  }> | null
  setlist?: {
    status?: LiveRoomSetlistStatus | null
    items?: Array<{
      song_artifact_bundle?: string | null
      source_asset_ref?: string | null
      title?: string | null
      artist?: string | null
      rights_basis?: LiveRoomRightsBasis | null
      license_ref?: string | null
      rights_status?: LiveRoomRightsStatus | null
      blocking_rights_failure?: boolean | null
    }> | null
  } | null
}

type LiveRoomRow = {
  live_room_id: string
  community_id: string
  anchor_post_id: string
  host_user_id: string
  guest_user_id: string | null
  room_kind: LiveRoomKind
  status: LiveRoomStatus
  access_mode: LiveRoomAccessMode
  visibility: LiveRoomVisibility
  title: string
  description: string | null
  cover_ref: string | null
  event_start_at: number | null
  live_started_at: number | null
  ended_at: number | null
  canceled_at: number | null
  broadcast_ref: string | null
  replay_status: string
  created_at: string
  updated_at: string
}

type AllocationRow = {
  allocation_id: string
  user_id: string
  role: "host" | "guest"
  share_bps: number
}

type SetlistRow = {
  setlist_id: string
  status: LiveRoomSetlistStatus
}

type SetlistItemRow = {
  setlist_item_id: string
  position: number
  song_artifact_bundle_id: string | null
  source_asset_ref: string | null
  title: string
  artist: string | null
  rights_basis: LiveRoomRightsBasis
  license_ref: string | null
  rights_status: LiveRoomRightsStatus
  blocking_rights_failure: number
}

export type LiveRoom = {
  id: string
  object: "live_room"
  community: string
  anchor_post: string
  host_user: string
  guest_user: string | null
  room_kind: LiveRoomKind
  status: LiveRoomStatus
  access_mode: LiveRoomAccessMode
  visibility: LiveRoomVisibility
  title: string
  description: string | null
  cover_ref: string | null
  event_start_at: number | null
  live_started_at: number | null
  ended_at: number | null
  canceled_at: number | null
  broadcast_ref: string | null
  replay_status: string
  performer_allocations: Array<{
    id: string
    object: "live_room_performer_allocation"
    user: string
    role: "host" | "guest"
    share_bps: number
  }>
  setlist: {
    id: string
    object: "live_room_setlist"
    status: LiveRoomSetlistStatus
    items: Array<{
      id: string
      object: "live_room_setlist_item"
      position: number
      song_artifact_bundle: string | null
      source_asset_ref: string | null
      title: string
      artist: string | null
      rights_basis: LiveRoomRightsBasis
      license_ref: string | null
      rights_status: LiveRoomRightsStatus
      blocking_rights_failure: boolean
    }>
  }
  created: number
}

export type LiveRoomAttachResponse = {
  room: LiveRoom
  runtime: LiveRoomRuntimeAttachResponse["runtime"]
  bridge: LiveRoomRuntimeAttachResponse["bridge"]
  agora: LiveRoomRuntimeAttachResponse["agora"]
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

type LiveRoomRepository = CommunityReadRepository & CommunityDatabaseBindingRepository & CommunityPostProjectionRepository
type LiveRoomExecutor = Pick<Client, "execute">

function unixSeconds(iso: string): number {
  const millis = Date.parse(iso)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function requireTitle(value: unknown): string {
  const title = cleanString(value)
  if (!title) {
    throw badRequestError("title is required")
  }
  if (title.length > 140) {
    throw badRequestError("title must be 140 characters or fewer")
  }
  return title
}

function optionalDescription(value: unknown): string | null {
  const description = cleanString(value)
  if (!description) return null
  if (description.length > 2000) {
    throw badRequestError("description must be 2000 characters or fewer")
  }
  return description
}

function normalizeRoomKind(value: unknown): LiveRoomKind {
  if (value == null || value === "") return "solo"
  if (value === "solo" || value === "duet") return value
  throw badRequestError("room_kind must be solo or duet")
}

function normalizeAccessMode(value: unknown): LiveRoomAccessMode {
  if (value == null || value === "") return "free"
  if (value === "free" || value === "gated" || value === "paid") return value
  throw badRequestError("access_mode must be free, gated, or paid")
}

function normalizeVisibility(value: unknown, accessMode: LiveRoomAccessMode): LiveRoomVisibility {
  if (value == null || value === "") return "public"
  if (value !== "public" && value !== "unlisted") {
    throw badRequestError("visibility must be public or unlisted")
  }
  if (accessMode === "paid" && value !== "public") {
    throw badRequestError("paid live rooms must be public")
  }
  return value
}

function normalizeSetlistStatus(value: unknown): LiveRoomSetlistStatus {
  if (value == null || value === "") return "draft"
  if (value === "draft" || value === "ready" || value === "locked") return value
  throw badRequestError("setlist.status must be draft, ready, or locked")
}

function normalizeRightsBasis(value: unknown): LiveRoomRightsBasis {
  if (value === "original" || value === "licensed" || value === "cover" || value === "public_domain" || value === "unknown") {
    return value
  }
  throw badRequestError("setlist item rights_basis is required")
}

function normalizeRightsStatus(value: unknown): LiveRoomRightsStatus {
  if (value == null || value === "") return "pending"
  if (value === "pending" || value === "ready" || value === "blocked") return value
  throw badRequestError("setlist item rights_status must be pending, ready, or blocked")
}

function normalizeEventStartAt(value: unknown): number | null {
  if (value == null || value === "") return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw badRequestError("event_start_at must be a Unix timestamp")
  }
  return parsed
}

function normalizeUserId(value: unknown, field: string): string {
  const userId = cleanString(value)
  const decodedUserId = userId ? decodePublicUserId(userId) : null
  if (!decodedUserId || !/^usr_[a-zA-Z0-9]+$/.test(decodedUserId)) {
    throw badRequestError(`${field} must be a Pirate user id`)
  }
  return decodedUserId
}

function normalizeSongArtifactBundleId(value: unknown): string | null {
  const songArtifactBundleId = cleanString(value)
  if (!songArtifactBundleId) return null
  const decodedSongArtifactBundleId = decodePublicSongArtifactBundleId(songArtifactBundleId)
  if (!/^sab_[a-zA-Z0-9]+$/.test(decodedSongArtifactBundleId)) {
    throw badRequestError("setlist item song_artifact_bundle must be a Pirate song artifact bundle id")
  }
  return decodedSongArtifactBundleId
}

function normalizeSourceAssetRef(value: unknown): string | null {
  const sourceAssetRef = cleanString(value)
  if (!sourceAssetRef) return null
  if (!sourceAssetRef.startsWith("story:asset:")) {
    throw badRequestError("setlist item source_asset_ref must be a Story asset ref")
  }
  const assetRef = sourceAssetRef.slice("story:asset:".length)
  const decodedAssetId = decodePublicAssetId(assetRef)
  if (!/^ast_[a-zA-Z0-9_]+$/.test(decodedAssetId)) {
    throw badRequestError("setlist item source_asset_ref must reference a Pirate asset")
  }
  return `story:asset:${publicId(decodedAssetId, "asset")}`
}

function rowToLiveRoom(row: QueryResultRow): LiveRoomRow {
  return {
    live_room_id: requiredString(row, "live_room_id"),
    community_id: requiredString(row, "community_id"),
    anchor_post_id: requiredString(row, "anchor_post_id"),
    host_user_id: requiredString(row, "host_user_id"),
    guest_user_id: stringOrNull(rowValue(row, "guest_user_id")),
    room_kind: requiredString(row, "room_kind") as LiveRoomKind,
    status: requiredString(row, "status") as LiveRoomStatus,
    access_mode: requiredString(row, "access_mode") as LiveRoomAccessMode,
    visibility: requiredString(row, "visibility") as LiveRoomVisibility,
    title: requiredString(row, "title"),
    description: stringOrNull(rowValue(row, "description")),
    cover_ref: stringOrNull(rowValue(row, "cover_ref")),
    event_start_at: numberOrNull(rowValue(row, "event_start_at")),
    live_started_at: numberOrNull(rowValue(row, "live_started_at")),
    ended_at: numberOrNull(rowValue(row, "ended_at")),
    canceled_at: numberOrNull(rowValue(row, "canceled_at")),
    broadcast_ref: stringOrNull(rowValue(row, "broadcast_ref")),
    replay_status: requiredString(row, "replay_status"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function rowToAllocation(row: QueryResultRow): AllocationRow {
  return {
    allocation_id: requiredString(row, "allocation_id"),
    user_id: requiredString(row, "user_id"),
    role: requiredString(row, "role") as AllocationRow["role"],
    share_bps: Number(rowValue(row, "share_bps") ?? 0),
  }
}

function rowToSetlist(row: QueryResultRow): SetlistRow {
  return {
    setlist_id: requiredString(row, "setlist_id"),
    status: requiredString(row, "status") as LiveRoomSetlistStatus,
  }
}

function rowToSetlistItem(row: QueryResultRow): SetlistItemRow {
  return {
    setlist_item_id: requiredString(row, "setlist_item_id"),
    position: Number(rowValue(row, "position") ?? 0),
    song_artifact_bundle_id: stringOrNull(rowValue(row, "song_artifact_bundle_id")),
    source_asset_ref: stringOrNull(rowValue(row, "source_asset_ref")),
    title: requiredString(row, "title"),
    artist: stringOrNull(rowValue(row, "artist")),
    rights_basis: requiredString(row, "rights_basis") as LiveRoomRightsBasis,
    license_ref: stringOrNull(rowValue(row, "license_ref")),
    rights_status: requiredString(row, "rights_status") as LiveRoomRightsStatus,
    blocking_rights_failure: Number(rowValue(row, "blocking_rights_failure") ?? 0),
  }
}

async function hydrateLiveRoom(client: LiveRoomExecutor, room: LiveRoomRow): Promise<LiveRoom> {
  const allocations = (await client.execute({
    sql: `
      SELECT allocation_id, user_id, role, share_bps
      FROM live_room_performer_allocations
      WHERE live_room_id = ?1
      ORDER BY CASE role WHEN 'host' THEN 0 ELSE 1 END
    `,
    args: [room.live_room_id],
  })).rows.map(rowToAllocation)

  const setlistRow = await executeFirst(client, {
    sql: `
      SELECT setlist_id, status
      FROM live_room_setlists
      WHERE live_room_id = ?1
      LIMIT 1
    `,
    args: [room.live_room_id],
  }) as QueryResultRow | null
  if (!setlistRow) {
    throw notFoundError("Live room setlist not found")
  }
  const setlist = rowToSetlist(setlistRow)
  const items = (await client.execute({
    sql: `
      SELECT setlist_item_id, position, song_artifact_bundle_id, source_asset_ref, title, artist,
             rights_basis, license_ref, rights_status, blocking_rights_failure
      FROM live_room_setlist_items
      WHERE setlist_id = ?1
      ORDER BY position ASC
    `,
    args: [setlist.setlist_id],
  })).rows.map(rowToSetlistItem)

  return {
    id: room.live_room_id,
    object: "live_room",
    community: room.community_id,
    anchor_post: room.anchor_post_id,
    host_user: room.host_user_id,
    guest_user: room.guest_user_id,
    room_kind: room.room_kind,
    status: room.status,
    access_mode: room.access_mode,
    visibility: room.visibility,
    title: room.title,
    description: room.description,
    cover_ref: room.cover_ref,
    event_start_at: room.event_start_at,
    live_started_at: room.live_started_at,
    ended_at: room.ended_at,
    canceled_at: room.canceled_at,
    broadcast_ref: room.broadcast_ref,
    replay_status: room.replay_status,
    performer_allocations: allocations.map((allocation) => ({
      id: allocation.allocation_id,
      object: "live_room_performer_allocation",
      user: allocation.user_id,
      role: allocation.role,
      share_bps: allocation.share_bps,
    })),
    setlist: {
      id: setlist.setlist_id,
      object: "live_room_setlist",
      status: setlist.status,
      items: items.map((item) => ({
        id: item.setlist_item_id,
        object: "live_room_setlist_item",
        position: item.position,
        song_artifact_bundle: item.song_artifact_bundle_id,
        source_asset_ref: item.source_asset_ref,
        title: item.title,
        artist: item.artist,
        rights_basis: item.rights_basis,
        license_ref: item.license_ref,
        rights_status: item.rights_status,
        blocking_rights_failure: item.blocking_rights_failure === 1,
      })),
    },
    created: unixSeconds(room.created_at),
  }
}

function serializeLiveRoom(room: LiveRoom): LiveRoom {
  return {
    ...room,
    host_user: publicId(room.host_user, "usr"),
    guest_user: room.guest_user ? publicId(room.guest_user, "usr") : null,
    performer_allocations: room.performer_allocations.map((allocation) => ({
      ...allocation,
      user: publicId(allocation.user, "usr"),
    })),
    setlist: {
      ...room.setlist,
      items: room.setlist.items.map((item) => ({
        ...item,
        song_artifact_bundle: item.song_artifact_bundle
          ? publicId(item.song_artifact_bundle, "sab")
          : null,
      })),
    },
  }
}

async function getRoomRow(client: LiveRoomExecutor, communityId: string, liveRoomId: string): Promise<LiveRoomRow> {
  const row = await executeFirst(client, {
    sql: `
      SELECT live_room_id, community_id, anchor_post_id, host_user_id, guest_user_id,
             room_kind, status, access_mode, visibility, title, description, cover_ref,
             event_start_at, live_started_at, ended_at, canceled_at, broadcast_ref,
             replay_status, created_at, updated_at
      FROM live_rooms
      WHERE community_id = ?1 AND live_room_id = ?2
      LIMIT 1
    `,
    args: [communityId, liveRoomId],
  }) as QueryResultRow | null
  if (!row) {
    throw notFoundError("Live room not found")
  }
  return rowToLiveRoom(row)
}

async function requireSchedulePermission(client: Client, communityId: string, userId: string): Promise<void> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (!hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
    throw notFoundError("Community not found")
  }
}

function normalizeAllocations(input: {
  body: CreateLiveRoomRequest
  hostUserId: string
  guestUserId: string | null
  roomKind: LiveRoomKind
}): Array<{ userId: string; role: "host" | "guest"; shareBps: number }> {
  const source = Array.isArray(input.body.performer_allocations)
    ? input.body.performer_allocations
    : input.roomKind === "duet" && input.guestUserId
      ? [
        { user: input.hostUserId, role: "host" as const, share_bps: 5000 },
        { user: input.guestUserId, role: "guest" as const, share_bps: 5000 },
      ]
      : [{ user: input.hostUserId, role: "host" as const, share_bps: 10000 }]

  const allocations = source.map((entry) => {
    const role = entry.role
    if (role !== "host" && role !== "guest") {
      throw badRequestError("performer allocation role must be host or guest")
    }
    const userId = normalizeUserId(entry.user, "performer allocation user")
    const shareBps = Number(entry.share_bps)
    if (!Number.isInteger(shareBps) || shareBps < 0 || shareBps > 10000) {
      throw badRequestError("performer allocation share_bps must be between 0 and 10000")
    }
    return { userId, role, shareBps }
  })

  if (allocations.reduce((sum, allocation) => sum + allocation.shareBps, 0) !== 10000) {
    throw badRequestError("performer allocations must sum to 10000 bps")
  }
  if (!allocations.some((allocation) => allocation.role === "host" && allocation.userId === input.hostUserId)) {
    throw badRequestError("performer allocations must include the host")
  }
  if (input.roomKind === "solo" && allocations.some((allocation) => allocation.role === "guest")) {
    throw badRequestError("solo rooms cannot include a guest allocation")
  }
  if (input.roomKind === "duet") {
    if (!input.guestUserId) {
      throw badRequestError("guest_user is required for duet rooms")
    }
    if (!allocations.some((allocation) => allocation.role === "guest" && allocation.userId === input.guestUserId)) {
      throw badRequestError("duet performer allocations must include the guest")
    }
  }
  return allocations
}

function normalizeSetlist(body: CreateLiveRoomRequest): {
  status: LiveRoomSetlistStatus
  items: Array<{
    title: string
    artist: string | null
    songArtifactBundleId: string | null
    sourceAssetRef: string | null
    rightsBasis: LiveRoomRightsBasis
    licenseRef: string | null
    rightsStatus: LiveRoomRightsStatus
    blockingRightsFailure: boolean
  }>
} {
  if (!body.setlist || !Array.isArray(body.setlist.items) || body.setlist.items.length === 0) {
    throw badRequestError("setlist.items is required")
  }
  return {
    status: normalizeSetlistStatus(body.setlist.status),
    items: body.setlist.items.map((item) => {
      const title = cleanString(item.title)
      if (!title) {
        throw badRequestError("setlist item title is required")
      }
      const rightsBasis = normalizeRightsBasis(item.rights_basis)
      const licenseRef = cleanString(item.license_ref)
      if (rightsBasis === "licensed" && !licenseRef) {
        throw badRequestError("setlist item license_ref is required when rights_basis is licensed")
      }
      return {
        title,
        artist: cleanString(item.artist),
        songArtifactBundleId: normalizeSongArtifactBundleId(item.song_artifact_bundle),
        sourceAssetRef: normalizeSourceAssetRef(item.source_asset_ref),
        rightsBasis,
        licenseRef,
        rightsStatus: normalizeRightsStatus(item.rights_status),
        blockingRightsFailure: item.blocking_rights_failure === true,
      }
    }),
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

async function assertAcceptedGuestInvite(client: LiveRoomExecutor, input: {
  communityId: string
  liveRoomId: string
  guestUserId: string
}): Promise<void> {
  const row = await executeFirst(client, {
    sql: `
      SELECT status
      FROM live_room_guest_invites
      WHERE community_id = ?1
        AND live_room_id = ?2
        AND guest_user_id = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.liveRoomId, input.guestUserId],
  }) as QueryResultRow | null
  if (rowValue(row, "status") !== "accepted") {
    throw conflictError("Guest invite must be accepted before attach")
  }
}

function parseOptionalPositiveInteger(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value?.trim()) return fallback
  const normalized = value.trim().toLowerCase()
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true
  if (normalized === "0" || normalized === "false" || normalized === "no") return false
  return fallback
}

function jacktripServerForRoom(env: Env, room: LiveRoom): string | null {
  const template = cleanString(env.LIVE_ROOM_JACKTRIP_HOST_TEMPLATE)
  if (template) {
    return template
      .replaceAll("{community}", room.community)
      .replaceAll("{room}", room.id)
      .replaceAll("{live_room}", room.id)
  }
  return cleanString(env.LIVE_ROOM_JACKTRIP_HOST)
}

function buildJacktripBlock(env: Env, room: LiveRoom): LiveRoomAttachResponse["jacktrip"] {
  const required = room.room_kind === "duet"
  const server = required ? jacktripServerForRoom(env, room) : null
  const port = required ? parseOptionalPositiveInteger(env.LIVE_ROOM_JACKTRIP_PORT) ?? 4464 : null
  return {
    required,
    configured: !required || Boolean(server),
    server,
    port,
    bind_port: required ? parseOptionalPositiveInteger(env.LIVE_ROOM_JACKTRIP_BIND_PORT) : null,
    quality: cleanString(env.LIVE_ROOM_JACKTRIP_QUALITY) ?? "4",
    buffer_strategy: cleanString(env.LIVE_ROOM_JACKTRIP_BUFFER_STRATEGY) ?? "3",
    linux_audio_setup_recommended: required
      ? parseBooleanEnv(env.LIVE_ROOM_JACKTRIP_LINUX_AUDIO_SETUP_RECOMMENDED, true)
      : false,
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
  const title = requireTitle(input.body.title)
  const description = optionalDescription(input.body.description)
  const roomKind = normalizeRoomKind(input.body.room_kind)
  const accessMode = normalizeAccessMode(input.body.access_mode)
  const visibility = normalizeVisibility(input.body.visibility, accessMode)
  const guestUserId = input.body.guest_user ? normalizeUserId(input.body.guest_user, "guest_user") : null
  const eventStartAt = normalizeEventStartAt(input.body.event_start_at)
  if (roomKind === "duet" && !guestUserId) {
    throw badRequestError("guest_user is required for duet rooms")
  }
  if (roomKind === "solo" && guestUserId) {
    throw badRequestError("solo rooms cannot include guest_user")
  }
  if (guestUserId) {
    const guest = await input.userRepository.getUserById(guestUserId)
    if (!guest) {
      throw notFoundError("Guest user not found")
    }
  }
  const allocations = normalizeAllocations({
    body: input.body,
    hostUserId: input.userId,
    guestUserId,
    roomKind,
  })
  const setlist = normalizeSetlist(input.body)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireSchedulePermission(db.client, input.communityId, input.userId)
    const liveRoomId = makeId("lr")
    const anchorPostId = makeId("pst")
    const setlistId = makeId("lrs")
    const now = nowIso()
    const status: LiveRoomStatus = "scheduled"
    const tx = await db.client.transaction("write")
    let createdRoom: LiveRoom | null = null
    let anchorPost: Awaited<ReturnType<typeof getPostById>> = null
    try {
      await tx.execute({
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
        args: [anchorPostId, input.communityId, input.userId, title, description, now],
      })
      await tx.execute({
        sql: `
          INSERT INTO live_rooms (
            live_room_id, community_id, anchor_post_id, host_user_id, guest_user_id,
            room_kind, status, access_mode, visibility, title, description, cover_ref,
            event_start_at, live_started_at, ended_at, canceled_at, broadcast_ref,
            replay_status, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, ?9, ?10, ?11, ?12,
            ?13, NULL, NULL, NULL, NULL,
            'none', ?14, ?14
          )
        `,
        args: [
          liveRoomId,
          input.communityId,
          anchorPostId,
          input.userId,
          guestUserId,
          roomKind,
          status,
          accessMode,
          visibility,
          title,
          description,
          cleanString(input.body.cover_ref),
          eventStartAt,
          now,
        ],
      })
      for (const allocation of allocations) {
        await tx.execute({
          sql: `
            INSERT INTO live_room_performer_allocations (
              allocation_id, live_room_id, community_id, user_id, role, share_bps, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
          `,
          args: [makeId("lra"), liveRoomId, input.communityId, allocation.userId, allocation.role, allocation.shareBps, now],
        })
      }
      await tx.execute({
        sql: `
          INSERT INTO live_room_setlists (
            setlist_id, live_room_id, community_id, status, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        `,
        args: [setlistId, liveRoomId, input.communityId, setlist.status, now],
      })
      for (const [index, item] of setlist.items.entries()) {
        await tx.execute({
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
      if (guestUserId) {
        await tx.execute({
          sql: `
            INSERT INTO live_room_guest_invites (
              guest_invite_id, live_room_id, community_id, guest_user_id, status,
              accepted_at, revoked_at, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, 'pending', NULL, NULL, ?5, ?5)
          `,
          args: [makeId("lgi"), liveRoomId, input.communityId, guestUserId, now],
        })
      }

      const room = await hydrateLiveRoom(tx, await getRoomRow(tx, input.communityId, liveRoomId))
      const post = await getPostById(tx, anchorPostId)
      if (!post) {
        throw notFoundError("Anchor post not found")
      }
      createdRoom = room
      anchorPost = post
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
    if (!createdRoom || !anchorPost) {
      throw notFoundError("Live room not found")
    }
    try {
      await input.communityRepository.recordCommunityPostProjection({
        communityId: input.communityId,
        sourcePostId: anchorPost.post_id,
        authorUserId: anchorPost.author_user_id ?? null,
        identityMode: anchorPost.identity_mode,
        postType: anchorPost.post_type,
        status: anchorPost.status,
        visibility: anchorPost.visibility,
        sourceCreatedAt: anchorPost.created_at,
        projectedPayloadJson: JSON.stringify(anchorPost),
        actorUserId: input.userId,
        createdAt: now,
      })
    } catch (error) {
      console.error("[live-rooms] failed to record anchor post projection; queued retry", {
        communityId: input.communityId,
        liveRoomId,
        postId: anchorPost.post_id,
        error,
      })
      await enqueueAnchorPostProjectionRetry({
        client: db.client,
        communityId: input.communityId,
        postId: anchorPost.post_id,
        sourceCreatedAt: anchorPost.created_at,
        createdAt: nowIso(),
      })
    }
    return serializeLiveRoom(createdRoom)
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
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    if (!hasCommunityRole(membership, ["owner", "admin", "moderator"]) && membership.membership_status !== "member") {
      throw notFoundError("Live room not found")
    }
    return serializeLiveRoom(await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId)))
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const room = await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId))
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
    const attachedRoom = await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId))
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const room = await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId))
    if (room.guest_user !== input.userId) {
      throw notFoundError("Live room not found")
    }
    await assertAcceptedGuestInvite(db.client, {
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
    const room = await getRoomRow(db.client, input.communityId, input.liveRoomId)
    if (room.host_user_id !== input.userId) {
      throw notFoundError("Live room not found")
    }
    if (room.status === "live" || room.status === "ended") {
      throw conflictError("Live room cannot be canceled after it is live")
    }
    const now = nowIso()
    await db.client.execute({
      sql: `
        UPDATE live_rooms
        SET status = 'canceled',
            canceled_at = ?3,
            updated_at = ?4
        WHERE community_id = ?1 AND live_room_id = ?2
      `,
      args: [input.communityId, input.liveRoomId, Math.floor(Date.now() / 1000), now],
    })
    return serializeLiveRoom(await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId)))
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
    const room = await getRoomRow(db.client, input.communityId, input.liveRoomId)
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
    return serializeLiveRoom(await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId)))
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
    const room = await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId))
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
    return serializeLiveRoom(await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId)))
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
    const room = await hydrateLiveRoom(db.client, await getRoomRow(db.client, input.communityId, input.liveRoomId))
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
      const endedRoom = await hydrateLiveRoom(tx, await getRoomRow(tx, input.communityId, input.liveRoomId))
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
