import type { Env } from "../../../env"
import type { User, WalletAttachmentSummary } from "../../../types"
import type { CommunityGateRuleRow, GateAtom, GateExpression, GatePolicy, GatePolicyEvaluation, GateTraceNode, RequiredAction, RequiredActionNode, RequiredActionSet } from "./gate-types"
import { evaluateIdentityGateRule } from "./identity-gate-evaluation"
import { evaluateTokenGateRule } from "./token-gate-evaluation"
import { verifyAndConsumeAltchaProof, type AltchaProofInput, type AltchaScope } from "../../verification/altcha-provider"

type AtomEvaluation = {
  passed: boolean
  trace: GateTraceNode
  requiredAction: RequiredAction | null
}

export type EvaluationMode = "preview" | "enforce"

export async function evaluateMembershipGatePolicy(input: {
  env: Env
  policy: GatePolicy | null
  user: User
  walletAttachments: WalletAttachmentSummary[]
  mode?: EvaluationMode
  altchaScope?: AltchaScope
  altchaProof?: AltchaProofInput
}): Promise<GatePolicyEvaluation> {
  if (!input.policy) {
    return {
      satisfied: false,
      trace: { kind: "op", op: "and", passed: false, children: [] },
      requiredActionSet: { kind: "set", mode: "all", items: [] },
    }
  }

  const result = await evaluateExpression({
    env: input.env,
    expression: input.policy.expression,
    user: input.user,
    walletAttachments: input.walletAttachments,
    mode: input.mode ?? "preview",
    altchaScope: input.altchaScope ?? input.altchaProof?.scope ?? "community_join",
    altchaProof: input.altchaProof,
  })

  return {
    satisfied: result.passed,
    trace: result.trace,
    requiredActionSet: result.passed ? null : result.requiredActionSet,
  }
}

async function evaluateExpression(input: {
  env: Env
  expression: GateExpression
  user: User
  walletAttachments: WalletAttachmentSummary[]
  mode: EvaluationMode
  altchaScope: AltchaScope
  altchaProof?: AltchaProofInput
}): Promise<{ passed: boolean; trace: GateTraceNode; requiredActionSet: RequiredActionSet | null }> {
  const { expression } = input
  if (expression.op === "gate") {
    const result = await evaluateAtom({ ...input, atom: expression.gate })
    return {
      passed: result.passed,
      trace: result.trace,
      requiredActionSet: result.passed || !result.requiredAction
        ? null
        : { kind: "set", mode: "all", items: [result.requiredAction] },
    }
  }

  const children = input.mode === "enforce"
    ? await evaluateChildrenSequentially({ ...input, expression })
    : await Promise.all(expression.children.map((child) =>
        evaluateExpression({ ...input, expression: child }),
      ))
  const passed = expression.op === "and"
    ? children.every((child) => child.passed)
    : children.some((child) => child.passed)
  const failedChildren = children.filter((child) => !child.passed)
  const requiredItems = failedChildren
    .map((child) => child.requiredActionSet)
    .filter((item): item is RequiredActionSet => item != null)

  return {
    passed,
    trace: {
      kind: "op",
      op: expression.op,
      passed,
      children: children.map((child) => child.trace),
    },
    requiredActionSet: passed
      ? null
      : collapseActionSet({
        kind: "set",
        mode: expression.op === "and" ? "all" : "any",
        items: requiredItems,
      }),
  }
}

async function evaluateChildrenSequentially(input: {
  env: Env
  expression: Extract<GateExpression, { op: "and" | "or" }>
  user: User
  walletAttachments: WalletAttachmentSummary[]
  mode: EvaluationMode
  altchaScope: AltchaScope
  altchaProof?: AltchaProofInput
}): Promise<Array<{ passed: boolean; trace: GateTraceNode; requiredActionSet: RequiredActionSet | null }>> {
  const children: Array<{ passed: boolean; trace: GateTraceNode; requiredActionSet: RequiredActionSet | null }> = []
  for (const childExpression of input.expression.children) {
    const child = await evaluateExpression({ ...input, expression: childExpression })
    children.push(child)
    if (input.expression.op === "or" && child.passed) {
      break
    }
    if (input.expression.op === "and" && !child.passed) {
      break
    }
  }
  return children
}

