import { createHash, timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import type { Env } from "../env"
import {
  completeTelegramSetupIntentByRequest,
  completeTelegramSetupIntent,
  prepareTelegramSetupChatRequest,
  type TelegramBotAdminStatus,
  type TelegramChatType,
  type CompleteTelegramSetupIntentInput,
} from "../lib/telegram/community-chat-service"
import {
  approveTelegramChatJoinRequest,
  getTelegramChat,
  getTelegramChatMember,
  telegramBotUserId,
  telegramBotUsername,
  type TelegramBotCredential,
  type TelegramChatMember,
} from "../lib/telegram/bot-api"
import {
  decryptActiveCommunityTelegramBotOrNull,
  decryptCommunityTelegramBotByWebhookId,
  type TelegramCommunityBotCredential,
} from "../lib/telegram/community-bot-service"
import {
  approvePendingTelegramJoinGrantsForUser,
  exchangeTelegramOnboardingSession,
} from "../lib/telegram/onboarding-service"
import {
  evaluateTelegramChatJoinRequest,
  markTelegramJoinGrantApproved,
  markTelegramJoinGrantFailed,
  markTelegramJoinGrantPrompted,
  resolveTelegramAccount,
  linkPendingTelegramJoinGrantsForTelegramUser,
  syncTelegramAccountForUser,
} from "../lib/telegram/join-request-service"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import { getJoinEligibility } from "../lib/communities/membership/eligibility-service"
import { joinCommunity } from "../lib/communities/membership/request-service"
import { sendCommunityAssistantTelegramDirectMessage } from "../lib/communities/assistant-policy/chat-service"
import { answerTelegramGroupAssistantPrompt, telegramText } from "../lib/telegram/assistant-service"
import { getProfileRepository, getSessionRepository, getUserRepository } from "../lib/auth/repositories"
import { mintPirateAccessToken } from "../lib/auth/pirate-session-token"
import {
  configuredTelegramInitDataMaxAgeSeconds,
  verifyTelegramMiniAppInitData,
} from "../lib/telegram/mini-app-auth"
import { trackApiEvent } from "../lib/analytics/track"
import { authError, badRequestError, HttpError } from "../lib/errors"
import { publicCommunityId } from "../lib/public-ids"
import { getTelegramCopy } from "../lib/telegram/telegram-copy"
import {
  resolveTelegramStartLocale,
  type RuntimeUiLocaleCode,
} from "../lib/telegram/telegram-locale"
import {
  isCommunityBot,
  isPrivateChat,
  parseCommunityJoinPayload,
  parseCommunityStartPayload,
  parseDirectAssistantPrompt,
  parseDirectAssistantVoiceTrigger,
  parseGroupAssistantTrigger,
  parseGroupAssistantVoiceTrigger,
  parseStartToken,
  telegramIdentifier,
  telegramLanguageCode,
  type TelegramWebhookChatJoinRequest,
  type TelegramWebhookMessage,
  type TelegramWebhookUpdate,
} from "../lib/telegram/webhook-parsing"
import {
  directAssistantFailureMessage,
  getTelegramDirectAssistantPolicy,
  maybeSendTelegramAssistantVoiceReply,
  maybeSendTelegramAssistantVoiceReplyForCommunity,
  safeSendTelegramMessage,
  safeSetTelegramChatMenuButton,
  sendDirectAssistantOnboardingPrompt,
  sendDirectAssistantPreviewResponse,
  telegramRouteErrorLogFields,
  telegramUserCanAccessCommunity,
  transcribeTelegramAssistantVoiceForCommunity,
  transcribeTelegramGroupAssistantVoice,
} from "./telegram-assistant-workflow"

const telegram = new Hono<{ Bindings: Env }>()

function timingSafeSecretEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest()
  const rightDigest = createHash("sha256").update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function requireBotIntegrationSecret(c: {
  env: Env
  req: { header(name: string): string | undefined }
}): void {
  const configuredSecret = c.env.TELEGRAM_BOT_INTEGRATION_SECRET?.trim()
  if (!configuredSecret) {
    throw authError("Telegram bot integration is not configured")
  }
  const providedSecret = c.req.header("x-telegram-bot-secret")?.trim()
  if (!providedSecret || !timingSafeSecretEqual(providedSecret, configuredSecret)) {
    throw authError("Authentication failed")
  }
}

function requireTelegramWebhookSecret(c: {
  env: Env
  req: { header(name: string): string | undefined }
}): void {
  const configuredSecret = c.env.TELEGRAM_WEBHOOK_SECRET?.trim()
  if (!configuredSecret) {
    throw authError("Telegram webhook is not configured")
  }
  const providedSecret = c.req.header("x-telegram-bot-api-secret-token")?.trim()
  if (!providedSecret || !timingSafeSecretEqual(providedSecret, configuredSecret)) {
    throw authError("Authentication failed")
  }
}

function telegramPlatformMiniAppVerificationTokens(env: Env): string[] {
  const token = env.TELEGRAM_BOT_TOKEN?.trim()
  return token ? [token] : []
}

async function telegramAutoExchangeMiniAppVerificationTokens(env: Env, communityId: string): Promise<string[]> {
  const communityBot = await decryptActiveCommunityTelegramBotOrNull({
    env,
    communityId,
  })
  if (communityBot) {
    return [communityBot.token]
  }
  return telegramPlatformMiniAppVerificationTokens(env)
}

function summarizeTelegramJoinGrantApprovalResults(
  results: Array<{ status: "approved" | "failed" | "ignored" | "pending" }>,
): "approved" | "failed" | "ignored" | "none" | "pending" {
  if (results.length === 0) {
    return "none"
  }
  if (results.some((result) => result.status === "approved")) {
    return "approved"
  }
  if (results.some((result) => result.status === "pending")) {
    return "pending"
  }
  if (results.some((result) => result.status === "failed")) {
    return "failed"
  }
  return "ignored"
}

function chatPickerAdminRights() {
  return {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: true,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
  }
}

function chatPickerMarkup(requestId: number) {
  return {
    keyboard: [[{
      text: "Select group",
      request_chat: {
        request_id: requestId,
        chat_is_channel: false,
        bot_is_member: true,
        user_administrator_rights: chatPickerAdminRights(),
        bot_administrator_rights: chatPickerAdminRights(),
        request_title: true,
        request_username: true,
      },
    }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }
}

function setupInstructions(bot: Env | TelegramBotCredential): string {
  const username = telegramBotUsername(bot)
  return username
    ? `Add @${username} to the group as an admin with invite-user permission, then tap Select group.`
    : "Add this bot to the group as an admin with invite-user permission, then tap Select group."
}

function botPrivateChatInstructions(bot: Env | TelegramBotCredential): string {
  const username = telegramBotUsername(bot)
  return username
    ? `Open a private chat with @${username} from Pirate's Connect Telegram flow.`
    : "Open a private chat with this bot from Pirate's Connect Telegram flow."
}

function setupErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 409) {
    return error.message
  }
  if (error instanceof HttpError && error.status === 404) {
    return "Telegram setup link was not found. Start again from Pirate."
  }
  return "Could not start Telegram setup. Start again from Pirate."
}

function completionErrorMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 409) {
    return error.message
  }
  if (error instanceof HttpError && error.status === 404) {
    return "Telegram setup request was not found. Start again from Pirate."
  }
  return "Could not connect this Telegram chat. Start again from Pirate."
}

