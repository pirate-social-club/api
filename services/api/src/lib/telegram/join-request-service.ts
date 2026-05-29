import type { Env } from "../../env"
import { getUserRepository } from "../auth/repositories"
import { getJoinEligibility } from "../communities/membership/eligibility-service"
import type { CommunityMembershipRepository } from "../communities/membership/types"
import { badRequestError, conflictError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { publicCommunityId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import { getTelegramLinkedChatBotContext } from "./community-chat-service"
import type { TelegramMiniAppUser } from "./mini-app-auth"
import {
  createTelegramOnboardingIntent,
  telegramOnboardingWebAppReplyMarkup,
} from "./onboarding-service"

const JOIN_GRANT_TTL_MS = 24 * 60 * 60 * 1000

export type TelegramJoinRequestDecision =
  | {
      action: "approve"
      grantId: string
      telegramChatId: string
      telegramUserId: string
    }
  | {
      action: "prompt"
      grantId: string
      telegramUserChatId: string
      text: string
      replyMarkup?: unknown
    }
  | {
      action: "ignore"
      grantId?: string
    }

export type ResolvedTelegramAccount = {
  userId: string
}

type TelegramJoinMissingCapability =
  | "telegram_account"
  | "unique_human"
  | "age_over_18"
  | "minimum_age"
  | "nationality"
  | "gender"
  | "wallet_score"
  | "altcha_pow"

function webOrigin(env: Env): string {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim()
  if (!origin) {
    throw badRequestError("PIRATE_WEB_PUBLIC_ORIGIN is required for Telegram join prompts")
  }
  return origin.replace(/\/+$/u, "")
}

function communityJoinUrl(env: Env, communityId: string): string {
  return `${webOrigin(env)}/tg/c/${publicCommunityId(communityId)}`
}

function joinRequestDateFromSeconds(value: number | null): string {
  if (value && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString()
  }
  return nowIso()
}

async function upsertResolvedTelegramAccount(input: {
  client: Client
  telegramUserId: string
  userId: string
}): Promise<void> {
  const now = nowIso()
  await input.client.execute({
    sql: `
      DELETE FROM telegram_accounts
      WHERE telegram_user_id = ?1
         OR user_id = ?2
    `,
    args: [input.telegramUserId, input.userId],
  })
  await input.client.execute({
    sql: `
      INSERT INTO telegram_accounts (
        telegram_user_id, user_id, username, first_name, last_name, photo_url,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        ?1, ?2, NULL, NULL, NULL, NULL,
        ?3, ?3, ?3
      )
    `,
    args: [input.telegramUserId, input.userId, now],
  })
}

export async function resolveTelegramAccount(input: {
  env: Env
  telegramUserId: string
}): Promise<ResolvedTelegramAccount | null> {
  const client = getControlPlaneClient(input.env)
  const account = await client.execute({
    sql: `
      SELECT user_id
      FROM telegram_accounts
      WHERE telegram_user_id = ?1
      LIMIT 1
    `,
    args: [input.telegramUserId],
  })
  const accountUserId = stringOrNull(rowValue(account.rows[0], "user_id"))
  if (accountUserId) {
    return { userId: accountUserId }
  }

  const link = await client.execute({
    sql: `
      SELECT user_id
      FROM auth_provider_links
      WHERE provider = 'telegram'
        AND provider_subject = ?1
        AND status = 'active'
      LIMIT 1
    `,
    args: [input.telegramUserId],
  })
  const linkedUserId = stringOrNull(rowValue(link.rows[0], "user_id"))
  if (linkedUserId) {
    return { userId: linkedUserId }
  }

  const setupOwner = await client.execute({
    sql: `
      SELECT owner_user_id
      FROM telegram_setup_intents
      WHERE status = 'completed'
        AND (
          telegram_user_id = ?1
          OR request_owner_telegram_user_id = ?1
        )
      ORDER BY COALESCE(completed_at, updated_at) DESC, telegram_setup_intent_id DESC
      LIMIT 1
    `,
    args: [input.telegramUserId],
  })
  const setupOwnerUserId = stringOrNull(rowValue(setupOwner.rows[0], "owner_user_id"))
  if (!setupOwnerUserId) {
    return null
  }

  await upsertResolvedTelegramAccount({
    client,
    telegramUserId: input.telegramUserId,
    userId: setupOwnerUserId,
  })
  return { userId: setupOwnerUserId }
}

export async function syncTelegramAccountForUser(input: {
  env: Env
  telegramUser: TelegramMiniAppUser
  userId: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  const existingByTelegram = await client.execute({
    sql: `
      SELECT user_id
      FROM telegram_accounts
      WHERE telegram_user_id = ?1
      LIMIT 1
    `,
    args: [input.telegramUser.id],
  })
  const existingTelegramUserId = stringOrNull(rowValue(existingByTelegram.rows[0], "user_id"))
  if (existingTelegramUserId && existingTelegramUserId !== input.userId) {
    throw conflictError("Telegram account is linked to another Pirate user")
  }

  const existingByUser = await client.execute({
    sql: `
      SELECT telegram_user_id
      FROM telegram_accounts
      WHERE user_id = ?1
      LIMIT 1
    `,
    args: [input.userId],
  })
  const existingUserTelegramId = stringOrNull(rowValue(existingByUser.rows[0], "telegram_user_id"))
  if (existingUserTelegramId && existingUserTelegramId !== input.telegramUser.id) {
    throw conflictError("Pirate user is linked to another Telegram account")
  }

  const now = nowIso()
  await client.execute({
    sql: `
      INSERT INTO telegram_accounts (
        telegram_user_id, user_id, username, first_name, last_name, photo_url,
        first_seen_at, last_seen_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?7, ?7
      )
      ON CONFLICT(telegram_user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        photo_url = excluded.photo_url,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `,
    args: [
      input.telegramUser.id,
      input.userId,
      input.telegramUser.username,
      input.telegramUser.firstName,
      input.telegramUser.lastName,
      input.telegramUser.photoUrl,
      now,
    ],
  })
}

export async function linkPendingTelegramJoinGrantsForTelegramUser(input: {
  env: Env
  telegramUserId: string
  userId: string
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_join_grants
      SET user_id = ?2,
          updated_at = ?3
      WHERE telegram_user_id = ?1
        AND user_id IS NULL
        AND status = 'pending'
        AND expires_at > ?3
    `,
    args: [input.telegramUserId, input.userId, nowIso()],
  })
}

async function insertJoinGrant(input: {
  env: Env
  communityId: string
  telegramChatId: string
  telegramUserId: string
  telegramUserChatId: string | null
  userId: string | null
  linkMode: "invite_link" | "join_request"
  missingCapabilitiesJson: string | null
  joinRequestDate: string
  now: string
}): Promise<string> {
  const grantId = makeId("tjg")
  const expiresAt = new Date(Date.parse(input.joinRequestDate) + JOIN_GRANT_TTL_MS).toISOString()
  const existing = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT grant_id
      FROM telegram_join_grants
      WHERE telegram_chat_id = ?1
        AND telegram_user_id = ?2
        AND status = 'pending'
      ORDER BY created_at DESC, grant_id DESC
      LIMIT 1
    `,
    args: [input.telegramChatId, input.telegramUserId],
  })
  const existingGrantId = stringOrNull(rowValue(existing.rows[0], "grant_id"))
  if (existingGrantId) {
    await getControlPlaneClient(input.env).execute({
      sql: `
        UPDATE telegram_join_grants
        SET community_id = ?2,
            telegram_user_chat_id = ?3,
            user_id = ?4,
            link_mode = ?5,
            missing_capabilities_json = ?6,
            join_request_date = ?7,
            expires_at = ?8,
            error_message = NULL,
            updated_at = ?9
        WHERE grant_id = ?1
      `,
      args: [
        existingGrantId,
        input.communityId,
        input.telegramUserChatId,
        input.userId,
        input.linkMode,
        input.missingCapabilitiesJson,
        input.joinRequestDate,
        expiresAt,
        input.now,
      ],
    })
    return existingGrantId
  }
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO telegram_join_grants (
        grant_id, community_id, telegram_chat_id, telegram_user_id, telegram_user_chat_id,
        user_id, link_mode, status, missing_capabilities_json, join_request_date,
        prompted_at, approved_at, expires_at, error_message, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, 'pending', ?8, ?9,
        NULL, NULL, ?10, NULL, ?11, ?11
      )
    `,
    args: [
      grantId,
      input.communityId,
      input.telegramChatId,
      input.telegramUserId,
      input.telegramUserChatId,
      input.userId,
      input.linkMode,
      input.missingCapabilitiesJson,
      input.joinRequestDate,
      expiresAt,
      input.now,
    ],
  })
  return grantId
}

async function updateJoinGrant(input: {
  env: Env
  grantId: string
  status: "pending" | "approved" | "denied" | "failed"
  promptedAt?: string | null
  approvedAt?: string | null
  errorMessage?: string | null
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE telegram_join_grants
      SET status = ?2,
          prompted_at = COALESCE(?3, prompted_at),
          approved_at = COALESCE(?4, approved_at),
          error_message = ?5,
          updated_at = ?6
      WHERE grant_id = ?1
    `,
    args: [
      input.grantId,
      input.status,
      input.promptedAt ?? null,
      input.approvedAt ?? null,
      input.errorMessage ?? null,
      nowIso(),
    ],
  })
}

