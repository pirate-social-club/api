import type { Client, QueryResultRow } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { conflictError } from "../../errors"
import { rowValue } from "../../sql-row"

type LiveRoomGuestInviteExecutor = Pick<Client, "execute">

export type LiveRoomGuestInviteStatus = "pending" | "accepted" | "revoked"

export async function assertAcceptedLiveRoomGuestInvite(client: LiveRoomGuestInviteExecutor, input: {
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

export async function getLiveRoomGuestInviteStatus(client: LiveRoomGuestInviteExecutor, input: {
  communityId: string
  liveRoomId: string
  guestUserId: string
}): Promise<LiveRoomGuestInviteStatus | null> {
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
  const status = rowValue(row, "status")
  return status === "pending" || status === "accepted" || status === "revoked" ? status : null
}
