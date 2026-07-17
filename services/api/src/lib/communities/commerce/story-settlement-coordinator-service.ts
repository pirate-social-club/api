import { getAddress, zeroAddress, type Hex } from "viem"

import type { Env } from "../../../env"
import { badRequestError, conflictError } from "../../errors"
import { resolveStoryCoordinatorDirectSigner } from "../../story/story-direct-signer"
import { isStorySettlementCoordinatorAdmissionEnabled } from "../../story/story-settlement-admission"
import { deriveStorySettlementCallIdentity, type StorySettlementStepKind } from "../../story/story-settlement-call-identity"
import { resolveStorySettlementProtocolAddresses } from "../../story/story-settlement-protocol-addresses"
import {
  buildStoryEntitlementMintCall,
  buildStoryParentVaultTransferCall,
  buildStoryRoyaltyPaymentCalls,
  type UnsignedStorySettlementCall,
} from "../../story/story-settlement-transaction-builder"
import {
  deriveStorySettlementPlanRef,
  storySettlementCoordinatorName,
  type StorySettlementCoordinatorStepInput,
  type StorySettlementPlanRequest,
  type StorySettlementPlanResult,
} from "../../story/story-settlement-wallet-coordinator-do"
import { resolveStoryChainId, resolveStoryDeliveryContracts } from "../../story/story-runtime-config"
import type { DbExecutor } from "../../db-helpers"
import type { AssetRow } from "./row-types"
import { parseJsonValue } from "./row-types"
import {
  beginPurchaseSettlementEffectAttempt,
  listPurchaseSettlementEffectsByQuote,
  type PurchaseSettlementEffectKind,
  type PurchaseSettlementEffectRow,
} from "./settlement-effects"
import {
  claimStorySettlementCoordinatorPlan,
  mirrorStorySettlementCoordinatorPlan,
  type StorySettlementEffectPlanBinding,
} from "./story-settlement-coordinator-mirror"
import { excludeKnownZeroRevenueShareStoryParents } from "./derivative-parent-revenue-share"

type EffectPlan = {
  effectKind: Extract<PurchaseSettlementEffectKind, "story_royalty_payment" | "story_parent_royalty_vault_transfer" | "story_entitlement_mint">
  effectKey: string
  idempotencyKey: string
  metadataJson: string
  calls: Array<UnsignedStorySettlementCall & {
    identity: Omit<StorySettlementCoordinatorStepInput, "callIdentity" | "ordinal" | "target" | "nativeValue" | "calldata" | "stepKind">
  }>
}

export type CoordinateStorySettlementResult =
  | { kind: "not_coordinator_owned" }
  | { kind: "pending"; planRef: Hex; plan: StorySettlementPlanResult | null }
  | { kind: "confirmed"; planRef: Hex; plan: StorySettlementPlanResult }

function requiredPolicyVersion(value: string | undefined, field: string): string {
  const normalized = String(value || "").trim()
  if (!normalized) throw badRequestError(`${field}_missing`)
  return normalized
}

