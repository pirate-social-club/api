import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { CommunityRow } from "../auth/auth-db-rows"
import { sha256Hex } from "../crypto"
import { executeFirst } from "../db-helpers"
import { badRequestError, conflictError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { publicCommunityId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client, Transaction } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { isCommunityLive } from "../communities/community-status"
import type { CommunityReadRepository } from "../communities/db-community-repository"
import type { Env } from "../../env"

const DEFAULT_SETUP_INTENT_TTL_SECONDS = 10 * 60
const SETUP_TOKEN_PREFIX = "tgsetup"

type TelegramLinkedChatLinkMode = "invite_link" | "join_request"
export type TelegramBotAdminStatus =
  | "unknown"
  | "ready"
  | "missing"
  | "insufficient_permissions"
  | "left_chat"
export type TelegramChatType = "group" | "supergroup"

type TelegramSetupIntentStatus = "pending" | "completed" | "expired" | "canceled"
type TelegramLinkedChatStatus = "active" | "unlinked"

type TelegramSetupIntentRow = {
  telegram_setup_intent_id: string
  telegram_community_bot_id: string | null
  community_id: string
  owner_user_id: string
  setup_token_hash: string
  request_id: number | null
  request_owner_telegram_user_id: string | null
  request_private_chat_id: string | null
  request_message_id: number | null
  request_sent_at: string | null
  status: TelegramSetupIntentStatus
  expires_at: string
  completed_at: string | null
  canceled_at: string | null
  telegram_user_id: string | null
  telegram_chat_id: string | null
  created_at: string
  updated_at: string
}

type TelegramLinkedChatRow = {
  telegram_linked_chat_id: string
  telegram_community_bot_id: string | null
  community_id: string
  telegram_chat_id: string
  chat_title: string
  chat_username: string | null
  chat_type: TelegramChatType
  link_mode: TelegramLinkedChatLinkMode
  bot_admin_status: TelegramBotAdminStatus
  directory_visible: boolean
  status: TelegramLinkedChatStatus
  linked_by_user_id: string
  setup_intent_id: string | null
  linked_at: string
  unlinked_at: string | null
  updated_at: string
}

type TelegramCommunityBotSetupRow = {
  telegram_community_bot_id: string
  bot_username: string
}

export type TelegramSetupIntentResource = {
  id: string
  object: "telegram_setup_intent"
  community: string
  status: TelegramSetupIntentStatus
  expires_at: number
  bot_start_parameter: string
  bot_deep_link: string | null
}

export type TelegramLinkedChatResource = {
  id: string
  object: "telegram_linked_chat"
  community: string
  title: string
  username: string | null
  link_mode: TelegramLinkedChatLinkMode
  bot_admin_status: TelegramBotAdminStatus
  directory_visible: boolean
  linked_at: number
}

export type CommunityTelegramChatSettingsResource = {
  id: string
  object: "community_telegram_chat_settings"
  community: string
  linked_chat: TelegramLinkedChatResource | null
}

export type TelegramSetupChatRequestResource = {
  id: string
  object: "telegram_setup_chat_request"
  community: string
  request_id: number
  expires_at: number
}

export type TelegramLinkedChatBotContext = {
  communityId: string
  telegramCommunityBotId: string | null
  telegramChatId: string
  title: string
  username: string | null
  linkMode: TelegramLinkedChatLinkMode
  botAdminStatus: TelegramBotAdminStatus
}

export type CompleteTelegramSetupIntentInput = {
  setup_token?: unknown
  telegram_user?: unknown
  telegram_chat?: unknown
  bot_admin_status?: unknown
}

export type UpdateTelegramChatSettingsInput = {
  link_mode?: unknown
  directory_visible?: unknown
}

type TelegramChatCompletionPayload = {
  setupToken: string
} & TelegramChatCompletion

type TelegramChatCompletion = {
  telegramCommunityBotId?: string | null
  telegramUserId: string | null
  telegramChatId: string
  chatTitle: string
  chatUsername: string | null
  chatType: TelegramChatType
  botAdminStatus: TelegramBotAdminStatus
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function unixSecondsFromIso(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : nowSeconds()
}

function ttlSeconds(env: Env): number {
  const parsed = Number(env.TELEGRAM_SETUP_INTENT_TTL_SECONDS)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SETUP_INTENT_TTL_SECONDS
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function makeSetupToken(): string {
  return `${SETUP_TOKEN_PREFIX}_${randomHex(16)}`
}

function makeTelegramRequestId(): number {
  const data = new Int32Array(1)
  crypto.getRandomValues(data)
  return data[0] === 0 ? 1 : data[0]
}

async function setupTokenHash(setupToken: string): Promise<string> {
  return await sha256Hex(`telegram-setup:${setupToken}`)
}

function buildBotDeepLink(usernameInput: string | null, setupToken: string): string | null {
  const username = usernameInput?.trim().replace(/^@/, "")
  if (!username || !/^[A-Za-z0-9_]{5,32}$/u.test(username)) {
    return null
  }
  const url = new URL(`https://t.me/${username}`)
  url.searchParams.set("start", setupToken)
  return url.toString()
}

function normalizeLinkMode(value: unknown): TelegramLinkedChatLinkMode {
  if (value === "invite_link" || value === "join_request") {
    return value
  }
  throw badRequestError("link_mode is invalid")
}

function normalizeOptionalLinkMode(value: unknown): TelegramLinkedChatLinkMode | null {
  if (value === undefined || value === null) {
    return null
  }
  return normalizeLinkMode(value)
}

function normalizeBotAdminStatus(value: unknown): TelegramBotAdminStatus {
  if (
    value === "unknown"
    || value === "ready"
    || value === "missing"
    || value === "insufficient_permissions"
    || value === "left_chat"
  ) {
    return value
  }
  if (value === undefined || value === null) {
    return "unknown"
  }
  throw badRequestError("bot_admin_status is invalid")
}

function normalizeChatType(value: unknown): TelegramChatType {
  if (value === "group" || value === "supergroup") {
    return value
  }
  throw badRequestError("telegram_chat.type must be group or supergroup")
}

function normalizeNonEmptyString(value: unknown, field: string): string {
  const normalized = typeof value === "number" || typeof value === "bigint"
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : ""
  if (!normalized) {
    throw badRequestError(`${field} is required`)
  }
  return normalized
}

function normalizeOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value !== "string") {
    throw badRequestError(`${field} is invalid`)
  }
  const trimmed = value.trim()
  return trimmed || null
}

function normalizeOptionalIdentifier(value: unknown, field: string): string | null {
  if (value === undefined || value === null) {
    return null
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value)
  }
  return normalizeOptionalString(value, field)
}

