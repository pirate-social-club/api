import type { Env } from "../../../env"
import type { User, WalletAttachmentSummary } from "../../../types"
import type { CommunityGateRuleRow, DocumentProofProvider, GateAtom, GateEvaluationOutcome, GateExpression, GatePolicy, GatePolicyEvaluation, GateTraceNode, RequiredAction, RequiredActionNode, RequiredActionSet } from "./gate-types"
import { evaluateIdentityGateRule } from "./identity-gate-evaluation"
import { evaluateTokenGateRule } from "./token-gate-evaluation"
import { verifyAndConsumeAltchaProof, type AltchaProofInput, type AltchaScope, type VerifiedAltchaProof } from "../../verification/altcha-provider"
import { evaluateAttachedWalletAssetBalance } from "../community-asset-balance"

type AtomEvaluation = {
  outcome: GateEvaluationOutcome
  passed: boolean
  trace: GateTraceNode
  requiredAction: RequiredAction | null
}

type ExpressionEvaluation = {
  outcome: GateEvaluationOutcome
  passed: boolean
  trace: GateTraceNode
  requiredActionSet: RequiredActionSet | null
}

export type EvaluationMode = "preview" | "enforce" | "diagnose"

function getDocumentAcceptedProviders(
  atom: Extract<GateAtom, { type: "minimum_age" | "nationality" | "gender" }>,
): DocumentProofProvider[] {
  return atom.accepted_providers?.length ? atom.accepted_providers : [atom.provider]
}

function getPreferredDocumentProvider(providers: readonly DocumentProofProvider[]): DocumentProofProvider {
  return providers.includes("self") ? "self" : providers[0] ?? "self"
}

export async function evaluateMembershipGatePolicy(input: {
  env: Env
  policy: GatePolicy | null
  user: User
  walletAttachments: WalletAttachmentSummary[]
  mode?: EvaluationMode
  altchaScope?: AltchaScope
  altchaProof?: AltchaProofInput
  verifiedAltchaProof?: VerifiedAltchaProof
}): Promise<GatePolicyEvaluation> {
  if (!input.policy) {
    return {
      satisfied: false,
      outcome: "terminal_mismatch",
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
    verifiedAltchaProof: input.verifiedAltchaProof,
  })

  return {
    satisfied: result.passed,
    outcome: result.outcome,
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
  verifiedAltchaProof?: VerifiedAltchaProof
}): Promise<ExpressionEvaluation> {
  const { expression } = input
  if (expression.op === "gate") {
    const result = await evaluateAtom({ ...input, atom: expression.gate })
    return {
      outcome: result.outcome,
      passed: result.passed,
      trace: result.trace,
      requiredActionSet: result.passed || !result.requiredAction
        ? null
        : { kind: "set", mode: "all", items: [result.requiredAction] },
    }
  }

  const children = input.mode === "enforce"
    ? await evaluateChildrenForEnforcement({ ...input, expression })
    : await Promise.all(expression.children.map((child) =>
        evaluateExpression({ ...input, expression: child }),
      ))
  const passed = expression.op === "and"
    ? children.every((child) => child.passed)
    : children.some((child) => child.passed)
  const failedChildren = children.filter((child) => !child.passed)
  const requiredItems = failedChildren
    .filter((child) => child.outcome === "action_required")
    .map((child) => child.requiredActionSet)
    .filter((item): item is RequiredActionSet => item != null)
  const outcome = composeExpressionOutcome(expression.op, children)

  return {
    outcome,
    passed,
    trace: {
      kind: "op",
      op: expression.op,
      passed,
      children: children.map((child) => child.trace),
    },
    requiredActionSet: outcome !== "action_required"
      ? null
      : collapseActionSet({
        kind: "set",
        mode: expression.op === "and" ? "all" : "any",
        items: requiredItems,
      }),
  }
}

