import { apiRoutes, type Community } from "@pirate/api-contracts"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getFlag } from "../args.js"
import { readJsonFile } from "../command-utils.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

const VALID_AGENT_POSTING_POLICIES = new Set(["disallow", "review", "allow_with_disclosure", "allow"])
const VALID_AGENT_POSTING_SCOPES = new Set(["replies_only", "top_level_and_replies"])
const VALID_VERIFICATION_LANES = new Set(["self", "very"])
const VALID_AGENT_OWNERSHIP_PROVIDERS = new Set(["self_agent_id", "clawkey"])

export type UpdateCommunityRulesRequestBody = {
  rules: Array<{
    rule_id?: string | null
    title: string
    body: string
    report_reason?: string | null
    position?: number | null
    status?: "active" | "archived" | null
  }>
}

const SETTINGS_USAGE = "Usage: pirate community settings set <community_id|@slug> (--file <settings.json>|--agent-posting-policy <policy> [--agent-posting-scope <scope>] [--human-verification-lane <lane>] [--accepted-agent-ownership-providers <provider,...>])"

export async function runCommunitySettings(rest: string[], args: ParsedArgs): Promise<void> {
  const subcommand = rest[0]
  if (subcommand !== "set") {
    exitWithUsage(SETTINGS_USAGE)
  }
  const session = requireStoredSession()
  const communityId = rest[1]
  if (!communityId) {
    exitWithUsage(SETTINGS_USAGE)
  }

  const file = getFlag(args, "file")
  if (file) {
    const body = normalizeSettingsPayload(readJsonFile(file))
    const result = await apiRequest<Community>({
      baseUrl: session.baseUrl,
      path: apiRoutes.community(communityId),
      method: "POST",
      ...apiAuthHeadersForSession(session),
      body,
    })
    printJson(result)
    return
  }

  const body = buildSettingsFromFlags(args)
  if (!body) {
    exitWithUsage(SETTINGS_USAGE)
  }

  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: apiRoutes.community(communityId),
    method: "POST",
    ...apiAuthHeadersForSession(session),
    body,
  })
  printJson(result)
}

function buildSettingsFromFlags(args: ParsedArgs): Record<string, unknown> | null {
  const body: Record<string, unknown> = {}

  const agentPostingPolicy = getFlag(args, "agent-posting-policy")
  if (agentPostingPolicy) {
    if (!VALID_AGENT_POSTING_POLICIES.has(agentPostingPolicy)) {
      throw new Error(`--agent-posting-policy must be one of: ${[...VALID_AGENT_POSTING_POLICIES].join(", ")}`)
    }
    body.agent_posting_policy = agentPostingPolicy
  }

  const agentPostingScope = getFlag(args, "agent-posting-scope")
  if (agentPostingScope) {
    if (!VALID_AGENT_POSTING_SCOPES.has(agentPostingScope)) {
      throw new Error(`--agent-posting-scope must be one of: ${[...VALID_AGENT_POSTING_SCOPES].join(", ")}`)
    }
    body.agent_posting_scope = agentPostingScope
  }

  const humanVerificationLane = getFlag(args, "human-verification-lane")
  if (humanVerificationLane) {
    if (!VALID_VERIFICATION_LANES.has(humanVerificationLane)) {
      throw new Error(`--human-verification-lane must be one of: ${[...VALID_VERIFICATION_LANES].join(", ")}`)
    }
    body.human_verification_lane = humanVerificationLane
  }

  const acceptedProviders = getFlag(args, "accepted-agent-ownership-providers")
  if (acceptedProviders) {
    const values = acceptedProviders.split(",").map((v) => v.trim()).filter(Boolean)
    for (const v of values) {
      if (!VALID_AGENT_OWNERSHIP_PROVIDERS.has(v)) {
        throw new Error(`--accepted-agent-ownership-providers contains invalid value: ${v}`)
      }
    }
    body.accepted_agent_ownership_providers = values
  }

  const dailyPostCap = getFlag(args, "agent-daily-post-cap")
  if (dailyPostCap) {
    const parsed = parseInt(dailyPostCap, 10)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error("--agent-daily-post-cap must be a positive integer")
    }
    body.agent_daily_post_cap = parsed
  }

  const dailyReplyCap = getFlag(args, "agent-daily-reply-cap")
  if (dailyReplyCap) {
    const parsed = parseInt(dailyReplyCap, 10)
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error("--agent-daily-reply-cap must be a positive integer")
    }
    body.agent_daily_reply_cap = parsed
  }

  return Object.keys(body).length > 0 ? body : null
}

function normalizeSettingsPayload(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Settings payload must be a JSON object")
  }
  return value as Record<string, unknown>
}

