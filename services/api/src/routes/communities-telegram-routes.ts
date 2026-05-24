import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  createTelegramSetupIntent,
  getCommunityTelegramChatSettings,
  unlinkCommunityTelegramChat,
  updateCommunityTelegramChatSettings,
  type UpdateTelegramChatSettingsInput,
} from "../lib/telegram/community-chat-service"
import {
  getCommunityTelegramBot,
  revokeCommunityTelegramBot,
  saveCommunityTelegramBot,
} from "../lib/telegram/community-bot-service"
import {
  getResolvedCommunityRouteContext,
  optionalJsonBody,
} from "./communities-route-helpers"

export function registerCommunityTelegramRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/telegram-bot", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityTelegramBot({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/telegram-bot", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await optionalJsonBody<{ bot_token?: unknown }>(c, "Invalid Telegram bot payload")
    const result = await saveCommunityTelegramBot({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      botToken: body?.bot_token,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/telegram-bot/revoke", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await revokeCommunityTelegramBot({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/telegram-chat", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityTelegramChatSettings({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/telegram-chat/setup-intents", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await createTelegramSetupIntent({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/telegram-chat", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await optionalJsonBody<UpdateTelegramChatSettingsInput>(c, "Invalid Telegram chat settings payload")
    const result = await updateCommunityTelegramChatSettings({
      env: c.env,
      communityRepository,
      communityId,
      actor,
      body,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/telegram-chat/unlink", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await unlinkCommunityTelegramChat({
      env: c.env,
      communityRepository,
      communityId,
      actor,
    })
    return c.json(result, 200)
  })
}