function normalizeSetupToken(value: unknown): string {
  const setupToken = normalizeNonEmptyString(value, "setup_token")
  if (!setupToken.startsWith(`${SETUP_TOKEN_PREFIX}_`)) {
    throw badRequestError("setup_token is invalid")
  }
  return setupToken
}

function normalizeCompletionPayload(body: CompleteTelegramSetupIntentInput | null): TelegramChatCompletionPayload {
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid Telegram setup completion payload")
  }
  const telegramChat = body.telegram_chat && typeof body.telegram_chat === "object"
    ? body.telegram_chat as Record<string, unknown>
    : null
  if (!telegramChat) {
    throw badRequestError("telegram_chat is required")
  }
  const telegramUser = body.telegram_user && typeof body.telegram_user === "object"
    ? body.telegram_user as Record<string, unknown>
    : null
  return {
    setupToken: normalizeSetupToken(body.setup_token),
    telegramUserId: telegramUser ? normalizeOptionalIdentifier(telegramUser.id, "telegram_user.id") : null,
    telegramChatId: normalizeNonEmptyString(telegramChat.id, "telegram_chat.id"),
    chatTitle: normalizeNonEmptyString(telegramChat.title, "telegram_chat.title"),
    chatUsername: normalizeOptionalString(telegramChat.username, "telegram_chat.username"),
    chatType: normalizeChatType(telegramChat.type),
    botAdminStatus: normalizeBotAdminStatus(body.bot_admin_status),
  }
}