function collapseActionSet(set: RequiredActionSet): RequiredActionSet {
  const items: RequiredActionNode[] = []
  for (const item of set.items) {
    if (item.kind === "set" && item.mode === set.mode) {
      items.push(...item.items)
    } else {
      items.push(item)
    }
  }
  return { ...set, items }
}

async function evaluateAtom(input: {
  env: Env
  atom: GateAtom
  user: User
  walletAttachments: WalletAttachmentSummary[]
  mode: EvaluationMode
  altchaScope: AltchaScope
  altchaProof?: AltchaProofInput
}): Promise<AtomEvaluation> {
  switch (input.atom.type) {
    case "altcha_pow":
      return evaluateAltchaAtom({ ...input, atom: input.atom })
    case "unique_human":
      return evaluateIdentityAtom(input, [{
        proof_type: "unique_human",
        accepted_providers: [input.atom.provider],
      }], {
        kind: "action",
        provider: input.atom.provider,
        capability: "unique_human",
      })
    case "minimum_age":
      return evaluateIdentityAtom(input, [{
        proof_type: "minimum_age",
        accepted_providers: ["self"],
        config: { minimum_age: input.atom.minimum_age },
      }], {
        kind: "action",
        provider: "self",
        capability: "minimum_age",
        required_age: input.atom.minimum_age,
      }, { required_age: input.atom.minimum_age })
    case "nationality":
      return evaluateIdentityAtom(input, [{
        proof_type: "nationality",
        accepted_providers: ["self"],
        config: { required_values: input.atom.allowed },
      }], {
        kind: "action",
        provider: "self",
        capability: "nationality",
        allowed_countries: input.atom.allowed,
      })
    case "gender":
      return evaluateGenderAtom({ atom: input.atom, user: input.user })
    case "wallet_score":
      return evaluateIdentityAtom(input, [{
        proof_type: "wallet_score",
        accepted_providers: ["passport"],
        config: { minimum_score: input.atom.minimum_score },
      }], {
        kind: "action",
        provider: "passport",
        capability: "wallet_score",
        minimum_score: input.atom.minimum_score,
        actual_score: readWalletScore(input.user),
      }, {
        required_score: input.atom.minimum_score,
        actual_score: readWalletScore(input.user),
      })
    case "erc721_holding":
    case "erc721_inventory_match":
      return evaluateTokenAtom({
        env: input.env,
        atom: input.atom,
        walletAttachments: input.walletAttachments,
      })
  }
}

async function evaluateAltchaAtom(input: {
  env: Env
  atom: Extract<GateAtom, { type: "altcha_pow" }>
  user: User
  mode: EvaluationMode
  altchaScope: AltchaScope
  altchaProof?: AltchaProofInput
}): Promise<AtomEvaluation> {
  if (input.mode === "preview") {
    return {
      passed: false,
      trace: {
        kind: "gate",
        gate_type: "altcha_pow",
        provider: "altcha",
        passed: false,
        reason: "missing_altcha_pow",
      },
      requiredAction: {
        kind: "action",
        provider: "altcha",
        capability: "altcha_pow",
        scope: input.altchaScope,
      },
    }
  }

  const result = await verifyAndConsumeAltchaProof({
    env: input.env,
    actorUserId: input.user.user_id,
    proof: input.altchaProof,
  })
  return {
    passed: result.verified,
    trace: {
      kind: "gate",
      gate_type: "altcha_pow",
      provider: "altcha",
      passed: result.verified,
      reason: result.verified ? undefined : result.reason ?? "invalid_altcha_pow",
    },
    requiredAction: result.verified ? null : {
      kind: "action",
      provider: "altcha",
      capability: "altcha_pow",
      scope: input.altchaScope,
    },
  }
}