function createEffectPlans(input: {
  env: Env
  chainId: number
  quoteId: string
  asset: AssetRow
  buyerAddress: string
  purchaseRef: Hex
  amount: bigint
  parentIpIds: string[]
}): EffectPlan[] {
  const protocol = resolveStorySettlementProtocolAddresses(input.chainId)
  const paymentKey = `${input.quoteId}:story_royalty:${input.asset.story_ip_id}:${input.amount.toString()}`
  const plans: EffectPlan[] = [{
    effectKind: "story_royalty_payment",
    effectKey: input.asset.asset_id,
    idempotencyKey: paymentKey,
    metadataJson: JSON.stringify({
      amount_wip_wei: input.amount.toString(),
      buyer_wallet_address: input.buyerAddress,
      asset: input.asset.asset_id,
      story_ip_id: input.asset.story_ip_id,
      creator_user_id: input.asset.creator_user_id,
      title: input.asset.display_title,
    }),
    calls: buildStoryRoyaltyPaymentCalls({
      chainId: input.chainId,
      receiverIpId: input.asset.story_ip_id!,
      payerIpId: null,
      amount: input.amount,
    }).map((call) => ({
      ...call,
      identity: {
        effectKind: "story_royalty_payment",
        effectKey: input.asset.asset_id,
        settlementToken: protocol.wipToken,
        amount: input.amount,
        receiverIpId: input.asset.story_ip_id,
        payerIpId: zeroAddress,
      },
    })),
  }]

  for (const parentIpId of input.parentIpIds) {
    const parentRef = parentIpId.trim()
    const normalizedParent = getAddress(parentRef)
    const effectKey = `${input.asset.asset_id}:${parentRef}`
    plans.push({
      effectKind: "story_parent_royalty_vault_transfer",
      effectKey,
      idempotencyKey: `${input.quoteId}:story_parent_royalty_vault:${input.asset.story_ip_id}:${parentRef}:${input.amount.toString()}`,
      metadataJson: JSON.stringify({
        amount_wip_wei: input.amount.toString(),
        asset: input.asset.asset_id,
        child_story_ip_id: input.asset.story_ip_id,
        parent_story_ip_id: parentRef,
        story_royalty_policy: input.asset.story_royalty_policy,
        title: input.asset.display_title,
      }),
      calls: [{
        ...buildStoryParentVaultTransferCall({
          chainId: input.chainId,
          childIpId: input.asset.story_ip_id!,
          parentIpId: normalizedParent,
          royaltyPolicyAddress: input.asset.story_royalty_policy,
        }),
        identity: {
          effectKind: "story_parent_royalty_vault_transfer",
          effectKey,
          settlementToken: protocol.wipToken,
          childIpId: input.asset.story_ip_id,
          parentIpId: normalizedParent,
        },
      }],
    })
  }

  if (input.asset.access_mode === "locked") {
    const tokenId = BigInt(input.asset.story_entitlement_token_id!)
    const entitlementToken = resolveStoryDeliveryContracts(input.env).purchaseEntitlementToken
    const effectKey = `${input.asset.asset_id}:${tokenId.toString()}:${input.buyerAddress.toLowerCase()}`
    plans.push({
      effectKind: "story_entitlement_mint",
      effectKey,
      idempotencyKey: `${input.quoteId}:story_entitlement:${effectKey}`,
      metadataJson: JSON.stringify({
        asset: input.asset.asset_id,
        buyer_wallet_address: input.buyerAddress,
        entitlement_token_id: tokenId.toString(),
        purchase_ref: input.purchaseRef,
      }),
      calls: [{
        ...buildStoryEntitlementMintCall({
          entitlementTokenAddress: entitlementToken,
          buyerAddress: input.buyerAddress,
          entitlementTokenId: tokenId,
          purchaseRef: input.purchaseRef,
        }),
        identity: {
          effectKind: "story_entitlement_mint",
          effectKey,
          entitlementToken,
          buyerAddress: input.buyerAddress,
          purchaseRef: input.purchaseRef,
        },
      }],
    })
  }
  return plans
}

async function ensureEffects(input: {
  client: DbExecutor
  communityId: string
  quoteId: string
  purchaseId: string
  plans: readonly EffectPlan[]
  planRef: Hex
  now: string
}): Promise<PurchaseSettlementEffectRow[]> {
  const existing = await listPurchaseSettlementEffectsByQuote(input)
  const effects: PurchaseSettlementEffectRow[] = []
  for (const plan of input.plans) {
    const found = existing.find((effect) => effect.idempotency_key === plan.idempotencyKey)
    const effect = found ?? await beginPurchaseSettlementEffectAttempt({
      client: input.client,
      communityId: input.communityId,
      quoteId: input.quoteId,
      purchaseId: input.purchaseId,
      effectKind: plan.effectKind,
      effectKey: plan.effectKey,
      idempotencyKey: plan.idempotencyKey,
      coordinatorPlanRef: input.planRef,
      now: input.now,
    })
    await input.client.execute({
      sql: `UPDATE purchase_settlement_effects SET metadata_json = COALESCE(metadata_json, ?2), updated_at = ?3 WHERE purchase_settlement_effect_id = ?1`,
      args: [effect.purchase_settlement_effect_id, plan.metadataJson, input.now],
    })
    effects.push({ ...effect, metadata_json: effect.metadata_json ?? plan.metadataJson })
  }
  return effects
}

