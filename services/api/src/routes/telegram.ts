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
  type TelegramSetupKind,
} from "../lib/telegram/community-chat-service"
import {
  answerTelegramCallbackQuery,
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
import { resolveCanonicalUserId } from "../lib/auth/account-alias-service"
import { mintPirateAccessToken } from "../lib/auth/pirate-session-token"
import {
  configuredTelegramInitDataMaxAgeSeconds,
  verifyTelegramMiniAppInitData,
} from "../lib/telegram/mini-app-auth"
import { trackApiEvent } from "../lib/analytics/track"
import { authError, badRequestError, HttpError, notFoundError, telegramStudyUnavailable } from "../lib/errors"
import { decodePublicUserId, publicCommunityId, publicId } from "../lib/public-ids"
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
  type TelegramWebhookCallbackQuery,
  type TelegramWebhookChatJoinRequest,
  type TelegramWebhookMessage,
  type TelegramWebhookUpdate,
} from "../lib/telegram/webhook-parsing"
import {
  handleTelegramStudyVoiceMessage,
} from "../lib/telegram/study-voice-service"
import { isTelegramStudyVoiceEnabled } from "../lib/telegram/study-voice-admission"
import {
  answerPrivateStudyTutorQuestion,
  releaseTutorDisclosureReceipt,
} from "../lib/telegram/private-study-tutor-service"
import { telegramStudyContinueTutorButton } from "../lib/telegram/chat-study-playback-service"
import {
  continueTelegramChatStudyAfterVoice,
  getTelegramStudyRewardOpportunityCount,
  handleTelegramChatStudyCallback,
  startTelegramChatStudy,
} from "../lib/telegram/chat-study-service"
import { withBackgroundControlPlaneClients } from "../lib/runtime-deps"
import {
  directAssistantFailureMessage,
  getTelegramCommunityAssistantPolicy,
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
import { completeTelegramChannelSetupByRequest } from "../lib/telegram/channel-destination-service"
import { getWaitUntil } from "./execution-context"
import { getRewardsSummaryForUser } from "../lib/rewards/reward-read-service"

const telegram = new Hono<{ Bindings: Env }>()

const TELEGRAM_START_MENU_STUDY = "menu:study"
const TELEGRAM_START_MENU_REWARDS = "menu:rewards"
const TELEGRAM_START_MENU_SETTINGS = "menu:settings"

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

async function telegramStudyMiniAppVerificationTokens(env: Env, communityId: string): Promise<string[]> {
  const communityBot = await decryptActiveCommunityTelegramBotOrNull({
    env,
    communityId,
  })
  if (!communityBot) {
    throw telegramStudyUnavailable()
  }
  return [communityBot.token]
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

function groupPickerAdminRights() {
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

function channelPickerAdminRights() {
  return {
    is_anonymous: false,
    can_manage_chat: true,
    can_delete_messages: false,
    can_manage_video_chats: false,
    can_restrict_members: false,
    can_promote_members: false,
    can_change_info: false,
    can_invite_users: false,
    can_post_messages: true,
    can_edit_messages: false,
    can_post_stories: false,
    can_edit_stories: false,
    can_delete_stories: false,
  }
}

function chatPickerMarkup(requestId: number, setupKind: TelegramSetupKind) {
  const isChannel = setupKind === "channel"
  const rights = isChannel ? channelPickerAdminRights() : groupPickerAdminRights()
  return {
    keyboard: [[{
      text: isChannel ? "Select channel" : "Select group",
      request_chat: {
        request_id: requestId,
        chat_is_channel: isChannel,
        bot_is_member: true,
        user_administrator_rights: rights,
        bot_administrator_rights: rights,
        request_title: true,
        request_username: true,
      },
    }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  }
}

function setupInstructions(bot: Env | TelegramBotCredential, setupKind: TelegramSetupKind): string {
  const username = telegramBotUsername(bot)
  if (setupKind === "channel") {
    return username
      ? `Add @${username} to the channel as an admin with permission to post messages, then tap Select channel.`
      : "Add this bot to the channel as an admin with permission to post messages, then tap Select channel."
  }
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

function telegramRewardsUrl(env: Env): string | null {
  const origin = telegramWebPublicOrigin(env)
  return origin ? `${origin}/wallet` : null
}

function telegramRewardDeadline(locale: RuntimeUiLocaleCode, value: number | string | null): string | null {
  if (value === null || value === "") return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date)
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
  copy: ReturnType<typeof getTelegramCopy>
  studyEnabled: boolean
}): unknown {
  const rows: Array<Array<Record<string, unknown>>> = []
  if (input.studyEnabled) {
    rows.push([{ text: input.copy.menu.study, callback_data: TELEGRAM_START_MENU_STUDY }])
  }
  rows.push([{ text: input.copy.menu.rewards, callback_data: TELEGRAM_START_MENU_REWARDS }])
  if (input.studyEnabled) {
    rows.push([{ text: input.copy.menu.settings, callback_data: TELEGRAM_START_MENU_SETTINGS }])
  }
  return {
    inline_keyboard: rows,
  }
}

function telegramCommunityActionMarkup(text: string, url: string): unknown {
  return {
    inline_keyboard: [[{ text, web_app: { url } }]],
  }
}

async function handleTelegramStartMenuCallback(input: {
  bot: TelegramCommunityBotCredential
  callback: TelegramWebhookCallbackQuery
  env: Env
}): Promise<boolean> {
  if (input.callback.data !== TELEGRAM_START_MENU_STUDY
    && input.callback.data !== TELEGRAM_START_MENU_REWARDS) {
    if (input.callback.data !== TELEGRAM_START_MENU_SETTINGS) return false
  }
  const callbackQueryId = telegramIdentifier(input.callback.id)
  const chatId = telegramIdentifier(input.callback.message?.chat?.id)
  const telegramUserId = telegramIdentifier(input.callback.from?.id)
  if (!callbackQueryId || !chatId || !telegramUserId) return true
  console.info("[telegram-start-menu] callback", {
    callbackData: input.callback.data,
    communityId: input.bot.communityId,
    messageId: input.callback.message?.message_id ?? null,
    telegramUserId,
  })

  if (input.callback.data === TELEGRAM_START_MENU_REWARDS) {
    const account = await resolveTelegramAccount({ env: input.env, telegramUserId })
    const profile = account
      ? await getProfileRepository(input.env).getProfileByUserId(account.userId).catch(() => null)
      : null
    const locale = resolveTelegramStartLocale({
      profilePreferredLocale: profile?.preferred_locale,
      telegramLanguageCode: input.callback.from?.language_code ?? null,
    })
    const copy = getTelegramCopy(locale)
    const rewardsUrl = telegramRewardsUrl(input.env)
    const [summary, opportunityCount] = account
      ? await Promise.all([
          getRewardsSummaryForUser({ env: input.env, userId: account.userId }).catch(() => null),
          getTelegramStudyRewardOpportunityCount({ communityId: input.bot.communityId, env: input.env, userId: account.userId }).catch(() => 0),
        ])
      : [null, 0] as const
    const pendingCents = summary?.pending_verification.conditional_cents ?? 0
    const balanceCents = summary?.balance_cents ?? 0
    const money = (cents: number) => `${(cents / 100).toFixed(2)} USDC`
    const rewardSummary = !summary || (balanceCents <= 0 && pendingCents <= 0)
      ? copy.rewards.empty
      : pendingCents > 0
        ? copy.rewards.pending({
            balance: money(balanceCents),
            expiresAt: telegramRewardDeadline(locale, summary.pending_verification.earliest_expires_at),
            pending: money(pendingCents),
          })
        : copy.rewards.balance({ balance: money(balanceCents) })
    const text = `${rewardSummary}\n\n${copy.rewards.opportunities({ count: opportunityCount })}`
    await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => false)
    await safeSendTelegramMessage(input.bot, {
      chat_id: chatId,
      text,
      ...(rewardsUrl && (balanceCents > 0 || pendingCents > 0) ? {
        reply_markup: {
          inline_keyboard: [[{ text: copy.rewards.claim, web_app: { url: rewardsUrl } }]],
        },
      } : {}),
    })
    return true
  }

  if (!isTelegramStudyVoiceEnabled(input.env, input.bot.communityId)) {
    await answerTelegramCallbackQuery(input.bot, {
      callback_query_id: callbackQueryId,
      text: "Study is not available here yet.",
    }).catch(() => false)
    return true
  }
  await answerTelegramCallbackQuery(input.bot, { callback_query_id: callbackQueryId }).catch(() => false)
  await startTelegramChatStudy({
    bot: input.bot,
    chatId,
    env: input.env,
    forcePreferences: input.callback.data === TELEGRAM_START_MENU_SETTINGS,
    requestMessageId: input.callback.data === TELEGRAM_START_MENU_SETTINGS
      ? null
      : input.callback.message?.message_id ?? null,
    targetLanguage: telegramLanguageCode(input.callback.from?.language_code),
    telegramUserId,
  })
  return true
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
        text: setupInstructions(input.bot, setupRequest.setup_kind),
        reply_markup: chatPickerMarkup(setupRequest.request_id, setupRequest.setup_kind),
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
    // Start presentation is independent of the private study tutor toggle, and
    // always shows the community welcome plus menu. The assistant remains
    // reachable through its menu button rather than replacing the welcome.
    const policy = await getTelegramCommunityAssistantPolicy({
      env,
      communityId: input.bot.communityId,
    }).catch(() => null)
    await handleCommunityStartMessage(env, {
      bot: input.bot,
      chatId: input.chatId,
      communityId: input.bot.communityId,
      assistantEnabled: Boolean(policy?.enabled),
      showStartMenu: true,
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
      text: setupInstructions(bot, setupRequest.setup_kind),
      reply_markup: chatPickerMarkup(setupRequest.request_id, setupRequest.setup_kind),
    })
  } catch (error) {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: setupErrorMessage(error),
    })
  }
}

