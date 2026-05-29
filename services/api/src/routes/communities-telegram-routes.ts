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
  getActiveCommunityTelegramBotUsername,
  getCommunityTelegramBot,
  revokeCommunityTelegramBot,
  saveCommunityTelegramBot,
} from "../lib/telegram/community-bot-service"
import {
  getResolvedCommunityRouteContext,
  optionalJsonBody,
} from "./communities-route-helpers"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { notFoundError } from "../lib/errors"

export function registerCommunityTelegramRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/telegram-bot-username", async (c) => {
    const communityIdentifier = c.req.param("communityId")?.trim()
    const communityRepository = getCommunityRepository(c.env)
    const communityId = communityIdentifier
      ? await resolveCommunityIdentifier(communityRepository, communityIdentifier)
      : null
    if (!communityId) {
      throw notFoundError("Community not found")
    }
    const community = await communityRepository.getCommunityById(communityId)
    if (!community || community.status !== "active") {
      throw notFoundError("Community not found")
    }
    const username = await getActiveCommunityTelegramBotUsername({
      env: c.env,
      communityId: community.community_id,
    })
    return c.json({ active_telegram_bot_username: username }, 200)
  })

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