async function evaluateChildrenForEnforcement(input: {
  env: Env
  expression: Extract<GateExpression, { op: "and" | "or" }>
  user: User
  walletAttachments: WalletAttachmentSummary[]
  mode: EvaluationMode
  altchaScope: AltchaScope
  altchaProof?: AltchaProofInput
  verifiedAltchaProof?: VerifiedAltchaProof
}): Promise<ExpressionEvaluation[]> {
  const children: ExpressionEvaluation[] = []
  for (const [index, childExpression] of input.expression.children.entries()) {
    const child = await evaluateExpression({ ...input, expression: childExpression })
    children.push(child)
    if (input.expression.op === "or" && child.passed) {
      break
    }
    if (input.expression.op === "and" && !child.passed) {
      const remaining = input.expression.children.slice(index + 1)
      children.push(...await Promise.all(remaining.map((expression) =>
        evaluateExpression({ ...input, expression, mode: "diagnose", altchaProof: undefined }),
      )))
      break
    }
  }
  return children
}

function composeExpressionOutcome(
  op: "and" | "or",
  children: readonly ExpressionEvaluation[],
): GateEvaluationOutcome {
  const outcomes = new Set(children.map((child) => child.outcome))
  if (op === "or") {
    if (outcomes.has("passed")) return "passed"
    if (outcomes.has("action_required")) return "action_required"
    if (outcomes.has("provider_unavailable")) return "provider_unavailable"
    return "terminal_mismatch"
  }

  if (outcomes.has("terminal_mismatch")) return "terminal_mismatch"
  if (outcomes.has("provider_unavailable")) return "provider_unavailable"
  if (outcomes.has("action_required")) return "action_required"
  return "passed"
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
  verifiedAltchaProof?: VerifiedAltchaProof
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
      {
        const acceptedProviders = getDocumentAcceptedProviders(input.atom)
        const preferredProvider = getPreferredDocumentProvider(acceptedProviders)
        return evaluateIdentityAtom(input, [{
          proof_type: "minimum_age",
          accepted_providers: acceptedProviders,
          config: { minimum_age: input.atom.minimum_age },
        }], {
          kind: "action",
          provider: preferredProvider,
          accepted_providers: acceptedProviders,
          capability: "minimum_age",
          required_age: input.atom.minimum_age,
        }, { required_age: input.atom.minimum_age })
      }
    case "nationality":
      {
        const acceptedProviders = getDocumentAcceptedProviders(input.atom)
        const preferredProvider = getPreferredDocumentProvider(acceptedProviders)
        return evaluateIdentityAtom(input, [{
          proof_type: "nationality",
          accepted_providers: acceptedProviders,
          config: { required_values: input.atom.allowed },
        }], {
          kind: "action",
          provider: preferredProvider,
          accepted_providers: acceptedProviders,
          capability: "nationality",
          allowed_countries: input.atom.allowed,
        })
      }
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
    case "asset_balance":
      return evaluateAssetBalanceAtom({
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
  verifiedAltchaProof?: VerifiedAltchaProof
}): Promise<AtomEvaluation> {
  if (input.mode !== "enforce") {
    return {
      outcome: "action_required",
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

  if (
    input.verifiedAltchaProof?.actorUserId === input.user.user_id
    && input.verifiedAltchaProof.scope === input.altchaScope
    && input.verifiedAltchaProof.action === input.altchaProof?.action
  ) {
    return {
      outcome: "passed",
      passed: true,
      trace: {
        kind: "gate",
        gate_type: "altcha_pow",
        provider: "altcha",
        passed: true,
      },
      requiredAction: null,
    }
  }

  const result = await verifyAndConsumeAltchaProof({
    env: input.env,
    actorUserId: input.user.user_id,
    proof: input.altchaProof,
  })
  return {
    outcome: result.verified ? "passed" : "action_required",
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
  const actionRequired = result.missingCapabilities.length > 0
    || result.mismatchReasons.includes("provider_not_accepted")
  return {
    outcome: passed ? "passed" : actionRequired ? "action_required" : "terminal_mismatch",
    passed,
    trace: {
      kind: "gate",
      gate_type: input.atom.type,
      provider: "provider" in input.atom ? input.atom.provider : undefined,
      passed,
      reason: passed ? undefined : (result.mismatchReasons[0] ?? result.missingCapabilities[0] ?? "missing_verification"),
      ...traceFields,
    },
    requiredAction: actionRequired ? requiredAction : null,
  }
}

function evaluateGenderAtom(input: {
  atom: Extract<GateAtom, { type: "gender" }>
  user: User
}): AtomEvaluation {
  const capability = input.user.verification_capabilities.gender
  const acceptedProviders = getDocumentAcceptedProviders(input.atom)
  const preferredProvider = getPreferredDocumentProvider(acceptedProviders)
  const providerAccepted = capability.state === "verified"
    && acceptedProviders.some((provider) => provider === capability.provider)
  const normalizedValue = capability.value === "M" || capability.value === "F" ? capability.value : null
  const passed = providerAccepted && normalizedValue != null && input.atom.allowed.includes(normalizedValue)
  const missing = capability.state !== "verified"
  const providerMismatch = capability.state === "verified" && !providerAccepted
  const actionRequired = missing || providerMismatch
  return {
    outcome: passed ? "passed" : actionRequired ? "action_required" : "terminal_mismatch",
    passed,
    trace: {
      kind: "gate",
      gate_type: "gender",
      provider: input.atom.provider,
      passed,
      reason: passed ? undefined : missing ? "gender" : providerMismatch ? "provider_not_accepted" : "gender_mismatch",
    },
    requiredAction: actionRequired ? {
      kind: "action",
      provider: preferredProvider,
      accepted_providers: acceptedProviders,
      capability: "gender",
      allowed_markers: input.atom.allowed,
    } : null,
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
  const reason = mismatchReasons[0] ?? "wallet_verification_required"
  const unavailable = reason === "ethereum_rpc_not_configured"
    || reason === "token_inventory_unavailable"
    || reason === "unsupported_gate_config"
    || reason === "unsupported_chain_namespace"
    || reason.startsWith("unsupported_gate_type:")
  return {
    outcome: passed ? "passed" : unavailable ? "provider_unavailable" : "action_required",
    passed,
    trace: {
      kind: "gate",
      gate_type: input.atom.type,
      provider: input.atom.type === "erc721_inventory_match" ? "courtyard" : "wallet",
      passed,
      reason: passed ? undefined : reason,
    },
    requiredAction: passed || unavailable ? null : input.atom.type === "erc721_holding"
      ? {
        kind: "action",
        provider: "wallet",
        capability: "erc721_holding",
        chain_namespace: input.atom.chain_namespace,
        contract_address: input.atom.contract_address,
        min_quantity: input.atom.min_count ?? 1,
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

async function evaluateAssetBalanceAtom(input: {
  env: Env
  atom: Extract<GateAtom, { type: "asset_balance" }>
  walletAttachments: WalletAttachmentSummary[]
}): Promise<AtomEvaluation> {
  const result = await evaluateAttachedWalletAssetBalance({
    env: input.env,
    assetId: input.atom.asset_id,
    minAmountAtomic: input.atom.min_amount_atomic,
    walletAttachments: input.walletAttachments,
  })
  const current = result.currentAmountAtomic
  const shortfall = current == null ? null : (BigInt(input.atom.min_amount_atomic) - BigInt(current)).toString()
  return {
    outcome: result.passed ? "passed" : result.unavailable ? "provider_unavailable" : "action_required",
    passed: result.passed,
    trace: {
      kind: "gate",
      gate_type: "asset_balance",
      provider: "wallet",
      passed: result.passed,
      reason: result.passed ? undefined : result.unavailable ? "asset_balance_unavailable" : "asset_balance_required",
      asset_id: input.atom.asset_id,
      required_amount_atomic: input.atom.min_amount_atomic,
      current_amount_atomic: current,
      evaluated_wallet_count: result.evaluatedWalletCount,
    },
    requiredAction: result.passed || result.unavailable || current == null || shortfall == null ? null : {
      kind: "action",
      provider: "wallet",
      capability: "asset_balance",
      asset_id: input.atom.asset_id,
      required_amount_atomic: input.atom.min_amount_atomic,
      current_amount_atomic: current,
      shortfall_amount_atomic: shortfall,
      // Zero means no wallet was observed at all, which a zero current amount
      // cannot express on its own.
      evaluated_wallet_count: result.evaluatedWalletCount,
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
      ? {
        contract_address: atom.contract_address,
        ...(atom.min_count != null ? { min_count: atom.min_count } : {}),
      }
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
