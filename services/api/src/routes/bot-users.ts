import { Hono } from "hono"
import { authenticateAdminTokenOnly } from "../lib/auth-middleware"
import { loadSnapshot } from "../lib/auth/auth-db-user-queries"
import { normalizeDesiredGlobalHandleLabel, isReservedGlobalHandleLabel } from "../lib/auth/global-handle-policy"
import { mintPirateAccessToken } from "../lib/auth/pirate-session-token"
import { buildDefaultVerificationCapabilities } from "../lib/verification/verification-capabilities"
import { badRequestError, conflictError, authError, notFoundError } from "../lib/errors"
import { makeId, nowIso } from "../lib/helpers"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { safeRollback } from "../lib/transactions"
import type { Env } from "../env"
import { optionalTrimmedString } from "./route-helpers"
import { writeAuditEventBestEffortForEnv } from "../lib/audit"
import {
  serializeBotUserProvisionResponse,
  serializeBotUserTokenResponse,
  type BotUserTokenResponse,
} from "../serializers/bot-user"

const botUsers = new Hono<{ Bindings: Env }>()

const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/

function requireAdmin(c: { env: Env; req: { header: (name: string) => string | undefined } }) {
  const admin = authenticateAdminTokenOnly({
    env: c.env,
    token: c.req.header("x-admin-token"),
  })
  if (!admin) {
    throw authError("Authentication failed")
  }
  return admin
}

function requireWalletAddress(value: unknown): `0x${string}` {
  if (typeof value !== "string" || !EVM_ADDRESS_PATTERN.test(value.trim())) {
    throw badRequestError("Invalid wallet_address")
  }
  return value.trim().toLowerCase() as `0x${string}`
}

