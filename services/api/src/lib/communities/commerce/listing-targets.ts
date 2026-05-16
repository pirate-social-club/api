import type { Client } from "../../sql-client"
import { badRequestError } from "../../errors"
import { decodePublicAssetId } from "../../public-ids"
import type { CreateCommunityListingRequest } from "../../../types"

type ListingTargetExecutor = Pick<Client, "execute">

export type RequestedListingTarget = {
  assetId: string | null
  liveRoomId: string | null
}

export type LiveRoomListingTarget = {
  live_room_id: string
  host_user_id: string
}

export function resolveRequestedListingTarget(body: CreateCommunityListingRequest): RequestedListingTarget {
  const assetId = body.asset?.trim() ? decodePublicAssetId(body.asset) : null
  const liveRoomId = normalizeLiveRoomListingId(body.live_room)
  if (!assetId && !liveRoomId) {
    throw badRequestError("asset or live_room is required")
  }
  if (assetId && liveRoomId) {
    throw badRequestError("listing cannot reference both asset and live_room")
  }
  return { assetId, liveRoomId }
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

function normalizeLiveRoomListingId(value: unknown): string | null {
  if (typeof value !== "string") return null
  const liveRoomId = value.trim()
  if (!liveRoomId) return null
  if (!/^lr_[a-zA-Z0-9_-]+$/.test(liveRoomId)) {
    throw badRequestError("live_room must be a Pirate live room id")
  }
  return liveRoomId
}
