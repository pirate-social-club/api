import type { Client } from "../../sql-client"
import { notFoundError } from "../../errors"
import { publicId } from "../../public-ids"
import {
  getActiveEntitlementForBuyer,
  getListingRowByAssetId,
  getListingRowByLiveRoomId,
  usdToCents,
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
import type { LiveRoom, LiveRoomAccessMode, LiveRoomAudienceGate, LiveRoomAudienceGateSegment, LiveRoomVisibility } from "./types"

type LiveRoomAccessExecutor = Pick<Client, "execute">
type LiveRoomMembership = Awaited<ReturnType<typeof getCommunityMembershipState>>

export type LiveRoomAccessDecisionReason =
  | "not_live"
  | "ended"
  | "canceled"
  | "unlisted"
  | "membership_required"
  | "purchase_required"
  | "gate_unsatisfied"
  | "allowed"

export type LiveRoomGateFailedSegment =
  | { type: "community_members" }
  | {
    type: "purchase_entitlement"
    entitlement_kind: "asset_access"
    required_target_refs: string[]
    purchasable_listings?: Array<{
      listing: string
      asset: string
      price_cents: number
      status: ListingRow["status"]
    }>
  }

export type LiveRoomGateAccessPayload = {
  failed_segments: LiveRoomGateFailedSegment[]
} | null

export type LiveRoomAccessPayload = {
  allowed: boolean
  decision_reason: LiveRoomAccessDecisionReason | null
  access_mode: LiveRoomAccessMode
  visibility: LiveRoomVisibility
  listing: string | null
  purchase_entitlement: string | null
  guest_invite_status: LiveRoomGuestInviteStatus | null
  gate: LiveRoomGateAccessPayload
}

export type LiveRoomViewerAccessResolution = {
  room: LiveRoom
  listing: ListingRow | null
  entitlement: PurchaseEntitlementRow | null
  guestInviteStatus: LiveRoomGuestInviteStatus | null
  allowed: boolean
  decisionReason: LiveRoomAccessDecisionReason | null
  gate: LiveRoomGateAccessPayload
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
  const isPrivileged = isProducer || hasCommunityRole(membership, ["owner", "admin", "moderator"])

  const guestInviteStatus = room.guest_user === input.userId
    ? await getLiveRoomGuestInviteStatus(input.client, {
      communityId: input.communityId,
      liveRoomId: input.liveRoomId,
      guestUserId: input.userId,
    })
    : null

  if (!isPrivileged) {
    if (room.access_mode === "gated") {
      if (room.audience_gate) {
        const gate = await evaluateAudienceGate({
          client: input.client,
          communityId: input.communityId,
          userId: input.userId,
          membership,
          gate: room.audience_gate,
        })
        if (!gate.satisfied) {
          return {
            room,
            listing: null,
            entitlement: null,
            guestInviteStatus,
            allowed: false,
            decisionReason: "gate_unsatisfied",
            gate: gate.payload,
          }
        }
      } else if (membership.membership_status !== "member") {
        return {
          room,
          listing: null,
          entitlement: null,
          guestInviteStatus,
          allowed: false,
          decisionReason: "membership_required",
          gate: null,
        }
      }
    } else if (membership.membership_status !== "member") {
      throw notFoundError("Live room not found")
    }
  }

  if (room.visibility === "unlisted" && !canReadUnlistedLiveRoom({ membership, room, userId: input.userId })) {
    return {
      room,
      listing: null,
      entitlement: null,
      guestInviteStatus,
      allowed: false,
      decisionReason: "unlisted",
      gate: null,
    }
  }

  const listing = room.access_mode === "paid"
    ? await getListingRowByLiveRoomId(input.client, input.communityId, input.liveRoomId)
    : null
  const activeListing = listing?.status === "active" ? listing : null
  const entitlement = room.access_mode === "paid"
    ? await getActiveEntitlementForBuyer(input.client, input.communityId, input.userId, room.id, "live_room_access")
    : null
  if (room.access_mode === "paid" && !entitlement) {
    return {
      room,
      listing: activeListing,
      entitlement,
      guestInviteStatus,
      allowed: false,
      decisionReason: "purchase_required",
      gate: null,
    }
  }
  if (room.status === "canceled") {
    return { room, listing: activeListing, entitlement, guestInviteStatus, allowed: false, decisionReason: "canceled", gate: null }
  }
  if (room.status === "ended") {
    return { room, listing: activeListing, entitlement, guestInviteStatus, allowed: false, decisionReason: "ended", gate: null }
  }
  if (room.status !== "live") {
    return { room, listing: activeListing, entitlement, guestInviteStatus, allowed: false, decisionReason: "not_live", gate: null }
  }
  return {
    room,
    listing: activeListing,
    entitlement,
    guestInviteStatus,
    allowed: true,
    decisionReason: null,
    gate: null,
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
      gate: null,
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
      gate: null,
    }
  }
  if (room.access_mode === "gated") {
    const gate = room.audience_gate
      ? await buildAudienceGateFailurePayload(input.client, input.communityId, room.audience_gate)
      : null
    return {
      room,
      listing: null,
      entitlement: null,
      guestInviteStatus: null,
      allowed: false,
      decisionReason: room.audience_gate ? "gate_unsatisfied" : "membership_required",
      gate,
    }
  }
  if (room.status === "canceled") {
    return { room, listing: activeListing, entitlement: null, guestInviteStatus: null, allowed: false, decisionReason: "canceled", gate: null }
  }
  if (room.status === "ended") {
    return { room, listing: activeListing, entitlement: null, guestInviteStatus: null, allowed: false, decisionReason: "ended", gate: null }
  }
  if (room.status !== "live") {
    return { room, listing: activeListing, entitlement: null, guestInviteStatus: null, allowed: false, decisionReason: "not_live", gate: null }
  }
  return {
    room,
    listing: activeListing,
    entitlement: null,
    guestInviteStatus: null,
    allowed: true,
    decisionReason: null,
    gate: null,
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
    gate: input.gate,
  }
}