function normalizeUpdatePayload(body: UpdateTelegramChatSettingsInput | null): {
  linkMode: TelegramLinkedChatLinkMode | null
  directoryVisible: boolean | null
} {
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid Telegram chat settings payload")
  }
  const linkMode = normalizeOptionalLinkMode(body.link_mode)
  let directoryVisible: boolean | null = null
  if (body.directory_visible !== undefined && body.directory_visible !== null) {
    if (typeof body.directory_visible !== "boolean") {
      throw badRequestError("directory_visible must be a boolean")
    }
    directoryVisible = body.directory_visible
  }
  if (linkMode === null && directoryVisible === null) {
    throw badRequestError("No Telegram chat settings were provided")
  }
  return { linkMode, directoryVisible }
}

function toSetupIntentRow(row: unknown): TelegramSetupIntentRow | null {
  if (!row || typeof row !== "object") return null
  const requestId = rowValue(row, "request_id")
  const requestMessageId = rowValue(row, "request_message_id")
  return {
    telegram_setup_intent_id: String(rowValue(row, "telegram_setup_intent_id") ?? ""),
    telegram_community_bot_id: stringOrNull(rowValue(row, "telegram_community_bot_id")),
    community_id: String(rowValue(row, "community_id") ?? ""),
    owner_user_id: String(rowValue(row, "owner_user_id") ?? ""),
    setup_token_hash: String(rowValue(row, "setup_token_hash") ?? ""),
    request_id: requestId == null ? null : Number(requestId),
    request_owner_telegram_user_id: stringOrNull(rowValue(row, "request_owner_telegram_user_id")),
    request_private_chat_id: stringOrNull(rowValue(row, "request_private_chat_id")),
    request_message_id: requestMessageId == null ? null : Number(requestMessageId),
    request_sent_at: stringOrNull(rowValue(row, "request_sent_at")),
    status: String(rowValue(row, "status") ?? "pending") as TelegramSetupIntentStatus,
    expires_at: String(rowValue(row, "expires_at") ?? ""),
    completed_at: stringOrNull(rowValue(row, "completed_at")),
    canceled_at: stringOrNull(rowValue(row, "canceled_at")),
    telegram_user_id: stringOrNull(rowValue(row, "telegram_user_id")),
    telegram_chat_id: stringOrNull(rowValue(row, "telegram_chat_id")),
    created_at: String(rowValue(row, "created_at") ?? ""),
    updated_at: String(rowValue(row, "updated_at") ?? ""),
  }
}

function toLinkedChatRow(row: unknown): TelegramLinkedChatRow | null {
  if (!row || typeof row !== "object") return null
  return {
    telegram_linked_chat_id: String(rowValue(row, "telegram_linked_chat_id") ?? ""),
    telegram_community_bot_id: stringOrNull(rowValue(row, "telegram_community_bot_id")),
    community_id: String(rowValue(row, "community_id") ?? ""),
    telegram_chat_id: String(rowValue(row, "telegram_chat_id") ?? ""),
    chat_title: String(rowValue(row, "chat_title") ?? ""),
    chat_username: stringOrNull(rowValue(row, "chat_username")),
    chat_type: String(rowValue(row, "chat_type") ?? "group") as TelegramChatType,
    link_mode: String(rowValue(row, "link_mode") ?? "join_request") as TelegramLinkedChatLinkMode,
    bot_admin_status: String(rowValue(row, "bot_admin_status") ?? "unknown") as TelegramBotAdminStatus,
    directory_visible: Number(rowValue(row, "directory_visible") ?? 0) === 1,
    status: String(rowValue(row, "status") ?? "active") as TelegramLinkedChatStatus,
    linked_by_user_id: String(rowValue(row, "linked_by_user_id") ?? ""),
    setup_intent_id: stringOrNull(rowValue(row, "setup_intent_id")),
    linked_at: String(rowValue(row, "linked_at") ?? ""),
    unlinked_at: stringOrNull(rowValue(row, "unlinked_at")),
    updated_at: String(rowValue(row, "updated_at") ?? ""),
  }
}

