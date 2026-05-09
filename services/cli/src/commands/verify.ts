import {
  apiRoutes,
  type CompleteNamespaceVerificationSessionRequest,
  type CompleteVerificationSessionRequest,
  type NamespaceVerification,
  type NamespaceVerificationSession,
  type StartNamespaceVerificationSessionRequest,
  type StartVerificationSessionRequest,
  type VerificationSession,
} from "@pirate/api-contracts"
import { getFlag, hasFlag, requireFlag } from "../args.js"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"
import type { ParsedArgs } from "../types.js"

export async function runVerify(
  action: string | undefined,
  rest: string[],
  args: ParsedArgs,
): Promise<void> {
  const session = requireStoredSession()
  if (action === "human") {
    const sub = rest[0]
    switch (sub) {
      case "start": {
        const provider = (getFlag(args, "provider") || "self") as "self" | "very"
        const body: StartVerificationSessionRequest = {
          provider,
          requested_capabilities: ["unique_human"],
        }
        const result = await apiRequest<VerificationSession>({
          baseUrl: session.baseUrl,
          path: apiRoutes.verificationSessions,
          method: "POST",
          accessToken: session.accessToken,
          body,
        })
        printJson(result)
        return
      }
      case "status": {
        const sessionId = requireFlag(args, "session-id")
        const result = await apiRequest<VerificationSession>({
          baseUrl: session.baseUrl,
          path: apiRoutes.verificationSession(sessionId),
          accessToken: session.accessToken,
        })
        printJson(result)
        return
      }
      case "complete": {
        const sessionId = requireFlag(args, "session-id")
        const attestationId = getFlag(args, "attestation-id")
        const proofHash = getFlag(args, "proof-hash")
        const proof = getFlag(args, "proof")
        const providerPayloadRef = getFlag(args, "provider-payload-ref")
        const body: CompleteVerificationSessionRequest = {
          ...(attestationId ? { attestation_id: attestationId } : {}),
          ...(proofHash ? { proof_hash: proofHash } : {}),
          ...(proof ? { proof } : {}),
          ...(providerPayloadRef ? { provider_payload_ref: providerPayloadRef } : {}),
        }
        const result = await apiRequest<VerificationSession>({
          baseUrl: session.baseUrl,
          path: apiRoutes.verificationSessionComplete(sessionId),
          method: "POST",
          accessToken: session.accessToken,
          body,
        })
        printJson(result)
        return
      }
      default:
        exitWithUsage("Usage: pirate verify human <start|status|complete>")
    }
  }

  if (action === "namespace") {
    const sub = rest[0]
    switch (sub) {
      case "start": {
        const root = rest[1]
        if (!root) {
          exitWithUsage("Usage: pirate verify namespace start <root|@root>")
        }
        const body: StartNamespaceVerificationSessionRequest = {
          family: namespaceFamilyForRootInput(root),
          root_label: root,
        }
        const result = await apiRequest<NamespaceVerificationSession>({
          baseUrl: session.baseUrl,
          path: apiRoutes.namespaceVerificationSessions,
          method: "POST",
          ...apiAuthHeadersForSession(session),
          body,
        })
        printJson(result)
        return
      }
      case "complete": {
        const sessionId = rest[1]
        if (!sessionId) {
          exitWithUsage("Usage: pirate verify namespace complete <session_id> [--restart-challenge]")
        }
        const body: CompleteNamespaceVerificationSessionRequest = hasFlag(args, "restart-challenge")
          ? { restart_challenge: true }
          : {}
        const result = await apiRequest<NamespaceVerificationSession>({
          baseUrl: session.baseUrl,
          path: apiRoutes.namespaceVerificationSessionComplete(sessionId),
          method: "POST",
          ...apiAuthHeadersForSession(session),
          body,
        })
        printJson(result)
        return
      }
      case "status": {
        const id = rest[1]
        if (!id) {
          exitWithUsage("Usage: pirate verify namespace status <session_id|verification_id> [--kind session|verification|auto]")
        }
        const kind = getFlag(args, "kind") || inferNamespaceStatusKind(id)
        const path =
          kind === "verification"
            ? apiRoutes.namespaceVerification(id)
            : apiRoutes.namespaceVerificationSession(id)
        const result = await apiRequest<NamespaceVerification | NamespaceVerificationSession>({
          baseUrl: session.baseUrl,
          path,
          ...apiAuthHeadersForSession(session),
        })
        printJson(result)
        return
      }
      default:
        exitWithUsage("Usage: pirate verify namespace <start|complete|status>")
    }
  }

  exitWithUsage("Usage: pirate verify <human|namespace> ...")
}

export function inferNamespaceStatusKind(id: string): "session" | "verification" {
  return id.startsWith("nv_") ? "verification" : "session"
}

export function namespaceFamilyForRootInput(root: string): "hns" | "spaces" {
  return root.trim().startsWith("@") ? "spaces" : "hns"
}
