import type { Env } from "../../../env"
import type { CommunityListing } from "../../../types"
import type { UserRepository } from "../../auth/repositories"
import { notFoundError } from "../../errors"
import { fetchSongArtifactBytes } from "../../song-artifacts/song-artifact-storage"
import {
  buildLockedDeliveryStoryCdrAccessPackage,
  type LockedDeliveryStoryCdrAccessPackage,
} from "../commerce/asset-delivery"
import {
  getActiveEntitlementForBuyer,
  resolvePrimaryWalletAddress,
} from "../commerce/shared"
import { hydrateCommunityListing } from "../commerce/listing-service"
import { openCommunityReadClient } from "../community-read-access"
import type {
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import {
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { canReadUnlistedLiveRoom } from "./access"
import {
  fetchLiveRoomRecordingCaptureObject,
  type LiveRoomRecordingRawArtifactRef,
} from "./recording-ingest"
import { getLiveRoomReplayAsset, type LiveRoomReplayAsset } from "./replay-assets"
import { getHydratedLiveRoom } from "./store"

type LiveRoomRepository = CommunityReadRepository & CommunityDatabaseBindingRepository & CommunityPostProjectionRepository

type LiveRoomReplayAccessResponse = {
  live_room: string
  replay_asset: string | null
  replay_listing: CommunityListing | null
  replay_status: string
  access_mode: LiveRoomReplayAsset["access_mode"] | null
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
      const entitlementKind = asset.access_mode === "paid" ? "replay_access" : "live_room_access"
      const entitlement = await getActiveEntitlementForBuyer(
        db.client,
        input.communityId,
        input.userId,
        entitlementTarget,
        entitlementKind,
      )
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