export async function coordinateStorySettlement(input: {
  env: Env
  client: DbExecutor
  communityId: string
  quoteId: string
  purchaseId: string
  asset: AssetRow
  buyerAddress: string
  purchaseRef: Hex
  amount: bigint
  now: string
}): Promise<CoordinateStorySettlementResult> {
  const existing = await listPurchaseSettlementEffectsByQuote({
    client: input.client,
    communityId: input.communityId,
    quoteId: input.quoteId,
    purchaseId: input.purchaseId,
  })
  const existingPlanRef = existing.find((effect) => effect.coordinator_plan_ref)?.coordinator_plan_ref as Hex | undefined
  if (
    !isStorySettlementCoordinatorAdmissionEnabled(input.env, input.communityId)
    && !existingPlanRef
  ) return { kind: "not_coordinator_owned" }

  const binding = input.env.STORY_SETTLEMENT_WALLET_COORDINATOR
  if (!binding) throw badRequestError("story_settlement_coordinator_binding_missing")
  const signer = resolveStoryCoordinatorDirectSigner(input.env)
  if (!signer.ok) throw badRequestError(signer.error)
  if (!signer.value) throw badRequestError("story_settlement_coordinator_signer_missing")

  const chainId = resolveStoryChainId(input.env)
  const feePolicyVersion = requiredPolicyVersion(
    input.env.STORY_SETTLEMENT_FEE_POLICY_VERSION,
    "story_settlement_fee_policy_version",
  )
  const finalityPolicyVersion = requiredPolicyVersion(
    input.env.STORY_SETTLEMENT_FINALITY_POLICY_VERSION,
    "story_settlement_finality_policy_version",
  )
  const persistedParentIpIds = parseJsonValue<unknown[]>(input.asset.story_derivative_parent_ip_ids_json, [])
    .filter((parentIpId): parentIpId is string => typeof parentIpId === "string" && Boolean(parentIpId.trim()))
    .map((parentIpId) => parentIpId.trim())
  const parentIpIds = await excludeKnownZeroRevenueShareStoryParents({
    env: input.env,
    parentIpIds: persistedParentIpIds,
  })
  const effectPlans = createEffectPlans({ ...input, chainId, parentIpIds })
  const steps: StorySettlementCoordinatorStepInput[] = []
  const mirrorStepGroups: Array<StorySettlementEffectPlanBinding["steps"]> = []
  let ordinal = 0
  for (const effectPlan of effectPlans) {
    const mirrorSteps: StorySettlementEffectPlanBinding["steps"][number][] = []
    for (const call of effectPlan.calls) {
      const stepKind = call.kind as StorySettlementStepKind
      const identityInput = {
        chainId,
        signerAddress: signer.value.address,
        communityId: input.communityId,
        quoteId: input.quoteId,
        purchaseId: input.purchaseId,
        ...call.identity,
        stepKind,
        ordinal,
        target: call.target,
        nativeValue: call.value,
        calldata: call.calldata,
      }
      const callIdentity = deriveStorySettlementCallIdentity(identityInput)
      steps.push({
        ...call.identity,
        stepKind,
        ordinal,
        target: call.target,
        nativeValue: call.value,
        calldata: call.calldata,
        callIdentity,
      })
      mirrorSteps.push({ callIdentity, stepKind })
      ordinal += 1
    }
    mirrorStepGroups.push(mirrorSteps)
  }

  const request: StorySettlementPlanRequest = {
    chainId,
    signerAddress: signer.value.address,
    communityId: input.communityId,
    quoteId: input.quoteId,
    purchaseId: input.purchaseId,
    feePolicyVersion,
    finalityPolicyVersion,
    steps,
  }
  const derivedPlanRef = deriveStorySettlementPlanRef(request)
  if (existingPlanRef && existingPlanRef !== derivedPlanRef) {
    throw conflictError("Existing Story settlement coordinator plan does not match current immutable calls")
  }
  const effects = await ensureEffects({ ...input, plans: effectPlans, planRef: derivedPlanRef })
  const mirrorBindings = effects.map((effect, index) => ({
    effect,
    steps: mirrorStepGroups[index]!,
  }))
  await claimStorySettlementCoordinatorPlan({ client: input.client, planRef: derivedPlanRef, effects, now: input.now })
  const claimedBindings = mirrorBindings.map((mirrorBinding) => ({
    ...mirrorBinding,
    effect: {
      ...mirrorBinding.effect,
      coordinator_plan_ref: derivedPlanRef,
      coordinator_state: mirrorBinding.effect.coordinator_state ?? "pending",
      coordinator_version: mirrorBinding.effect.coordinator_version ?? 0,
    },
  }))

  const coordinator = binding.getByName(storySettlementCoordinatorName(chainId, signer.value.address))
  let plan: StorySettlementPlanResult
  try {
    const existingPlan = existingPlanRef ? await coordinator.reconcile(existingPlanRef) : null
    plan = existingPlan ?? await coordinator.admit(request)
  } catch (error) {
    // Coordinator ownership was durably claimed before this await. An RPC timeout
    // is therefore an unknown admission/lookup outcome, never authorization to
    // fail the effect or fall back to the legacy signer path.
    console.error(JSON.stringify({
      message: "story settlement coordinator RPC requires reconciliation",
      communityId: input.communityId,
      quoteId: input.quoteId,
      purchaseId: input.purchaseId,
      planRef: derivedPlanRef,
      error: error instanceof Error ? error.message : String(error),
    }))
    return { kind: "pending", planRef: derivedPlanRef, plan: null }
  }
  await mirrorStorySettlementCoordinatorPlan({
    client: input.client,
    chainId,
    signerAddress: signer.value.address,
    plan,
    bindings: claimedBindings,
    now: input.now,
  })
  if (plan.state === "confirmed") return { kind: "confirmed", planRef: plan.planRef, plan }
  if (plan.state !== "pending") throw conflictError(`Story settlement coordinator plan is ${plan.state}`)
  return { kind: "pending", planRef: plan.planRef, plan }
}
