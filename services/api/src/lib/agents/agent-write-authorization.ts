import type { ProfileRepository } from "../auth/repositories"
import { badRequestError, eligibilityFailed } from "../errors"
import type { Community, Env } from "../../types"
import type { Client } from "../sql-client"
import { getControlPlaneAgentOwnershipRepository } from "./control-plane-agent-ownership-repository"
import { dedupeStrings, splitCsv } from "../helpers"
import {
  computeAgentActionProofHash,
  recordAgentActionReplay,
  verifyAgentActionProofSignature,
} from "./agent-action-proof"
import { getControlPlaneClient } from "../runtime-deps"

type AgentWritableRequest = {
  authorship_mode?: "human_direct" | "user_agent"
  agent_id?: string | null
  agent_action_proof?: {
    nonce: string
    signed_at: string
    canonical_request_hash: string
    signature: string
  } | null
  identity_mode?: "public" | "anonymous"
}

export type AgentWriteAuthorization = {
  agentId: string
  agentOwnershipRecordId: string
  agentHandleSnapshot: string
  agentDisplayNameSnapshot: string
  agentOwnerHandleSnapshot: string
  agentOwnershipProviderSnapshot: "self_agent_id" | "clawkey"
}

const AGENT_ACTION_PROOF_FRESHNESS_MS = 5 * 60 * 1000
const AGENT_ACTION_REPLAY_RETENTION_MS = 15 * 60 * 1000
const AGENT_ACTION_PROOF_MAX_FUTURE_SKEW_MS = 30 * 1000
const DEFAULT_PLATFORM_APPROVED_DERIVED_KYA_PROVIDERS = ["clawkey"] as const

function buildCanonicalAgentWriteBody<T extends AgentWritableRequest>(body: T): Omit<T, "agent_action_proof"> {
  const { agent_action_proof: _agentActionProof, ...canonicalBody } = body
  return canonicalBody
}

function startOfCurrentUtcDayIso(nowMs = Date.now()): string {
  const dayStart = new Date(nowMs)
  dayStart.setUTCHours(0, 0, 0, 0)
  return dayStart.toISOString()
}

function resolveEffectiveAcceptedAgentOwnershipProviders(
  env: Env,
  community: Community,
): Array<NonNullable<Community["accepted_agent_ownership_providers"]>[number]> {
  if (community.accepted_agent_ownership_providers_origin === "explicit") {
    return community.accepted_agent_ownership_providers
  }

  if (community.human_verification_lane === "very") {
    // Public v0 resolves the platform-approved KYA provider list from an explicit
    // server policy source. Unset preserves the default clawkey posture; an
    // explicitly blank value disables derived acceptance.
    const configuredProviders = env.PLATFORM_APPROVED_KYA_PROVIDERS == null
      ? [...DEFAULT_PLATFORM_APPROVED_DERIVED_KYA_PROVIDERS]
      : dedupeStrings(splitCsv(env.PLATFORM_APPROVED_KYA_PROVIDERS))
          .filter((value): value is NonNullable<Community["accepted_agent_ownership_providers"]>[number] =>
            value === "self_agent_id" || value === "clawkey"
          )
    return configuredProviders
  }

  // Public v0 only ships clawkey. Self-lane communities keep a conservative deny-by-default
  // posture until a stronger request-native or Self-backed ownership provider is live.
  return []
}

async function countAgentWritesToday(input: {
  client: Client
  communityId: string
  agentId: string
  writeTarget: "top_level_post" | "comment"
  nowMs?: number
}): Promise<number> {
  const dayStartIso = startOfCurrentUtcDayIso(input.nowMs)
  const result = await input.client.execute({
    sql: input.writeTarget === "top_level_post"
      ? `
          SELECT COUNT(*) AS write_count
          FROM posts
          WHERE community_id = ?1
            AND authorship_mode = 'user_agent'
            AND agent_id = ?2
            AND parent_post_id IS NULL
            AND created_at >= ?3
        `
      : `
          SELECT COUNT(*) AS write_count
          FROM comments
          WHERE community_id = ?1
            AND authorship_mode = 'user_agent'
            AND agent_id = ?2
            AND created_at >= ?3
        `,
    args: [input.communityId, input.agentId, dayStartIso],
  })

  return Number(result.rows[0]?.write_count ?? 0)
}

function assertAgentWritingAllowedForCommunity(input: {
  community: Community
  body: AgentWritableRequest
  writeTarget: "top_level_post" | "comment"
}): void {
  if (input.community.agent_posting_policy === "disallow") {
    throw eligibilityFailed("User-owned agent posts are not enabled in this community")
  }
  if (input.writeTarget === "top_level_post" && input.community.agent_posting_scope !== "top_level_and_replies") {
    throw eligibilityFailed("This community only allows user-owned agents to post replies")
  }
  if ((input.body.identity_mode ?? "public") !== "public") {
    throw badRequestError("user_agent posts must use public identity")
  }
}

