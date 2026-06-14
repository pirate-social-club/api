import { internalError } from "../../errors"
import type { Env } from "../../../env"
import { makeId } from "../../helpers"

type OperatorBootstrapPayload = {
  description?: string | null
  avatar_ref?: string | null
  banner_ref?: string | null
  membership_mode?: "open" | "request" | "gated"
  default_age_gate_policy?: "none" | "18_plus"
  gate_policy?: Record<string, unknown> | null
  membership_unique_human_provider?: "self" | "very" | null
  posting_unique_human_provider?: "self" | "very" | null
  handle_policy_template?: "standard" | "premium" | "membership_gated" | "custom"
  handle_pricing_model?: string | null
  namespace_label?: string | null
  initial_settings?: Record<string, unknown> | null
}

export type ProvisionCommunityOperatorResult = {
  communityId: string
  jobId: string
  bindingId: string
  credentialId: string
  organizationSlug: string
  groupName: string
  groupId: string | null
  databaseName: string
  databaseId: string | null
  databaseUrl: string
  location: string | null
  tokenName: string
  plaintextToken: string
  issuedAt: string
  expiresAt: string | null
  rotationNumber: number
}

export type MigrateCommunityDatabaseOperatorResult = {
  applied: number
  skipped: number
}

export type CommunityProvisionOperatorVersion = {
  service: string | null
  environment: string | null
  git_sha: string | null
  git_ref: string | null
  build_timestamp: string | null
}

function trim(value: string | null | undefined): string {
  return String(value ?? "").trim()
}

function requireText(value: string | null | undefined, label: string): string {
  const normalized = trim(value)
  if (!normalized) {
    throw internalError(`${label} is not configured`)
  }
  return normalized
}

function parsedRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function operatorErrorDetails(input: {
  status: number
  requestId: string
  communityId: string
  parsed: unknown
}): Record<string, unknown> {
  const body = parsedRecord(input.parsed)
  const message = typeof body.message === "string" ? body.message.slice(0, 500) : null
  return {
    operator_status: input.status,
    operator_request_id: input.requestId,
    community_id: input.communityId,
    ...(typeof body.error_code === "string" ? { operator_error_code: body.error_code } : {}),
    ...(typeof body.provision_step === "string" ? { operator_step: body.provision_step } : {}),
    ...(message ? { operator_message: message } : {}),
  }
}

function validateExpectedOrganizationSlug(env: Env, result: ProvisionCommunityOperatorResult): void {
  const expected = trim(env.COMMUNITY_PROVISION_EXPECTED_ORGANIZATION_SLUG)
  if (!expected) {
    return
  }

  if (result.organizationSlug !== expected) {
    throw internalError("community_provision_operator_organization_mismatch", {
      expected_organization_slug: expected,
      actual_organization_slug: result.organizationSlug,
      database_name: result.databaseName,
      database_url: result.databaseUrl,
    })
  }
}

export function isCommunityProvisionOperatorConfigured(env: Env): boolean {
  if (env.COMMUNITY_PROVISION_OPERATOR) {
    return true
  }

  const environment = trim(env.ENVIRONMENT).toLowerCase()
  return environment !== "development" && environment !== "test"
}

export async function getCommunityProvisionOperatorVersion(env: Env): Promise<CommunityProvisionOperatorVersion | null> {
  if (!env.COMMUNITY_PROVISION_OPERATOR) {
    return null
  }

  try {
    const response = await env.COMMUNITY_PROVISION_OPERATOR.fetch(new Request("https://internal/health"))
    if (!response.ok) {
      return null
    }
    const body = parsedRecord(await response.json().catch(() => null))
    return {
      service: typeof body.service === "string" ? body.service : null,
      environment: typeof body.environment === "string" ? body.environment : null,
      git_sha: typeof body.git_sha === "string" ? body.git_sha : null,
      git_ref: typeof body.git_ref === "string" ? body.git_ref : null,
      build_timestamp: typeof body.build_timestamp === "string" ? body.build_timestamp : null,
    }
  } catch {
    return null
  }
}

export type CommunityProvisionOperatorHealth = {
  ok: boolean
  configured: boolean
  control_plane_ok: boolean
  environment: string | null
  error_code: string | null
}

/**
 * Probes the operator's authenticated `/health/deep` endpoint, which actually
 * opens the control plane (validates CONTROL_PLANE_DATABASE_URL and runs
 * `SELECT 1`). This is the check the plain `/health` endpoint cannot do, and is
 * what surfaces a misconfigured (e.g. `file:`) control-plane URL before a real
 * community-creation request hits it.
 */