function telegramWebPublicOrigin(env: Env): string | null {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
  return origin || null
}

function telegramCommunityParticipationUrl(env: Env, communityId: string): string | null {
  const origin = telegramWebPublicOrigin(env)
  return origin ? `${origin}/tg/c/${encodeURIComponent(publicCommunityId(communityId))}` : null
}

function telegramCommunityVerificationUrl(env: Env, communityId: string): string | null {
  const origin = telegramWebPublicOrigin(env)
  return origin ? `${origin}/tg/verify/${encodeURIComponent(publicCommunityId(communityId))}` : null
}

function telegramMiniAppLauncherMarkup(url: string): unknown {
  return {
    inline_keyboard: [[{
      text: "Open Pirate",
      web_app: { url },
    }]],
  }
}

function telegramCommunityStartMarkup(input: {
  text: string
  url: string
}): unknown {
  return {
    inline_keyboard: [[{
      text: input.text,
      web_app: { url: input.url },
    }]],
  }
}

async function safeApproveTelegramChatJoinRequest(
  bot: Env | TelegramBotCredential,
  body: Parameters<typeof approveTelegramChatJoinRequest>[1],
): Promise<boolean> {
  try {
    await approveTelegramChatJoinRequest(bot, body)
    return true
  } catch (error) {
    console.warn("[telegram-webhook] approveChatJoinRequest failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

function mapTelegramChatType(type: string | undefined): TelegramChatType | null {
  if (type === "group" || type === "supergroup") {
    return type
  }
  return null
}

function mapBotAdminStatus(member: TelegramChatMember): TelegramBotAdminStatus {
  if (member.status === "administrator" || member.status === "creator") {
    return member.can_invite_users === false ? "insufficient_permissions" : "ready"
  }
  if (member.status === "left" || member.status === "kicked") {
    return "left_chat"
  }
  return "insufficient_permissions"
}

async function getBotAdminStatus(bot: Env | TelegramBotCredential, chatId: number | string): Promise<TelegramBotAdminStatus> {
  try {
    const member = await getTelegramChatMember(bot, chatId, telegramBotUserId(bot))
    return mapBotAdminStatus(member)
  } catch {
    return "missing"
  }
}

async function handleCommunityBotStartMessage(env: Env, input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  message: TelegramWebhookMessage
  telegramLanguageCode: string | null
  telegramUserId: string | null
}): Promise<void> {
  const startPayload = parseStartToken(input.message.text)
  const isSetupToken = startPayload?.startsWith("tgsetup_") === true
  if (isSetupToken) {
    if (!input.telegramUserId || !startPayload) {
      await safeSendTelegramMessage(input.bot, {
        chat_id: input.chatId,
        text: "Open this setup link from your own Telegram account.",
      })
      return
    }
    try {
      const setupRequest = await prepareTelegramSetupChatRequest({
        env,
        setupToken: startPayload,
        telegramCommunityBotId: input.bot.id,
        telegramUserId: input.telegramUserId,
        privateChatId: input.chatId,
        requestMessageId: input.message.message_id ?? null,
      })
      await safeSendTelegramMessage(input.bot, {
        chat_id: input.chatId,
        text: setupInstructions(input.bot),
        reply_markup: chatPickerMarkup(setupRequest.request_id),
      })
    } catch (error) {
      await safeSendTelegramMessage(input.bot, {
        chat_id: input.chatId,
        text: setupErrorMessage(error),
      })
    }
    return
  }

  const joinCommunityId = parseCommunityJoinPayload(startPayload)
  const legacyCommunityId = joinCommunityId ? null : parseCommunityStartPayload(startPayload)
  const requestedCommunityId = joinCommunityId ?? legacyCommunityId
  if (!startPayload) {
    const policy = await getTelegramDirectAssistantPolicy({
      env,
      communityId: input.bot.communityId,
    }).catch(() => null)
    if (policy?.telegramPreviewEnabled && policy.telegramPreviewDailyCap > 0) {
      const locale = resolveTelegramStartLocale({
        telegramLanguageCode: input.telegramLanguageCode,
      })
      await safeSendTelegramMessage(input.bot, {
        chat_id: input.chatId,
        text: getTelegramCopy(locale).privateAssistant.intro,
      })
      return
    }
    await handleCommunityStartMessage(env, {
      bot: input.bot,
      chatId: input.chatId,
      communityId: input.bot.communityId,
      telegramLanguageCode: input.telegramLanguageCode,
      telegramUserId: input.telegramUserId,
    })
    return
  }
  if (requestedCommunityId && requestedCommunityId !== input.bot.communityId) {
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "This link is for a different community.",
    })
    return
  }
  if (startPayload && !requestedCommunityId) {
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "This Telegram link is not valid for this community.",
    })
    return
  }

  await handleCommunityStartMessage(env, {
    bot: input.bot,
    chatId: input.chatId,
    communityId: input.bot.communityId,
    telegramLanguageCode: input.telegramLanguageCode,
    telegramUserId: input.telegramUserId,
  })
}

