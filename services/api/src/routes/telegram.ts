import { createHash, timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import type { Env } from "../env"
import {
  completeTelegramSetupIntentByRequest,
  completeTelegramSetupIntent,
  getTelegramLinkedChatBotContext,
  prepareTelegramSetupChatRequest,
  type TelegramBotAdminStatus,
  type TelegramChatType,
  type CompleteTelegramSetupIntentInput,
} from "../lib/telegram/community-chat-service"
import {
  approveTelegramChatJoinRequest,
  downloadTelegramFile,
  getTelegramFile,
  getTelegramChat,
  getTelegramChatMember,
  sendTelegramMessage,
  sendTelegramVoice,
  telegramBotUserId,
  telegramBotUsername,
  type TelegramBotCredential,
  type TelegramChatMember,
} from "../lib/telegram/bot-api"
import {
  decryptCommunityTelegramBotByWebhookId,
  type TelegramCommunityBotCredential,
} from "../lib/telegram/community-bot-service"
import {
  createTelegramOnboardingIntent,
  exchangeTelegramOnboardingSession,
  telegramOnboardingWebAppReplyMarkup,
} from "../lib/telegram/onboarding-service"
import {
  answerTelegramGroupAssistantPrompt,
  telegramText,
  type TelegramAssistantTriggerType,
} from "../lib/telegram/assistant-service"
import {
  COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES,
  synthesizeCommunityAssistantSpeechForCommunity,
  TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
  transcribeCommunityAssistantAudioForCommunity,
} from "../lib/communities/assistant-policy/speech-service"
import { getCommunityAssistantRuntimePolicyForCommunity } from "../lib/communities/assistant-policy/service"
import {
  evaluateTelegramChatJoinRequest,
  markTelegramJoinGrantApproved,
  markTelegramJoinGrantFailed,
  markTelegramJoinGrantPrompted,
  resolveTelegramAccount,
} from "../lib/telegram/join-request-service"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { openCommunityDb } from "../lib/communities/community-db-factory"
import {
  canAccessCommunity,
  getCommunityMembershipState,
} from "../lib/communities/membership/membership-state-store"
import { sendCommunityAssistantTelegramDirectMessage } from "../lib/communities/assistant-policy/chat-service"
import { authError, badRequestError, HttpError } from "../lib/errors"
import { publicCommunityId } from "../lib/public-ids"

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

type TelegramWebhookUpdate = {
  message?: TelegramWebhookMessage
  chat_join_request?: TelegramWebhookChatJoinRequest
}

type TelegramWebhookMessage = {
  message_id?: number
  message_thread_id?: number
  text?: string
  from?: { id?: number | string; is_bot?: boolean; username?: string }
  chat?: { id?: number | string; type?: string }
  voice?: TelegramWebhookAudioAttachment
  audio?: TelegramWebhookAudioAttachment
  reply_to_message?: {
    message_id?: number
    from?: { id?: number | string; is_bot?: boolean; username?: string }
  }
  chat_shared?: {
    request_id?: number
    chat_id?: number | string
    title?: string
    username?: string
  }
}

type TelegramWebhookAudioAttachment = {
  file_id?: string
  file_unique_id?: string
  file_name?: string
  mime_type?: string
  duration?: number
  file_size?: number
}

type TelegramWebhookChatJoinRequest = {
  chat?: { id?: number | string; type?: string; title?: string; username?: string }
  from?: { id?: number | string; is_bot?: boolean; username?: string }
  user_chat_id?: number | string
  date?: number
  bio?: string
}

function telegramIdentifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value)
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim()
  }
  return null
}

function parseStartToken(text: string | undefined): string | null {
  const match = text?.trim().match(/^\/start(?:@[A-Za-z0-9_]{5,32})?(?:\s+(\S+))?$/u)
  return match?.[1] ?? null
}

type TelegramGroupAssistantTrigger = {
  prompt: string
  triggerType: TelegramAssistantTriggerType
}