botUsers.post("/provision", async (c) => {
  const admin = requireAdmin(c)
  const body = await c.req.json<{
    handle?: unknown
    display_name?: unknown
    bio?: unknown
    avatar_ref?: unknown
    cover_ref?: unknown
    wallet_address?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid bot user provision payload")
  }

  if (typeof body.handle !== "string") {
    throw badRequestError("Invalid handle")
  }
  const requestedHandle = normalizeDesiredGlobalHandleLabel(body.handle)
  if (isReservedGlobalHandleLabel(requestedHandle.labelNormalized)) {
    throw badRequestError("Invalid handle")
  }

  const walletAddress = requireWalletAddress(body.wallet_address)
  const displayName = optionalTrimmedString(body.display_name, "display_name") ?? requestedHandle.labelDisplay
  const bio = optionalTrimmedString(body.bio, "bio")
  const avatarRef = optionalTrimmedString(body.avatar_ref, "avatar_ref")
  const coverRef = optionalTrimmedString(body.cover_ref, "cover_ref")
  const providerSubject = `bot:${requestedHandle.labelDisplay}`
  const client = getControlPlaneClient(c.env)
  const tx = await client.transaction("write")
  let userId: string | null = null
  let created = false

  try {
    const existingHandle = await tx.execute({
      sql: `
        SELECT global_handle_id, user_id
        FROM global_handles
        WHERE label_normalized = ?1
          AND status = 'active'
        LIMIT 1
      `,
      args: [requestedHandle.labelNormalized],
    })
    const existingHandleRow = existingHandle.rows[0] as { global_handle_id?: unknown; user_id?: unknown } | undefined

    if (existingHandleRow) {
      const handleUserId = String(existingHandleRow.user_id)
      const botLink = await tx.execute({
        sql: `
          SELECT provider_subject
          FROM auth_provider_links
          WHERE user_id = ?1
            AND provider = 'bot'
            AND status = 'active'
          LIMIT 1
        `,
        args: [handleUserId],
      })
      const providerSubjectValue = String((botLink.rows[0] as { provider_subject?: unknown } | undefined)?.provider_subject ?? "")
      if (providerSubjectValue !== providerSubject) {
        throw conflictError("Handle is already owned by a non-bot user")
      }
      userId = handleUserId
    } else {
      const existingBotLink = await tx.execute({
        sql: `
          SELECT user_id
          FROM auth_provider_links
          WHERE provider = 'bot'
            AND provider_subject = ?1
            AND status = 'active'
          LIMIT 1
        `,
        args: [providerSubject],
      })
      if (existingBotLink.rows.length > 0) {
        throw conflictError("Bot auth link exists without the requested active handle")
      }

      const createdAt = nowIso()
      userId = makeId("usr")
      const globalHandleId = makeId("ghd")

      await tx.execute({
        sql: `
          INSERT INTO users (
            user_id, primary_wallet_attachment_id, verification_state, capability_provider,
            verification_capabilities_json, verified_at, current_verification_session_id, created_at, updated_at
          ) VALUES (?1, NULL, 'unverified', NULL, ?2, NULL, NULL, ?3, ?3)
        `,
        args: [userId, JSON.stringify(buildDefaultVerificationCapabilities()), createdAt],
      })
      await tx.execute({
        sql: `
          INSERT INTO global_handles (
            global_handle_id, user_id, label_normalized, label_display, status, tier, issuance_source,
            redirect_target_global_handle_id, price_paid_usd, free_rename_consumed, issued_at, replaced_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'active', 'standard', 'admin_grant', NULL, NULL, 1, ?5, NULL, ?5, ?5)
        `,
        args: [globalHandleId, userId, requestedHandle.labelNormalized, requestedHandle.labelDisplay, createdAt],
      })
      await tx.execute({
        sql: `
          INSERT INTO profiles (
            user_id, display_name, bio, avatar_ref, cover_ref, global_handle_id, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
        `,
        args: [userId, displayName, bio, avatarRef, coverRef, globalHandleId, createdAt],
      })
      await tx.execute({
        sql: `
          INSERT INTO auth_provider_links (
            auth_provider_link_id, user_id, provider, provider_subject, provider_user_ref,
            status, linked_at, revoked_at, created_at, updated_at
          ) VALUES (?1, ?2, 'bot', ?3, ?3, 'active', ?4, NULL, ?4, ?4)
        `,
        args: [makeId("apl"), userId, providerSubject, createdAt],
      })
      created = true
    }

    const updatedAt = nowIso()
    await tx.execute({
      sql: `
        UPDATE profiles
        SET display_name = ?2,
            bio = ?3,
            avatar_ref = ?4,
            cover_ref = ?5,
            updated_at = ?6
        WHERE user_id = ?1
      `,
      args: [userId, displayName, bio, avatarRef, coverRef, updatedAt],
    })

    const existingWallet = await tx.execute({
      sql: `
        SELECT wallet_attachment_id
        FROM wallet_attachments
        WHERE user_id = ?1
          AND chain_namespace = 'eip155:1'
          AND wallet_address_normalized = ?2
          AND status = 'active'
        LIMIT 1
      `,
      args: [userId, walletAddress],
    })
    const conflictingWallet = await tx.execute({
      sql: `
        SELECT user_id
        FROM wallet_attachments
        WHERE chain_namespace = 'eip155:1'
          AND wallet_address_normalized = ?1
          AND status = 'active'
          AND user_id <> ?2
        LIMIT 1
      `,
      args: [walletAddress, userId],
    })
    if (conflictingWallet.rows.length > 0) {
      throw conflictError("Wallet address is already attached to another user")
    }

    let walletAttachmentId = String((existingWallet.rows[0] as { wallet_attachment_id?: unknown } | undefined)?.wallet_attachment_id ?? "")
    if (!walletAttachmentId) {
      walletAttachmentId = makeId("wal")
      await tx.execute({
        sql: `
          INSERT INTO wallet_attachments (
            wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
            source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
          ) VALUES (?1, ?2, 'eip155:1', ?3, ?3, 'bot', ?4, 'external', 0, 'active', ?5, NULL, ?5, ?5)
        `,
        args: [walletAttachmentId, userId, walletAddress, providerSubject, updatedAt],
      })
    }

    await tx.execute({
      sql: `
        UPDATE wallet_attachments
        SET is_primary = 0,
            updated_at = ?2
        WHERE user_id = ?1
          AND status = 'active'
          AND is_primary = 1
      `,
      args: [userId, updatedAt],
    })
    await tx.execute({
      sql: `
        UPDATE wallet_attachments
        SET is_primary = 1,
            updated_at = ?3
        WHERE user_id = ?1
          AND wallet_attachment_id = ?2
          AND status = 'active'
      `,
      args: [userId, walletAttachmentId, updatedAt],
    })
    await tx.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, walletAttachmentId, updatedAt],
    })

    await tx.commit()
  } catch (error) {
    await safeRollback(tx, "[bot-users] rollback failed while provisioning bot user")
    throw error
  } finally {
    tx.close()
  }

  if (!userId) {
    throw conflictError("Bot user could not be provisioned")
  }

  await writeAuditEventBestEffortForEnv(c.env, {
    action: created ? "bot_user.provisioned" : "bot_user.updated",
    actorId: admin.adminActorId,
    actorType: "operator",
    metadata: {
      handle: requestedHandle.labelDisplay,
      wallet_address: walletAddress,
    },
    targetId: userId,
    targetType: "user",
  }, "[bot-users]")

  const session = await loadSnapshot(client, userId)
  return c.json(serializeBotUserProvisionResponse({
    created,
    user_id: userId,
    handle: requestedHandle.labelDisplay,
    wallet_address: walletAddress,
    ...session,
  }), created ? 201 : 200)
})

