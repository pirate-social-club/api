import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import { badRequestError } from "../../errors"
import { executeFirst } from "../../db-helpers"
import { makeId, nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import { numberOrNull, rowValue, stringOrNull } from "../../sql-row"
import { resolveCommunityDbWrapKey, resolveCommunityDbWrapKeyVersion } from "../create/repository"
import type {
  AssistantOpenRouterKeyStatus,
} from "./validation"
import {
  decryptOpenRouterKey,
  encryptOpenRouterKey,
  normalizeOpenRouterKey,
} from "./credential-crypto"
import {
  requireAssistantOwnerOrAdminAccess,
  type CommunityAssistantRepository,
} from "./access"
import type { Env } from "../../../env"

const OPENROUTER_PROVIDER = "openrouter"

export type CommunityAssistantCredentialResponse = {
  object: "community_assistant_credential"
  provider: "openrouter"
  openRouterKeyStatus: AssistantOpenRouterKeyStatus
}

type CommunityAssistantCredentialRow = {
  community_assistant_credential_id: string
  community_id: string
  provider: "openrouter"
  encrypted_secret: string
  key_last4: string
  encryption_key_version: number
  status: "active" | "revoked" | "invalid"
  created_at: string
  revoked_at: string | null
  rotated_from: string | null
  actor_user_id: string
}

function serializeCredentialRow(row: unknown): CommunityAssistantCredentialRow | null {
  if (!row || typeof row !== "object") {
    return null
  }
  const provider = stringOrNull(rowValue(row, "provider"))
  const status = stringOrNull(rowValue(row, "status"))
  if (provider !== OPENROUTER_PROVIDER || !["active", "revoked", "invalid"].includes(String(status))) {
    return null
  }

  return {
    community_assistant_credential_id: String(rowValue(row, "community_assistant_credential_id") || ""),
    community_id: String(rowValue(row, "community_id") || ""),
    provider,
    encrypted_secret: String(rowValue(row, "encrypted_secret") || ""),
    key_last4: String(rowValue(row, "key_last4") || ""),
    encryption_key_version: numberOrNull(rowValue(row, "encryption_key_version")) ?? 1,
    status: status as CommunityAssistantCredentialRow["status"],
    created_at: String(rowValue(row, "created_at") || ""),
    revoked_at: stringOrNull(rowValue(row, "revoked_at")),
    rotated_from: stringOrNull(rowValue(row, "rotated_from")),
    actor_user_id: String(rowValue(row, "actor_user_id") || ""),
  }
}

async function readOpenRouterCredential(input: {
  env: Env
  communityId: string
  status: "active" | "invalid"
}): Promise<CommunityAssistantCredentialRow | null> {
  const client = getControlPlaneClient(input.env)
  const row = await executeFirst(client, {
    sql: `
      SELECT community_assistant_credential_id, community_id, provider, encrypted_secret,
             key_last4, encryption_key_version, status, created_at, revoked_at, rotated_from, actor_user_id
      FROM community_assistant_credentials
      WHERE community_id = ?1
        AND provider = ?2
        AND status = ?3
      ORDER BY created_at DESC, community_assistant_credential_id DESC
      LIMIT 1
    `,
    args: [input.communityId, OPENROUTER_PROVIDER, input.status],
  })
  return serializeCredentialRow(row)
}

export async function getCommunityOpenRouterKeyStatus(input: {
  env: Env
  communityId: string
}): Promise<AssistantOpenRouterKeyStatus> {
  const active = await readOpenRouterCredential({
    env: input.env,
    communityId: input.communityId,
    status: "active",
  })
  if (active) {
    return {
      kind: "connected",
      last4: active.key_last4,
      ...(active.created_at ? { connectedAt: active.created_at } : {}),
    }
  }

  const invalid = await readOpenRouterCredential({
    env: input.env,
    communityId: input.communityId,
    status: "invalid",
  })
  if (invalid) {
    return {
      kind: "invalid",
      last4: invalid.key_last4,
      message: "OpenRouter rejected this key.",
    }
  }

  return { kind: "missing" }
}

export async function saveCommunityAssistantCredential(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  apiKey: unknown
}): Promise<CommunityAssistantCredentialResponse> {
  await requireAssistantOwnerOrAdminAccess({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  if (typeof input.apiKey !== "string") {
    throw badRequestError("OpenRouter API key is required")
  }
  const plaintextKey = normalizeOpenRouterKey(input.apiKey)

  const wrapKey = resolveCommunityDbWrapKey(input.env)
  const encryptionKeyVersion = resolveCommunityDbWrapKeyVersion(input.env)
  const encryptedSecret = encryptOpenRouterKey({ plaintextKey, wrapKey })
  const keyLast4 = plaintextKey.slice(-4)
  const now = nowIso()
  const client = getControlPlaneClient(input.env)
  const tx = await client.transaction("write")
  try {
    const existing = serializeCredentialRow(await executeFirst(tx, {
      sql: `
        SELECT community_assistant_credential_id, community_id, provider, encrypted_secret,
               key_last4, encryption_key_version, status, created_at, revoked_at, rotated_from, actor_user_id
        FROM community_assistant_credentials
        WHERE community_id = ?1
          AND provider = ?2
          AND status = 'active'
        LIMIT 1
      `,
      args: [input.communityId, OPENROUTER_PROVIDER],
    }))

    if (existing) {
      await tx.execute({
        sql: `
          UPDATE community_assistant_credentials
          SET status = 'revoked',
              revoked_at = ?3
          WHERE community_id = ?1
            AND provider = ?2
            AND status = 'active'
        `,
        args: [input.communityId, OPENROUTER_PROVIDER, now],
      })
    }

    await tx.execute({
      sql: `
        INSERT INTO community_assistant_credentials (
          community_assistant_credential_id, community_id, provider, encrypted_secret,
          key_last4, encryption_key_version, status, created_at, revoked_at, rotated_from, actor_user_id
        ) VALUES (
          ?1, ?2, ?3, ?4,
          ?5, ?6, 'active', ?7, NULL, ?8, ?9
        )
      `,
      args: [
        makeId("cac"),
        input.communityId,
        OPENROUTER_PROVIDER,
        encryptedSecret,
        keyLast4,
        encryptionKeyVersion,
        now,
        existing?.community_assistant_credential_id ?? null,
        input.actor.userId,
      ],
    })

    await tx.commit()
  } catch (error) {
    await tx.rollback().catch((rollbackError) => {
      console.error("[community-assistant-credential] rollback failed while saving key", rollbackError)
    })
    throw error
  } finally {
    tx.close()
  }

  return {
    object: "community_assistant_credential",
    provider: OPENROUTER_PROVIDER,
    openRouterKeyStatus: {
      kind: "connected",
      last4: keyLast4,
      connectedAt: now,
    },
  }
}

export async function decryptActiveCommunityOpenRouterKey(input: {
  env: Env
  communityId: string
}): Promise<string> {
  const active = await readOpenRouterCredential({
    env: input.env,
    communityId: input.communityId,
    status: "active",
  })
  if (!active) {
    throw badRequestError("OpenRouter API key is required before chatting with the community assistant")
  }

  return decryptOpenRouterKey({
    encryptedSecret: active.encrypted_secret,
    encryptionKeyVersion: active.encryption_key_version,
    wrapKey: resolveCommunityDbWrapKey(input.env),
  })
}

export async function revokeCommunityAssistantCredential(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
}): Promise<CommunityAssistantCredentialResponse> {
  await requireAssistantOwnerOrAdminAccess({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })

  const client = getControlPlaneClient(input.env)
  await client.execute({
    sql: `
      UPDATE community_assistant_credentials
      SET status = 'revoked',
          revoked_at = ?3
      WHERE community_id = ?1
        AND provider = ?2
        AND status = 'active'
    `,
    args: [input.communityId, OPENROUTER_PROVIDER, nowIso()],
  })

  return {
    object: "community_assistant_credential",
    provider: OPENROUTER_PROVIDER,
    openRouterKeyStatus: { kind: "missing" },
  }
}