type TelegramGroupAssistantVoiceTrigger = {
  fileId: string
  fileName: string
  fileSize: number | null
  mimeType: string
  triggerType: TelegramAssistantTriggerType
}

function isTelegramGroupChat(type: string | undefined): boolean {
  return type === "group" || type === "supergroup"
}

function sameTelegramUsername(left: string | null, right: string | undefined): boolean {
  return Boolean(left && right && left.toLowerCase() === right.replace(/^@/, "").toLowerCase())
}

function isReplyToThisBot(bot: Env | TelegramBotCredential, message: TelegramWebhookMessage): boolean {
  const replyFrom = message.reply_to_message?.from
  if (!replyFrom?.is_bot) {
    return false
  }
  const replyFromId = telegramIdentifier(replyFrom.id)
  if (replyFromId) {
    try {
      return replyFromId === String(telegramBotUserId(bot))
    } catch {
      return false
    }
  }
  return sameTelegramUsername(telegramBotUsername(bot), replyFrom.username)
}

function parseGroupAssistantTrigger(bot: Env | TelegramBotCredential, message: TelegramWebhookMessage): TelegramGroupAssistantTrigger | null {
  if (!isTelegramGroupChat(message.chat?.type)) {
    return null
  }
  const text = message.text?.trim()
  if (!text) {
    return null
  }
  const commandMatch = text.match(/^\/ask(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([\s\S]+))?$/u)
  if (commandMatch) {
    const mentionedUsername = commandMatch[1]
    if (mentionedUsername && !sameTelegramUsername(telegramBotUsername(bot), mentionedUsername)) {
      return null
    }
    let prompt = commandMatch[2]?.trim()
    let triggerType: TelegramAssistantTriggerType = mentionedUsername ? "ask_command_mention" : "ask_command"
    if (!mentionedUsername && prompt) {
      const leadingMention = prompt.match(/^@([A-Za-z0-9_]{5,32})(?:\s+([\s\S]+))?$/u)
      if (leadingMention && sameTelegramUsername(telegramBotUsername(bot), leadingMention[1])) {
        prompt = leadingMention[2]?.trim()
        triggerType = "ask_command_mention"
      }
    }
    if (!prompt) {
      return null
    }
    return {
      prompt,
      triggerType,
    }
  }
  if (!text.startsWith("/") && isReplyToThisBot(bot, message)) {
    return {
      prompt: text,
      triggerType: "reply_to_bot",
    }
  }
  return null
}

function telegramAttachmentFileId(attachment: TelegramWebhookAudioAttachment | undefined): string | null {
  const fileId = attachment?.file_id
  return typeof fileId === "string" && fileId.trim() ? fileId.trim() : null
}

function telegramAttachmentFileSize(attachment: TelegramWebhookAudioAttachment | undefined): number | null {
  const fileSize = attachment?.file_size
  return typeof fileSize === "number" && Number.isFinite(fileSize) && fileSize >= 0 ? fileSize : null
}

function inferTelegramAudioMimeType(input: {
  explicitMimeType?: string
  fallback: string
  fileName?: string
}): string {
  const explicit = input.explicitMimeType?.trim().toLowerCase()
  if (explicit && explicit !== "application/octet-stream") {
    return explicit
  }
  const name = input.fileName?.trim().toLowerCase() ?? ""
  if (name.endsWith(".oga") || name.endsWith(".ogg") || name.endsWith(".opus")) return "audio/ogg"
  if (name.endsWith(".mp3")) return "audio/mpeg"
  if (name.endsWith(".m4a")) return "audio/x-m4a"
  if (name.endsWith(".wav")) return "audio/wav"
  if (name.endsWith(".webm")) return "audio/webm"
  return input.fallback
}

