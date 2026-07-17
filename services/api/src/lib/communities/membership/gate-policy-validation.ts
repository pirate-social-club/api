import { eligibilityFailed } from "../../errors"
import { normalizeIdentityCountryCode } from "../../identity/country-codes"
import { normalizeEthereumAddress } from "../community-token-gates"
import {
  getInventoryMatchKeys,
  isAllowedCourtyardRegistry,
  MAX_INVENTORY_MATCH_VALUES_PER_KEY,
  normalizeAssetMatch,
  normalizeInventoryText,
} from "../community-token-inventory-gates"
import type { DocumentProofProvider, GateAtom, GateExpression, GatePolicy } from "./gate-types"
import { isAtomicBalanceThreshold, resolveAssetBalanceDescriptor } from "./asset-balance-registry"

const MAX_GATE_POLICY_DEPTH = 4
const MAX_GATE_POLICY_ATOMS = 20
const DOCUMENT_PROOF_PROVIDERS: DocumentProofProvider[] = ["self", "zkpassport"]
const GATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export function validateGatePolicy(input: unknown): GatePolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw eligibilityFailed("gate_policy must be an object")
  }
  const policy = input as Record<string, unknown>
  if (policy.version !== 1) {
    throw eligibilityFailed("gate_policy version must be 1")
  }
  const atomCount = { value: 0 }
  const gateIds = new Set<string>()
  const expression = validateGateExpression(policy.expression, 1, atomCount, gateIds, [0])
  if (atomCount.value === 0) {
    throw eligibilityFailed("gate_policy requires at least one gate")
  }
  return { version: 1, expression }
}

function validateGateExpression(
  input: unknown,
  depth: number,
  atomCount: { value: number },
  gateIds: Set<string>,
  path: number[],
): GateExpression {
  if (depth > MAX_GATE_POLICY_DEPTH) {
    throw eligibilityFailed(`gate_policy supports at most ${MAX_GATE_POLICY_DEPTH} levels`)
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw eligibilityFailed("gate_policy expression must be an object")
  }
  const expression = input as Record<string, unknown>
  if (expression.op === "and" || expression.op === "or") {
    if (!Array.isArray(expression.children) || expression.children.length === 0) {
      throw eligibilityFailed(`${expression.op} gate expressions require at least one child`)
    }
    if (expression.children.length > MAX_GATE_POLICY_ATOMS) {
      throw eligibilityFailed(`${expression.op} gate expressions have too many children`)
    }
    return {
      op: expression.op,
      children: expression.children.map((child, index) =>
        validateGateExpression(child, depth + 1, atomCount, gateIds, [...path, index])),
    }
  }
  if (expression.op === "gate") {
    atomCount.value += 1
    if (atomCount.value > MAX_GATE_POLICY_ATOMS) {
      throw eligibilityFailed(`gate_policy supports at most ${MAX_GATE_POLICY_ATOMS} gates`)
    }
    return { op: "gate", gate: validateGateAtom(expression.gate, gateIds, path) }
  }
  throw eligibilityFailed("gate_policy expression op must be and, or, or gate")
}