async function mintBotTokenResponse(input: {
  adminActorId: string
  env: Env
  userId: string
}): Promise<BotUserTokenResponse> {
  const client = getControlPlaneClient(input.env)
  const link = await client.execute({
    sql: `
      SELECT user_id
      FROM auth_provider_links
      WHERE user_id = ?1
        AND provider = 'bot'
        AND status = 'active'
      LIMIT 1
    `,
    args: [input.userId],
  })
  if (link.rows.length === 0) {
    throw notFoundError("Bot user not found")
  }

  const accessToken = await mintPirateAccessToken({ env: input.env, userId: input.userId })
  await writeAuditEventBestEffortForEnv(input.env, {
    action: "bot_user.token_minted",
    actorId: input.adminActorId,
    actorType: "operator",
    targetId: input.userId,
    targetType: "user",
    metadata: {},
  }, "[bot-users]")

  return {
    access_token: accessToken,
    user_id: input.userId,
    token_type: "Bearer",
  }
}

botUsers.post("/handle/:handle/token", async (c) => {
  const admin = requireAdmin(c)
  const requestedHandle = normalizeDesiredGlobalHandleLabel(c.req.param("handle"))
  const client = getControlPlaneClient(c.env)
  const result = await client.execute({
    sql: `
      SELECT gh.user_id
      FROM global_handles gh
      JOIN auth_provider_links apl
        ON apl.user_id = gh.user_id
       AND apl.provider = 'bot'
       AND apl.status = 'active'
      WHERE gh.label_normalized = ?1
        AND gh.status = 'active'
      LIMIT 1
    `,
    args: [requestedHandle.labelNormalized],
  })
  const userId = String((result.rows[0] as { user_id?: unknown } | undefined)?.user_id ?? "")
  if (!userId) {
    throw notFoundError("Bot user not found")
  }

  return c.json(serializeBotUserTokenResponse(await mintBotTokenResponse({
    adminActorId: admin.adminActorId,
    env: c.env,
    userId,
  })), 200)
})

botUsers.post("/:userId/token", async (c) => {
  const admin = requireAdmin(c)
  const userId = c.req.param("userId").trim()
  if (!userId) {
    throw badRequestError("Invalid user id")
  }

  return c.json(serializeBotUserTokenResponse(await mintBotTokenResponse({
    adminActorId: admin.adminActorId,
    env: c.env,
    userId,
  })), 200)
})

export default botUsers