export async function runCommunityRules(rest: string[], args: ParsedArgs): Promise<void> {
  const subcommand = rest[0]
  if (subcommand !== "set") {
    exitWithUsage("Usage: pirate community rules set <community_id> --file <rules.txt|rules.json>")
  }

  const session = requireStoredSession()
  const communityId = rest[1]
  if (!communityId) {
    exitWithUsage("Usage: pirate community rules set <community_id> --file <rules.txt|rules.json>")
  }

  const body = parseRulesFile(requireFileFlag(args))
  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.community(communityId)}/rules`,
    method: "POST",
    ...apiAuthHeadersForSession(session),
    body,
  })
  printJson(result)
}

export async function runCommunityGates(rest: string[], args: ParsedArgs): Promise<void> {
  const subcommand = rest[0]
  if (subcommand !== "set") {
    exitWithUsage("Usage: pirate community gates set <community_id|@slug> (--file <gates.json>|--self-nationality <ISO2|ISO3>)")
  }
  const session = requireStoredSession()
  const communityId = rest[1]
  if (!communityId) {
    exitWithUsage("Usage: pirate community gates set <community_id|@slug> (--file <gates.json>|--self-nationality <ISO2|ISO3>)")
  }

  const file = getFlag(args, "file")
  const selfNationality = getFlag(args, "self-nationality")
  const body = file
    ? readJsonFile(file)
    : selfNationality
      ? buildSelfNationalityGatePayload(selfNationality)
      : null
  if (!body) {
    exitWithUsage("Usage: pirate community gates set <community_id|@slug> (--file <gates.json>|--self-nationality <ISO2|ISO3>)")
  }

  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.community(communityId)}/gates`,
    method: "POST",
    ...apiAuthHeadersForSession(session),
    body,
  })
  printJson(result)
}

export async function runCommunityJsonSetting(
  rest: string[],
  args: ParsedArgs,
  input: {
    pathSuffix: string
    method: "POST"
    usage: string
    normalize: (value: unknown) => unknown
  },
): Promise<void> {
  const subcommand = rest[0]
  if (subcommand !== "set") {
    exitWithUsage(input.usage)
  }
  const session = requireStoredSession()
  const communityId = rest[1]
  if (!communityId) {
    exitWithUsage(input.usage)
  }
  const body = input.normalize(readJsonFile(requireFileFlag(args)))
  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.community(communityId)}/${input.pathSuffix}`,
    method: input.method,
    ...apiAuthHeadersForSession(session),
    body,
  })
  printJson(result)
}

function requireFileFlag(args: ParsedArgs): string {
  const file = getFlag(args, "file")
  if (!file) {
    throw new Error("Missing required flag --file")
  }
  return file
}

export function parseRulesFile(filePath: string): UpdateCommunityRulesRequestBody {
  const text = readFileSync(resolve(filePath), "utf8").trim()
  if (!text) {
    throw new Error("Rules file is empty")
  }

  if (text.startsWith("{") || text.startsWith("[")) {
    const parsed = JSON.parse(text) as unknown
    const rules = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { rules?: unknown }).rules)
        ? (parsed as { rules: unknown[] }).rules
        : null
    if (!rules) {
      throw new Error("Rules JSON must be an array or an object with a rules array")
    }
    return { rules: rules.map(normalizeRuleInput) }
  }

  const blocks = text
    .split(/\n\s*\n/u)
    .map((block) => block.trim())
    .filter(Boolean)
  const rules = blocks.map((block) => {
    const lines = block.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
    const title = lines[0] ?? ""
    const body = lines.slice(1).join("\n\n")
    if (!title) {
      throw new Error("Each text rule block must start with a title")
    }
    return { title, body, report_reason: title, status: "active" as const }
  })

  return { rules }
}

export function buildSelfNationalityGatePayload(requiredValue: string): Record<string, unknown> {
  const value = requiredValue.trim().toUpperCase()
  if (!/^[A-Z]{2,3}$/.test(value)) {
    throw new Error("--self-nationality must be an ISO-3166 alpha-2 or alpha-3 country code")
  }
  return {
    membership_mode: "gated",
    default_age_gate_policy: "none",
    allow_anonymous_identity: false,
    gate_rules: [{
      scope: "membership",
      gate_family: "identity_proof",
      gate_type: "nationality",
      proof_requirements: [{
        proof_type: "nationality",
        accepted_providers: ["self"],
        config: { required_value: value },
      }],
    }],
  }
}

export function normalizeReferenceLinksPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { reference_links: value }
  }
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Array.isArray((value as Record<string, unknown>).reference_links)
  ) {
    return value
  }
  throw new Error("Reference links payload must be an array or an object with reference_links")
}

function normalizeRuleInput(value: unknown): UpdateCommunityRulesRequestBody["rules"][number] {
  if (!value || typeof value !== "object") {
    throw new Error("Each rule must be an object")
  }

  const record = value as Record<string, unknown>
  if (record.rule_id != null && typeof record.rule_id !== "string") {
    throw new Error("rule_id must be a string when present")
  }
  if (typeof record.title !== "string" || !record.title.trim()) {
    throw new Error("Each rule must include a non-empty title")
  }
  if (typeof record.body !== "string" || !record.body.trim()) {
    throw new Error("Each rule must include a non-empty body")
  }
  if (record.report_reason != null && typeof record.report_reason !== "string") {
    throw new Error("report_reason must be a string when present")
  }
  if (record.position != null && typeof record.position !== "number") {
    throw new Error("position must be a number when present")
  }
  if (record.status != null && record.status !== "active" && record.status !== "archived") {
    throw new Error("status must be active or archived when present")
  }

  return {
    rule_id: record.rule_id ?? null,
    title: record.title,
    body: record.body,
    report_reason: record.report_reason ?? null,
    position: record.position ?? null,
    status: record.status === "archived" ? "archived" : "active",
  }
}
