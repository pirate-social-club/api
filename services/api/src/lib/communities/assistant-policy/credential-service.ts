import type { ActorContext, AdminActorContext } from "../../auth-middleware"
import { badRequestError } from "../../errors"
import { executeFirst } from "../../db-helpers"
import { makeId, nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import { numberOrNull, rowValue, stringOrNull } from "../../sql-row"
import { withTransaction } from "../../transactions"
import { resolveCredentialWrapKey, resolveCredentialWrapKeyVersion } from "../../crypto/credential-wrap-key"
import type {
  AssistantElevenLabsKeyStatus,
  AssistantOpenRouterKeyStatus,
  AssistantProviderKeyStatus,
} from "./validation"
import {
  decryptElevenLabsKey,
  decryptOpenRouterKey,
  encryptElevenLabsKey,
  encryptOpenRouterKey,
  normalizeElevenLabsKey,
  normalizeOpenRouterKey,
} from "./credential-crypto"
import {
  requireAssistantOwnerOrAdminAccess,
  type CommunityAssistantRepository,
} from "./access"
import type { Env } from "../../../env"

export type CommunityAssistantCredentialProvider = "openrouter" | "elevenlabs"

const OPENROUTER_PROVIDER = "openrouter" as const
const ELEVENLABS_PROVIDER = "elevenlabs" as const

export type CommunityAssistantCredentialResponse =
  | {
    object: "community_assistant_credential"
    provider: "openrouter"
    keyStatus: AssistantOpenRouterKeyStatus
    openRouterKeyStatus: AssistantOpenRouterKeyStatus
  }
  | {
    object: "community_assistant_credential"
    provider: "elevenlabs"
    keyStatus: AssistantElevenLabsKeyStatus
    elevenLabsKeyStatus: AssistantElevenLabsKeyStatus
  }

type CommunityAssistantCredentialRow = {
  community_assistant_credential_id: string
  community_id: string
  provider: CommunityAssistantCredentialProvider
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
  if (
    (provider !== OPENROUTER_PROVIDER && provider !== ELEVENLABS_PROVIDER)
    || !["active", "revoked", "invalid"].includes(String(status))
  ) {
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

function normalizeProvider(value: unknown): CommunityAssistantCredentialProvider {
  if (value == null || value === "") {
    return OPENROUTER_PROVIDER
  }
  if (value === OPENROUTER_PROVIDER || value === ELEVENLABS_PROVIDER) {
    return value
  }
  throw badRequestError("assistant credential provider must be openrouter or elevenlabs")
}

function normalizeCredentialKey(provider: CommunityAssistantCredentialProvider, apiKey: unknown): string {
  if (typeof apiKey !== "string") {
    throw badRequestError(provider === OPENROUTER_PROVIDER
      ? "OpenRouter API key is required"
      : "ElevenLabs API key is required")
  }
  return provider === OPENROUTER_PROVIDER
    ? normalizeOpenRouterKey(apiKey)
    : normalizeElevenLabsKey(apiKey)
}

function encryptCredentialKey(input: {
  plaintextKey: string
  provider: CommunityAssistantCredentialProvider
  wrapKey: string
}): string {
  return input.provider === OPENROUTER_PROVIDER
    ? encryptOpenRouterKey({ plaintextKey: input.plaintextKey, wrapKey: input.wrapKey })
    : encryptElevenLabsKey({ plaintextKey: input.plaintextKey, wrapKey: input.wrapKey })
}

function decryptCredentialKey(input: {
  encryptedSecret: string
  encryptionKeyVersion: number
  provider: CommunityAssistantCredentialProvider
  wrapKey: string
}): string {
  return input.provider === OPENROUTER_PROVIDER
    ? decryptOpenRouterKey({
      encryptedSecret: input.encryptedSecret,
      encryptionKeyVersion: input.encryptionKeyVersion,
      wrapKey: input.wrapKey,
    })
    : decryptElevenLabsKey({
      encryptedSecret: input.encryptedSecret,
      encryptionKeyVersion: input.encryptionKeyVersion,
      wrapKey: input.wrapKey,
    })
}

function credentialResponse(
  provider: CommunityAssistantCredentialProvider,
  keyStatus: AssistantProviderKeyStatus,
): CommunityAssistantCredentialResponse {
  return provider === OPENROUTER_PROVIDER
    ? {
      object: "community_assistant_credential",
      provider,
      keyStatus,
      openRouterKeyStatus: keyStatus,
    }
    : {
      object: "community_assistant_credential",
      provider,
      keyStatus,
      elevenLabsKeyStatus: keyStatus,
    }
}

async function readCredential(input: {
  env: Env
  communityId: string
  provider: CommunityAssistantCredentialProvider
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
    args: [input.communityId, input.provider, input.status],
  })
  return serializeCredentialRow(row)
}

export async function getCommunityAssistantCredentialStatus(input: {
  env: Env
  communityId: string
  provider: CommunityAssistantCredentialProvider
}): Promise<AssistantProviderKeyStatus> {
  const active = await readCredential({
    env: input.env,
    communityId: input.communityId,
    provider: input.provider,
    status: "active",
  })
  if (active) {
    return {
      kind: "connected",
      last4: active.key_last4,
      ...(active.created_at ? { connectedAt: active.created_at } : {}),
    }
  }

  const invalid = await readCredential({
    env: input.env,
    communityId: input.communityId,
    provider: input.provider,
    status: "invalid",
  })
  if (invalid) {
    return {
      kind: "invalid",
      last4: invalid.key_last4,
      message: input.provider === OPENROUTER_PROVIDER
        ? "OpenRouter rejected this key."
        : "ElevenLabs rejected this key.",
    }
  }

  return { kind: "missing" }
}

export async function getCommunityOpenRouterKeyStatus(input: {
  env: Env
  communityId: string
}): Promise<AssistantOpenRouterKeyStatus> {
  return getCommunityAssistantCredentialStatus({
    ...input,
    provider: OPENROUTER_PROVIDER,
  })
}

export async function getCommunityElevenLabsKeyStatus(input: {
  env: Env
  communityId: string
}): Promise<AssistantElevenLabsKeyStatus> {
  return getCommunityAssistantCredentialStatus({
    ...input,
    provider: ELEVENLABS_PROVIDER,
  })
}

export async function saveCommunityAssistantCredential(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  apiKey: unknown
  provider?: unknown
}): Promise<CommunityAssistantCredentialResponse> {
  await requireAssistantOwnerOrAdminAccess({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })
  const provider = normalizeProvider(input.provider)
  const plaintextKey = normalizeCredentialKey(provider, input.apiKey)
  console.info("[community-assistant-credential] save:start", {
    communityId: input.communityId,
    provider,
    actorUserId: input.actor.userId,
  })

  const wrapKey = resolveCredentialWrapKey(input.env)
  const encryptionKeyVersion = resolveCredentialWrapKeyVersion(input.env)
  const encryptedSecret = encryptCredentialKey({ plaintextKey, provider, wrapKey })
  const keyLast4 = plaintextKey.slice(-4)
  const now = nowIso()
  const client = getControlPlaneClient(input.env)
  await withTransaction(client, "write", async (tx) => {
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
      args: [input.communityId, provider],
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
        args: [input.communityId, provider, now],
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
        provider,
        encryptedSecret,
        keyLast4,
        encryptionKeyVersion,
        now,
        existing?.community_assistant_credential_id ?? null,
        input.actor.userId,
      ],
    })

  })

  console.info("[community-assistant-credential] save:success", {
    communityId: input.communityId,
    provider,
    actorUserId: input.actor.userId,
    last4: keyLast4,
  })

  return credentialResponse(provider, {
    kind: "connected",
    last4: keyLast4,
    connectedAt: now,
  })
}