async function handleStartMessage(env: Env, message: TelegramWebhookMessage, bot: Env | TelegramCommunityBotCredential = env): Promise<void> {
  const chatId = telegramIdentifier(message.chat?.id)
  const telegramUserId = telegramIdentifier(message.from?.id)
  const telegramLanguage = telegramLanguageCode(message.from?.language_code)
  if (!chatId) {
    return
  }
  if (message.chat?.type !== "private") {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: botPrivateChatInstructions(bot),
    })
    return
  }
  if (isCommunityBot(bot)) {
    await handleCommunityBotStartMessage(env, {
      bot,
      chatId,
      message,
      telegramLanguageCode: telegramLanguage,
      telegramUserId,
    })
    return
  }
  const setupToken = parseStartToken(message.text)
  const communityStartId = parseCommunityStartPayload(setupToken)
  const isSetupToken = setupToken?.startsWith("tgsetup_") === true

  if (communityStartId || (setupToken && !isSetupToken)) {
    await handleCommunityStartMessage(env, {
      bot,
      chatId,
      communityId: communityStartId ?? setupToken ?? "",
      telegramLanguageCode: telegramLanguage,
      telegramUserId,
    })
    return
  }

  if (!isSetupToken || !telegramUserId) {
    const communityId = isCommunityBot(bot) ? bot.communityId : null
    const url = communityId ? telegramCommunityParticipationUrl(env, communityId) : null
    if (url) {
      await safeSetTelegramChatMenuButton(bot, {
        chat_id: chatId,
        menu_button: {
          type: "web_app",
          text: "Open Pirate",
          web_app: { url },
        },
      })
      await safeSendTelegramMessage(bot, {
        chat_id: chatId,
        text: "Open this community in Pirate.",
        reply_markup: telegramMiniAppLauncherMarkup(url),
      })
      return
    }
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: "Open a Pirate community invite link to get started.",
    })
    return
  }

  try {
    const setupRequest = await prepareTelegramSetupChatRequest({
      env,
      setupToken,
      telegramCommunityBotId: isCommunityBot(bot) ? bot.id : null,
      telegramUserId,
      privateChatId: chatId,
      requestMessageId: message.message_id ?? null,
    })
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: setupInstructions(bot),
      reply_markup: chatPickerMarkup(setupRequest.request_id),
    })
  } catch (error) {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: setupErrorMessage(error),
    })
  }
}

