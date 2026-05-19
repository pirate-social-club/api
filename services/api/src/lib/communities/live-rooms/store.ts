import type { Client, QueryResultRow } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { notFoundError } from "../../errors"
import { publicId } from "../../public-ids"
import { requiredString, rowValue, stringOrNull, numberOrNull } from "../../sql-row"
import type {
  LiveRoom,
  LiveRoomAccessMode,
  LiveRoomKind,
  LiveRoomRightsBasis,
  LiveRoomRightsStatus,
  LiveRoomSetlistStatus,
  LiveRoomStatus,
  LiveRoomVisibility,
} from "./types"

export type LiveRoomExecutor = Pick<Client, "execute">

export type LiveRoomRow = {
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
  store_url: string | null
  store_label: string | null
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

export async function getLiveRoomRow(
  client: LiveRoomExecutor,
  communityId: string,
  liveRoomId: string,
): Promise<LiveRoomRow> {
  const row = await executeFirst(client, {
    sql: `
      SELECT live_room_id, community_id, anchor_post_id, host_user_id, guest_user_id,
             room_kind, status, access_mode, visibility, title, description, cover_ref,
             store_url, store_label, event_start_at, live_started_at, ended_at,
             canceled_at, broadcast_ref, replay_status, created_at, updated_at
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

export async function getHydratedLiveRoom(
  client: LiveRoomExecutor,
  communityId: string,
  liveRoomId: string,
): Promise<LiveRoom> {
  return hydrateLiveRoom(client, await getLiveRoomRow(client, communityId, liveRoomId))
}

export async function hydrateLiveRoom(client: LiveRoomExecutor, room: LiveRoomRow): Promise<LiveRoom> {
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
    store_url: room.store_url,
    store_label: room.store_label,
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

export function serializeLiveRoom(room: LiveRoom): LiveRoom {
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

function unixSeconds(iso: string): number {
  const millis = Date.parse(iso)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : 0
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
    store_url: stringOrNull(rowValue(row, "store_url")),
    store_label: stringOrNull(rowValue(row, "store_label")),
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
