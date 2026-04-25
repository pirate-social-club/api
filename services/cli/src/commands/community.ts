import {
  apiRoutes,
  type Community,
  type CommunityPreview,
  type CommunityCreateAcceptedResponse,
  type CreateCommunityRequest,
  type Job,
  type NamespaceVerificationSession,
  type StartNamespaceVerificationSessionRequest,
} from "@pirate/api-contracts"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getFlag, hasFlag, requireFlag } from "../args.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

type UpdateCommunityRulesRequestBody = {
  rules: Array<{
    rule_id?: string | null
    title: string
    body: string
    report_reason?: string | null
    position?: number | null
    status?: "active" | "archived" | null
  }>
}

export async function runCommunity(
  action: string | undefined,
  rest: string[],
  args: ParsedArgs,
): Promise<void> {
  const session = requireStoredSession()
  switch (action) {
    case "create": {
      const displayName = requireFlag(args, "display-name")
      const namespaceVerificationId = requireFlag(args, "namespace-verification-id")
      const description = getFlag(args, "description")
      const body: CreateCommunityRequest = {
        display_name: displayName,
        description: description ?? null,
        membership_mode: "open",
        governance_mode: "centralized",
        default_age_gate_policy: "none",
        allow_anonymous_identity: false,
        handle_policy: {
          policy_template: "standard",
        },
        namespace: {
          namespace_verification_id: namespaceVerificationId,
        },
      }
      const result = await apiRequest<CommunityCreateAcceptedResponse>({
        baseUrl: session.baseUrl,
        path: apiRoutes.communities,
        method: "POST",
        accessToken: session.accessToken,
        body,
      })
      printJson(result)
      return
    }
    case "get": {
      const communityId = rest[0]
      if (!communityId) {
        exitWithUsage("Usage: pirate community get <community_id>")
      }
      const result = await apiRequest<Community>({
        baseUrl: session.baseUrl,
        path: apiRoutes.community(communityId),
        accessToken: session.accessToken,
      })
      printJson(result)
      return
    }
    case "update": {
      await updateCommunity(rest, args)
      return
    }
    case "preview": {
      await previewCommunity(rest, args)
      return
    }
    case "rules": {
      await runCommunityRules(rest, args)
      return
    }
    case "launch-spaces": {
      await launchSpacesCommunity(rest, args)
      return
    }
    case "finalize-spaces": {
      await finalizeSpacesCommunity(rest, args)
      return
    }
    default:
      exitWithUsage("Usage: pirate community <create|get|update|preview|rules|launch-spaces|finalize-spaces>")
  }
}

async function updateCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community update <community_id> [--display-name <name>] [--description <text>] [--clear-description]")
  }

  const displayName = getFlag(args, "display-name")
  const description = getFlag(args, "description")
  const body: Record<string, unknown> = {}
  if (displayName != null) {
    body.display_name = displayName
  }
  if (description != null) {
    body.description = description
  } else if (hasFlag(args, "clear-description")) {
    body.description = null
  }
  if (Object.keys(body).length === 0) {
    exitWithUsage("Usage: pirate community update <community_id> [--display-name <name>] [--description <text>] [--clear-description]")
  }

  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: apiRoutes.community(communityId),
    method: "PATCH",
    accessToken: session.accessToken,
    body,
  })
  printJson(result)
}