async function handleCommunityStartMessage(env: Env, input: {
  bot: Env | TelegramCommunityBotCredential
  chatId: string
  communityId: string
  telegramLanguageCode: string | null
  telegramUserId: string | null
}): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  const communityId = await resolveCommunityIdentifier(communityRepository, input.communityId) ?? input.communityId
  const community = await communityRepository.getCommunityById(communityId)
  if (!community || community.status !== "active") {
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "This Pirate community is not available.",
    })
    return
  }

  const boardUrl = telegramCommunityParticipationUrl(env, community.community_id)
  const verifyUrl = telegramCommunityVerificationUrl(env, community.community_id)
  if (!boardUrl || !verifyUrl) {
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: "Pirate links are not configured for this bot.",
    })
    return
  }

  const account = input.telegramUserId
    ? await resolveTelegramAccount({
        env,
        telegramUserId: input.telegramUserId,
      })
    : null
  const profile = account
    ? await getProfileRepository(env).getProfileByUserId(account.userId).catch(() => null)
    : null
  const locale = resolveTelegramStartLocale({
    telegramLanguageCode: input.telegramLanguageCode,
    profilePreferredLocale: profile?.preferred_locale,
  })
  const copy = getTelegramCopy(locale)
  const presentation = await telegramCommunityStartPresentation({
    accountUserId: account?.userId ?? null,
    boardUrl,
    communityDisplayName: community.display_name,
    communityId: community.community_id,
    communityRepository,
    env,
    locale,
    telegramUserId: input.telegramUserId,
    verifyUrl,
  })
  await safeSetTelegramChatMenuButton(input.bot, {
    chat_id: input.chatId,
    menu_button: {
      type: "web_app",
      text: copy.buttons.openPirate,
      web_app: { url: boardUrl },
    },
  })
  await safeSendTelegramMessage(input.bot, {
    chat_id: input.chatId,
    text: presentation.messageText,
    reply_markup: telegramCommunityStartMarkup({
      text: presentation.actionText,
      url: presentation.actionUrl,
    }),
  })
}

type TelegramCommunityStartPresentation = {
  actionText: string
  actionUrl: string
  messageText: string
}