function promptText(input: {
  env: Env
  communityId: string
  reason: "unmapped" | "verification_required" | "not_joinable"
  missingCapabilities?: TelegramJoinMissingCapability[]
}): string {
  const url = communityJoinUrl(input.env, input.communityId)
  if (input.reason === "unmapped") {
    return `Open Pirate to verify and join this community:\n${url}\n\nIf this link expires, message this bot with /start and try joining the group again.`
  }
  if (input.reason === "verification_required") {
    return `This community requires ${verificationPromptRequirement(input.missingCapabilities ?? [])} before Telegram access can be approved:\n${url}\n\nAfter verification, try joining the group again.`
  }
  return `Pirate cannot approve this Telegram join request yet:\n${url}`
}

function verificationPromptRequirement(missingCapabilities: TelegramJoinMissingCapability[]): string {
  const labels = missingCapabilities
    .map((capability) => {
      switch (capability) {
        case "nationality":
          return "verified nationality"
        case "minimum_age":
        case "age_over_18":
          return "age verification"
        case "gender":
          return "verified gender"
        case "wallet_score":
          return "a Passport wallet score"
        case "unique_human":
          return "human verification"
        case "altcha_pow":
          return "proof-of-work"
        case "telegram_account":
          return "a linked Telegram account"
        default:
          return null
      }
    })
    .filter((label): label is NonNullable<typeof label> => label !== null)
    .filter((label, index, all) => all.indexOf(label) === index)

  if (labels.length === 0) {
    return "verification"
  }
  if (labels.length === 1) {
    return labels[0]!
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`
}

async function promptDecision(input: {
  env: Env
  grantId: string
  telegramUserChatId: string
  communityId: string
  reason: "unmapped" | "verification_required" | "not_joinable"
  missingCapabilities?: TelegramJoinMissingCapability[]
  onboardingWebAppUrl?: string | null
}): Promise<TelegramJoinRequestDecision> {
  try {
    return {
      action: "prompt",
      grantId: input.grantId,
      telegramUserChatId: input.telegramUserChatId,
      text: promptText({
        env: input.env,
        communityId: input.communityId,
        reason: input.reason,
        missingCapabilities: input.missingCapabilities,
      }),
      ...(input.onboardingWebAppUrl
        ? { replyMarkup: telegramOnboardingWebAppReplyMarkup(input.onboardingWebAppUrl, "Open Pirate") }
        : {}),
    }
  } catch (error) {
    await updateJoinGrant({
      env: input.env,
      grantId: input.grantId,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
    })
    return { action: "ignore", grantId: input.grantId }
  }
}

async function createJoinRequestOnboardingUrl(input: {
  env: Env
  communityId: string
  telegramCommunityBotId: string | null
  telegramUserId: string
  telegramUserChatId: string | null
  grantId: string
}): Promise<string | null> {
  if (!input.telegramCommunityBotId) {
    return null
  }
  return await createTelegramOnboardingIntent({
    env: input.env,
    communityId: input.communityId,
    telegramCommunityBotId: input.telegramCommunityBotId,
    telegramUserId: input.telegramUserId,
    privateChatId: input.telegramUserChatId,
    joinGrantId: input.grantId,
    source: "join_request",
  })
    .then((intent) => intent.web_app_url)
    .catch(() => null)
}

export async function evaluateTelegramChatJoinRequest(input: {
  env: Env
  communityRepository: CommunityMembershipRepository
  telegramChatId: string
  telegramUserId: string
  telegramUserChatId: string | null
  joinRequestDate: number | null
  telegramCommunityBotIdForOnboarding?: string | null
}): Promise<TelegramJoinRequestDecision | null> {
  const linkedChat = await getTelegramLinkedChatBotContext({
    env: input.env,
    telegramChatId: input.telegramChatId,
  })
  if (!linkedChat) {
    return null
  }
  const onboardingBotId = input.telegramCommunityBotIdForOnboarding
    && input.telegramCommunityBotIdForOnboarding === linkedChat.telegramCommunityBotId
    ? input.telegramCommunityBotIdForOnboarding
    : null

  const now = nowIso()
  const joinRequestDate = joinRequestDateFromSeconds(input.joinRequestDate)
  const account = await resolveTelegramAccount({
    env: input.env,
    telegramUserId: input.telegramUserId,
  })

  if (!account) {
    const grantId = await insertJoinGrant({
      env: input.env,
      communityId: linkedChat.communityId,
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
      telegramUserChatId: input.telegramUserChatId,
      userId: null,
      linkMode: linkedChat.linkMode,
      missingCapabilitiesJson: JSON.stringify(["telegram_account"]),
      joinRequestDate,
      now,
    })
    if (!input.telegramUserChatId) {
      return { action: "ignore", grantId }
    }
    const onboardingWebAppUrl = await createJoinRequestOnboardingUrl({
      env: input.env,
      communityId: linkedChat.communityId,
      telegramCommunityBotId: onboardingBotId,
      telegramUserId: input.telegramUserId,
      telegramUserChatId: input.telegramUserChatId,
      grantId,
    })
    return promptDecision({
      env: input.env,
      grantId,
      telegramUserChatId: input.telegramUserChatId,
      communityId: linkedChat.communityId,
      reason: "unmapped",
      onboardingWebAppUrl,
    })
  }

  const eligibility = await getJoinEligibility({
    env: input.env,
    userId: account.userId,
    communityId: linkedChat.communityId,
    userRepository: getUserRepository(input.env),
    communityRepository: input.communityRepository,
  })
  const missingCapabilitiesJson = eligibility.missing_capabilities
    ? JSON.stringify(eligibility.missing_capabilities)
    : null
  const missingCapabilities = Array.isArray(eligibility.missing_capabilities)
    ? eligibility.missing_capabilities as TelegramJoinMissingCapability[]
    : []
  const grantId = await insertJoinGrant({
    env: input.env,
    communityId: linkedChat.communityId,
    telegramChatId: input.telegramChatId,
    telegramUserId: input.telegramUserId,
    telegramUserChatId: input.telegramUserChatId,
    userId: account.userId,
    linkMode: linkedChat.linkMode,
    missingCapabilitiesJson,
    joinRequestDate,
    now,
  })

  if (eligibility.status === "already_joined" || eligibility.joinable_now) {
    return {
      action: "approve",
      grantId,
      telegramChatId: input.telegramChatId,
      telegramUserId: input.telegramUserId,
    }
  }

  if (eligibility.status === "banned") {
    await updateJoinGrant({
      env: input.env,
      grantId,
      status: "denied",
      errorMessage: "Pirate user is banned from this community",
    })
    return { action: "ignore", grantId }
  }

  if (!input.telegramUserChatId) {
    return { action: "ignore", grantId }
  }
  const onboardingWebAppUrl = await createJoinRequestOnboardingUrl({
    env: input.env,
    communityId: linkedChat.communityId,
    telegramCommunityBotId: onboardingBotId,
    telegramUserId: input.telegramUserId,
    telegramUserChatId: input.telegramUserChatId,
    grantId,
  })
  return promptDecision({
    env: input.env,
    grantId,
    telegramUserChatId: input.telegramUserChatId,
    communityId: linkedChat.communityId,
    reason: eligibility.status === "verification_required" ? "verification_required" : "not_joinable",
    missingCapabilities,
    onboardingWebAppUrl,
  })
}

export async function markTelegramJoinGrantPrompted(input: {
  env: Env
  grantId: string
}): Promise<void> {
  await updateJoinGrant({
    env: input.env,
    grantId: input.grantId,
    status: "pending",
    promptedAt: nowIso(),
  })
}

export async function markTelegramJoinGrantApproved(input: {
  env: Env
  grantId: string
}): Promise<void> {
  await updateJoinGrant({
    env: input.env,
    grantId: input.grantId,
    status: "approved",
    approvedAt: nowIso(),
  })
}

export async function markTelegramJoinGrantFailed(input: {
  env: Env
  grantId: string
  errorMessage: string
}): Promise<void> {
  await updateJoinGrant({
    env: input.env,
    grantId: input.grantId,
    status: "failed",
    errorMessage: input.errorMessage,
  })
}