async function previewCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const communityId = rest[0]
  if (!communityId) {
    exitWithUsage("Usage: pirate community preview <community_id> [--locale <locale>]")
  }

  const locale = getFlag(args, "locale")
  const suffix = locale ? `?locale=${encodeURIComponent(locale)}` : ""
  const result = await apiRequest<CommunityPreview>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.communityPreview(communityId)}${suffix}`,
    accessToken: session.accessToken,
  })
  printJson(result)
}

async function runCommunityRules(rest: string[], args: ParsedArgs): Promise<void> {
  const subcommand = rest[0]
  if (subcommand !== "set") {
    exitWithUsage("Usage: pirate community rules set <community_id> --file <rules.txt|rules.json>")
  }

  const session = requireStoredSession()
  const communityId = rest[1]
  if (!communityId) {
    exitWithUsage("Usage: pirate community rules set <community_id> --file <rules.txt|rules.json>")
  }

  const body = parseRulesFile(requireFlag(args, "file"))
  const result = await apiRequest<Community>({
    baseUrl: session.baseUrl,
    path: `${apiRoutes.community(communityId)}/rules`,
    method: "PUT",
    accessToken: session.accessToken,
    body,
  })
  printJson(result)
}

async function launchSpacesCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const rootInput = rest[0]
  if (!rootInput) {
    exitWithUsage("Usage: pirate community launch-spaces <@root> --display-name <name> [--publish] [--very-gate]")
  }

  const rootLabel = canonicalizeSpacesRootLabel(rootInput)
  const namespaceKey = `@${rootLabel}`
  const displayName = requireFlag(args, "display-name")
  const description = getFlag(args, "description")
  const publisherDir = getPublisherDir(args)
  const publish = args.flags.publish === true
  const veryGate = args.flags["very-gate"] === true
  const waitForJob = args.flags["no-wait"] !== true

  const namespaceSession = await startSpacesNamespaceSession(session, rootLabel)
  const challenge = getSpacesChallengePayload(namespaceSession)
  const publishCommand = buildSpacesPublishCommand(publisherDir, namespaceKey, challenge)

  if (!publish) {
    printJson({
      next_step: "publish_fabric_records_then_complete",
      namespace_verification_session_id: namespaceSession.namespace_verification_session_id,
      namespace: namespaceKey,
      publish_command: publishCommand,
      complete_command: `pirate verify namespace complete ${namespaceSession.namespace_verification_session_id}`,
    })
    return
  }

  runSpacesPublisher(publisherDir, namespaceKey, challenge)
  const namespaceVerificationId = await completeSpacesNamespaceSession(
    session,
    namespaceSession.namespace_verification_session_id,
  )
  const created = await createCommunityForNamespace(session, {
    displayName,
    description,
    namespaceVerificationId,
    veryGate,
  })
  const job = waitForJob ? await waitForCommunityJob(session, created.job.job_id) : created.job

  printJson({
    namespace: namespaceKey,
    namespace_verification_id: namespaceVerificationId,
    community: created.community,
    job,
  })
}

async function finalizeSpacesCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const namespaceVerificationSessionId = rest[0]
  if (!namespaceVerificationSessionId) {
    exitWithUsage("Usage: pirate community finalize-spaces <session_id> --display-name <name> [--very-gate] [--no-wait]")
  }

  const displayName = requireFlag(args, "display-name")
  const description = getFlag(args, "description")
  const veryGate = args.flags["very-gate"] === true
  const waitForJob = args.flags["no-wait"] !== true
  const namespaceVerificationId = await completeSpacesNamespaceSession(session, namespaceVerificationSessionId)
  const created = await createCommunityForNamespace(session, {
    displayName,
    description,
    namespaceVerificationId,
    veryGate,
  })
  const job = waitForJob ? await waitForCommunityJob(session, created.job.job_id) : created.job

  printJson({
    namespace_verification_id: namespaceVerificationId,
    community: created.community,
    job,
  })
}

type StoredSession = ReturnType<typeof requireStoredSession>

type SpacesChallenge = {
  txtKey: string
  txtValue: string
  webUrl: string
  freedomUrl: string
}

async function startSpacesNamespaceSession(
  session: StoredSession,
  rootLabel: string,
): Promise<NamespaceVerificationSession> {
  const body: StartNamespaceVerificationSessionRequest = {
    family: "spaces",
    root_label: rootLabel,
  }
  return apiRequest<NamespaceVerificationSession>({
    baseUrl: session.baseUrl,
    path: apiRoutes.namespaceVerificationSessions,
    method: "POST",
    accessToken: session.accessToken,
    body,
  })
}

function getSpacesChallengePayload(namespaceSession: NamespaceVerificationSession): SpacesChallenge {
  if (namespaceSession.family !== "spaces" || namespaceSession.challenge_kind !== "fabric_txt_publish") {
    throw new Error("Namespace session did not return a Spaces Fabric publish challenge")
  }
  const payload = namespaceSession.challenge_payload ?? {}
  const txtKey = stringField(payload, "txt_key")
  const txtValue = stringField(payload, "txt_value")
  const webUrl = stringField(payload, "web_url")
  const freedomUrl = stringField(payload, "freedom_url")
  if (!txtKey || !txtValue || !webUrl || !freedomUrl) {
    throw new Error("Spaces challenge payload is missing required Fabric records")
  }
  return { txtKey, txtValue, webUrl, freedomUrl }
}

async function completeSpacesNamespaceSession(
  session: StoredSession,
  namespaceVerificationSessionId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const completed = await apiRequest<NamespaceVerificationSession>({
      baseUrl: session.baseUrl,
      path: apiRoutes.namespaceVerificationSessionComplete(namespaceVerificationSessionId),
      method: "POST",
      accessToken: session.accessToken,
      body: {},
    })
    if (completed.status === "verified" && completed.namespace_verification_id) {
      return completed.namespace_verification_id
    }
    if (completed.status !== "challenge_pending" && completed.status !== "challenge_required" && completed.status !== "verifying") {
      throw new Error(`Spaces namespace verification ended with status ${completed.status}`)
    }
    await delay(5000)
  }

  throw new Error("Timed out waiting for Spaces namespace verification")
}

async function createCommunityForNamespace(
  session: StoredSession,
  input: {
    displayName: string
    description: string | null
    namespaceVerificationId: string
    veryGate: boolean
  },
): Promise<CommunityCreateAcceptedResponse> {
  const body: CreateCommunityRequest = {
    display_name: input.displayName,
    description: input.description ?? null,
    membership_mode: input.veryGate ? "gated" : "open",
    governance_mode: "centralized",
    default_age_gate_policy: "none",
    allow_anonymous_identity: false,
    human_verification_lane: input.veryGate ? "very" : null,
    handle_policy: {
      policy_template: "standard",
    },
    namespace: {
      namespace_verification_id: input.namespaceVerificationId,
    },
    gate_rules: input.veryGate
      ? [{
          scope: "membership",
          gate_family: "identity_proof",
          gate_type: "unique_human",
          proof_requirements: [{
            proof_type: "unique_human",
            accepted_providers: ["very"],
          }],
        }]
      : null,
  }

  return apiRequest<CommunityCreateAcceptedResponse>({
    baseUrl: session.baseUrl,
    path: apiRoutes.communities,
    method: "POST",
    accessToken: session.accessToken,
    body,
  })
}

async function waitForCommunityJob(session: StoredSession, jobId: string): Promise<Job> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const job = await apiRequest<Job>({
      baseUrl: session.baseUrl,
      path: apiRoutes.job(jobId),
      accessToken: session.accessToken,
    })
    if (job.status === "succeeded") {
      return job
    }
    if (job.status === "failed") {
      throw new Error(`Community provisioning failed: ${job.error_code ?? "unknown_error"}`)
    }
    await delay(5000)
  }

  throw new Error(`Timed out waiting for community provisioning job ${jobId}`)
}

function runSpacesPublisher(
  publisherDir: string,
  namespaceKey: string,
  challenge: SpacesChallenge,
): void {
  const result = spawnSync("go", [
    "run",
    ".",
    "publish",
    namespaceKey,
    "--web",
    challenge.webUrl,
    "--freedom",
    challenge.freedomUrl,
    "--txt",
    `${challenge.txtKey}=${challenge.txtValue}`,
  ], {
    cwd: publisherDir,
    env: process.env,
    stdio: "inherit",
  })
  if (result.status !== 0) {
    throw new Error(`Spaces publisher failed with exit code ${result.status ?? "unknown"}`)
  }
}

function buildSpacesPublishCommand(
  _publisherDir: string,
  namespaceKey: string,
  challenge: SpacesChallenge,
): string {
  return [
    "go run github.com/pirate-social-club/pirate-spaces-publisher@v0.1.0 publish",
    shellQuote(namespaceKey),
    "--wallet-export",
    shellQuote("/full/path/to/your-wallet-export.json"),
    "--web",
    shellQuote(challenge.webUrl),
    "--freedom",
    shellQuote(challenge.freedomUrl),
    "--txt",
    shellQuote(`${challenge.txtKey}=${challenge.txtValue}`),
  ].join(" ")
}

function getPublisherDir(args: ParsedArgs): string {
  const configured = getFlag(args, "publisher-dir") ?? process.env.PIRATE_SPACES_PUBLISHER_DIR
  if (configured) {
    return resolve(configured)
  }

  const currentFile = fileURLToPath(import.meta.url)
  return resolve(dirname(currentFile), "../../../../../core/tools/spaces-publisher")
}

function canonicalizeSpacesRootLabel(value: string): string {
  const label = value.trim().normalize("NFKC").toLowerCase().replace(/^@/, "")
  if (!label) {
    throw new Error("Spaces root is required")
  }
  const asciiLabel = toAsciiRootLabel(label)
  if (!isProtocolRootLabel(asciiLabel)) {
    throw new Error(`Invalid Spaces root: ${value}`)
  }
  return asciiLabel
}

function toAsciiRootLabel(value: string): string {
  if (!value || value.includes(".")) {
    return value
  }
  if (/^[\x00-\x7F]+$/u.test(value)) {
    return value
  }
  try {
    const hostname = new URL(`http://${value}.invalid`).hostname
    return hostname.endsWith(".invalid") ? hostname.slice(0, -".invalid".length) : value
  } catch {
    return value
  }
}

