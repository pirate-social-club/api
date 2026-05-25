import { createHash, createHmac, timingSafeEqual } from "node:crypto"
import { sha256Hex } from "../crypto"
import { executeFirst } from "../db-helpers"
import { authError, badRequestError, conflictError, notFoundError, providerUnavailable } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getProfileRepository, getSessionRepository, getUserRepository } from "../auth/repositories"
import { mintPirateAccessToken } from "../auth/pirate-session-token"
import { getCommunityRepository } from "../communities/db-community-repository"
import { getJoinEligibility } from "../communities/membership/eligibility-service"
import { joinCommunity } from "../communities/membership/request-service"
import { publicCommunityId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import type { Env, JoinEligibility, SessionExchangeResponse, UpstreamIdentity } from "../../types"
import type { MembershipResult } from "../communities/membership/types"
import { approveTelegramChatJoinRequest } from "./bot-api"
import {
  decryptCommunityTelegramBotById,
  type TelegramCommunityBotCredential,
} from "./community-bot-service"

const TELEGRAM_ONBOARDING_TOKEN_PREFIX = "tgonboard"
const TELEGRAM_ONBOARDING_TTL_MS = 30 * 60 * 1000
const TELEGRAM_INIT_DATA_MAX_AGE_SECONDS = 24 * 60 * 60

type TelegramOnboardingSource = "dm" | "join_request"
type TelegramOnboardingStatus = "pending" | "completed" | "expired" | "canceled"

type TelegramOnboardingIntentRow = {
  telegram_onboarding_intent_id: string
  community_id: string
  telegram_community_bot_id: string
  onboarding_token_hash: string
  telegram_user_id: string | null
  telegram_private_chat_id: string | null
  join_grant_id: string | null
  source: TelegramOnboardingSource
  status: TelegramOnboardingStatus
  expires_at: string
  completed_at: string | null
  created_at: string
  updated_at: string
}

type TelegramJoinGrantRow = {
  grant_id: string
  community_id: string
  telegram_chat_id: string
  telegram_user_id: string
  status: string
}

type TelegramInitDataUser = {
  id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  photo_url: string | null
}

export type TelegramOnboardingIntentResource = {
  id: string
  object: "telegram_onboarding_intent"
  community: string
  status: TelegramOnboardingStatus
  expires_at: number
  web_app_url: string
}

export type TelegramOnboardingExchangeResponse = SessionExchangeResponse & {
  object: "telegram_onboarding_exchange"
  community: string
  telegram_user_id: string
  eligibility: JoinEligibility
  membership_result: MembershipResult | null
  telegram_join_request: {
    status: "not_applicable" | "approved" | "pending" | "failed"
  }
}

function randomHex(bytes: number): string {
  const data = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(data, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function unixSecondsFromIso(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(Date.now() / 1000)
}

function webOrigin(env: Env): string {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim().replace(/\/+$/u, "")
  if (!origin || !origin.startsWith("https://")) {
    throw badRequestError("PIRATE_WEB_PUBLIC_ORIGIN is required for Telegram onboarding")
  }
  return origin
}

function makeOnboardingToken(): string {
  return `${TELEGRAM_ONBOARDING_TOKEN_PREFIX}_${randomHex(16)}`
}

async function onboardingTokenHash(token: string): Promise<string> {
  if (!token.startsWith(`${TELEGRAM_ONBOARDING_TOKEN_PREFIX}_`)) {
    throw badRequestError("Telegram onboarding token is invalid")
  }
  return await sha256Hex(`telegram-onboarding:${token}`)
}

function serializeIntentRow(row: unknown): TelegramOnboardingIntentRow | null {
  if (!row || typeof row !== "object") return null
  const source = stringOrNull(rowValue(row, "source"))
  const status = stringOrNull(rowValue(row, "status"))
  if (source !== "dm" && source !== "join_request") return null
  if (status !== "pending" && status !== "completed" && status !== "expired" && status !== "canceled") return null
  return {
    telegram_onboarding_intent_id: String(rowValue(row, "telegram_onboarding_intent_id") ?? ""),
    community_id: String(rowValue(row, "community_id") ?? ""),
    telegram_community_bot_id: String(rowValue(row, "telegram_community_bot_id") ?? ""),
    onboarding_token_hash: String(rowValue(row, "onboarding_token_hash") ?? ""),
    telegram_user_id: stringOrNull(rowValue(row, "telegram_user_id")),
    telegram_private_chat_id: stringOrNull(rowValue(row, "telegram_private_chat_id")),
    join_grant_id: stringOrNull(rowValue(row, "join_grant_id")),
    source,
    status,
    expires_at: String(rowValue(row, "expires_at") ?? ""),
    completed_at: stringOrNull(rowValue(row, "completed_at")),
    created_at: String(rowValue(row, "created_at") ?? ""),
    updated_at: String(rowValue(row, "updated_at") ?? ""),
  }
}

function buildWebAppUrl(env: Env, communityId: string, token: string): string {
  const url = new URL("/tg/exchange", webOrigin(env))
  url.searchParams.set("community", publicCommunityId(communityId))
  url.searchParams.set("token", token)
  return url.toString()
}

function serializeIntentResource(input: {
  env: Env
  row: TelegramOnboardingIntentRow
  token: string
}): TelegramOnboardingIntentResource {
  return {
    id: input.row.telegram_onboarding_intent_id,
    object: "telegram_onboarding_intent",
    community: publicCommunityId(input.row.community_id),
    status: input.row.status,
    expires_at: unixSecondsFromIso(input.row.expires_at),
    web_app_url: buildWebAppUrl(input.env, input.row.community_id, input.token),
  }
}

export function telegramOnboardingWebAppReplyMarkup(url: string, label = "Open Pirate"): {
  inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>>
} {
  return {
    inline_keyboard: [[{ text: label, web_app: { url } }]],
  }
}

async function expirePendingOnboardingIntents(client: Pick<Client, "execute">, now: string): Promise<void> {
  await client.execute({
    sql: `
      UPDATE telegram_onboarding_intents
      SET status = 'expired',
          updated_at = ?1
      WHERE status = 'pending'
        AND expires_at <= ?1
    `,
    args: [now],
  })
}

async function cancelSupersededOnboardingIntents(input: {
  client: Pick<Client, "execute">
  communityId: string
  telegramCommunityBotId: string
  telegramUserId: string | null
  privateChatId: string | null
  joinGrantId: string | null
  source: TelegramOnboardingSource
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE telegram_onboarding_intents
      SET status = 'canceled',
          updated_at = ?7
      WHERE community_id = ?1
        AND telegram_community_bot_id = ?2
        AND source = ?3
        AND status = 'pending'
        AND COALESCE(telegram_user_id, '') = COALESCE(?4, '')
        AND COALESCE(telegram_private_chat_id, '') = COALESCE(?5, '')
        AND COALESCE(join_grant_id, '') = COALESCE(?6, '')
    `,
    args: [
      input.communityId,
      input.telegramCommunityBotId,
      input.source,
      input.telegramUserId,
      input.privateChatId,
      input.joinGrantId,
      input.now,
    ],
  })
}

export async function createTelegramOnboardingIntent(input: {
  env: Env
  communityId: string
  telegramCommunityBotId: string
  telegramUserId: string | null
  privateChatId?: string | null
  joinGrantId?: string | null
  source: TelegramOnboardingSource
}): Promise<TelegramOnboardingIntentResource> {
  const token = makeOnboardingToken()
  const tokenHash = await onboardingTokenHash(token)
  const now = nowIso()
  const expiresAt = new Date(Date.now() + TELEGRAM_ONBOARDING_TTL_MS).toISOString()
  const intentId = makeId("toi")
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  try {
    await expirePendingOnboardingIntents(tx, now)
    await cancelSupersededOnboardingIntents({
      client: tx,
      communityId: input.communityId,
      telegramCommunityBotId: input.telegramCommunityBotId,
      telegramUserId: input.telegramUserId,
      privateChatId: input.privateChatId ?? null,
      joinGrantId: input.joinGrantId ?? null,
      source: input.source,
      now,
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_onboarding_intents (
          telegram_onboarding_intent_id, community_id, telegram_community_bot_id,
          onboarding_token_hash, telegram_user_id, telegram_private_chat_id, join_grant_id,
          source, status, expires_at, completed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3,
          ?4, ?5, ?6, ?7,
          ?8, 'pending', ?9, NULL, ?10, ?10
        )
      `,
      args: [
        intentId,
        input.communityId,
        input.telegramCommunityBotId,
        tokenHash,
        input.telegramUserId,
        input.privateChatId ?? null,
        input.joinGrantId ?? null,
        input.source,
        expiresAt,
        now,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }

  return serializeIntentResource({
    env: input.env,
    token,
    row: {
      telegram_onboarding_intent_id: intentId,
      community_id: input.communityId,
      telegram_community_bot_id: input.telegramCommunityBotId,
      onboarding_token_hash: tokenHash,
      telegram_user_id: input.telegramUserId,
      telegram_private_chat_id: input.privateChatId ?? null,
      join_grant_id: input.joinGrantId ?? null,
      source: input.source,
      status: "pending",
      expires_at: expiresAt,
      completed_at: null,
      created_at: now,
      updated_at: now,
    },
  })
}

async function readIntentByToken(input: {
  env: Env
  token: string
}): Promise<TelegramOnboardingIntentRow | null> {
  const row = await executeFirst(getControlPlaneClient(input.env), {
    sql: `
      SELECT telegram_onboarding_intent_id, community_id, telegram_community_bot_id,
             onboarding_token_hash, telegram_user_id, telegram_private_chat_id, join_grant_id,
             source, status, expires_at, completed_at, created_at, updated_at
      FROM telegram_onboarding_intents
      WHERE onboarding_token_hash = ?1
      LIMIT 1
    `,
    args: [await onboardingTokenHash(input.token)],
  })
  return serializeIntentRow(row)
}

function timingSafeStringEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest()
  const rightDigest = createHash("sha256").update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

function parseTelegramInitData(input: {
  initData: unknown
  botToken: string
}): TelegramInitDataUser {
  if (typeof input.initData !== "string" || !input.initData.trim()) {
    throw badRequestError("Telegram initData is required")
  }
  const params = new URLSearchParams(input.initData)
  const hash = params.get("hash")
  if (!hash) {
    throw authError("Telegram initData signature is missing")
  }
  params.delete("hash")
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
  const secretKey = createHmac("sha256", "WebAppData").update(input.botToken).digest()
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex")
  if (!timingSafeStringEqual(expectedHash, hash)) {
    throw authError("Telegram initData signature is invalid")
  }

  const authDateRaw = params.get("auth_date")
  const authDate = authDateRaw ? Number(authDateRaw) : NaN
  if (!Number.isFinite(authDate) || authDate <= 0) {
    throw authError("Telegram initData auth_date is invalid")
  }
  if ((Date.now() / 1000) - authDate > TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) {
    throw authError("Telegram initData is expired")
  }

  const rawUser = params.get("user")
  if (!rawUser) {
    throw authError("Telegram initData user is missing")
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(rawUser) as Record<string, unknown>
  } catch {
    throw authError("Telegram initData user is invalid")
  }
  const userId = parsed.id == null ? null : String(parsed.id)
  if (!userId?.trim()) {
    throw authError("Telegram initData user id is missing")
  }
  return {
    id: userId.trim(),
    username: typeof parsed.username === "string" && parsed.username.trim() ? parsed.username.trim() : null,
    first_name: typeof parsed.first_name === "string" && parsed.first_name.trim() ? parsed.first_name.trim() : null,
    last_name: typeof parsed.last_name === "string" && parsed.last_name.trim() ? parsed.last_name.trim() : null,
    photo_url: typeof parsed.photo_url === "string" && parsed.photo_url.trim() ? parsed.photo_url.trim() : null,
  }
}

async function upsertTelegramAccount(input: {
  client: Client
  telegramUser: TelegramInitDataUser
  userId: string
}): Promise<void> {
  const now = nowIso()
  const tx = await input.client.transaction("write")
  try {
    await tx.execute({
      sql: `
        DELETE FROM telegram_accounts
        WHERE telegram_user_id = ?1
           OR user_id = ?2
      `,
      args: [input.telegramUser.id, input.userId],
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_accounts (
          telegram_user_id, user_id, username, first_name, last_name, photo_url,
          first_seen_at, last_seen_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6,
          ?7, ?7, ?7
        )
      `,
      args: [
        input.telegramUser.id,
        input.userId,
        input.telegramUser.username,
        input.telegramUser.first_name,
        input.telegramUser.last_name,
        input.telegramUser.photo_url,
        now,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

async function readJoinGrant(input: {
  env: Env
  grantId: string
}): Promise<TelegramJoinGrantRow | null> {
  const row = await executeFirst(getControlPlaneClient(input.env), {
    sql: `
      SELECT grant_id, community_id, telegram_chat_id, telegram_user_id, status
      FROM telegram_join_grants
      WHERE grant_id = ?1
      LIMIT 1
    `,
    args: [input.grantId],
  })
  return row
    ? {
        grant_id: String(rowValue(row, "grant_id") ?? ""),
        community_id: String(rowValue(row, "community_id") ?? ""),
        telegram_chat_id: String(rowValue(row, "telegram_chat_id") ?? ""),
        telegram_user_id: String(rowValue(row, "telegram_user_id") ?? ""),
        status: String(rowValue(row, "status") ?? ""),
      }
    : null
}

async function updateJoinGrantStatus(input: {
  env: Env
  grantId: string
  status: "approved" | "failed"
  errorMessage?: string | null
}): Promise<void> {
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_join_grants
      SET status = ?2,
          approved_at = CASE WHEN ?2 = 'approved' THEN ?3 ELSE approved_at END,
          error_message = ?4,
          updated_at = ?3
      WHERE grant_id = ?1
    `,
    args: [input.grantId, input.status, now, input.errorMessage ?? null],
  })
}

async function maybeApproveJoinRequest(input: {
  env: Env
  bot: TelegramCommunityBotCredential
  intent: TelegramOnboardingIntentRow
  membershipResult: MembershipResult | null
  eligibility: JoinEligibility
}): Promise<TelegramOnboardingExchangeResponse["telegram_join_request"]> {
  if (!input.intent.join_grant_id) {
    return { status: "not_applicable" }
  }
  const grant = await readJoinGrant({
    env: input.env,
    grantId: input.intent.join_grant_id,
  })
  if (!grant || grant.status !== "pending") {
    return { status: "pending" }
  }
  const canApprove = input.eligibility.status === "already_joined" || input.membershipResult?.status === "joined"
  if (!canApprove) {
    return { status: "pending" }
  }
  try {
    await approveTelegramChatJoinRequest(input.bot, {
      chat_id: grant.telegram_chat_id,
      user_id: grant.telegram_user_id,
    })
    await updateJoinGrantStatus({
      env: input.env,
      grantId: grant.grant_id,
      status: "approved",
    })
    return { status: "approved" }
  } catch (error) {
    await updateJoinGrantStatus({
      env: input.env,
      grantId: grant.grant_id,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return { status: "failed" }
  }
}

export async function exchangeTelegramOnboardingSession(input: {
  env: Env
  body: { token?: unknown; init_data?: unknown } | null
}): Promise<TelegramOnboardingExchangeResponse> {
  if (!input.body || typeof input.body !== "object") {
    throw badRequestError("Invalid Telegram onboarding exchange payload")
  }
  const token = typeof input.body.token === "string" ? input.body.token.trim() : ""
  const intent = await readIntentByToken({ env: input.env, token })
  if (!intent) {
    throw notFoundError("Telegram onboarding intent not found")
  }
  if (intent.status !== "pending") {
    throw conflictError("Telegram onboarding intent is no longer pending")
  }
  const nowMs = Date.now()
  if (Date.parse(intent.expires_at) <= nowMs) {
    await getControlPlaneClient(input.env).execute({
      sql: `
        UPDATE telegram_onboarding_intents
        SET status = 'expired',
            updated_at = ?2
        WHERE telegram_onboarding_intent_id = ?1
      `,
      args: [intent.telegram_onboarding_intent_id, nowIso()],
    })
    throw conflictError("Telegram onboarding intent expired")
  }

  const bot = await decryptCommunityTelegramBotById({
    env: input.env,
    botId: intent.telegram_community_bot_id,
  })
  if (!bot || bot.communityId !== intent.community_id) {
    throw providerUnavailable("Telegram community bot is not available")
  }

  const telegramUser = parseTelegramInitData({
    initData: input.body.init_data,
    botToken: bot.token,
  })
  if (intent.telegram_user_id && intent.telegram_user_id !== telegramUser.id) {
    throw authError("Telegram onboarding user does not match this intent")
  }

  const identity: UpstreamIdentity = {
    provider: "telegram",
    providerSubject: telegramUser.id,
    providerUserRef: telegramUser.username ?? telegramUser.id,
    walletAddresses: [],
    selectedWalletAddress: null,
    wallets: [],
    selectedWallet: null,
  }
  const session = await getSessionRepository(input.env).exchangeIdentity(identity)
  const userId = session.user.id.replace(/^usr_/, "")
  await upsertTelegramAccount({
    client: getControlPlaneClient(input.env),
    telegramUser,
    userId,
  })

  const communityRepository = getCommunityRepository(input.env)
  const userRepository = getUserRepository(input.env)
  const eligibility = await getJoinEligibility({
    env: input.env,
    userId,
    communityId: intent.community_id,
    userRepository,
    communityRepository,
  })
  let membershipResult: MembershipResult | null = null
  if (eligibility.joinable_now) {
    membershipResult = await joinCommunity({
      env: input.env,
      userId,
      communityId: intent.community_id,
      userRepository,
      communityRepository,
    })
  }

  const telegramJoinRequest = await maybeApproveJoinRequest({
    env: input.env,
    bot,
    intent,
    eligibility,
    membershipResult,
  })

  const completedAt = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_onboarding_intents
      SET status = 'completed',
          completed_at = ?2,
          updated_at = ?2
      WHERE telegram_onboarding_intent_id = ?1
    `,
    args: [intent.telegram_onboarding_intent_id, completedAt],
  })

  const syncedProfile = await getProfileRepository(input.env)
    .syncLinkedHandles(userId)
    .catch(() => null)
  const accessToken = await mintPirateAccessToken({
    env: input.env,
    userId,
  })

  return {
    object: "telegram_onboarding_exchange",
    community: publicCommunityId(intent.community_id),
    telegram_user_id: telegramUser.id,
    access_token: accessToken,
    ...session,
    profile: syncedProfile ?? session.profile,
    eligibility,
    membership_result: membershipResult,
    telegram_join_request: telegramJoinRequest,
  }
}