export async function decryptActiveCommunityAssistantCredential(input: {
  env: Env
  communityId: string
  provider: CommunityAssistantCredentialProvider
}): Promise<string> {
  const active = await readCredential({
    env: input.env,
    communityId: input.communityId,
    provider: input.provider,
    status: "active",
  })
  if (!active) {
    throw badRequestError(input.provider === OPENROUTER_PROVIDER
      ? "OpenRouter API key is required before chatting with the community assistant"
      : "ElevenLabs API key is required before using assistant voice")
  }

  return decryptCredentialKey({
    encryptedSecret: active.encrypted_secret,
    encryptionKeyVersion: active.encryption_key_version,
    provider: input.provider,
    wrapKey: resolveCredentialWrapKey(input.env),
  })
}

export async function decryptActiveCommunityOpenRouterKey(input: {
  env: Env
  communityId: string
}): Promise<string> {
  return decryptActiveCommunityAssistantCredential({
    ...input,
    provider: OPENROUTER_PROVIDER,
  })
}

export async function decryptActiveCommunityElevenLabsKey(input: {
  env: Env
  communityId: string
}): Promise<string> {
  return decryptActiveCommunityAssistantCredential({
    ...input,
    provider: ELEVENLABS_PROVIDER,
  })
}

export async function revokeCommunityAssistantCredential(input: {
  env: Env
  communityRepository: CommunityAssistantRepository
  communityId: string
  actor: ActorContext | AdminActorContext
  provider?: unknown
}): Promise<CommunityAssistantCredentialResponse> {
  await requireAssistantOwnerOrAdminAccess({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor: input.actor,
  })

  const provider = normalizeProvider(input.provider)
  console.info("[community-assistant-credential] revoke:start", {
    communityId: input.communityId,
    provider,
    actorUserId: input.actor.userId,
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
    args: [input.communityId, provider, nowIso()],
  })

  console.info("[community-assistant-credential] revoke:success", {
    communityId: input.communityId,
    provider,
    actorUserId: input.actor.userId,
  })

  return credentialResponse(provider, { kind: "missing" })
}