async function handleCommunityStartMessage(env: Env, input: {
  assistantEnabled?: boolean
  bot: Env | TelegramCommunityBotCredential
  chatId: string
  communityId: string
  showStartMenu?: boolean
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
  const rewardsUrl = telegramRewardsUrl(env)
  if (!boardUrl || !verifyUrl || !rewardsUrl) {
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
    text: input.showStartMenu
      ? [
          copy.start.overview({ community: community.display_name }),
          input.assistantEnabled === true ? copy.start.assistantHint : null,
        ].filter((value): value is string => Boolean(value)).join("\n\n")
      : presentation.messageText,
    reply_markup: input.showStartMenu
      ? telegramCommunityStartMarkup({
          copy,
          studyEnabled: isCommunityBot(input.bot)
            && isTelegramStudyVoiceEnabled(env, input.bot.communityId),
        })
      : telegramCommunityActionMarkup(presentation.actionText, presentation.actionUrl),
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
    if (telegramChat.type === "channel") {
      if (!isCommunityBot(bot)) {
        throw badRequestError("A community bot is required to connect a channel")
      }
      const member = await getTelegramChatMember(bot, sharedChatId, telegramBotUserId(bot))
      if (
        member.status !== "administrator"
        && member.status !== "creator"
        || member.can_post_messages === false
      ) {
        throw badRequestError("The community bot must be a channel administrator with permission to post messages")
      }
      await completeTelegramChannelSetupByRequest({
        env,
        telegramCommunityBotId: bot.id,
        requestId: shared.request_id,
        telegramUserId,
        privateChatId: chatId,
        telegramChatId: sharedChatId,
        channelTitle: telegramChat.title ?? shared.title ?? "Telegram channel",
        channelUsername: telegramChat.username ?? shared.username ?? null,
      })
      await safeSendTelegramMessage(bot, {
        chat_id: chatId,
        text: "Telegram channel connected. New public Pirate posts can now be published there.",
      })
      return
    }
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

/**
 * Answers a question asked during an active study session. Returns false only
 * when the learner has no active exercise, which is the single case where
 * falling back to the community board assistant is appropriate. While an
 * exercise is open every outcome is terminal, so a learner asking about the
 * line in front of them is never answered with a join prompt.
 */
async function respondToPrivateStudyTutorQuestion(input: {
  bot: TelegramCommunityBotCredential
  chatId: string
  env: Env
  question: string | null
  telegramMessageId: number
  telegramUserId: string
}): Promise<boolean> {
  const { bot, chatId, env } = input
  const question = input.question?.trim()
  if (!question) {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: "I could not make out that question. Send it as text and I will explain.",
      reply_parameters: { message_id: input.telegramMessageId },
    })
    return true
  }
  try {
    const tutor = await answerPrivateStudyTutorQuestion({
      bot,
      env,
      question,
      telegramChatId: chatId,
      telegramMessageId: input.telegramMessageId,
      telegramUserId: input.telegramUserId,
    })
    if (tutor.kind === "no_session") {
      return false
    }
    if (tutor.kind !== "answered") {
      await safeSendTelegramMessage(bot, {
        chat_id: chatId,
        text: "The study tutor is not available in this community yet. Your exercise is still waiting for your answer.",
        reply_parameters: { message_id: input.telegramMessageId },
      })
      return true
    }
    const delivered = await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: telegramText(tutor.disclosure ? `${tutor.disclosure}\n\n${tutor.answer}` : tutor.answer),
      reply_parameters: { message_id: input.telegramMessageId },
      reply_markup: {
        inline_keyboard: [[telegramStudyContinueTutorButton(tutor.sessionId, tutor.language)]],
      },
    })
    if (!delivered && tutor.disclosureReceipt) {
      await releaseTutorDisclosureReceipt({ env, receipt: tutor.disclosureReceipt }).catch(() => undefined)
    }
    return true
  } catch (error) {
    console.warn("[private-study-tutor] prompt failed", {
      ...telegramRouteErrorLogFields(error),
      communityId: bot.communityId,
      telegramChatId: chatId,
      telegramCommunityBotId: bot.id,
      telegramUserId: input.telegramUserId,
    })
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: error instanceof HttpError && error.status === 429
        ? "The study tutor is rate limited right now. Try again in a minute."
        : "The study tutor is unavailable right now. Your exercise is still waiting for your answer.",
      reply_parameters: { message_id: input.telegramMessageId },
    })
    return true
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
      ? await getTelegramCommunityAssistantPolicy({ env, communityId: bot.communityId }).catch(() => null)
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
      ? await getTelegramCommunityAssistantPolicy({ env, communityId: bot.communityId }).catch(() => null)
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
    // The board assistant depends on the community assistant being enabled, not
    // on the private study tutor toggle.
    const boardPolicy = await getTelegramCommunityAssistantPolicy({
      env,
      communityId: bot.communityId,
    })
    if (!boardPolicy.enabled) {
      throw notFoundError("Community assistant is not enabled")
    }
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