export async function getCommunityProvisionOperatorHealth(env: Env): Promise<CommunityProvisionOperatorHealth> {
  if (!env.COMMUNITY_PROVISION_OPERATOR) {
    return { ok: false, configured: false, control_plane_ok: false, environment: null, error_code: "operator_binding_unconfigured" }
  }
  const authToken = trim(env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN)
  if (!authToken) {
    return { ok: false, configured: false, control_plane_ok: false, environment: null, error_code: "operator_auth_unconfigured" }
  }

  try {
    const response = await env.COMMUNITY_PROVISION_OPERATOR.fetch(
      new Request("https://internal/health/deep", {
        headers: { authorization: `Bearer ${authToken}` },
      }),
    )
    const body = parsedRecord(await response.json().catch(() => null))
    const controlPlaneOk = body.control_plane_ok === true
    return {
      ok: response.ok && body.ok === true && controlPlaneOk,
      configured: true,
      control_plane_ok: controlPlaneOk,
      environment: typeof body.environment === "string" ? body.environment : null,
      error_code: typeof body.error_code === "string" ? body.error_code : (response.ok ? null : "operator_http_error"),
    }
  } catch {
    return { ok: false, configured: true, control_plane_ok: false, environment: null, error_code: "operator_unreachable" }
  }
}

export async function provisionCommunityViaOperator(input: {
  env: Env
  communityId: string
  creatorUserId: string
  displayName: string
  namespaceVerificationId: string | null
  groupLocation: string
  bootstrapPayload: OperatorBootstrapPayload
}): Promise<ProvisionCommunityOperatorResult> {
  const requestId = makeId("opr")

  const response = await invokeOperator(input.env, {
    path: "/internal/v0/community-provisioning/provision",
    requestId,
    body: {
      community_id: input.communityId,
      creator_user_id: input.creatorUserId,
      display_name: input.displayName,
      namespace_verification_id: input.namespaceVerificationId,
      group_location: input.groupLocation,
      bootstrap_payload: input.bootstrapPayload,
    },
  })

  const body = parsedRecord(response.parsed)

  if (!response.ok) {
    const errorCode = "error_code" in body
      ? String(body.error_code)
      : response.status === 401
        ? "community_provision_operator_unauthorized"
        : "community_provision_operator_http_error"
    throw internalError(errorCode, operatorErrorDetails({
      status: response.status,
      requestId,
      communityId: input.communityId,
      parsed: response.parsed,
    }))
  }

  if (!response.parsed || typeof response.parsed !== "object") {
    throw internalError("community_provision_operator_invalid_response")
  }

  const nullableText = (value: unknown): string | null =>
    value == null ? null : String(value)

  const result = {
    communityId: String(body.community_id ?? ""),
    jobId: String(body.job_id ?? ""),
    bindingId: String(body.binding_id ?? ""),
    credentialId: String(body.credential_id ?? ""),
    organizationSlug: String(body.organization_slug ?? ""),
    groupName: String(body.group_name ?? ""),
    groupId: nullableText(body.group_id),
    databaseName: String(body.database_name ?? ""),
    databaseId: nullableText(body.database_id),
    databaseUrl: String(body.database_url ?? ""),
    location: nullableText(body.location),
    tokenName: String(body.token_name ?? ""),
    plaintextToken: String(body.plaintext_token ?? ""),
    issuedAt: String(body.issued_at ?? ""),
    expiresAt: nullableText(body.expires_at),
    rotationNumber: Number(body.rotation_number ?? 0),
  }

  validateExpectedOrganizationSlug(input.env, result)
  return result
}

export async function migrateCommunityDatabaseViaOperator(input: {
  env: Env
  communityId: string
  databaseUrl: string
  databaseAuthToken: string
}): Promise<MigrateCommunityDatabaseOperatorResult> {
  const requestId = makeId("opr")

  const response = await invokeOperator(input.env, {
    path: "/internal/v0/community-provisioning/migrate",
    requestId,
    body: {
      database_url: input.databaseUrl,
      database_auth_token: input.databaseAuthToken,
    },
  })

  const body = parsedRecord(response.parsed)

  if (!response.ok) {
    const errorCode = "error_code" in body
      ? String(body.error_code)
      : response.status === 401
        ? "community_provision_operator_unauthorized"
        : "community_provision_operator_http_error"
    throw internalError(errorCode, operatorErrorDetails({
      status: response.status,
      requestId,
      communityId: input.communityId,
      parsed: response.parsed,
    }))
  }

  if (!response.parsed || typeof response.parsed !== "object") {
    throw internalError("community_provision_operator_invalid_response")
  }

  return {
    applied: Number(body.applied ?? 0),
    skipped: Number(body.skipped ?? 0),
  }
}

async function invokeOperator(
  env: Env,
  input: {
    path: string
    requestId: string
    body: unknown
  },
): Promise<{ ok: boolean; status: number; parsed: unknown }> {
  if (!env.COMMUNITY_PROVISION_OPERATOR) {
    throw internalError("COMMUNITY_PROVISION_OPERATOR service binding is not configured")
  }
  const authToken = requireText(
    env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN,
    "COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN",
  )
  const response = await env.COMMUNITY_PROVISION_OPERATOR.fetch(
    new Request(`https://internal${input.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-request-id": input.requestId,
      },
      body: JSON.stringify(input.body),
    }),
  )

  const raw = await response.text()
  let parsed: unknown = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = { raw }
  }

  return { ok: response.ok, status: response.status, parsed }
}
