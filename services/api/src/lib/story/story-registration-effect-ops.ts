import type { Env } from "../../env"
import { writeAuditEventBestEffortForEnv, writeAuditEventForEnv } from "../audit"
import type { Client } from "../sql-client"
import type { StoryRoyaltyRegistrationResult } from "./story-royalty-registration-service"
import type {
  StoryRegistrationReceiptEvidence,
  StoryRegistrationRevertedReceiptEvidence,
} from "./story-registration-effect-resolution"
import {
  getStoryRegistrationEffect,
  transitionReconciledStoryRegistrationToConfirmed,
  transitionRevertedStoryRegistrationToRetryable,
  transitionStoryRegistrationNotBroadcast,
  type StoryRegistrationEffect,
} from "./story-registration-effect-store"

async function requireEffect(client: Client, communityId: string, assetId: string): Promise<StoryRegistrationEffect> {
  const effect = await getStoryRegistrationEffect({ client, communityId, assetId })
  if (!effect) throw new Error("story_registration_effect_missing_after_resolution")
  return effect
}

type OperatorResolutionBase = {
  env: Env
  client: Client
  communityId: string
  assetId: string
  expectedOperationId: string
  actorId: string
  reason: string
  now: string
}

function auditBase(input: OperatorResolutionBase) {
  return {
    actorId: input.actorId,
    actorType: "operator" as const,
    communityId: input.communityId,
    createdAt: input.now,
    targetId: input.assetId,
    targetType: "asset",
  }
}

export async function operatorAttestStoryRegistrationNotBroadcast(
  input: OperatorResolutionBase,
): Promise<StoryRegistrationEffect> {
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 180)
  await writeAuditEventForEnv(input.env, {
    ...auditBase(input),
    action: "story.registration_effect.resolution_requested",
    metadata: {
      operation_id: input.expectedOperationId,
      requested_resolution: "failed_prebroadcast",
      reason,
    },
  })
  await transitionStoryRegistrationNotBroadcast(input)
  await writeAuditEventBestEffortForEnv(input.env, {
    ...auditBase(input),
    action: "story.registration_effect.resolution_applied",
    metadata: {
      operation_id: input.expectedOperationId,
      resolution: "failed_prebroadcast",
      reason,
    },
  }, "[story-registration-resolution]")
  return await requireEffect(input.client, input.communityId, input.assetId)
}

export async function operatorConfirmStoryRegistration(input: OperatorResolutionBase & {
  result: StoryRoyaltyRegistrationResult
  evidence: StoryRegistrationReceiptEvidence
}): Promise<StoryRegistrationEffect> {
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 180)
  if (reason.length < 10) throw new Error("story_registration_resolution_reason_required")
  const evidenceMetadata = {
    operation_id: input.expectedOperationId,
    provider_tx_ref: input.evidence.providerTxRef,
    block_hash: input.evidence.blockHash,
    block_number: input.evidence.blockNumber,
    story_ip_id: input.evidence.storyIpId,
    story_ip_nft_contract: input.evidence.storyIpNftContract,
    story_ip_nft_token_id: input.evidence.storyIpNftTokenId,
    reason,
  }
  await writeAuditEventForEnv(input.env, {
    ...auditBase(input),
    action: "story.registration_effect.resolution_requested",
    metadata: { ...evidenceMetadata, requested_resolution: "confirmed" },
  })
  await transitionReconciledStoryRegistrationToConfirmed({
    client: input.client,
    communityId: input.communityId,
    assetId: input.assetId,
    expectedOperationId: input.expectedOperationId,
    providerTxRef: input.evidence.providerTxRef,
    result: input.result,
    now: input.now,
  })
  await writeAuditEventBestEffortForEnv(input.env, {
    ...auditBase(input),
    action: "story.registration_effect.resolution_applied",
    metadata: { ...evidenceMetadata, resolution: "confirmed" },
  }, "[story-registration-resolution]")
  return await requireEffect(input.client, input.communityId, input.assetId)
}

export async function operatorConfirmStoryRegistrationReverted(input: OperatorResolutionBase & {
  evidence: StoryRegistrationRevertedReceiptEvidence
}): Promise<StoryRegistrationEffect> {
  const reason = input.reason.trim().replace(/\s+/g, " ").slice(0, 180)
  if (reason.length < 10) throw new Error("story_registration_resolution_reason_required")
  const evidenceMetadata = {
    operation_id: input.expectedOperationId,
    provider_tx_ref: input.evidence.providerTxRef,
    block_hash: input.evidence.blockHash,
    block_number: input.evidence.blockNumber,
    receipt_outcome: input.evidence.outcome,
    reason,
  }
  await writeAuditEventForEnv(input.env, {
    ...auditBase(input),
    action: "story.registration_effect.resolution_requested",
    metadata: { ...evidenceMetadata, requested_resolution: "failed_prebroadcast" },
  })
  await transitionRevertedStoryRegistrationToRetryable({
    client: input.client,
    communityId: input.communityId,
    assetId: input.assetId,
    expectedOperationId: input.expectedOperationId,
    providerTxRef: input.evidence.providerTxRef,
    reason,
    now: input.now,
  })
  await writeAuditEventBestEffortForEnv(input.env, {
    ...auditBase(input),
    action: "story.registration_effect.resolution_applied",
    metadata: { ...evidenceMetadata, resolution: "failed_prebroadcast" },
  }, "[story-registration-resolution]")
  return await requireEffect(input.client, input.communityId, input.assetId)
}
