import {
  apiRoutes,
  type CommunityCreateAcceptedResponse,
  type CreateCommunityRequest,
  type NamespaceVerificationSession,
  type StartNamespaceVerificationSessionRequest,
} from "@pirate/api-contracts"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getFlag, requireFlag } from "../args.js"
import { stringField } from "../command-utils.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"
import { waitForCommunityJob } from "./community-jobs.js"

type StoredSession = ReturnType<typeof requireStoredSession>

type SpacesChallenge = {
  txtKey: string
  txtValue: string
  webUrl: string
  freedomUrl: string
}

export async function launchSpacesCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const rootInput = rest[0]
  if (!rootInput) {
    exitWithUsage("Usage: pirate community launch-spaces <@root> --display-name <name> [--publish] [--very-gate] [--allow-agents]")
  }

  const rootLabel = canonicalizeSpacesRootLabel(rootInput)
  const namespaceKey = `@${rootLabel}`
  const displayName = requireFlag(args, "display-name")
  const description = getFlag(args, "description")
  const publish = args.flags.publish === true
  const veryGate = args.flags["very-gate"] === true
  const allowAgents = args.flags["allow-agents"] === true
  const waitForJob = args.flags["no-wait"] !== true

  const namespaceSession = await startSpacesNamespaceSession(session, rootLabel)
  const challenge = getSpacesChallengePayload(namespaceSession)

  if (!publish) {
    printJson({
      next_step: "publish_fabric_records_then_complete",
      namespace_verification_session_id: namespaceSession.id,
      namespace: namespaceKey,
      publish_command: buildSpacesPublishCommand(namespaceKey, challenge),
      complete_command: `pirate verify namespace complete ${namespaceSession.id}`,
    })
    return
  }

  const publisherDir = getPublisherDir(args)
  runSpacesPublisher(publisherDir, namespaceKey, challenge)
  const namespaceVerificationId = await completeSpacesNamespaceSession(
    session,
    namespaceSession.id,
  )
  const created = await createCommunityForNamespace(session, {
    displayName,
    description,
    namespaceVerificationId,
    veryGate,
    allowAgents,
  })
  const job = waitForJob ? await waitForCommunityJob(session, created.job.id) : created.job

  printJson({
    namespace: namespaceKey,
    namespace_verification_id: namespaceVerificationId,
    community: created.community,
    job,
  })
}

export async function finalizeSpacesCommunity(rest: string[], args: ParsedArgs): Promise<void> {
  const session = requireStoredSession()
  const namespaceVerificationSessionId = rest[0]
  if (!namespaceVerificationSessionId) {
    exitWithUsage("Usage: pirate community finalize-spaces <session_id> --display-name <name> [--very-gate] [--allow-agents] [--no-wait]")
  }

  const displayName = requireFlag(args, "display-name")
  const description = getFlag(args, "description")
  const veryGate = args.flags["very-gate"] === true
  const waitForJob = args.flags["no-wait"] !== true
  const allowAgents = args.flags["allow-agents"] === true
  const namespaceVerificationId = await completeSpacesNamespaceSession(session, namespaceVerificationSessionId)
  const created = await createCommunityForNamespace(session, {
    displayName,
    description,
    namespaceVerificationId,
    veryGate,
    allowAgents,
  })
  const job = waitForJob ? await waitForCommunityJob(session, created.job.id) : created.job

  printJson({
    namespace_verification_id: namespaceVerificationId,
    community: created.community,
    job,
  })
}

async function startSpacesNamespaceSession(
  session: StoredSession,
  rootLabel: string,
): Promise<NamespaceVerificationSession> {
  const body: StartNamespaceVerificationSessionRequest = {
    family: "spaces",
    root_label: `@${rootLabel}`,
  }
  return apiRequest<NamespaceVerificationSession>({
    baseUrl: session.baseUrl,
    path: apiRoutes.namespaceVerificationSessions,
    method: "POST",
    ...apiAuthHeadersForSession(session),
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
      ...apiAuthHeadersForSession(session),
      body: {},
    })
    if (completed.status === "verified" && completed.namespace_verification) {
      return completed.namespace_verification
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
    allowAgents: boolean
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
    agent_posting_policy: input.allowAgents ? "allow" : null,
    agent_posting_scope: input.allowAgents ? "top_level_and_replies" : null,
    handle_policy: {
      policy_template: "standard",
    },
    namespace: {
      namespace_verification: input.namespaceVerificationId,
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
    ...apiAuthHeadersForSession(session),
    body,
  })
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
