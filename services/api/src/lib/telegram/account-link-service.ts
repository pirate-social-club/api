import type { Env } from "../../env"
import { codedConflictError, badRequestError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import { mergeTelegramAccountIntoCanonical } from "./account-merge-service"

const LINK_INTENT_TTL_MS = 15 * 60 * 1000

function randomToken(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return Buffer.from(digest).toString("hex")
}

function publicWebOrigin(env: Env): string {
  const origin = env.PIRATE_WEB_PUBLIC_ORIGIN?.trim()
  if (!origin) throw badRequestError("PIRATE_WEB_PUBLIC_ORIGIN is required")
  return origin.replace(/\/+$/u, "")
}

export async function createTelegramAccountLinkIntent(input: {
  env: Env
  sourceUserId: string
  communityId: string
}): Promise<{ expires_at: string; link_url: string }> {
  const client = getControlPlaneClient(input.env)
  const identity = await client.execute({
    sql: `
      SELECT
        ta.telegram_user_id,
        apl.provider_subject,
        tcb.telegram_community_bot_id
      FROM telegram_accounts ta
      JOIN auth_provider_links apl
        ON apl.user_id = ta.user_id
       AND apl.provider = 'telegram'
       AND apl.provider_subject = ta.telegram_user_id
       AND apl.status = 'active'
      JOIN telegram_community_bots tcb
        ON tcb.community_id = ?2
       AND tcb.status = 'active'
      WHERE ta.user_id = ?1
      LIMIT 1
    `,
    args: [input.sourceUserId, input.communityId],
  })
  const row = identity.rows[0]
  const telegramUserId = stringOrNull(rowValue(row, "telegram_user_id"))
  const providerSubject = stringOrNull(rowValue(row, "provider_subject"))
  const botId = stringOrNull(rowValue(row, "telegram_community_bot_id"))
  if (!telegramUserId || !providerSubject || !botId) {
    throw codedConflictError(
      "telegram_account_link_unavailable",
      "A Telegram-authenticated session from this community bot is required",
    )
  }

  const token = randomToken()
  const tokenHash = await hashToken(token)
  const now = nowIso()
  const expiresAt = new Date(Date.now() + LINK_INTENT_TTL_MS).toISOString()
  const tx = await client.transaction("write")
  try {
    await tx.execute({
      sql: `
        UPDATE telegram_account_link_intents
        SET status = 'canceled', updated_at = ?2
        WHERE telegram_provider_subject = ?1
          AND status = 'pending'
      `,
      args: [providerSubject, now],
    })
    await tx.execute({
      sql: `
        INSERT INTO telegram_account_link_intents (
          link_intent_id, token_hash, source_user_id, telegram_user_id,
          telegram_provider_subject, telegram_community_bot_id, status,
          expires_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?4, ?5, 'pending', ?6, ?7, ?7)
      `,
      args: [makeId("tli"), tokenHash, input.sourceUserId, telegramUserId, botId, expiresAt, now],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  }

  return {
    expires_at: expiresAt,
    link_url: `${publicWebOrigin(input.env)}/telegram/account-link?token=${encodeURIComponent(token)}`,
  }
}

type LinkIntent = {
  id: string
  sourceUserId: string
  telegramUserId: string
  providerSubject: string
}

function readLinkIntent(row: unknown): LinkIntent | null {
  const id = stringOrNull(rowValue(row, "link_intent_id"))
  const sourceUserId = stringOrNull(rowValue(row, "source_user_id"))
  const telegramUserId = stringOrNull(rowValue(row, "telegram_user_id"))
  const providerSubject = stringOrNull(rowValue(row, "telegram_provider_subject"))
  return id && sourceUserId && telegramUserId && providerSubject
    ? { id, providerSubject, sourceUserId, telegramUserId }
    : null
}

export async function consumeTelegramAccountLinkIntent(input: {
  env: Env
  targetUserId: string
  token: string
}): Promise<{ linked: true }> {
  const token = input.token.trim()
  if (!token) throw badRequestError("token is required")
  const tokenHash = await hashToken(token)
  const client = getControlPlaneClient(input.env)
  const now = nowIso()
  const selected = await client.execute({
    sql: `
      SELECT link_intent_id, source_user_id, telegram_user_id, telegram_provider_subject
      FROM telegram_account_link_intents
      WHERE token_hash = ?1
        AND status = 'pending'
        AND expires_at > ?2
      LIMIT 1
    `,
    args: [tokenHash, now],
  })
  const intent = readLinkIntent(selected.rows[0])
  if (!intent) {
    throw codedConflictError(
      "telegram_account_link_expired",
      "This Telegram account link has expired or was already used",
    )
  }

  if (intent.sourceUserId !== input.targetUserId) {
    await mergeTelegramAccountIntoCanonical({
      env: input.env,
      linkIntentId: intent.id,
      sourceUserId: intent.sourceUserId,
      canonicalUserId: input.targetUserId,
      providerSubject: intent.providerSubject,
      telegramUserId: intent.telegramUserId,
    })
  }

  const tx = await client.transaction("write")
  try {
    const claimed = await tx.execute({
      sql: `
        UPDATE telegram_account_link_intents
        SET status = 'consumed',
            consumed_by_user_id = ?2,
            consumed_at = ?3,
            updated_at = ?3
        WHERE link_intent_id = ?1 AND status = 'pending'
      `,
      args: [intent.id, input.targetUserId, now],
    })
    if ((claimed.rowsAffected ?? 0) !== 1) {
      throw codedConflictError(
        "telegram_account_link_expired",
        "This Telegram account link was already used",
      )
    }
    await tx.commit()
    return { linked: true }
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  }
}
