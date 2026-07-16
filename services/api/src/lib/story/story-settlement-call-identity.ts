import {
  encodeAbiParameters,
  getAddress,
  isHex,
  keccak256,
  parseAbiParameters,
  size,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from "viem"

export type StorySettlementEffectKind =
  | "story_royalty_payment"
  | "story_parent_royalty_vault_transfer"
  | "story_entitlement_mint"

export type StorySettlementStepKind =
  | "wip_wrap"
  | "wip_approve"
  | "story_royalty_payment"
  | "story_parent_vault_transfer"
  | "story_entitlement_mint"

export type StorySettlementCallIdentityInput = {
  chainId: number
  signerAddress: string
  communityId: string
  quoteId: string
  purchaseId: string
  effectKind: StorySettlementEffectKind
  effectKey: string
  stepKind: StorySettlementStepKind
  ordinal: number
  target: string
  nativeValue: bigint
  calldata: Hex
  settlementToken?: string | null
  amount?: bigint | null
  receiverIpId?: string | null
  payerIpId?: string | null
  childIpId?: string | null
  parentIpId?: string | null
  entitlementToken?: string | null
  buyerAddress?: string | null
  purchaseRef?: Hex | null
}

const CALL_IDENTITY_SCHEMA_VERSION = 1
const CALL_IDENTITY_PARAMETERS = parseAbiParameters(
  "uint16 schemaVersion, uint256 chainId, address signerAddress, string communityId, string quoteId, string purchaseId, string effectKind, string effectKey, string stepKind, uint32 ordinal, address target, uint256 nativeValue, bytes calldata, bool hasSettlementToken, address settlementToken, bool hasAmount, uint256 amount, address receiverIpId, address payerIpId, address childIpId, address parentIpId, address entitlementToken, address buyerAddress, bytes32 purchaseRef",
)

function exactIdentifier(name: string, value: string): string {
  if (!value || value !== value.trim()) throw new Error(`${name}_missing_or_noncanonical`)
  return value
}

function optionalAddress(value: string | null | undefined): Address {
  return value == null || value === "" ? zeroAddress : getAddress(value)
}

function requireAddress(name: string, value: string | null | undefined): Address {
  if (value == null || value === "") throw new Error(`${name}_missing`)
  return getAddress(value)
}

function requireBytes32(name: string, value: Hex | null | undefined): Hex {
  if (!value || !isHex(value, { strict: true }) || size(value) !== 32) throw new Error(`${name}_must_be_bytes32`)
  return value
}

export function deriveStorySettlementCallIdentity(input: StorySettlementCallIdentityInput): Hex {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new Error("chain_id_must_be_positive")
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 0xffff_ffff) {
    throw new Error("ordinal_must_be_uint32")
  }
  if (input.nativeValue < 0n) throw new Error("native_value_must_be_non_negative")
  if (!isHex(input.calldata, { strict: true }) || size(input.calldata) < 4) throw new Error("calldata_must_include_selector")
  if (input.amount != null && input.amount < 0n) throw new Error("amount_must_be_non_negative")

  const allowedStepKinds: Readonly<Record<StorySettlementEffectKind, readonly StorySettlementStepKind[]>> = {
    story_royalty_payment: ["wip_wrap", "wip_approve", "story_royalty_payment"],
    story_parent_royalty_vault_transfer: ["story_parent_vault_transfer"],
    story_entitlement_mint: ["story_entitlement_mint"],
  }
  if (!allowedStepKinds[input.effectKind].includes(input.stepKind)) {
    throw new Error(`step_kind_does_not_match_effect_kind:${input.effectKind}:${input.stepKind}`)
  }
  const moneyStep = input.stepKind !== "story_entitlement_mint"
  if (moneyStep && (input.settlementToken == null || input.settlementToken === "")) {
    throw new Error("settlement_token_missing")
  }
  if (["wip_wrap", "wip_approve", "story_royalty_payment"].includes(input.stepKind) && input.amount == null) {
    throw new Error("settlement_amount_missing")
  }

  const receiverIpId = input.effectKind === "story_royalty_payment"
    ? requireAddress("receiver_ip_id", input.receiverIpId)
    : optionalAddress(input.receiverIpId)
  const payerIpId = input.effectKind === "story_royalty_payment"
    ? requireAddress("payer_ip_id", input.payerIpId)
    : optionalAddress(input.payerIpId)
  const childIpId = input.stepKind === "story_parent_vault_transfer"
    ? requireAddress("child_ip_id", input.childIpId)
    : optionalAddress(input.childIpId)
  const parentIpId = input.stepKind === "story_parent_vault_transfer"
    ? requireAddress("parent_ip_id", input.parentIpId)
    : optionalAddress(input.parentIpId)
  const entitlementToken = input.stepKind === "story_entitlement_mint"
    ? requireAddress("entitlement_token", input.entitlementToken)
    : optionalAddress(input.entitlementToken)
  const buyerAddress = input.stepKind === "story_entitlement_mint"
    ? requireAddress("buyer_address", input.buyerAddress)
    : optionalAddress(input.buyerAddress)
  const purchaseRef = input.stepKind === "story_entitlement_mint"
    ? requireBytes32("purchase_ref", input.purchaseRef)
    : input.purchaseRef == null ? zeroHash : requireBytes32("purchase_ref", input.purchaseRef)

  const hasSettlementToken = input.settlementToken != null && input.settlementToken !== ""
  const hasAmount = input.amount != null
  return keccak256(encodeAbiParameters(CALL_IDENTITY_PARAMETERS, [
    CALL_IDENTITY_SCHEMA_VERSION,
    BigInt(input.chainId),
    getAddress(input.signerAddress),
    exactIdentifier("community_id", input.communityId),
    exactIdentifier("quote_id", input.quoteId),
    exactIdentifier("purchase_id", input.purchaseId),
    input.effectKind,
    exactIdentifier("effect_key", input.effectKey),
    input.stepKind,
    input.ordinal,
    getAddress(input.target),
    input.nativeValue,
    input.calldata,
    hasSettlementToken,
    optionalAddress(input.settlementToken),
    hasAmount,
    input.amount ?? 0n,
    receiverIpId,
    payerIpId,
    childIpId,
    parentIpId,
    entitlementToken,
    buyerAddress,
    purchaseRef,
  ]))
}
