import { badRequestError } from "../../errors"
import { decodePublicAssetId, decodePublicSongArtifactBundleId, decodePublicUserId, publicId } from "../../public-ids"
import type {
  CreateLiveRoomRequest,
  LiveRoomAccessMode,
  LiveRoomKind,
  LiveRoomRightsBasis,
  LiveRoomRightsStatus,
  LiveRoomSetlistStatus,
  LiveRoomVisibility,
} from "./types"

export type PreparedLiveRoomCreate = {
  title: string
  description: string | null
  roomKind: LiveRoomKind
  accessMode: LiveRoomAccessMode
  visibility: LiveRoomVisibility
  guestUserId: string | null
  eventStartAt: number | null
  coverRef: string | null
  storeUrl: string | null
  storeLabel: string | null
  allocations: Array<{ userId: string; role: "host" | "guest"; shareBps: number }>
  setlist: PreparedLiveRoomSetlist
}

type PreparedLiveRoomSetlist = {
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
}

export function normalizeLiveRoomCreateRequest(input: {
  body: CreateLiveRoomRequest
  hostUserId: string
}): PreparedLiveRoomCreate {
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
  return {
    title,
    description,
    roomKind,
    accessMode,
    visibility,
    guestUserId,
    eventStartAt,
    coverRef: cleanString(input.body.cover_ref),
    storeUrl: normalizeStoreUrl(input.body.store_url),
    storeLabel: cleanString(input.body.store_label),
    allocations: normalizeAllocations({
      body: input.body,
      hostUserId: input.hostUserId,
      guestUserId,
      roomKind,
    }),
    setlist: normalizeSetlist(input.body),
  }
}

function cleanString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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
  if (description && description.length > 2000) {
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
  const visibility = value == null || value === "" ? "public" : value
  if (visibility !== "public" && visibility !== "unlisted") {
    throw badRequestError("visibility must be public or unlisted")
  }
  if (accessMode === "paid" && visibility !== "public") {
    throw badRequestError("paid live rooms must be public")
  }
  return visibility
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

function normalizeStoreUrl(value: unknown): string | null {
  const storeUrl = cleanString(value)
  if (!storeUrl) return null
  try {
    const url = new URL(storeUrl)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString()
    }
  } catch {
    // Fall through to the normalized validation error below.
  }
  throw badRequestError("store_url must be an HTTP(S) URL")
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

function normalizeSetlist(body: CreateLiveRoomRequest): PreparedLiveRoomSetlist {
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