function serializeLinkedChat(row: TelegramLinkedChatRow): TelegramLinkedChatResource {
  return {
    id: row.telegram_linked_chat_id,
    object: "telegram_linked_chat",
    community: publicCommunityId(row.community_id),
    title: row.chat_title,
    username: row.chat_username,
    link_mode: row.link_mode,
    bot_admin_status: row.bot_admin_status,
    directory_visible: row.directory_visible,
    linked_at: unixSecondsFromIso(row.linked_at),
  }
}

function serializeSettings(input: {
  communityId: string
  linkedChat: TelegramLinkedChatRow | null
}): CommunityTelegramChatSettingsResource {
  return {
    id: `ctgs_${input.communityId}`,
    object: "community_telegram_chat_settings",
    community: publicCommunityId(input.communityId),
    linked_chat: input.linkedChat ? serializeLinkedChat(input.linkedChat) : null,
  }
}

async function getLiveCommunity(
  repository: Pick<CommunityReadRepository, "getCommunityById">,
  communityId: string,
): Promise<CommunityRow> {
  const community = await repository.getCommunityById(communityId)
  if (!isCommunityLive(community)) {
    throw notFoundError("Community not found")
  }
  return community
}

export async function requireOwnedTelegramCommunity(input: {
  repository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<CommunityRow> {
  const community = await getLiveCommunity(input.repository, input.communityId)
  if ("adminOverride" in input.actor || community.creator_user_id === input.actor.userId) {
    return community
  }
  throw notFoundError("Community not found")
}

async function getActiveLinkedChat(
  client: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  communityId: string,
): Promise<TelegramLinkedChatRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT telegram_linked_chat_id, community_id, telegram_chat_id, chat_title, chat_username,
             chat_type, link_mode, bot_admin_status, directory_visible, status, linked_by_user_id,
             setup_intent_id, telegram_community_bot_id, linked_at, unlinked_at, updated_at
      FROM telegram_linked_chats
      WHERE community_id = ?1
        AND status = 'active'
      LIMIT 1
    `,
    args: [communityId],
  })
  return toLinkedChatRow(row)
}

async function getActiveLinkedChatByTelegramChatId(
  client: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  telegramChatId: string,
): Promise<TelegramLinkedChatRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT telegram_linked_chat_id, community_id, telegram_chat_id, chat_title, chat_username,
             chat_type, link_mode, bot_admin_status, directory_visible, status, linked_by_user_id,
             setup_intent_id, telegram_community_bot_id, linked_at, unlinked_at, updated_at
      FROM telegram_linked_chats
      WHERE telegram_chat_id = ?1
        AND status = 'active'
      LIMIT 1
    `,
    args: [telegramChatId],
  })
  return toLinkedChatRow(row)
}