async function evaluateAudienceGate(input: {
  client: LiveRoomAccessExecutor
  communityId: string
  userId: string
  membership: LiveRoomMembership
  gate: LiveRoomAudienceGate
}): Promise<{ satisfied: true; payload: null } | { satisfied: false; payload: NonNullable<LiveRoomGateAccessPayload> }> {
  const failedSegments: LiveRoomGateFailedSegment[] = []
  for (const segment of input.gate.segments) {
    const result = await evaluateAudienceGateSegment({
      client: input.client,
      communityId: input.communityId,
      userId: input.userId,
      membership: input.membership,
      segment,
    })
    if (result.satisfied) {
      return { satisfied: true, payload: null }
    }
    failedSegments.push(result.failedSegment)
  }
  return { satisfied: false, payload: { failed_segments: failedSegments } }
}

async function evaluateAudienceGateSegment(input: {
  client: LiveRoomAccessExecutor
  communityId: string
  userId: string
  membership: LiveRoomMembership
  segment: LiveRoomAudienceGateSegment
}): Promise<{ satisfied: true } | { satisfied: false; failedSegment: LiveRoomGateFailedSegment }> {
  if (input.segment.type === "community_members") {
    return input.membership.membership_status === "member"
      ? { satisfied: true }
      : { satisfied: false, failedSegment: { type: "community_members" } }
  }
  for (const targetRef of input.segment.target_refs) {
    const entitlement = await getActiveEntitlementForBuyer(
      input.client,
      input.communityId,
      input.userId,
      targetRef,
      input.segment.entitlement_kind,
    )
    if (entitlement) {
      return { satisfied: true }
    }
  }
  return {
    satisfied: false,
    failedSegment: await buildPurchaseEntitlementFailedSegment(input.client, input.communityId, input.segment),
  }
}

async function buildAudienceGateFailurePayload(
  client: LiveRoomAccessExecutor,
  communityId: string,
  gate: LiveRoomAudienceGate,
): Promise<NonNullable<LiveRoomGateAccessPayload>> {
  return {
    failed_segments: await Promise.all(gate.segments.map(async (segment) => {
      if (segment.type === "community_members") return { type: "community_members" }
      return buildPurchaseEntitlementFailedSegment(client, communityId, segment)
    })),
  }
}

async function buildPurchaseEntitlementFailedSegment(
  client: LiveRoomAccessExecutor,
  communityId: string,
  segment: Extract<LiveRoomAudienceGateSegment, { type: "purchase_entitlement" }>,
): Promise<LiveRoomGateFailedSegment> {
  const purchasableListings = (await Promise.all(segment.target_refs.map(async (targetRef) => {
    const listing = await getListingRowByAssetId(client, communityId, targetRef)
    if (!listing || listing.status !== "active" || !listing.asset_id) return null
    const priceCents = usdToCents(listing.price_usd)
    if (priceCents == null) return null
    return {
      listing: publicId(listing.listing_id, "lst"),
      asset: publicId(listing.asset_id, "asset"),
      price_cents: priceCents,
      status: listing.status,
    }
  }))).filter((listing): listing is NonNullable<typeof listing> => listing != null)
  return {
    type: "purchase_entitlement",
    entitlement_kind: segment.entitlement_kind,
    required_target_refs: segment.target_refs.map((targetRef) => publicId(targetRef, "asset")),
    ...(purchasableListings.length > 0 ? { purchasable_listings: purchasableListings } : {}),
  }
}

function serializeLiveRoomListing(row: ListingRow | null): string | null {
  return row ? publicId(row.listing_id, "lst") : null
}

function serializeLiveRoomPurchaseEntitlement(row: PurchaseEntitlementRow | null): string | null {
  return row?.purchase_entitlement_id ?? null
}