async function telegramCommunityStartPresentation(input: {
  accountUserId: string | null
  boardUrl: string
  communityDisplayName: string
  communityId: string
  communityRepository: ReturnType<typeof getCommunityRepository>
  env: Env
  locale: RuntimeUiLocaleCode
  telegramUserId: string | null
  verifyUrl: string
}): Promise<TelegramCommunityStartPresentation> {
  const copy = getTelegramCopy(input.locale)
  const community = input.communityDisplayName
  if (!input.telegramUserId) {
    return {
      actionText: copy.buttons.openPirate,
      actionUrl: input.boardUrl,
      messageText: copy.start.signIn({ community }),
    }
  }

  try {
    if (!input.accountUserId) {
      return {
        actionText: copy.buttons.verifyToJoin,
        actionUrl: input.verifyUrl,
        messageText: copy.start.linkRequired({ community }),
      }
    }

    const userId = input.accountUserId
    const eligibility = await getJoinEligibility({
      env: input.env,
      userId,
      communityId: input.communityId,
      userRepository: getUserRepository(input.env),
      communityRepository: input.communityRepository,
    })
    switch (eligibility.status) {
      case "already_joined":
        return {
          actionText: copy.buttons.openCommunity,
          actionUrl: input.boardUrl,
          messageText: copy.start.alreadyJoined({ community }),
      }
      case "joinable":
        {
          const joinResult = await joinCommunity({
            env: input.env,
            userId,
            communityId: input.communityId,
            userRepository: getUserRepository(input.env),
            profileRepository: getProfileRepository(input.env),
            communityRepository: input.communityRepository,
          })
          if (joinResult.status === "joined") {
            return {
              actionText: copy.buttons.openCommunity,
              actionUrl: input.boardUrl,
              messageText: copy.start.joined({ community }),
            }
          }
          if (joinResult.status === "requested") {
            return {
              actionText: copy.buttons.checkRequest,
              actionUrl: input.boardUrl,
              messageText: copy.start.requestSent({ community }),
            }
          }
          return {
            actionText: copy.buttons.openPirate,
            actionUrl: input.boardUrl,
            messageText: copy.start.fallback({ community }),
          }
        }
      case "requestable":
        return {
          actionText: copy.buttons.requestAccess,
          actionUrl: input.verifyUrl,
          messageText: copy.start.requestable({ community }),
        }
      case "pending_request":
        return {
          actionText: copy.buttons.checkRequest,
          actionUrl: input.boardUrl,
          messageText: copy.start.pendingRequest({ community }),
        }
      case "verification_required":
        return {
          actionText: copy.buttons.verifyToJoin,
          actionUrl: input.verifyUrl,
          messageText: copy.start.verifyRequired({ community }),
        }
      case "gate_failed":
        return {
          actionText: copy.buttons.checkStatus,
          actionUrl: input.verifyUrl,
          messageText: copy.start.gateFailed({ community }),
        }
      default:
        return {
          actionText: copy.buttons.openPirate,
          actionUrl: input.boardUrl,
          messageText: copy.start.fallback({ community }),
        }
    }
  } catch (error) {
    console.warn("[telegram-webhook] community start status failed", {
      communityId: input.communityId,
      error: error instanceof Error ? error.message : String(error),
      telegramUserId: input.telegramUserId,
    })
    return {
      actionText: copy.buttons.openPirate,
      actionUrl: input.boardUrl,
      messageText: copy.start.fallback({ community }),
    }
  }
}

async function handleChatSharedMessage(env: Env, message: TelegramWebhookMessage, bot: Env | TelegramCommunityBotCredential = env): Promise<void> {
  const chatId = telegramIdentifier(message.chat?.id)
  const telegramUserId = telegramIdentifier(message.from?.id)
  const shared = message.chat_shared
  if (!chatId || !telegramUserId || message.chat?.type !== "private" || !shared) {
    return
  }
  if (typeof shared.request_id !== "number" || !Number.isInteger(shared.request_id)) {
    return
  }
  const sharedChatId = telegramIdentifier(shared.chat_id)
  if (!sharedChatId) {
    return
  }

  try {
    const telegramChat = await getTelegramChat(bot, sharedChatId)
    const chatType = mapTelegramChatType(telegramChat.type)
    if (!chatType) {
      throw badRequestError("telegram_chat.type must be group or supergroup")
    }
    const botAdminStatus = await getBotAdminStatus(bot, sharedChatId)
    await completeTelegramSetupIntentByRequest({
      env,
      telegramCommunityBotId: "id" in bot ? bot.id : null,
      requestId: shared.request_id,
      telegramUserId,
      privateChatId: chatId,
      telegramChatId: sharedChatId,
      chatTitle: telegramChat.title ?? shared.title ?? "Telegram chat",
      chatUsername: telegramChat.username ?? shared.username ?? null,
      chatType,
      botAdminStatus,
    })
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: "Telegram chat connected. Return to Pirate to manage settings.",
    })
  } catch (error) {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: completionErrorMessage(error),
    })
  }
}