function isProtocolRootLabel(value: string): boolean {
  if (!value || value.length > 62) {
    return false
  }
  const verifyRange = value.startsWith("xn--") && value.length > "xn--".length
    ? value.slice("xn--".length)
    : value
  return Boolean(verifyRange)
    && !verifyRange.startsWith("-")
    && !verifyRange.endsWith("-")
    && !verifyRange.includes("--")
    && /^[a-z0-9-]+$/u.test(verifyRange)
}

function stringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field]
  return typeof value === "string" && value.trim() ? value : null
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

function parseRulesFile(filePath: string): UpdateCommunityRulesRequestBody {
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

function normalizeRuleInput(value: unknown): UpdateCommunityRulesRequestBody["rules"][number] {
  if (!value || typeof value !== "object") {
    throw new Error("Each rule must be an object")
  }

  const record = value as Record<string, unknown>
  const title = typeof record.title === "string" ? record.title : ""
  const body = typeof record.body === "string" ? record.body : ""
  if (!title.trim() && !body.trim()) {
    throw new Error("Each rule must include a title or body")
  }

  return {
    rule_id: typeof record.rule_id === "string" ? record.rule_id : null,
    title,
    body,
    report_reason: typeof record.report_reason === "string" ? record.report_reason : null,
    position: typeof record.position === "number" ? record.position : null,
    status: record.status === "archived" ? "archived" : "active",
  }
}
