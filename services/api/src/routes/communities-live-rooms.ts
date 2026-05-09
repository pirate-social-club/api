import { Hono } from "hono"
import { requireScope, type AuthenticatedEnv } from "../lib/auth-middleware"
import {
  acceptLiveRoomGuestInvite,
  cancelLiveRoom,
  createLiveRoom,
  endLiveRoom,
  getLiveRoom,
  guestAttachLiveRoom,
  hostAttachLiveRoom,
  revokeLiveRoomGuestInvite,
  type CreateLiveRoomRequest,
} from "../lib/communities/live-rooms/service"
import { getResolvedCommunityRouteContext, requireJsonBody } from "./communities-route-helpers"

export function registerCommunityLiveRoomRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/live-rooms", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateLiveRoomRequest>(c, "Invalid live room create payload")
    const room = await createLiveRoom({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(room, 201)
  })

  communities.get("/:communityId/live-rooms/:liveRoomId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const room = await getLiveRoom({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(room, 200)
  })

  communities.post("/:communityId/live-rooms/:liveRoomId/host_attach", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "live_room:attach")
    const attach = await hostAttachLiveRoom({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(attach, 200)
  })

  communities.post("/:communityId/live-rooms/:liveRoomId/guest_attach", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "live_room:attach")
    const attach = await guestAttachLiveRoom({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(attach, 200)
  })

  communities.post("/:communityId/live-rooms/:liveRoomId/guest_accept", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "live_room:attach")
    const room = await acceptLiveRoomGuestInvite({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(room, 200)
  })

  communities.post("/:communityId/live-rooms/:liveRoomId/guest_revoke", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "live_room:manage")
    const room = await revokeLiveRoomGuestInvite({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(room, 200)
  })

  communities.post("/:communityId/live-rooms/:liveRoomId/cancel", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "live_room:manage")
    const room = await cancelLiveRoom({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(room, 200)
  })

  communities.post("/:communityId/live-rooms/:liveRoomId/end", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    requireScope(actor, "live_room:manage")
    const room = await endLiveRoom({
      env: c.env,
      userId: actor.userId,
      communityId,
      liveRoomId: c.req.param("liveRoomId"),
      communityRepository,
    })
    return c.json(room, 200)
  })
}
