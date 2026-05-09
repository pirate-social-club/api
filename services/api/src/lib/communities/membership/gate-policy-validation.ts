import { eligibilityFailed } from "../../errors"
import { normalizeIdentityCountryCode } from "../../identity/country-codes"
import { normalizeEthereumAddress } from "../community-token-gates"
import {
  getInventoryMatchKeys,
  isAllowedCourtyardRegistry,
  normalizeAssetMatch,
  normalizeInventoryText,
} from "../community-token-inventory-gates"
import type { GateAtom, GateExpression, GatePolicy } from "./gate-types"

const MAX_GATE_POLICY_DEPTH = 4
const MAX_GATE_POLICY_ATOMS = 20

export function validateGatePolicy(input: unknown): GatePolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw eligibilityFailed("gate_policy must be an object")
  }
  const policy = input as Record<string, unknown>
  if (policy.version !== 1) {
    throw eligibilityFailed("gate_policy version must be 1")
  }
  const atomCount = { value: 0 }
  const expression = validateGateExpression(policy.expression, 1, atomCount)
  if (atomCount.value === 0) {
    throw eligibilityFailed("gate_policy requires at least one gate")
  }
  return { version: 1, expression }
}

function validateGateExpression(input: unknown, depth: number, atomCount: { value: number }): GateExpression {
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
      children: expression.children.map((child) => validateGateExpression(child, depth + 1, atomCount)),
    }
  }
  if (expression.op === "gate") {
    atomCount.value += 1
    if (atomCount.value > MAX_GATE_POLICY_ATOMS) {
      throw eligibilityFailed(`gate_policy supports at most ${MAX_GATE_POLICY_ATOMS} gates`)
    }
    return { op: "gate", gate: validateGateAtom(expression.gate) }
  }
  throw eligibilityFailed("gate_policy expression op must be and, or, or gate")
}

function validateGateAtom(input: unknown): GateAtom {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw eligibilityFailed("gate atom must be an object")
  }
  const atom = input as Record<string, unknown>
  switch (atom.type) {
    case "altcha_pow":
      return { type: "altcha_pow" }
    case "unique_human": {
      if (atom.provider !== "self" && atom.provider !== "very") {
        throw eligibilityFailed("unique_human gate provider must be self or very")
      }
      return { type: "unique_human", provider: atom.provider }
    }
    case "minimum_age": {
      if (atom.provider !== "self") {
        throw eligibilityFailed("minimum_age gate provider must be self")
      }
      if (!Number.isInteger(atom.minimum_age) || (atom.minimum_age as number) < 18 || (atom.minimum_age as number) > 125) {
        throw eligibilityFailed("minimum_age gate minimum_age must be an integer from 18 to 125")
      }
      return { type: "minimum_age", provider: "self", minimum_age: atom.minimum_age as number }
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
      return { type: "nationality", provider: "self", allowed: Array.from(new Set(allowed as string[])) }
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
      return { type: "gender", provider: "self", allowed: Array.from(new Set(allowed)) }
    }
    case "wallet_score": {
      if (atom.provider !== "passport") {
        throw eligibilityFailed("wallet_score gate provider must be passport")
      }
      if (typeof atom.minimum_score !== "number" || !Number.isFinite(atom.minimum_score) || atom.minimum_score < 0 || atom.minimum_score > 100) {
        throw eligibilityFailed("wallet_score gate minimum_score must be a number from 0 to 100")
      }
      return { type: "wallet_score", provider: "passport", minimum_score: atom.minimum_score }
    }
    case "erc721_holding": {
      if (atom.chain_namespace !== "eip155:1") {
        throw eligibilityFailed("erc721_holding gate must target Ethereum mainnet (eip155:1)")
      }
      const contractAddress = normalizeEthereumAddress(atom.contract_address)
      if (!contractAddress) {
        throw eligibilityFailed("erc721_holding gate requires a valid contract_address")
      }
      return { type: "erc721_holding", chain_namespace: "eip155:1", contract_address: contractAddress }
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
      const match = atom.match as Record<string, unknown>
      const allowedKeys = new Set(getInventoryMatchKeys())
      const invalidKeys = Object.keys(match).filter((key) => !allowedKeys.has(key))
      if (invalidKeys.length > 0) {
        throw eligibilityFailed(`erc721_inventory_match has unsupported keys: ${invalidKeys.join(", ")}`)
      }
      if (!normalizeAssetMatch(match)) {
        throw eligibilityFailed("erc721_inventory_match must include category plus a supported matching field")
      }
      if (Object.values(match).some((value) => typeof value === "string" && normalizeInventoryText(value) == null)) {
        throw eligibilityFailed("erc721_inventory_match values must be non-empty strings")
      }
      return {
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