async function handleTelegramWebhookUpdate(
  env: Env,
  update: TelegramWebhookUpdate,
  bot: Env | TelegramCommunityBotCredential = env,
  waitUntil?: (promise: Promise<void>) => void,
): Promise<void> {
  if (update.callback_query && isCommunityBot(bot)) {
    const handle = async () => {
      if (await handleTelegramStartMenuCallback({ bot, callback: update.callback_query!, env })) return
      await handleTelegramChatStudyCallback({
        bot,
        callback: update.callback_query!,
        env,
      })
    }
    if (waitUntil) {
      waitUntil(withBackgroundControlPlaneClients(handle))
    } else {
      await handle()
    }
    return
  }
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
      const chatId = telegramIdentifier(message.chat?.id)
      const telegramUserId = telegramIdentifier(message.from?.id)
      if (
        message.text?.trim().match(/^\/(?:study|preferences)(?:@[A-Za-z0-9_]{5,32})?$/u)
        && chatId
        && telegramUserId
      ) {
        if (isTelegramStudyVoiceEnabled(env, bot.communityId)) {
          const handle = () => startTelegramChatStudy({
            bot,
            chatId,
            env,
            forcePreferences: message.text?.trim().startsWith("/preferences") ?? false,
            requestMessageId: message.message_id ?? null,
            targetLanguage: telegramLanguageCode(message.from?.language_code),
            telegramUserId,
          }).then(() => undefined)
          if (waitUntil) {
            waitUntil(withBackgroundControlPlaneClients(handle))
          } else {
            await handle()
          }
          return
        }
      }
      if (await handleTelegramStudyVoiceMessage({
        bot,
        env,
        message,
        onChatStudyAttemptComplete: ({
          chatId: completionChatId,
          chatStudySessionId,
          result,
          telegramMessageId: voiceMessageId,
          transcript,
        }) =>
          continueTelegramChatStudyAfterVoice({
            bot,
            chatId: completionChatId,
            chatStudySessionId,
            env,
            replyToMessageId: voiceMessageId,
            result,
            transcript,
          }),
        onChatStudyAttemptConflict: ({
          chatId: conflictChatId,
          chatStudySessionId,
          lesson,
          telegramMessageId: conflictMessageId,
        }) =>
          continueTelegramChatStudyAfterVoice({
            bot,
            chatId: conflictChatId,
            chatStudySessionId,
            env,
            lesson,
            replyToMessageId: conflictMessageId,
          }),
        waitUntil,
      })) {
        return
      }
      const tutorQuestion = typeof message.text === "string" ? message.text.trim() : ""
      if (tutorQuestion && chatId && telegramUserId && typeof message.message_id === "number") {
        const handled = await respondToPrivateStudyTutorQuestion({
          bot,
          chatId,
          env,
          question: tutorQuestion,
          telegramMessageId: message.message_id,
          telegramUserId,
        })
        if (handled) {
          return
        }
      }
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
  const body = await c.req.json<{
    community_id?: unknown
    context?: unknown
    init_data?: unknown
  }>().catch(() => null)
  const communityIdentifier = typeof body?.community_id === "string" ? body.community_id.trim() : ""
  const context = body?.context === undefined ? "default" : body.context
  const initData = typeof body?.init_data === "string" ? body.init_data.trim() : ""
  if (!communityIdentifier || !initData) {
    throw badRequestError("community_id and init_data are required")
  }
  if (context !== "default" && context !== "study") {
    throw badRequestError("context must be default or study")
  }

  const communityRepository = getCommunityRepository(c.env)
  const communityId = await resolveCommunityIdentifier(communityRepository, communityIdentifier)
  if (!communityId) {
    throw badRequestError("Community was not found")
  }

  const telegramUser = verifyTelegramMiniAppInitData({
    botTokens: context === "study"
      ? await telegramStudyMiniAppVerificationTokens(c.env, communityId)
      : await telegramAutoExchangeMiniAppVerificationTokens(c.env, communityId),
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
  const userId = await resolveCanonicalUserId({
    env: c.env,
    userId: decodePublicUserId(session.user.id),
  })

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
    properties: {
      provider: "telegram",
      mode: context === "study" ? "mini_app_study" : "mini_app_auto",
    },
  })

  return c.json({
    ...session,
    access_token: accessToken,
    user: { ...session.user, id: publicId(userId, "usr") },
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
    await handleTelegramWebhookUpdate(c.env, body, bot, getWaitUntil(c))
  } catch (error) {
    console.warn("[telegram-community-webhook] update handling failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
  return c.json({ ok: true }, 200)
})

export default telegram
