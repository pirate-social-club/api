import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "./db-community-repository"
import { badRequestError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { writeAuditEventForEnv } from "../audit"
import { openCommunityReadClient, openCommunityWriteClient } from "./community-read-access"
import {
  communityMutationActorFromUserId,
  requireOwnedCommunity,
  type CommunityMutationActor,
} from "./create/shared"
import type { CommunityRow } from "../auth/auth-db-rows"
import type { Env } from "../../types"
import type { KaraokeScoringPolicy } from "@pirate/karaoke-runtime"

type CommunityKaraokePolicyRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export type CommunityKaraokePolicy = {
  community_id: string
  karaoke_enabled: boolean
  karaoke_scoring_enabled: boolean
  karaoke_stt_provider: "assistant" | "elevenlabs" | "mistral" | "none" | "openai"
  karaoke_stt_model: string | null
  karaoke_voice_coach_enabled: boolean
  karaoke_audio_retention: "not_stored"
  updated_at: string | null
}

export type CommunityKaraokePolicyPatch = {
  karaoke_enabled?: boolean
  karaoke_scoring_enabled?: boolean
  karaoke_stt_provider?: "assistant" | "elevenlabs" | "mistral" | "none" | "openai"
  karaoke_stt_model?: string | null
  karaoke_voice_coach_enabled?: boolean
  karaoke_audio_retention?: "not_stored"
}

export async function resolveCommunityKaraokeScoringPolicy(input: {
  env: Env
  communityRepository: CommunityKaraokePolicyRepository
  communityId: string
}): Promise<KaraokeScoringPolicy> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT c.karaoke_scoring_enabled, c.karaoke_stt_provider, c.karaoke_stt_model,
               c.karaoke_voice_coach_enabled, c.karaoke_audio_retention,
               p.stt_provider AS assistant_stt_provider, p.stt_model AS assistant_stt_model
        FROM communities c
        LEFT JOIN community_assistant_policy p ON p.community_id = c.community_id
        WHERE c.community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) throw notFoundError("Community not found")
    if (Number(row.karaoke_scoring_enabled ?? 0) !== 1) return { kind: "disabled" }

    const configuredProvider = String(row.karaoke_stt_provider ?? "assistant")
    const provider = configuredProvider === "assistant"
      ? String(row.assistant_stt_provider ?? "elevenlabs")
      : configuredProvider
    if (
      !provider
      || provider === "none"
      || !["assistant", "elevenlabs", "mistral", "openai"].includes(provider)
    ) return { kind: "disabled" }
    const configuredModel = String(row.karaoke_stt_model ?? "").trim()
    const model = configuredModel
      || String(row.assistant_stt_model ?? "").trim()
      || (provider === "elevenlabs" ? "scribe_v2_realtime" : "")
    if (!model || row.karaoke_audio_retention !== "not_stored") return { kind: "disabled" }

    return {
      kind: "enabled",
      model,
      provider: provider as "assistant" | "elevenlabs" | "mistral" | "openai",
      retention: "not_stored",
      voiceCoachEnabled: Number(row.karaoke_voice_coach_enabled ?? 0) === 1,
    }
  } finally {
    db.close()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function assertCommunityKaraokePolicyPatch(body: CommunityKaraokePolicyPatch | null): CommunityKaraokePolicyPatch {
  if (!isRecord(body)) {
    throw badRequestError("Invalid community karaoke policy payload")
  }
  const recognized = [
    "karaoke_enabled",
    "karaoke_scoring_enabled",
    "karaoke_stt_provider",
    "karaoke_stt_model",
    "karaoke_voice_coach_enabled",
    "karaoke_audio_retention",
  ] as const
  if (!recognized.some((field) => field in body)) {
    throw badRequestError("At least one karaoke policy field is required")
  }
  for (const field of ["karaoke_enabled", "karaoke_scoring_enabled", "karaoke_voice_coach_enabled"] as const) {
    if (field in body && typeof body[field] !== "boolean") {
      throw badRequestError(`${field} must be a boolean`)
    }
  }
  if (
    "karaoke_stt_provider" in body
    && !["assistant", "elevenlabs", "mistral", "none", "openai"].includes(String(body.karaoke_stt_provider))
  ) {
    throw badRequestError("karaoke_stt_provider is invalid")
  }
  if (
    "karaoke_stt_model" in body
    && body.karaoke_stt_model !== null
    && (typeof body.karaoke_stt_model !== "string" || !body.karaoke_stt_model.trim() || body.karaoke_stt_model.length > 200)
  ) {
    throw badRequestError("karaoke_stt_model must be null or a non-empty string of at most 200 characters")
  }
  if ("karaoke_audio_retention" in body && body.karaoke_audio_retention !== "not_stored") {
    throw badRequestError("karaoke_audio_retention must be not_stored")
  }

  return body
}

async function readCommunityKaraokePolicy(input: {
  env: Env
  communityRepository: CommunityKaraokePolicyRepository
  communityId: string
}): Promise<CommunityKaraokePolicy> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT karaoke_enabled, karaoke_scoring_enabled, karaoke_stt_provider,
               karaoke_stt_model, karaoke_voice_coach_enabled, karaoke_audio_retention,
               updated_at
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      throw notFoundError("Community not found")
    }

    return {
      community_id: input.communityId,
      karaoke_audio_retention: "not_stored",
      karaoke_enabled: Number(row.karaoke_enabled ?? 0) === 1,
      karaoke_scoring_enabled: Number(row.karaoke_scoring_enabled ?? 0) === 1,
      karaoke_stt_model: typeof row.karaoke_stt_model === "string" && row.karaoke_stt_model.trim()
        ? row.karaoke_stt_model
        : null,
      karaoke_stt_provider: (["assistant", "elevenlabs", "mistral", "none", "openai"].includes(String(row.karaoke_stt_provider))
        ? String(row.karaoke_stt_provider)
        : "assistant") as CommunityKaraokePolicy["karaoke_stt_provider"],
      karaoke_voice_coach_enabled: Number(row.karaoke_voice_coach_enabled ?? 0) === 1,
      updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
    }
  } finally {
    db.close()
  }
}