async function getActiveTelegramCommunityBotForSetup(
  client: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  communityId: string,
): Promise<TelegramCommunityBotSetupRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT telegram_community_bot_id, bot_username
      FROM telegram_community_bots
      WHERE community_id = ?1
        AND status = 'active'
      ORDER BY created_at DESC, telegram_community_bot_id DESC
      LIMIT 1
    `,
    args: [communityId],
  })
  if (!row) return null
  return {
    telegram_community_bot_id: String(rowValue(row, "telegram_community_bot_id") ?? ""),
    bot_username: String(rowValue(row, "bot_username") ?? ""),
  }
}

async function getSetupIntentByTokenHash(
  client: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  tokenHash: string,
): Promise<TelegramSetupIntentRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT telegram_setup_intent_id, telegram_community_bot_id, community_id, owner_user_id, setup_token_hash, status,
             request_id, request_owner_telegram_user_id, request_private_chat_id,
             request_message_id, request_sent_at,
             expires_at, completed_at, canceled_at, telegram_user_id, telegram_chat_id, created_at, updated_at
      FROM telegram_setup_intents
      WHERE setup_token_hash = ?1
      LIMIT 1
    `,
    args: [tokenHash],
  })
  return toSetupIntentRow(row)
}

async function getSetupIntentByRequest(
  client: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  input: {
    requestId: number
    telegramUserId: string
    privateChatId: string
  },
): Promise<TelegramSetupIntentRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT telegram_setup_intent_id, telegram_community_bot_id, community_id, owner_user_id, setup_token_hash, status,
             request_id, request_owner_telegram_user_id, request_private_chat_id,
             request_message_id, request_sent_at,
             expires_at, completed_at, canceled_at, telegram_user_id, telegram_chat_id, created_at, updated_at
      FROM telegram_setup_intents
      WHERE request_id = ?1
        AND request_owner_telegram_user_id = ?2
        AND request_private_chat_id = ?3
        AND status = 'pending'
      LIMIT 1
    `,
    args: [input.requestId, input.telegramUserId, input.privateChatId],
  })
  return toSetupIntentRow(row)
}

async function requireLiveCommunityForSetupIntent(
  client: Pick<Client, "execute"> | Pick<Transaction, "execute">,
  communityId: string,
): Promise<void> {
  const row = await executeFirst(client, {
    sql: `
      SELECT status, provisioning_state
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })
  const status = rowValue(row, "status")
  const provisioningState = rowValue(row, "provisioning_state")
  if (status !== "active" || provisioningState !== "active") {
    throw notFoundError("Community not found")
  }
}

async function upsertTelegramSetupOwnerAccount(input: {
  tx: Transaction
  telegramUserId: string
  userId: string
  now: string
}): Promise<void> {
  await input.tx.execute({
    sql: `
      DELETE FROM telegram_accounts
      WHERE telegram_user_id = ?1
         OR user_id = ?2
    `,
    args: [input.telegramUserId, input.userId],
  })
  await input.tx.execute({
    sql: `
      INSERT INTO telegram_accounts (
        telegram_user_id, user_id, username, first_name, last_name, photo_url,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        ?1, ?2, NULL, NULL, NULL, NULL,
        ?3, ?3, ?3
      )
    `,
    args: [input.telegramUserId, input.userId, input.now],
  })
}