async function handleDirectAssistantMessage(env: Env, message: TelegramWebhookMessage, bot: TelegramCommunityBotCredential): Promise<void> {
  const chatId = telegramIdentifier(message.chat?.id)
  const telegramUserId = telegramIdentifier(message.from?.id)
  if (!chatId || !telegramUserId || !isPrivateChat(message.chat?.type) || message.from?.is_bot) {
    return
  }

  const locale = resolveTelegramStartLocale({
    telegramLanguageCode: telegramLanguageCode(message.from?.language_code),
  })
  const textPrompt = parseDirectAssistantPrompt(bot, message)
  const voiceTrigger = textPrompt ? null : parseDirectAssistantVoiceTrigger(message)
  if (!textPrompt && !voiceTrigger) {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: "Send a text question to talk to this community assistant.",
    })
    return
  }

  const account = await resolveTelegramAccount({
    env,
    telegramUserId,
  })
  if (!account) {
    const previewPolicy = textPrompt
      ? await getTelegramDirectAssistantPolicy({ env, communityId: bot.communityId }).catch(() => null)
      : null
    if (
      !textPrompt
      || !previewPolicy?.telegramPreviewEnabled
      || previewPolicy.telegramPreviewDailyCap <= 0
    ) {
      await sendDirectAssistantOnboardingPrompt({
        env,
        bot,
        chatId,
        telegramUserId,
        reason: "unlinked",
      })
      return
    }
    await sendDirectAssistantPreviewResponse({
      env,
      bot,
      chatId,
      telegramMessageId: message.message_id ?? 0,
      telegramUserId,
      locale,
      policy: previewPolicy,
      prompt: textPrompt,
    })
    return
  }

  const canAccess = await telegramUserCanAccessCommunity({
    env,
    communityId: bot.communityId,
    userId: account.userId,
  })
  if (!canAccess) {
    const previewPolicy = textPrompt
      ? await getTelegramDirectAssistantPolicy({ env, communityId: bot.communityId }).catch(() => null)
      : null
    if (
      !textPrompt
      || !previewPolicy?.telegramPreviewEnabled
      || previewPolicy.telegramPreviewDailyCap <= 0
    ) {
      await sendDirectAssistantOnboardingPrompt({
        env,
        bot,
        chatId,
        telegramUserId,
        reason: "not_member",
      })
      return
    }
    await sendDirectAssistantPreviewResponse({
      env,
      bot,
      chatId,
      telegramMessageId: message.message_id ?? 0,
      telegramUserId,
      locale,
      policy: previewPolicy,
      prompt: textPrompt,
    })
    return
  }

  try {
    await getTelegramDirectAssistantPolicy({
      env,
      communityId: bot.communityId,
    })
    const prompt = textPrompt ?? await transcribeTelegramAssistantVoiceForCommunity({
      env,
      bot,
      communityId: bot.communityId,
      trigger: voiceTrigger!,
    })
    if (!prompt) {
      await safeSendTelegramMessage(bot, {
        chat_id: chatId,
        text: "I couldn't transcribe that voice message. Try again or send a text question.",
      })
      return
    }
    const answer = await sendCommunityAssistantTelegramDirectMessage({
      env,
      communityRepository: getCommunityRepository(env),
      communityId: bot.communityId,
      userId: account.userId,
      message: prompt,
      userMessageMetadata: {
        source: "telegram_dm",
        telegram_chat_id: chatId,
        telegram_community_bot_id: bot.id,
        telegram_message_id: message.message_id ?? null,
        telegram_user_id: telegramUserId,
      },
    })
    const answerText = telegramText(answer.assistant_message.content)
    const sentVoiceReply = await maybeSendTelegramAssistantVoiceReplyForCommunity({
      answerText,
      bot,
      chatId,
      communityId: bot.communityId,
      env,
      message,
      sendTextBeforeVoice: async () => {
        console.info("[telegram-assistant] direct text before voice", {
          answerLength: answerText.length,
          communityId: bot.communityId,
          telegramChatId: chatId,
          telegramCommunityBotId: bot.id,
          telegramUserId,
          triggerType: textPrompt ? "dm_text" : "dm_voice",
        })
        return safeSendTelegramMessage(bot, {
          chat_id: chatId,
          text: answerText,
        })
      },
    })
    if (sentVoiceReply) {
      return
    }
    console.info("[telegram-assistant] direct text fallback", {
      answerLength: answerText.length,
      communityId: bot.communityId,
      telegramChatId: chatId,
      telegramCommunityBotId: bot.id,
      telegramUserId,
      triggerType: textPrompt ? "dm_text" : "dm_voice",
    })
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: answerText,
    })
  } catch (error) {
    console.warn("[telegram-assistant] direct prompt failed", {
      ...telegramRouteErrorLogFields(error),
      communityId: bot.communityId,
      promptLength: textPrompt?.length ?? null,
      voiceFileId: voiceTrigger?.fileId ?? null,
      telegramChatId: chatId,
      telegramCommunityBotId: bot.id,
      telegramUserId,
      userId: account.userId,
    })
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: directAssistantFailureMessage(error),
    })
  }
}

