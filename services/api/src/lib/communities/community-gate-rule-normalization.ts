import { getAddress, isAddress } from "viem"

import { badRequestError } from "../errors"

type GateRuleInputLike = {
  gate_family?: "identity_proof" | "token_holding"
  gate_type?: string
  proof_requirements?: unknown[] | null
  chain_namespace?: string | null
  gate_config?: Record<string, unknown> | null
}

export const SUPPORTED_IDENTITY_GATE_TYPES = new Set([
  "unique_human",
  "age_over_18",
  "nationality",
  "gender",
  "sanctions_clear",
  "wallet_score",
])

export const SUPPORTED_TOKEN_HOLDING_GATE_TYPES = new Set([
  "erc721_holding",
  "erc1155_holding",
])

type NormalizedGateRule = {
  proofRequirementsJson: string | null
  chainNamespace: string | null
  gateConfigJson: string | null
}

function requireRecord(value: Record<string, unknown> | null | undefined, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError(`${fieldName} must be an object`)
  }

  return value
}

function requireChainNamespace(value: string | null | undefined): string {
  const chainNamespace = String(value || "").trim()
  if (!chainNamespace) {
    throw badRequestError("chain_namespace is required for token_holding gates")
  }

  return chainNamespace
}

function requireAddress(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !isAddress(value.trim())) {
    throw badRequestError(`${fieldName} must be a valid EVM address`)
  }

  return getAddress(value.trim())
}

function requireIntegerString(
  value: unknown,
  fieldName: string,
  minimum: bigint,
): string {
  const normalized = typeof value === "string"
    ? value.trim()
    : typeof value === "number" || typeof value === "bigint"
      ? String(value)
      : ""

  if (!/^\d+$/.test(normalized)) {
    throw badRequestError(`${fieldName} must be an integer string`)
  }

  const parsed = BigInt(normalized)
  if (parsed < minimum) {
    throw badRequestError(`${fieldName} must be at least ${minimum.toString()}`)
  }

  return parsed.toString()
}

function normalizeIdentityGate(body: GateRuleInputLike): NormalizedGateRule {
  if (!SUPPORTED_IDENTITY_GATE_TYPES.has(String(body.gate_type))) {
    throw badRequestError(`Unsupported identity gate type ${String(body.gate_type)}`)
  }

  return {
    proofRequirementsJson: body.proof_requirements == null ? null : JSON.stringify(body.proof_requirements),
    chainNamespace: null,
    gateConfigJson: body.gate_config == null ? null : JSON.stringify(body.gate_config),
  }
}

function normalizeTokenHoldingGate(body: GateRuleInputLike): NormalizedGateRule {
  if (!SUPPORTED_TOKEN_HOLDING_GATE_TYPES.has(String(body.gate_type))) {
    throw badRequestError(`Unsupported token_holding gate type ${String(body.gate_type)}`)
  }

  const gateConfig = requireRecord(body.gate_config, "gate_config")
  const contractAddress = requireAddress(gateConfig.contract_address, "gate_config.contract_address")
  const normalizedChainNamespace = requireChainNamespace(body.chain_namespace)

  if (body.gate_type === "erc721_holding") {
    return {
      proofRequirementsJson: null,
      chainNamespace: normalizedChainNamespace,
      gateConfigJson: JSON.stringify({
        contract_address: contractAddress,
      }),
    }
  }

  return {
    proofRequirementsJson: null,
    chainNamespace: normalizedChainNamespace,
    gateConfigJson: JSON.stringify({
      contract_address: contractAddress,
      token_id: requireIntegerString(gateConfig.token_id, "gate_config.token_id", 0n),
      min_balance: requireIntegerString(gateConfig.min_balance, "gate_config.min_balance", 1n),
    }),
  }
}

export function normalizeGateRuleInput(body: GateRuleInputLike): NormalizedGateRule {
  if (body.gate_family === "identity_proof") {
    return normalizeIdentityGate(body)
  }

  if (body.gate_family === "token_holding") {
    return normalizeTokenHoldingGate(body)
  }

  throw badRequestError(`Unsupported gate family ${String(body.gate_family)}`)
}
