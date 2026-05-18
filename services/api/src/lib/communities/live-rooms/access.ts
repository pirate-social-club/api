import type { Client } from "../../sql-client"
import { notFoundError } from "../../errors"
import { publicId } from "../../public-ids"
import {
  getActiveEntitlementForBuyer,
  getListingRowByLiveRoomId,
  type ListingRow,
  type PurchaseEntitlementRow,
} from "../commerce/shared"
import {
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import {
  getLiveRoomGuestInviteStatus,
  type LiveRoomGuestInviteStatus,
} from "./guest-invites"
import type { LiveRoom, LiveRoomAccessMode, LiveRoomVisibility } from "./types"

type LiveRoomAccessExecutor = Pick<Client, "execute">
type LiveRoomMembership = Awaited<ReturnType<typeof getCommunityMembershipState>>

export type LiveRoomAccessDecisionReason =
  | "not_live"
  | "ended"
  | "canceled"
  | "unlisted"
  | "membership_required"
  | "purchase_required"
  | "allowed"

export type LiveRoomAccessPayload = {
  allowed: boolean
  decision_reason: LiveRoomAccessDecisionReason | null
  access_mode: LiveRoomAccessMode
  visibility: LiveRoomVisibility
  listing: string | null
  purchase_entitlement: string | null
  guest_invite_status: LiveRoomGuestInviteStatus | null
}

export type LiveRoomViewerAccessResolution = {
  room: LiveRoom
  listing: ListingRow | null
  entitlement: PurchaseEntitlementRow | null
  guestInviteStatus: LiveRoomGuestInviteStatus | null
  allowed: boolean
  decisionReason: LiveRoomAccessDecisionReason | null
}

export function canReadUnlistedLiveRoom(input: {
  membership: LiveRoomMembership
  room: LiveRoom
  userId: string
}): boolean {
  return input.room.host_user === input.userId
    || input.room.guest_user === input.userId
    || hasCommunityRole(input.membership, ["owner", "admin", "moderator"])
}

export async function resolveLiveRoomViewerAccess(input: {
  client: LiveRoomAccessExecutor
  communityId: string
  liveRoomId: string
  userId: string
  loadRoom: (
    client: LiveRoomAccessExecutor,
    communityId: string,
    liveRoomId: string,
  ) => Promise<LiveRoom>
}): Promise<LiveRoomViewerAccessResolution> {
  const room = await input.loadRoom(input.client, input.communityId, input.liveRoomId)
  const membership = await getCommunityMembershipState(input.client, input.communityId, input.userId)
  const isProducer = room.host_user === input.userId || room.guest_user === input.userId
  if (!isProducer && !hasCommunityRole(membership, ["owner", "admin", "moderator"]) && membership.membership_status !== "member") {
    throw notFoundError("Live room not found")
  }

  const guestInviteStatus = room.guest_user === input.userId
    ? await getLiveRoomGuestInviteStatus(input.client, {
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      guestUserId: input.userId,
    })
    : null
  if (room.visibility === "unlisted" && !canReadUnlistedLiveRoom({ membership, room, userId: input.userId })) {
    return {
      room,
      listing: null,
      entitlement: null,
      guestInviteStatus,
      allowed: false,
      decisionReason: "unlisted",
    }
  }

  const listing = room.access_mode === "paid"
    ? await getListingRowByLiveRoomId(input.client, input.communityId, input.liveRoomId)
    : null
  const activeListing = listing?.status === "active" ? listing : null
  const entitlement = room.access_mode === "paid"
    ? await getActiveEntitlementForBuyer(input.client, input.communityId, input.userId, room.id)
    : null
  if (room.access_mode === "paid" && !entitlement) {
    return {
      room,
      listing: activeListing,
      entitlement,
      guestInviteStatus,
      allowed: false,
      decisionReason: "purchase_required",
    }
  }
  if (room.status === "canceled") {
    return { room, listing: activeListing, entitlement, guestInviteStatus, allowed: false, decisionReason: "canceled" }
  }
  if (room.status === "ended") {
    return { room, listing: activeListing, entitlement, guestInviteStatus, allowed: false, decisionReason: "ended" }
  }
  if (room.status !== "live") {
    return { room, listing: activeListing, entitlement, guestInviteStatus, allowed: false, decisionReason: "not_live" }
  }
  return {
    room,
    listing: activeListing,
    entitlement,
    guestInviteStatus,
    allowed: true,
    decisionReason: null,
  }
}

export async function resolvePublicLiveRoomViewerAccess(input: {
  client: LiveRoomAccessExecutor
  communityId: string
  liveRoomId: string
  loadRoom: (
    client: LiveRoomAccessExecutor,
    communityId: string,
    liveRoomId: string,
  ) => Promise<LiveRoom>
}): Promise<LiveRoomViewerAccessResolution> {
  const room = await input.loadRoom(input.client, input.communityId, input.liveRoomId)
  if (room.visibility !== "public") {
    return {
      room,
      listing: null,
      entitlement: null,
      guestInviteStatus: null,
      allowed: false,
      decisionReason: "unlisted",
    }
  }

  const listing = room.access_mode === "paid"
    ? await getListingRowByLiveRoomId(input.client, input.communityId, input.liveRoomId)
    : null
  const activeListing = listing?.status === "active" ? listing : null
  if (room.access_mode === "paid") {
    return {
      room,
      listing: activeListing,
      entitlement: null,
      guestInviteStatus: null,
      allowed: false,
      decisionReason: "purchase_required",
    }
  }
  if (room.access_mode === "gated") {
    return {
      room,
      listing: null,
      entitlement: null,
      guestInviteStatus: null,
      allowed: false,
      decisionReason: "membership_required",
    }
  }
  if (room.status === "canceled") {
    return { room, listing: activeListing, entitlement: null, guestInviteStatus: null, allowed: false, decisionReason: "canceled" }
  }
  if (room.status === "ended") {
    return { room, listing: activeListing, entitlement: null, guestInviteStatus: null, allowed: false, decisionReason: "ended" }
  }
  if (room.status !== "live") {
    return { room, listing: activeListing, entitlement: null, guestInviteStatus: null, allowed: false, decisionReason: "not_live" }
  }
  return {
    room,
    listing: activeListing,
    entitlement: null,
    guestInviteStatus: null,
    allowed: true,
    decisionReason: null,
  }
}

export function serializeLiveRoomAccess(input: LiveRoomViewerAccessResolution): LiveRoomAccessPayload {
  return {
    allowed: input.allowed,
    decision_reason: input.decisionReason,
    access_mode: input.room.access_mode,
    visibility: input.room.visibility,
    listing: serializeLiveRoomListing(input.listing),
    purchase_entitlement: serializeLiveRoomPurchaseEntitlement(input.entitlement),
    guest_invite_status: input.guestInviteStatus,
  }
}

function serializeLiveRoomListing(row: ListingRow | null): string | null {
  return row ? publicId(row.listing_id, "lst") : null
}

function serializeLiveRoomPurchaseEntitlement(row: PurchaseEntitlementRow | null): string | null {
  return row?.purchase_entitlement_id ?? null
}
