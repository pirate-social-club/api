import type { Env } from "../../env"
import { codedConflictError, badRequestError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Transaction } from "../sql-client"

const LINK_INTENT_TTL_MS = 15 * 60 * 1000
const TELEGRAM_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000

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

async function telegramSourceIsTriviallyEmpty(
  tx: Transaction,
  sourceUserId: string,
  providerSubject: string,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - TELEGRAM_ORPHAN_MAX_AGE_MS).toISOString()
  const result = await tx.execute({
    sql: `
      SELECT u.user_id
      FROM users u
      JOIN profiles p ON p.user_id = u.user_id
      JOIN global_handles gh
        ON gh.global_handle_id = p.global_handle_id
       AND gh.user_id = u.user_id
      WHERE u.user_id = ?1
        AND u.created_at >= ?3
        AND u.verification_state = 'unverified'
        AND u.primary_wallet_attachment_id IS NULL
        AND p.display_name IS NULL
        AND p.bio IS NULL
        AND p.avatar_ref IS NULL
        AND p.cover_ref IS NULL
        AND p.primary_linked_handle_id IS NULL
        AND gh.tier = 'generated'
        AND gh.issuance_source = 'generated_signup'
        AND gh.status = 'active'
        AND (SELECT COUNT(*) FROM auth_provider_links apl
             WHERE apl.user_id = u.user_id AND apl.status = 'active') = 1
        AND EXISTS (
          SELECT 1 FROM auth_provider_links apl
          WHERE apl.user_id = u.user_id
            AND apl.provider = 'telegram'
            AND apl.provider_subject = ?2
            AND apl.status = 'active'
        )
        AND NOT EXISTS (SELECT 1 FROM wallet_attachments wa WHERE wa.user_id = u.user_id)
        AND NOT EXISTS (SELECT 1 FROM linked_handles lh WHERE lh.user_id = u.user_id)
        AND NOT EXISTS (SELECT 1 FROM communities c WHERE c.creator_user_id = u.user_id)
        AND NOT EXISTS (
          SELECT 1 FROM community_post_projections cpp WHERE cpp.author_user_id = u.user_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM community_membership_projections cmp
          WHERE cmp.user_id = u.user_id AND cmp.membership_state IN ('member', 'pending_request')
        )
        AND NOT EXISTS (
          SELECT 1 FROM community_follow_projections cfp
          WHERE cfp.user_id = u.user_id AND cfp.follow_state = 'active'
        )
      LIMIT 1
    `,
    args: [sourceUserId, providerSubject, cutoff],
  })
  return result.rows.length === 1
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
  const tx = await client.transaction("write")
  const now = nowIso()
  try {
    const selected = await tx.execute({
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
      const targetTelegram = await tx.execute({
        sql: `
          SELECT 1
          FROM (
            SELECT user_id FROM auth_provider_links
            WHERE provider = 'telegram' AND status = 'active'
            UNION ALL
            SELECT user_id FROM telegram_accounts
          ) telegram_identity
          WHERE user_id = ?1
          LIMIT 1
        `,
        args: [input.targetUserId],
      })
      const sourceIsEmpty = await telegramSourceIsTriviallyEmpty(
        tx,
        intent.sourceUserId,
        intent.providerSubject,
      )
      if (targetTelegram.rows.length > 0 || !sourceIsEmpty) {
        await tx.execute({
          sql: `
            UPDATE telegram_account_link_intents
            SET status = 'refused',
                refusal_code = 'established_identity_conflict',
                updated_at = ?2
            WHERE link_intent_id = ?1 AND status = 'pending'
          `,
          args: [intent.id, now],
        })
        await tx.commit()
        console.warn("[telegram-account-link] refused established identity conflict", {
          linkIntentId: intent.id,
          sourceUserId: intent.sourceUserId,
          targetUserId: input.targetUserId,
        })
        throw codedConflictError(
          "telegram_account_link_conflict",
          "These accounts cannot be linked automatically because one already has activity",
        )
      }

      await tx.execute({
        sql: `
          UPDATE auth_provider_links
          SET user_id = ?2, updated_at = ?3
          WHERE user_id = ?1
            AND provider = 'telegram'
            AND provider_subject = ?4
            AND status = 'active'
        `,
        args: [intent.sourceUserId, input.targetUserId, now, intent.providerSubject],
      })
      await tx.execute({
        sql: `
          UPDATE telegram_accounts
          SET user_id = ?2, updated_at = ?3
          WHERE telegram_user_id = ?4 AND user_id = ?1
        `,
        args: [intent.sourceUserId, input.targetUserId, now, intent.telegramUserId],
      })
      await tx.execute({
        sql: `
          UPDATE global_handles
          SET status = 'retired', replaced_at = ?2, updated_at = ?2
          WHERE user_id = ?1
            AND status = 'active'
            AND tier = 'generated'
            AND issuance_source = 'generated_signup'
        `,
        args: [intent.sourceUserId, now],
      })
    }

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