async function requireKaraokePolicyCommunity(input: {
  communityRepository: CommunityKaraokePolicyRepository
  communityId: string
  actor: CommunityMutationActor
}): Promise<CommunityRow> {
  if ("adminOverride" in input.actor) {
    const community = await input.communityRepository.getCommunityById(input.communityId)
    if (!community) {
      throw notFoundError("Community not found")
    }
    return community
  }

  return requireOwnedCommunity(input.communityRepository, input.communityId, input.actor.userId)
}

export async function getCommunityKaraokePolicy(input: {
  env: Env
  communityRepository: CommunityKaraokePolicyRepository
  communityId: string
  actor: CommunityMutationActor
}): Promise<CommunityKaraokePolicy> {
  await requireKaraokePolicyCommunity(input)

  return readCommunityKaraokePolicy(input)
}

export async function updateCommunityKaraokePolicy(input: {
  env: Env
  communityRepository: CommunityKaraokePolicyRepository
  communityId: string
  userId?: string
  actor?: CommunityMutationActor
  body: CommunityKaraokePolicyPatch | null
}): Promise<CommunityKaraokePolicy> {
  const body = assertCommunityKaraokePolicyPatch(input.body)
  const actor = input.actor ?? communityMutationActorFromUserId(input.userId ?? "")
  const community = await requireKaraokePolicyCommunity({
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    actor,
  })
  const current = await readCommunityKaraokePolicy(input)
  const next: CommunityKaraokePolicy = {
    ...current,
    ...body,
    karaoke_stt_model: body.karaoke_stt_model === undefined
      ? current.karaoke_stt_model
      : body.karaoke_stt_model?.trim() ?? null,
  }

  const now = nowIso()
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await db.client.execute({
      sql: `
        UPDATE communities
        SET karaoke_enabled = ?2,
            karaoke_scoring_enabled = ?3,
            karaoke_stt_provider = ?4,
            karaoke_stt_model = ?5,
            karaoke_voice_coach_enabled = ?6,
            karaoke_audio_retention = ?7,
            updated_at = ?8
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        next.karaoke_enabled ? 1 : 0,
        next.karaoke_scoring_enabled ? 1 : 0,
        next.karaoke_stt_provider,
        next.karaoke_stt_model ?? "",
        next.karaoke_voice_coach_enabled ? 1 : 0,
        next.karaoke_audio_retention,
        now,
      ],
    })
  } finally {
    db.close()
  }

  await writeAuditEventForEnv(input.env, {
    action: "community.karaoke_policy_updated",
    actorId: "adminOverride" in actor ? actor.adminOverride.adminActorId : actor.userId,
    actorType: "adminOverride" in actor ? "operator" : "user",
    communityId: input.communityId,
    createdAt: now,
    targetId: input.communityId,
    targetType: "community",
    metadata: {
      karaoke_audio_retention: next.karaoke_audio_retention,
      karaoke_enabled: next.karaoke_enabled,
      karaoke_scoring_enabled: next.karaoke_scoring_enabled,
      karaoke_stt_model: next.karaoke_stt_model,
      karaoke_stt_provider: next.karaoke_stt_provider,
      karaoke_voice_coach_enabled: next.karaoke_voice_coach_enabled,
      owner_user_id: community.creator_user_id,
      ...("adminOverride" in actor
        ? {
            acting_user_id: actor.userId,
            scope: actor.adminOverride.scope,
          }
        : {}),
    },
  })

  return readCommunityKaraokePolicy(input)
}