function evaluateIdentityAtom(
  input: {
    atom: GateAtom
    user: User
  },
  proofRequirements: Array<Record<string, unknown>>,
  requiredAction: RequiredAction,
  traceFields: Partial<Extract<GateTraceNode, { kind: "gate" }>> = {},
): AtomEvaluation {
  const row = buildIdentityRow(input.atom, proofRequirements)
  const result = evaluateIdentityGateRule({ rule: row, user: input.user, suggestedProvider: null })
  const passed = result.missingCapabilities.length === 0 && result.mismatchReasons.length === 0
  return {
    passed,
    trace: {
      kind: "gate",
      gate_type: input.atom.type,
      provider: "provider" in input.atom ? input.atom.provider : undefined,
      passed,
      reason: passed ? undefined : (result.mismatchReasons[0] ?? result.missingCapabilities[0] ?? "missing_verification"),
      ...traceFields,
    },
    requiredAction: passed ? null : requiredAction,
  }
}

function evaluateGenderAtom(input: {
  atom: Extract<GateAtom, { type: "gender" }>
  user: User
}): AtomEvaluation {
  const capability = input.user.verification_capabilities.gender
  const providerAccepted = capability.state === "verified" && capability.provider === "self"
  const normalizedValue = capability.value === "M" || capability.value === "F" ? capability.value : null
  const passed = providerAccepted && normalizedValue != null && input.atom.allowed.includes(normalizedValue)
  const missing = capability.state !== "verified"
  return {
    passed,
    trace: {
      kind: "gate",
      gate_type: "gender",
      provider: "self",
      passed,
      reason: passed ? undefined : missing ? "gender" : "gender_mismatch",
    },
    requiredAction: passed ? null : {
      kind: "action",
      provider: "self",
      capability: "gender",
      allowed_markers: input.atom.allowed,
    },
  }
}

async function evaluateTokenAtom(input: {
  env: Env
  atom: Extract<GateAtom, { type: "erc721_holding" | "erc721_inventory_match" }>
  walletAttachments: WalletAttachmentSummary[]
}): Promise<AtomEvaluation> {
  const row = buildTokenRow(input.atom)
  const mismatchReasons = await evaluateTokenGateRule({
    env: input.env,
    rule: row,
    walletAttachments: input.walletAttachments,
  })
  const passed = mismatchReasons.length === 0
  return {
    passed,
    trace: {
      kind: "gate",
      gate_type: input.atom.type,
      provider: input.atom.type === "erc721_inventory_match" ? "courtyard" : "wallet",
      passed,
      reason: passed ? undefined : mismatchReasons[0] ?? "wallet_verification_required",
    },
    requiredAction: passed ? null : input.atom.type === "erc721_holding"
      ? {
        kind: "action",
        provider: "wallet",
        capability: "erc721_holding",
        chain_namespace: input.atom.chain_namespace,
        contract_address: input.atom.contract_address,
      }
      : {
        kind: "action",
        provider: "wallet",
        capability: "erc721_inventory_match",
        chain_namespace: input.atom.chain_namespace,
        contract_address: input.atom.contract_address,
        min_quantity: input.atom.min_quantity,
      },
  }
}

function buildIdentityRow(atom: GateAtom, proofRequirements: Array<Record<string, unknown>>): CommunityGateRuleRow {
  return {
    gate_rule_id: "policy_atom",
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: atom.type,
    proof_requirements_json: JSON.stringify(proofRequirements),
    chain_namespace: null,
    gate_config_json: null,
    status: "active",
  }
}

function buildTokenRow(atom: Extract<GateAtom, { type: "erc721_holding" | "erc721_inventory_match" }>): CommunityGateRuleRow {
  return {
    gate_rule_id: "policy_atom",
    scope: "membership",
    gate_family: "token_holding",
    gate_type: atom.type,
    proof_requirements_json: null,
    chain_namespace: atom.chain_namespace,
    gate_config_json: JSON.stringify(atom.type === "erc721_holding"
      ? { contract_address: atom.contract_address }
      : {
        contract_address: atom.contract_address,
        inventory_provider: atom.provider,
        min_quantity: atom.min_quantity,
        match: atom.match,
      }),
    status: "active",
  }
}

function readWalletScore(user: User): number | null {
  const raw = user.verification_capabilities.wallet_score.score_decimal
  if (raw == null) return null
  const score = Number(raw)
  return Number.isFinite(score) ? score : null
}