async function completePendingTelegramSetupIntent(input: {
  tx: Transaction
  intent: TelegramSetupIntentRow
  payload: TelegramChatCompletion
  now: string
}): Promise<TelegramLinkedChatResource> {
  await requireLiveCommunityForSetupIntent(input.tx, input.intent.community_id)

  const existingChat = await getActiveLinkedChatByTelegramChatId(input.tx, input.payload.telegramChatId)
  if (existingChat && existingChat.community_id !== input.intent.community_id) {
    throw conflictError("Telegram chat is already linked to another community")
  }

  await input.tx.execute({
    sql: `
      UPDATE telegram_linked_chats
      SET status = 'unlinked',
          unlinked_at = ?2,
          updated_at = ?2
      WHERE community_id = ?1
        AND status = 'active'
    `,
    args: [input.intent.community_id, input.now],
  })

  const linkedChatId = makeId("tlc")
  await input.tx.execute({
    sql: `
      INSERT INTO telegram_linked_chats (
        telegram_linked_chat_id, telegram_community_bot_id, community_id, telegram_chat_id, chat_title, chat_username,
        chat_type, link_mode, bot_admin_status, directory_visible, status, linked_by_user_id,
        setup_intent_id, linked_at, unlinked_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, 'join_request', ?8, 1, 'active', ?9,
        ?10, ?11, NULL, ?11
      )
    `,
    args: [
      linkedChatId,
      input.intent.telegram_community_bot_id,
      input.intent.community_id,
      input.payload.telegramChatId,
      input.payload.chatTitle,
      input.payload.chatUsername,
      input.payload.chatType,
      input.payload.botAdminStatus,
      input.intent.owner_user_id,
      input.intent.telegram_setup_intent_id,
      input.now,
    ],
  })

  await input.tx.execute({
    sql: `
      UPDATE telegram_setup_intents
      SET status = 'completed',
          completed_at = ?2,
          telegram_user_id = ?3,
          telegram_chat_id = ?4,
          updated_at = ?2
      WHERE telegram_setup_intent_id = ?1
    `,
    args: [
      input.intent.telegram_setup_intent_id,
      input.now,
      input.payload.telegramUserId,
      input.payload.telegramChatId,
    ],
  })

  if (input.payload.telegramUserId) {
    await upsertTelegramSetupOwnerAccount({
      tx: input.tx,
      telegramUserId: input.payload.telegramUserId,
      userId: input.intent.owner_user_id,
      now: input.now,
    })
  }

  const linkedChat = await getActiveLinkedChat(input.tx, input.intent.community_id)
  if (!linkedChat) {
    throw conflictError("Telegram chat link was not created")
  }
  return serializeLinkedChat(linkedChat)
}

async function completeTelegramSetupIntentWithLookup(input: {
  env: Env
  payload: TelegramChatCompletion
  lookup: (tx: Transaction) => Promise<TelegramSetupIntentRow | null>
}): Promise<TelegramLinkedChatResource> {
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  let transactionCommitted = false
  try {
    const intent = await input.lookup(tx)
    if (!intent) {
      throw notFoundError("Telegram setup intent not found")
    }
    if (intent.status !== "pending") {
      throw conflictError("Telegram setup intent is no longer pending")
    }
    if (
      input.payload.telegramCommunityBotId
      && intent.telegram_community_bot_id
      && input.payload.telegramCommunityBotId !== intent.telegram_community_bot_id
    ) {
      throw notFoundError("Telegram setup intent not found")
    }
    const now = nowIso()
    if (Date.parse(intent.expires_at) <= Date.now()) {
      await tx.execute({
        sql: `
          UPDATE telegram_setup_intents
          SET status = 'expired',
              updated_at = ?2
          WHERE telegram_setup_intent_id = ?1
        `,
        args: [intent.telegram_setup_intent_id, now],
      })
      await tx.commit()
      transactionCommitted = true
      throw conflictError("Telegram setup intent expired")
    }

    const linkedChat = await completePendingTelegramSetupIntent({
      tx,
      intent,
      payload: input.payload,
      now,
    })
    await tx.commit()
    transactionCommitted = true
    return linkedChat
  } catch (error) {
    if (!transactionCommitted) {
      await tx.rollback().catch(() => undefined)
    }
    throw error
  } finally {
    tx.close()
  }
}

export async function getCommunityTelegramChatSettings(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<CommunityTelegramChatSettingsResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const linkedChat = await getActiveLinkedChat(getControlPlaneClient(input.env), community.community_id)
  return serializeSettings({
    communityId: community.community_id,
    linkedChat,
  })
}

export async function getTelegramLinkedChatBotContext(input: {
  env: Env
  telegramChatId: string
}): Promise<TelegramLinkedChatBotContext | null> {
  const linkedChat = await getActiveLinkedChatByTelegramChatId(
    getControlPlaneClient(input.env),
    input.telegramChatId,
  )
  return linkedChat
    ? {
        communityId: linkedChat.community_id,
        telegramCommunityBotId: linkedChat.telegram_community_bot_id,
        telegramChatId: linkedChat.telegram_chat_id,
        title: linkedChat.chat_title,
        username: linkedChat.chat_username,
        linkMode: linkedChat.link_mode,
        botAdminStatus: linkedChat.bot_admin_status,
      }
    : null
}

