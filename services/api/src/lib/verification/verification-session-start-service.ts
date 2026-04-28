import type { Client } from "../sql-client"
import { badRequestError, internalError } from "../errors"
import { makeId } from "../helpers"
import { serializeVerificationSession } from "../auth/auth-serializers"
import { getVeryProvider } from "./very-provider"
import {
  canonicalizeRequestedCapabilities,
  getSelfProvider,
  normalizeVerificationRequirements,
} from "./self-provider"
import type {
  Env,
  RequestedVerificationCapability,
  VerificationIntent,
  VerificationRequirement,
  VerificationSession,
  VerificationSessionLaunch,
} from "../../types"
import { getVerificationSessionRowForUser } from "./verification-shared"

export async function startVerificationSession(
  client: Client,
  env: Env,
  input: {
    userId: string
    provider: "self" | "very"
    requestedCapabilities?: RequestedVerificationCapability[] | null
    verificationRequirements?: VerificationRequirement[] | null
    walletAttachmentId?: string | null
    verificationIntent?: VerificationIntent | null
    policyId?: string | null
    publicOrigin?: string | null
  },
): Promise<VerificationSession> {
  const requestedCapabilities = canonicalizeRequestedCapabilities(input.provider, (input.requestedCapabilities?.length ? input.requestedCapabilities : ["unique_human"]) as RequestedVerificationCapability[])
  const verificationRequirements = normalizeVerificationRequirements(input.provider, input.verificationRequirements)
  const now = new Date()
  const createdAt = now.toISOString()
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
  const verificationSessionId = makeId("ver")

  let upstreamSessionRef: string | null = null
  let launch: VerificationSessionLaunch | null = null

  if (input.provider === "very") {
    for (const cap of requestedCapabilities) {
      if (cap !== "unique_human") {
        throw badRequestError("Only unique_human verification is supported for the very provider")
      }
    }
    const provider = getVeryProvider(env)
    const result = await provider.startSession({
      verificationSessionId,
      userId: input.userId,
      requestedCapabilities: requestedCapabilities.filter((c): c is "unique_human" => c === "unique_human"),
      walletAttachmentId: input.walletAttachmentId ?? null,
      verificationIntent: input.verificationIntent ?? null,
      policyId: input.policyId ?? null,
      challengeExpiresAt: expiresAt,
      publicOrigin: input.publicOrigin ?? null,
    })
    upstreamSessionRef = result.upstreamSessionRef
    launch = { mode: "widget", very_widget: result.launch }
  }

  if (input.provider === "self") {
    const provider = getSelfProvider(env)
    const result = await provider.startSession({
      verificationSessionId,
      userId: input.userId,
      publicOrigin: input.publicOrigin ?? null,
      requestedCapabilities,
      verificationRequirements,
      verificationIntent: input.verificationIntent ?? null,
      policyId: input.policyId ?? null,
    })
    upstreamSessionRef = result.upstreamSessionRef
    launch = { mode: "qr_deeplink", self_app: result.launch }
  }

  await client.execute({
    sql: `
      INSERT INTO verification_sessions (
        verification_session_id, user_id, provider, session_kind, requested_capabilities_json,
        verification_requirements_json, status, upstream_session_ref, result_ref, failure_code,
        wallet_attachment_id, verification_intent, policy_id,
        started_at, completed_at, expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'identity_proof', ?4, ?5, 'pending', ?6, NULL, NULL, ?7, ?8, ?9, ?10, NULL, ?11, ?10, ?10)
    `,
    args: [
      verificationSessionId,
      input.userId,
      input.provider,
      JSON.stringify(requestedCapabilities),
      JSON.stringify(verificationRequirements),
      upstreamSessionRef,
      input.walletAttachmentId ?? null,
      input.verificationIntent ?? null,
      input.policyId ?? null,
      createdAt,
      expiresAt,
    ],
  })

  const row = await getVerificationSessionRowForUser(client, verificationSessionId, input.userId)
  if (!row) {
    throw internalError("Verification session row is missing after creation")
  }
  return serializeVerificationSession({ row, attestationRows: [], launch })
}
