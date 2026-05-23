import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getCommunityAssistantChat,
  listCommunityAssistantChats,
  sendCommunityAssistantMessage,
  type CommunityAssistantChatBody,
} from "../lib/communities/assistant-policy/chat-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

export function registerCommunityAssistantRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/assistant/chat", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityAssistantChatBody>(c, "Invalid community assistant chat payload")
    const result = await sendCommunityAssistantMessage({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      body,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assistant/chats", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityAssistantChats({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/assistant/chats/:chatId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityAssistantChat({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      chatId: c.req.param("chatId"),
    })
    return c.json(result, 200)
  })
}