async function handleGroupAssistantMessage(env: Env, message: TelegramWebhookMessage, bot: Env | TelegramCommunityBotCredential = env): Promise<void> {
  const chatId = telegramIdentifier(message.chat?.id)
  const telegramUserId = telegramIdentifier(message.from?.id)
  const textTrigger = parseGroupAssistantTrigger(bot, message)
  const voiceTrigger = textTrigger ? null : parseGroupAssistantVoiceTrigger(bot, message)
  if (!chatId || (!textTrigger && !voiceTrigger) || typeof message.message_id !== "number") {
    return
  }
  const telegramMessageId = message.message_id

  const prompt = textTrigger?.prompt ?? await transcribeTelegramGroupAssistantVoice({
    env,
    bot,
    telegramChatId: chatId,
    trigger: voiceTrigger!,
  })
  if (!prompt) {
    return
  }

  const answer = await answerTelegramGroupAssistantPrompt({
    env,
    communityRepository: getCommunityRepository(env),
    telegramChatId: chatId,
    telegramMessageId,
    telegramUserId,
    triggerType: textTrigger?.triggerType ?? voiceTrigger!.triggerType,
    prompt,
  })
  if (!answer) {
    return
  }
  const sentVoiceReply = await maybeSendTelegramAssistantVoiceReply({
    answerText: answer.text,
    bot,
    env,
    message,
    telegramChatId: chatId,
    sendTextBeforeVoice: async () => {
      console.info("[telegram-assistant] group text before voice", {
        answerLength: answer.text.length,
        communityId: isCommunityBot(bot) ? bot.communityId : null,
        telegramChatId: chatId,
        telegramMessageId,
        telegramUserId,
        triggerType: textTrigger?.triggerType ?? voiceTrigger!.triggerType,
      })
      return safeSendTelegramMessage(bot, {
        chat_id: chatId,
        ...(typeof message.message_thread_id === "number" ? { message_thread_id: message.message_thread_id } : {}),
        text: answer.text,
        reply_parameters: {
          message_id: telegramMessageId,
        },
      })
    },
  })
  if (sentVoiceReply) {
    return
  }
  console.info("[telegram-assistant] group text fallback", {
    answerLength: answer.text.length,
    communityId: isCommunityBot(bot) ? bot.communityId : null,
    telegramChatId: chatId,
    telegramMessageId,
    telegramUserId,
    triggerType: textTrigger?.triggerType ?? voiceTrigger!.triggerType,
  })
  await safeSendTelegramMessage(bot, {
    chat_id: chatId,
    ...(typeof message.message_thread_id === "number" ? { message_thread_id: message.message_thread_id } : {}),
    text: answer.text,
    reply_parameters: {
      message_id: telegramMessageId,
    },
  })
}

async function handleChatJoinRequest(env: Env, joinRequest: TelegramWebhookChatJoinRequest, bot: Env | TelegramCommunityBotCredential = env): Promise<void> {
  const telegramChatId = telegramIdentifier(joinRequest.chat?.id)
  const telegramUserId = telegramIdentifier(joinRequest.from?.id)
  if (!telegramChatId || !telegramUserId) {
    return
  }
  const decision = await evaluateTelegramChatJoinRequest({
    env,
    communityRepository: getCommunityRepository(env),
    telegramChatId,
    telegramUserId,
    telegramUserChatId: telegramIdentifier(joinRequest.user_chat_id),
    joinRequestDate: typeof joinRequest.date === "number" ? joinRequest.date : null,
    telegramCommunityBotIdForOnboarding: isCommunityBot(bot) ? bot.id : null,
  })
  if (!decision || decision.action === "ignore") {
    return
  }
  if (decision.action === "approve") {
    const approved = await safeApproveTelegramChatJoinRequest(bot, {
      chat_id: decision.telegramChatId,
      user_id: decision.telegramUserId,
    })
    if (approved) {
      await markTelegramJoinGrantApproved({ env, grantId: decision.grantId })
    } else {
      await markTelegramJoinGrantFailed({
        env,
        grantId: decision.grantId,
        errorMessage: "Telegram approveChatJoinRequest failed",
      })
    }
    return
  }
  const prompted = await safeSendTelegramMessage(bot, {
    chat_id: decision.telegramUserChatId,
    text: decision.text,
    ...(decision.replyMarkup ? { reply_markup: decision.replyMarkup } : {}),
  })
  if (prompted) {
    await markTelegramJoinGrantPrompted({ env, grantId: decision.grantId })
  } else {
    await markTelegramJoinGrantFailed({
      env,
      grantId: decision.grantId,
      errorMessage: "Telegram join verification prompt failed",
    })
  }
}

async function handleTelegramWebhookUpdate(env: Env, update: TelegramWebhookUpdate, bot: Env | TelegramCommunityBotCredential = env): Promise<void> {
  if (update.chat_join_request) {
    await handleChatJoinRequest(env, update.chat_join_request, bot)
    return
  }
  const message = update.message
  if (!message) {
    return
  }
  if (message.chat_shared) {
    await handleChatSharedMessage(env, message, bot)
    return
  }
  if (message.text?.trim().startsWith("/start")) {
    await handleStartMessage(env, message, bot)
    return
  }
  if (isPrivateChat(message.chat?.type)) {
    if (isCommunityBot(bot)) {
      await handleDirectAssistantMessage(env, message, bot)
    } else {
      await handleStartMessage(env, message, bot)
    }
    return
  }
  await handleGroupAssistantMessage(env, message, bot)
}