export async function createTelegramSetupIntent(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<TelegramSetupIntentResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const setupToken = makeSetupToken()
  const tokenHash = await setupTokenHash(setupToken)
  const createdAt = nowIso()
  const expiresAt = new Date(Date.now() + ttlSeconds(input.env) * 1000).toISOString()
  const setupIntentId = makeId("tsi")
  const activeBot = await getActiveTelegramCommunityBotForSetup(getControlPlaneClient(input.env), community.community_id)
  if (!activeBot) {
    throw badRequestError("Save a community Telegram bot token before connecting a chat")
  }

  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_setup_intents (
        telegram_setup_intent_id, telegram_community_bot_id, community_id, owner_user_id, setup_token_hash, status,
        expires_at, completed_at, canceled_at, telegram_user_id, telegram_chat_id, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'pending', ?6, NULL, NULL, NULL, NULL, ?7, ?7
      )
    `,
    args: [
      setupIntentId,
      activeBot.telegram_community_bot_id,
      community.community_id,
      community.creator_user_id,
      tokenHash,
      expiresAt,
      createdAt,
    ],
  })

  return {
    id: setupIntentId,
    object: "telegram_setup_intent",
    community: publicCommunityId(community.community_id),
    status: "pending",
    expires_at: unixSecondsFromIso(expiresAt),
    bot_start_parameter: setupToken,
    bot_deep_link: buildBotDeepLink(activeBot.bot_username, setupToken),
  }
}

export async function prepareTelegramSetupChatRequest(input: {
  env: Env
  setupToken: string
  telegramCommunityBotId?: string | null
  telegramUserId: string
  privateChatId: string
  requestMessageId: number | null
}): Promise<TelegramSetupChatRequestResource> {
  const setupToken = normalizeSetupToken(input.setupToken)
  const tokenHash = await setupTokenHash(setupToken)
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  let transactionCommitted = false
  try {
    const intent = await getSetupIntentByTokenHash(tx, tokenHash)
    if (!intent) {
      throw notFoundError("Telegram setup intent not found")
    }
    if (intent.status !== "pending") {
      throw conflictError("Telegram setup intent is no longer pending")
    }
    if (
      input.telegramCommunityBotId
      && intent.telegram_community_bot_id
      && input.telegramCommunityBotId !== intent.telegram_community_bot_id
    ) {
      throw notFoundError("Telegram setup intent not found")
    }
    const now = nowIso()
    if (Date.parse(intent.expires_at) <= Date.now()) {
      await tx.execute({
        sql: `
          UPDATE telegram_setup_intents
          SET status = 'expired',
              updated_at = ?2
          WHERE telegram_setup_intent_id = ?1
        `,
        args: [intent.telegram_setup_intent_id, now],
      })
      await tx.commit()
      transactionCommitted = true
      throw conflictError("Telegram setup intent expired")
    }
    await requireLiveCommunityForSetupIntent(tx, intent.community_id)

    const requestId = makeTelegramRequestId()
    await upsertTelegramSetupOwnerAccount({
      tx,
      telegramUserId: input.telegramUserId,
      userId: intent.owner_user_id,
      now,
    })
    await tx.execute({
      sql: `
        UPDATE telegram_setup_intents
        SET request_id = ?2,
            request_owner_telegram_user_id = ?3,
            request_private_chat_id = ?4,
            request_message_id = ?5,
            request_sent_at = ?6,
            updated_at = ?6
        WHERE telegram_setup_intent_id = ?1
      `,
      args: [
        intent.telegram_setup_intent_id,
        requestId,
        input.telegramUserId,
        input.privateChatId,
        input.requestMessageId,
        now,
      ],
    })

    await tx.commit()
    transactionCommitted = true
    return {
      id: `tsr_${intent.telegram_setup_intent_id}`,
      object: "telegram_setup_chat_request",
      community: publicCommunityId(intent.community_id),
      request_id: requestId,
      expires_at: unixSecondsFromIso(intent.expires_at),
    }
  } catch (error) {
    if (!transactionCommitted) {
      await tx.rollback().catch(() => undefined)
    }
    throw error
  } finally {
    tx.close()
  }
}

export async function completeTelegramSetupIntent(input: {
  env: Env
  body: CompleteTelegramSetupIntentInput | null
}): Promise<TelegramLinkedChatResource> {
  const payload = normalizeCompletionPayload(input.body)
  const tokenHash = await setupTokenHash(payload.setupToken)
  return completeTelegramSetupIntentWithLookup({
    env: input.env,
    payload,
    lookup: (tx) => getSetupIntentByTokenHash(tx, tokenHash),
  })
}

export async function completeTelegramSetupIntentByRequest(input: {
  env: Env
  telegramCommunityBotId?: string | null
  requestId: number
  telegramUserId: string
  privateChatId: string
  telegramChatId: string
  chatTitle: string
  chatUsername: string | null
  chatType: TelegramChatType
  botAdminStatus: TelegramBotAdminStatus
}): Promise<TelegramLinkedChatResource> {
  return completeTelegramSetupIntentWithLookup({
    env: input.env,
    payload: {
      telegramCommunityBotId: input.telegramCommunityBotId,
      telegramUserId: input.telegramUserId,
      telegramChatId: normalizeNonEmptyString(input.telegramChatId, "telegram_chat.id"),
      chatTitle: normalizeNonEmptyString(input.chatTitle, "telegram_chat.title"),
      chatUsername: input.chatUsername,
      chatType: input.chatType,
      botAdminStatus: input.botAdminStatus,
    },
    lookup: (tx) => getSetupIntentByRequest(tx, {
      requestId: input.requestId,
      telegramUserId: input.telegramUserId,
      privateChatId: input.privateChatId,
    }),
  })
}

export async function updateCommunityTelegramChatSettings(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
  body: UpdateTelegramChatSettingsInput | null
}): Promise<CommunityTelegramChatSettingsResource> {
  const payload = normalizeUpdatePayload(input.body)
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const client = getControlPlaneClient(input.env)
  const linkedChat = await getActiveLinkedChat(client, community.community_id)
  if (!linkedChat) {
    throw notFoundError("Telegram chat not linked")
  }
  const now = nowIso()
  await client.execute({
    sql: `
      UPDATE telegram_linked_chats
      SET link_mode = ?2,
          directory_visible = ?3,
          updated_at = ?4
      WHERE telegram_linked_chat_id = ?1
        AND status = 'active'
    `,
    args: [
      linkedChat.telegram_linked_chat_id,
      payload.linkMode ?? linkedChat.link_mode,
      (payload.directoryVisible ?? linkedChat.directory_visible) ? 1 : 0,
      now,
    ],
  })
  return serializeSettings({
    communityId: community.community_id,
    linkedChat: await getActiveLinkedChat(client, community.community_id),
  })
}

export async function unlinkCommunityTelegramChat(input: {
  env: Env
  communityRepository: Pick<CommunityReadRepository, "getCommunityById">
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<CommunityTelegramChatSettingsResource> {
  const community = await requireOwnedTelegramCommunity({
    repository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_linked_chats
      SET status = 'unlinked',
          unlinked_at = ?2,
          updated_at = ?2
      WHERE community_id = ?1
        AND status = 'active'
    `,
    args: [community.community_id, now],
  })
  return serializeSettings({
    communityId: community.community_id,
    linkedChat: null,
  })
}