export async function authorizeAgentWrite<T extends AgentWritableRequest>(input: {
  env: Env
  requestUrl: string
  userId: string
  body: T
  community: Community
  communityDbClient: Client
  profileRepository: ProfileRepository
  writeTarget: "top_level_post" | "comment"
}): Promise<AgentWriteAuthorization | null> {
  if ((input.body.authorship_mode ?? "human_direct") !== "user_agent") {
    return null
  }

  const agentId = input.body.agent_id?.trim()
  const proof = input.body.agent_action_proof

  if (!agentId) {
    throw badRequestError("agent_id is required when authorship_mode = user_agent")
  }
  if (!proof) {
    throw badRequestError("agent_action_proof is required when authorship_mode = user_agent")
  }

  assertAgentWritingAllowedForCommunity({
    community: input.community,
    body: input.body,
    writeTarget: input.writeTarget,
  })

  const profile = await input.profileRepository.getProfileByUserId(input.userId)
  if (!profile?.global_handle?.label?.trim()) {
    throw eligibilityFailed("Owner profile is not eligible for agent-authored posting")
  }

  const agentRepository = getControlPlaneAgentOwnershipRepository(input.env)
  const userAgent = await agentRepository.getUserAgent(agentId, input.userId)
  if (!userAgent || userAgent.status !== "active" || !userAgent.current_ownership_record_id || !userAgent.current_ownership) {
    throw eligibilityFailed("Agent does not have an active verified ownership interval")
  }
  if (!userAgent.handle?.label_display?.trim()) {
    throw eligibilityFailed("Agent does not have an active .clawitzer handle")
  }

  const acceptedProviders = resolveEffectiveAcceptedAgentOwnershipProviders(input.env, input.community)
  if (!acceptedProviders.length) {
    throw eligibilityFailed("This community does not currently accept any available agent ownership provider for this write")
  }
  if (!acceptedProviders.includes(userAgent.current_ownership.ownership_provider)) {
    throw eligibilityFailed("This community does not accept the agent ownership provider for this write")
  }

  const dailyCap = input.writeTarget === "top_level_post"
    ? input.community.agent_daily_post_cap
    : input.community.agent_daily_reply_cap
  if (dailyCap != null) {
    const writesToday = await countAgentWritesToday({
      client: input.communityDbClient,
      communityId: input.community.community_id,
      agentId,
      writeTarget: input.writeTarget,
    })
    if (writesToday >= dailyCap) {
      throw eligibilityFailed(
        input.writeTarget === "top_level_post"
          ? "This community has reached the daily user-owned agent post limit"
          : "This community has reached the daily user-owned agent reply limit",
      )
    }
  }

  const computedCanonicalRequestHash = await computeAgentActionProofHash({
    method: "POST",
    url: input.requestUrl,
    body: buildCanonicalAgentWriteBody(input.body),
  })
  if (proof.canonical_request_hash !== computedCanonicalRequestHash) {
    throw badRequestError("agent_action_proof canonical_request_hash does not match the request")
  }

  const signedAtMs = Date.parse(proof.signed_at)
  const nowMs = Date.now()
  if (
    Number.isNaN(signedAtMs)
    || signedAtMs > nowMs + AGENT_ACTION_PROOF_MAX_FUTURE_SKEW_MS
    || signedAtMs < nowMs - AGENT_ACTION_PROOF_FRESHNESS_MS
  ) {
    throw badRequestError("agent_action_proof signed_at is outside the allowed freshness window")
  }

  if (!userAgent.current_ownership.public_key?.trim()) {
    throw eligibilityFailed("Agent key material is not eligible for write verification")
  }
  if (!verifyAgentActionProofSignature({
    publicKey: userAgent.current_ownership.public_key,
    proof,
  })) {
    throw badRequestError("agent_action_proof signature is invalid")
  }

  await recordAgentActionReplay({
    client: getControlPlaneClient(input.env),
    agentId,
    nonce: proof.nonce,
    signedAt: proof.signed_at,
    canonicalRequestHash: proof.canonical_request_hash,
    expiresAt: new Date(Date.now() + AGENT_ACTION_REPLAY_RETENTION_MS).toISOString(),
  })

  return {
    agentId,
    agentOwnershipRecordId: userAgent.current_ownership_record_id,
    agentHandleSnapshot: userAgent.handle.label_display,
    agentDisplayNameSnapshot: userAgent.display_name,
    agentOwnerHandleSnapshot: profile.global_handle.label,
    agentOwnershipProviderSnapshot: userAgent.current_ownership.ownership_provider,
  }
}
