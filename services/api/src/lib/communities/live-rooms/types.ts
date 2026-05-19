import type { CreateCommunityListingRequest } from "../../../types"

export type LiveRoomKind = "solo" | "duet"
export type LiveRoomStatus = "scheduled" | "live" | "ended" | "canceled"
export type LiveRoomAccessMode = "free" | "gated" | "paid"
export type LiveRoomVisibility = "public" | "unlisted"
export type LiveRoomSetlistStatus = "draft" | "ready" | "locked"
export type LiveRoomRightsBasis = "original" | "licensed" | "cover" | "public_domain" | "unknown"
export type LiveRoomRightsStatus = "pending" | "ready" | "blocked"
export type LiveRoomAttachClientKind = "web_host_console" | "desktop_native" | "android_native"

export type CreateLiveRoomRequest = {
  title?: string | null
  description?: string | null
  room_kind?: LiveRoomKind | null
  access_mode?: LiveRoomAccessMode | null
  visibility?: LiveRoomVisibility | null
  guest_user?: string | null
  event_start_at?: number | null
  cover_ref?: string | null
  store_url?: string | null
  store_label?: string | null
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

export type PublishLiveRoomRequest = {
  room?: CreateLiveRoomRequest | null
  listing?: CreateCommunityListingRequest | null
}

export type HostAttachRequest = {
  client_kind?: LiveRoomAttachClientKind | null
  refresh?: boolean | null
}

export type GuestAttachRequest = {
  client_kind?: LiveRoomAttachClientKind | null
  refresh?: boolean | null
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
  store_url: string | null
  store_label: string | null
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

export type LiveRoomViewerRenewRequest = {
  uid?: unknown
}