telegram.post("/setup-intents/complete", async (c) => {
  requireBotIntegrationSecret(c)
  const body = await c.req.json<CompleteTelegramSetupIntentInput>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid Telegram setup completion payload")
  }
  const linkedChat = await completeTelegramSetupIntent({
    env: c.env,
    body,
  })
  return c.json({ linked_chat: linkedChat }, 200)
})

telegram.post("/session/exchange", async (c) => {
  const body = await c.req.json<{ token?: unknown; init_data?: unknown }>().catch(() => null)
  return c.json(await exchangeTelegramOnboardingSession({
    env: c.env,
    body,
  }), 200)
})

telegram.post("/session/auto-exchange", async (c) => {
  const body = await c.req.json<{ community_id?: unknown; init_data?: unknown }>().catch(() => null)
  const communityIdentifier = typeof body?.community_id === "string" ? body.community_id.trim() : ""
  const initData = typeof body?.init_data === "string" ? body.init_data.trim() : ""
  if (!communityIdentifier || !initData) {
    throw badRequestError("community_id and init_data are required")
  }

  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }

  const telegramUser = verifyTelegramMiniAppInitData({
    botTokens: await telegramAutoExchangeMiniAppVerificationTokens(c.env, communityId),
    initData,
    maxAgeSeconds: configuredTelegramInitDataMaxAgeSeconds(c.env),
  })
  const session = await getSessionRepository(c.env).exchangeIdentity({
    provider: "telegram",
    providerSubject: telegramUser.id,
    providerUserRef: telegramUser.username ?? telegramUser.id,
    selectedWalletAddress: null,
    walletAddresses: [],
    selectedWallet: null,
    wallets: [],
  })
  const userId = session.user.id.replace(/^usr_/, "")

  await syncTelegramAccountForUser({
    env: c.env,
    telegramUser,
    userId,
  })
  await linkPendingTelegramJoinGrantsForTelegramUser({
    env: c.env,
    telegramUserId: telegramUser.id,
    userId,
  })

  const joinGrantApprovals = await approvePendingTelegramJoinGrantsForUser({
    env: c.env,
    userId,
  })
  const eligibility = await getJoinEligibility({
    env: c.env,
    userId,
    communityId,
    userRepository: getUserRepository(c.env),
    communityRepository,
  })
  const accessToken = await mintPirateAccessToken({
    env: c.env,
    userId,
  })
  const syncedProfile = await getProfileRepository(c.env)
    .syncLinkedHandles(userId)
    .catch(() => null)
  await trackApiEvent(c.env, c.req, {
    eventName: "auth_session_exchanged",
    userId,
    properties: { provider: "telegram", mode: "mini_app_auto" },
  })

  return c.json({
    access_token: accessToken,
    ...session,
    profile: syncedProfile ?? session.profile,
    community: publicCommunityId(communityId),
    eligibility,
    membership_result: null,
    telegram_join_request: {
      status: summarizeTelegramJoinGrantApprovalResults(joinGrantApprovals),
    },
  }, 200)
})

telegram.post("/webhook", async (c) => {
  requireTelegramWebhookSecret(c)
  const body = await c.req.json<TelegramWebhookUpdate>().catch(() => null)
  if (!body || typeof body !== "object") {
    console.warn("[telegram-webhook] invalid payload")
    return c.json({ ok: true }, 200)
  }
  try {
    await handleTelegramWebhookUpdate(c.env, body)
  } catch (error) {
    console.warn("[telegram-webhook] update handling failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return c.json({ ok: true }, 200)
})

telegram.post("/community-bots/:webhookId/webhook", async (c) => {
  const webhookId = c.req.param("webhookId")?.trim()
  if (!webhookId) {
    throw authError("Authentication failed")
  }
  const bot = await decryptCommunityTelegramBotByWebhookId({
    env: c.env,
    webhookId,
  })
  if (!bot) {
    throw authError("Authentication failed")
  }
  const providedSecret = c.req.header("x-telegram-bot-api-secret-token")?.trim()
  if (!providedSecret || !timingSafeSecretEqual(providedSecret, bot.webhookSecret)) {
    throw authError("Authentication failed")
  }
  const body = await c.req.json<TelegramWebhookUpdate>().catch(() => null)
  if (!body || typeof body !== "object") {
    console.warn("[telegram-community-webhook] invalid payload")
    return c.json({ ok: true }, 200)
  }
  try {
    await handleTelegramWebhookUpdate(c.env, body, bot)
  } catch (error) {
    console.warn("[telegram-community-webhook] update handling failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return c.json({ ok: true }, 200)
})

export default telegram
