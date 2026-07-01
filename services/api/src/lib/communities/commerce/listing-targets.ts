import type { Client } from "../../sql-client"
import { badRequestError } from "../../errors"
import { decodePublicAssetId } from "../../public-ids"
import type { CreateCommunityListingRequest } from "../../../types"

type ListingTargetExecutor = Pick<Client, "execute">

export type RequestedListingTarget = {
  assetId: string | null
  liveRoomId: string | null
  replayAssetId: string | null
}

export type LiveRoomListingTarget = {
  live_room_id: string
  host_user_id: string
}

export type ReplayAssetListingTarget = {
  replay_asset_id: string
  live_room_id: string
  host_user_id: string
}

export function resolveRequestedListingTarget(body: CreateCommunityListingRequest): RequestedListingTarget {
  const assetId = body.asset?.trim() ? decodePublicAssetId(body.asset) : null
  const liveRoomId = normalizeLiveRoomListingId(body.live_room)
  const replayAssetId = normalizeReplayAssetListingId((body as { replay_asset?: unknown }).replay_asset)
  const targetCount = [assetId, liveRoomId, replayAssetId].filter(Boolean).length
  if (targetCount === 0) {
    throw badRequestError("asset, live_room, or replay_asset is required")
  }
  if (targetCount > 1) {
    throw badRequestError("listing must reference exactly one target")
  }
  return { assetId, liveRoomId, replayAssetId }
}

export async function getLiveRoomListingTarget(
  client: ListingTargetExecutor,
  communityId: string,
  liveRoomId: string,
): Promise<LiveRoomListingTarget | null> {
  const result = await client.execute({
    sql: `
      SELECT live_room_id, host_user_id
      FROM live_rooms
      WHERE community_id = ?1
        AND live_room_id = ?2
      LIMIT 1
    `,
    args: [communityId, liveRoomId],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    live_room_id: String(row.live_room_id),
    host_user_id: String(row.host_user_id),
  }
}

export async function getReplayAssetListingTarget(
  client: ListingTargetExecutor,
  communityId: string,
  replayAssetId: string,
): Promise<ReplayAssetListingTarget | null> {
  const result = await client.execute({
    sql: `
      SELECT lra.replay_asset_id, lra.live_room_id, lr.host_user_id
      FROM live_room_replay_assets lra
      INNER JOIN live_rooms lr
        ON lr.community_id = lra.community_id
       AND lr.live_room_id = lra.live_room_id
      WHERE lra.community_id = ?1
        AND lra.replay_asset_id = ?2
      LIMIT 1
    `,
    args: [communityId, replayAssetId],
  })
  const row = result.rows[0]
  if (!row) return null
  return {
    replay_asset_id: String(row.replay_asset_id),
    live_room_id: String(row.live_room_id),
    host_user_id: String(row.host_user_id),
  }
}

function normalizeLiveRoomListingId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const liveRoomId = value.trim()
  if (!liveRoomId) return null
  if (!/^lr_[a-zA-Z0-9_-]+$/.test(liveRoomId)) {
    throw badRequestError("live_room must be a Pirate live room id")
  }
  return liveRoomId
}

function normalizeReplayAssetListingId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const replayAssetId = value.trim()
  if (!replayAssetId) return null
  if (!/^lra_[a-zA-Z0-9_-]+$/.test(replayAssetId)) {
    throw badRequestError("replay_asset must be a Pirate replay asset id")
  }
  return replayAssetId
}