function validateGateAtom(input: unknown, gateIds: Set<string>, path: number[]): GateAtom {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw eligibilityFailed("gate atom must be an object")
  }
  const atom = input as Record<string, unknown>
  const gateId = atom.gate_id == null ? `legacy_${path.join("_")}` : atom.gate_id
  if (typeof gateId !== "string" || !GATE_ID_PATTERN.test(gateId)) {
    throw eligibilityFailed("gate atom gate_id must be 1 to 64 ASCII letters, numbers, underscores, or hyphens")
  }
  if (gateIds.has(gateId)) {
    throw eligibilityFailed("gate atom gate_id values must be unique within a policy")
  }
  gateIds.add(gateId)
  const identity = { gate_id: gateId }
  switch (atom.type) {
    case "altcha_pow":
      return { ...identity, type: "altcha_pow" }
    case "unique_human": {
      if (atom.provider !== "self" && atom.provider !== "very") {
        throw eligibilityFailed("unique_human gate provider must be self or very")
      }
      return { ...identity, type: "unique_human", provider: atom.provider }
    }
    case "minimum_age": {
      if (atom.provider !== "self") {
        throw eligibilityFailed("minimum_age gate provider must be self")
      }
      if (!Number.isInteger(atom.minimum_age) || (atom.minimum_age as number) < 18 || (atom.minimum_age as number) > 125) {
        throw eligibilityFailed("minimum_age gate minimum_age must be an integer from 18 to 125")
      }
      const acceptedProviders = validateDocumentAcceptedProviders(atom.accepted_providers, "minimum_age")
      return {
        ...identity,
        type: "minimum_age",
        provider: "self",
        ...(acceptedProviders ? { accepted_providers: acceptedProviders } : {}),
        minimum_age: atom.minimum_age as number,
      }
    }
    case "nationality": {
      if (atom.provider !== "self") {
        throw eligibilityFailed("nationality gate provider must be self")
      }
      if (atom.allowed != null && !Array.isArray(atom.allowed)) {
        throw eligibilityFailed("nationality gate allowed values must be an array")
      }
      const allowedInput = Array.isArray(atom.allowed) ? atom.allowed : []
      const allowed = allowedInput.map((value) => normalizeIdentityCountryCode(value))
      if (allowed.some((value) => value == null)) {
        throw eligibilityFailed("nationality gate allowed values must be valid ISO-2 or ISO-3 country codes")
      }
      const acceptedProviders = validateDocumentAcceptedProviders(atom.accepted_providers, "nationality")
      return {
        ...identity,
        type: "nationality",
        provider: "self",
        ...(acceptedProviders ? { accepted_providers: acceptedProviders } : {}),
        allowed: Array.from(new Set(allowed as string[])),
      }
    }
    case "gender": {
      if (atom.provider !== "self") {
        throw eligibilityFailed("gender gate provider must be self")
      }
      if (!Array.isArray(atom.allowed) || atom.allowed.length === 0) {
        throw eligibilityFailed("gender gate requires allowed markers")
      }
      const allowed = atom.allowed.filter((value): value is "M" | "F" => value === "M" || value === "F")
      if (allowed.length !== atom.allowed.length) {
        throw eligibilityFailed("gender gate allowed values must be M or F")
      }
      const acceptedProviders = validateDocumentAcceptedProviders(atom.accepted_providers, "gender")
      return {
        ...identity,
        type: "gender",
        provider: "self",
        ...(acceptedProviders ? { accepted_providers: acceptedProviders } : {}),
        allowed: Array.from(new Set(allowed)),
      }
    }
    case "wallet_score": {
      if (atom.provider !== "passport") {
        throw eligibilityFailed("wallet_score gate provider must be passport")
      }
      if (typeof atom.minimum_score !== "number" || !Number.isFinite(atom.minimum_score) || atom.minimum_score < 0 || atom.minimum_score > 100) {
        throw eligibilityFailed("wallet_score gate minimum_score must be a number from 0 to 100")
      }
      return { ...identity, type: "wallet_score", provider: "passport", minimum_score: atom.minimum_score }
    }
    case "erc721_holding": {
      if (atom.chain_namespace !== "eip155:1") {
        throw eligibilityFailed("erc721_holding gate must target Ethereum mainnet (eip155:1)")
      }
      const contractAddress = normalizeEthereumAddress(atom.contract_address)
      if (!contractAddress) {
        throw eligibilityFailed("erc721_holding gate requires a valid contract_address")
      }
      if (atom.min_count != null && (!Number.isInteger(atom.min_count) || (atom.min_count as number) < 1 || (atom.min_count as number) > 100)) {
        throw eligibilityFailed("erc721_holding gate min_count must be from 1 to 100")
      }
      return {
        ...identity,
        type: "erc721_holding",
        chain_namespace: "eip155:1",
        contract_address: contractAddress,
        ...(atom.min_count != null ? { min_count: atom.min_count as number } : {}),
      }
    }
    case "asset_balance": {
      const asset = resolveAssetBalanceDescriptor(atom.asset_id)
      if (!asset) {
        throw eligibilityFailed("asset_balance gate requires a supported canonical asset_id")
      }
      if (!isAtomicBalanceThreshold(atom.min_amount_atomic)) {
        throw eligibilityFailed("asset_balance gate min_amount_atomic must be a positive atomic integer string")
      }
      return {
        ...identity,
        type: "asset_balance",
        asset_id: asset.assetId,
        min_amount_atomic: atom.min_amount_atomic,
      }
    }
    case "erc721_inventory_match": {
      if (atom.provider !== "courtyard") {
        throw eligibilityFailed("erc721_inventory_match gate provider must be courtyard")
      }
      if (atom.chain_namespace !== "eip155:1" && atom.chain_namespace !== "eip155:137") {
        throw eligibilityFailed("erc721_inventory_match gate must target an allowlisted Courtyard chain")
      }
      const contractAddress = normalizeEthereumAddress(atom.contract_address)
      if (!contractAddress) {
        throw eligibilityFailed("erc721_inventory_match gate requires a valid contract_address")
      }
      if (!isAllowedCourtyardRegistry({ chainNamespace: atom.chain_namespace, contractAddress })) {
        throw eligibilityFailed("erc721_inventory_match gate requires an allowlisted Courtyard contract")
      }
      if (!Number.isInteger(atom.min_quantity) || (atom.min_quantity as number) < 1 || (atom.min_quantity as number) > 100) {
        throw eligibilityFailed("erc721_inventory_match gate min_quantity must be from 1 to 100")
      }
      if (!atom.match || typeof atom.match !== "object" || Array.isArray(atom.match)) {
        throw eligibilityFailed("erc721_inventory_match gate requires match")
      }
      const rawMatch = atom.match as Record<string, unknown>
      const allowedKeys = new Set(getInventoryMatchKeys())
      const invalidKeys = Object.keys(rawMatch).filter((key) => !allowedKeys.has(key))
      if (invalidKeys.length > 0) {
        throw eligibilityFailed(`erc721_inventory_match has unsupported keys: ${invalidKeys.join(", ")}`)
      }
      if (Object.values(rawMatch).some((value) => !isValidInventoryMatchValue(value))) {
        throw eligibilityFailed(`erc721_inventory_match values must be non-empty strings or arrays of 1 to ${MAX_INVENTORY_MATCH_VALUES_PER_KEY} unique non-empty strings`)
      }
      if (!normalizeAssetMatch(rawMatch)) {
        throw eligibilityFailed("erc721_inventory_match must include category plus a supported matching field")
      }
      const match = rawMatch as Record<string, string | string[]>
      return {
        ...identity,
        type: "erc721_inventory_match",
        provider: "courtyard",
        chain_namespace: atom.chain_namespace,
        contract_address: contractAddress,
        min_quantity: atom.min_quantity as number,
        match,
      }
    }
    default:
      throw eligibilityFailed("Unsupported gate atom type")
  }
}

function isValidInventoryMatchValue(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0 || values.length > MAX_INVENTORY_MATCH_VALUES_PER_KEY) {
    return false
  }
  const normalizedValues = new Set<string>()
  for (const raw of values) {
    const normalized = normalizeInventoryText(raw)
    if (!normalized || normalizedValues.has(normalized)) {
      return false
    }
    normalizedValues.add(normalized)
  }
  return Array.isArray(value) || typeof value === "string"
}

function validateDocumentAcceptedProviders(input: unknown, gateType: string): DocumentProofProvider[] | null {
  if (input == null) {
    return null
  }
  if (!Array.isArray(input) || input.length === 0) {
    throw eligibilityFailed(`${gateType} gate accepted_providers must be a non-empty array`)
  }
  const providers: DocumentProofProvider[] = []
  for (const value of input) {
    if (!DOCUMENT_PROOF_PROVIDERS.includes(value as DocumentProofProvider)) {
      throw eligibilityFailed(`${gateType} gate accepted_providers must only include self or zkpassport`)
    }
    providers.push(value as DocumentProofProvider)
  }
  return DOCUMENT_PROOF_PROVIDERS.filter((provider) => providers.includes(provider))
}