function parseGroupAssistantVoiceTrigger(bot: Env | TelegramBotCredential, message: TelegramWebhookMessage): TelegramGroupAssistantVoiceTrigger | null {
  if (!isTelegramGroupChat(message.chat?.type) || !isReplyToThisBot(bot, message)) {
    return null
  }
  const voiceFileId = telegramAttachmentFileId(message.voice)
  if (voiceFileId) {
    return {
      fileId: voiceFileId,
      fileName: "telegram-voice.oga",
      fileSize: telegramAttachmentFileSize(message.voice),
      mimeType: inferTelegramAudioMimeType({
        explicitMimeType: message.voice?.mime_type,
        fallback: "audio/ogg",
        fileName: "telegram-voice.oga",
      }),
      triggerType: "reply_to_bot",
    }
  }
  const audioFileId = telegramAttachmentFileId(message.audio)
  if (!audioFileId) {
    return null
  }
  const fileName = typeof message.audio?.file_name === "string" && message.audio.file_name.trim()
    ? message.audio.file_name.trim()
    : "telegram-audio.bin"
  return {
    fileId: audioFileId,
    fileName,
    fileSize: telegramAttachmentFileSize(message.audio),
    mimeType: inferTelegramAudioMimeType({
      explicitMimeType: message.audio?.mime_type,
      fallback: "application/octet-stream",
      fileName,
    }),
    triggerType: "reply_to_bot",
  }
}

function isPrivateChat(type: string | undefined): boolean {
  return type === "private"
}

function isCommunityBot(bot: Env | TelegramCommunityBotCredential): bot is TelegramCommunityBotCredential {
  return "id" in bot
}

function parseDirectAssistantPrompt(bot: TelegramCommunityBotCredential, message: TelegramWebhookMessage): string | null {
  const text = message.text?.trim()
  if (!text) {
    return null
  }
  const commandMatch = text.match(/^\/ask(?:@([A-Za-z0-9_]{5,32}))?(?:\s+([\s\S]+))?$/u)
  if (commandMatch) {
    const mentionedUsername = commandMatch[1]
    if (mentionedUsername && !sameTelegramUsername(telegramBotUsername(bot), mentionedUsername)) {
      return null
    }
    let prompt = commandMatch[2]?.trim()
    if (!mentionedUsername && prompt) {
      const leadingMention = prompt.match(/^@([A-Za-z0-9_]{5,32})(?:\s+([\s\S]+))?$/u)
      if (leadingMention && sameTelegramUsername(telegramBotUsername(bot), leadingMention[1])) {
        prompt = leadingMention[2]?.trim()
      }
    }
    return prompt || null
  }
  if (text.startsWith("/")) {
    return null
  }
  return text
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

function communityTelegramJoinUrl(env: Env, communityId: string): string | null {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
  return origin ? `${origin}/tg/c/${publicCommunityId(communityId)}` : null
}

function directAssistantLinkText(input: {
  env: Env
  communityId: string
  reason: "unlinked" | "not_member"
}): string {
  const url = communityTelegramJoinUrl(input.env, input.communityId)
  const body = input.reason === "unlinked"
    ? "Open Pirate to link this Telegram account before messaging the community assistant."
    : "Open Pirate to join or verify for this community before messaging the assistant."
  return url ? `${body}\n${url}` : body
}

async function sendDirectAssistantOnboardingPrompt(input: {
  env: Env
  bot: TelegramCommunityBotCredential
  chatId: string
  telegramUserId: string
  reason: "unlinked" | "not_member"
}): Promise<void> {
  try {
    const intent = await createTelegramOnboardingIntent({
      env: input.env,
      communityId: input.bot.communityId,
      telegramCommunityBotId: input.bot.id,
      telegramUserId: input.telegramUserId,
      privateChatId: input.chatId,
      source: "dm",
    })
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: input.reason === "unlinked"
        ? "Open Pirate to link this Telegram account before messaging the community assistant."
        : "Open Pirate to join or verify for this community before messaging the assistant.",
      reply_markup: telegramOnboardingWebAppReplyMarkup(intent.web_app_url),
    })
  } catch {
    await safeSendTelegramMessage(input.bot, {
      chat_id: input.chatId,
      text: directAssistantLinkText({
        env: input.env,
        communityId: input.bot.communityId,
        reason: input.reason,
      }),
    })
  }
}

function directAssistantFailureMessage(error: unknown): string {
  if (error instanceof HttpError && error.status === 404) {
    return "Community assistant is not enabled. In Pirate, open Mod > Assistant, turn it on, and save settings before messaging this bot."
  }
  if (error instanceof HttpError && error.status === 400) {
    return "Community assistant is missing required setup. In Pirate, check Mod > Assistant for the OpenRouter key, model, and saved assistant settings."
  }
  if (error instanceof HttpError && error.status === 429) {
    return "Community assistant is rate limited right now. Try again later."
  }
  if (error instanceof HttpError && error.status === 502) {
    return "The assistant model provider failed to respond. Try again, or choose a different model in Pirate under Mod > Assistant."
  }
  return "Community assistant is unavailable right now. Try again later."
}

function telegramRouteErrorLogFields(error: unknown): Record<string, unknown> {
  return {
    error: error instanceof Error ? error.message : String(error),
    errorName: error instanceof Error ? error.name : null,
    httpStatus: error instanceof HttpError ? error.status : null,
    httpCode: error instanceof HttpError ? error.code : null,
  }
}

async function safeSendTelegramMessage(
  bot: Env | TelegramBotCredential,
  body: Parameters<typeof sendTelegramMessage>[1],
): Promise<boolean> {
  try {
    await sendTelegramMessage(bot, body)
    return true
  } catch (error) {
    console.warn("[telegram-webhook] sendMessage failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function safeSendTelegramVoice(
  bot: Env | TelegramBotCredential,
  body: Parameters<typeof sendTelegramVoice>[1],
): Promise<boolean> {
  try {
    await sendTelegramVoice(bot, body)
    return true
  } catch (error) {
    console.warn("[telegram-webhook] sendVoice failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

function telegramFileNameFromPath(filePath: string | undefined, fallback: string): string {
  const name = filePath?.split("/").pop()?.trim()
  return name || fallback
}

async function transcribeTelegramGroupAssistantVoice(input: {
  env: Env
  bot: Env | TelegramCommunityBotCredential
  telegramChatId: string
  trigger: TelegramGroupAssistantVoiceTrigger
}): Promise<string | null> {
  const linkedChat = await getTelegramLinkedChatBotContext({
    env: input.env,
    telegramChatId: input.telegramChatId,
  })
  if (!linkedChat) {
    return null
  }

  if (
    input.trigger.fileSize !== null
    && input.trigger.fileSize > COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES
  ) {
    throw badRequestError("audio file must be at most 20MB")
  }

  const telegramFile = await getTelegramFile(input.bot, input.trigger.fileId)
  const fileSize = typeof telegramFile.file_size === "number" && Number.isFinite(telegramFile.file_size)
    ? telegramFile.file_size
    : input.trigger.fileSize
  if (fileSize !== null && fileSize > COMMUNITY_ASSISTANT_MAX_TRANSCRIPTION_AUDIO_BYTES) {
    throw badRequestError("audio file must be at most 20MB")
  }
  if (!telegramFile.file_path?.trim()) {
    throw badRequestError("Telegram audio file is not available")
  }

  const download = await downloadTelegramFile(input.bot, telegramFile.file_path)
  const fileName = telegramFileNameFromPath(telegramFile.file_path, input.trigger.fileName)
  const mimeType = inferTelegramAudioMimeType({
    explicitMimeType: input.trigger.mimeType === "application/octet-stream"
      ? download.contentType ?? undefined
      : input.trigger.mimeType,
    fallback: download.contentType ?? input.trigger.mimeType,
    fileName,
  })
  const transcript = await transcribeCommunityAssistantAudioForCommunity({
    env: input.env,
    communityRepository: getCommunityRepository(input.env),
    communityId: linkedChat.communityId,
    file: new File([download.bytes], fileName, { type: mimeType }),
  })
  const prompt = transcript.text.trim()
  return prompt || null
}

async function maybeSendTelegramAssistantVoiceReply(input: {
  answerText: string
  bot: Env | TelegramCommunityBotCredential
  env: Env
  message: TelegramWebhookMessage
  telegramChatId: string
}): Promise<boolean> {
  const linkedChat = await getTelegramLinkedChatBotContext({
    env: input.env,
    telegramChatId: input.telegramChatId,
  })
  if (!linkedChat) {
    return false
  }
  const communityRepository = getCommunityRepository(input.env)
  let policy
  try {
    policy = await getCommunityAssistantRuntimePolicyForCommunity({
      env: input.env,
      communityRepository,
      communityId: linkedChat.communityId,
    })
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return false
    }
    throw error
  }
  if (
    policy.voiceMode !== "voice_replies"
    || policy.ttsProvider !== "elevenlabs"
    || !policy.ttsVoice.trim()
  ) {
    return false
  }

  let speech
  try {
    speech = await synthesizeCommunityAssistantSpeechForCommunity({
      env: input.env,
      communityRepository,
      communityId: linkedChat.communityId,
      outputFormat: TELEGRAM_ELEVENLABS_TTS_OUTPUT_FORMAT,
      text: input.answerText,
    })
  } catch (error) {
    console.warn("[telegram-webhook] assistant TTS failed", {
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }

  return safeSendTelegramVoice(input.bot, {
    chat_id: input.telegramChatId,
    ...(typeof input.message.message_thread_id === "number" ? { message_thread_id: input.message.message_thread_id } : {}),
    voice: new File([speech.audio], "assistant-reply.ogg", {
      type: speech.contentType || "audio/ogg",
    }),
    reply_parameters: {
      message_id: input.message.message_id!,
    },
  })
}

async function telegramUserCanAccessCommunity(input: {
  env: Env
  communityId: string
  userId: string
}): Promise<boolean> {
  const communityRepository = getCommunityRepository(input.env)
  const db = await openCommunityDb(input.env, communityRepository, input.communityId)
  try {
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    return canAccessCommunity(membership)
  } finally {
    db.close()
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

async function handleStartMessage(env: Env, message: TelegramWebhookMessage, bot: Env | TelegramCommunityBotCredential = env): Promise<void> {
  const chatId = telegramIdentifier(message.chat?.id)
  const telegramUserId = telegramIdentifier(message.from?.id)
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
  const setupToken = parseStartToken(message.text)
  if (!setupToken || !telegramUserId) {
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: "Start Telegram setup from Pirate first.",
    })
    return
  }

  try {
    const setupRequest = await prepareTelegramSetupChatRequest({
      env,
      setupToken,
      telegramCommunityBotId: "id" in bot ? bot.id : null,
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

  const prompt = parseDirectAssistantPrompt(bot, message)
  if (!prompt) {
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
    await sendDirectAssistantOnboardingPrompt({
      env,
      bot,
      chatId,
      telegramUserId,
      reason: "unlinked",
    })
    return
  }

  const canAccess = await telegramUserCanAccessCommunity({
    env,
    communityId: bot.communityId,
    userId: account.userId,
  })
  if (!canAccess) {
    await sendDirectAssistantOnboardingPrompt({
      env,
      bot,
      chatId,
      telegramUserId,
      reason: "not_member",
    })
    return
  }

  try {
    const answer = await sendCommunityAssistantTelegramDirectMessage({
      env,
      communityRepository: getCommunityRepository(env),
      communityId: bot.communityId,
      userId: account.userId,
      message: prompt,
    })
    await safeSendTelegramMessage(bot, {
      chat_id: chatId,
      text: telegramText(answer.assistant_message.content),
    })
  } catch (error) {
    console.warn("[telegram-assistant] direct prompt failed", {
      ...telegramRouteErrorLogFields(error),
      communityId: bot.communityId,
      promptLength: prompt.length,
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
    telegramMessageId: message.message_id,
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
  })
  if (sentVoiceReply) {
    return
  }
  await safeSendTelegramMessage(bot, {
    chat_id: chatId,
    ...(typeof message.message_thread_id === "number" ? { message_thread_id: message.message_thread_id } : {}),
    text: answer.text,
    reply_parameters: {
      message_id: message.message_id,
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
