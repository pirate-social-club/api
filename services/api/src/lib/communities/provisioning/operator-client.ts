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

function parseTimeoutMs(value: string | null | undefined, fallbackMs: number): number {
  const parsed = Number(trim(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

function normalizeBaseUrl(env: Env): string {
  return requireText(env.COMMUNITY_PROVISION_OPERATOR_BASE_URL, "COMMUNITY_PROVISION_OPERATOR_BASE_URL").replace(/\/+$/, "")
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
  if (!trim(env.COMMUNITY_PROVISION_OPERATOR_BASE_URL)) {
    return false
  }
  if (trim(env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN)) {
    return true
  }

  const environment = trim(env.ENVIRONMENT).toLowerCase()
  return environment !== "development" && environment !== "test"
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

async function invokeOperator(
  env: Env,
  input: {
    path: string
    requestId: string
    body: unknown
  },
): Promise<{ ok: boolean; status: number; parsed: unknown }> {
  if (env.COMMUNITY_PROVISION_OPERATOR) {
    return invokeOperatorViaBinding(env, input)
  }
  return invokeOperatorViaHttp(env, input)
}

async function invokeOperatorViaBinding(
  env: Env,
  input: {
    path: string
    requestId: string
    body: unknown
  },
): Promise<{ ok: boolean; status: number; parsed: unknown }> {
  const authToken = requireText(
    env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN,
    "COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN",
  )
  const response = await env.COMMUNITY_PROVISION_OPERATOR!.fetch(
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

async function invokeOperatorViaHttp(
  env: Env,
  input: {
    path: string
    requestId: string
    body: unknown
  },
): Promise<{ ok: boolean; status: number; parsed: unknown }> {
  const baseUrl = normalizeBaseUrl(env)
  const authToken = requireText(
    env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN,
    "COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN",
  )
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort("timeout"),
    parseTimeoutMs(env.COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS, 60000),
  )

  try {
    const response = await fetch(`${baseUrl}${input.path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
        "x-request-id": input.requestId,
      },
      body: JSON.stringify(input.body),
      signal: controller.signal,
    })

    const raw = await response.text()
    let parsed: unknown = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = { raw }
    }

    return { ok: response.ok, status: response.status, parsed }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw internalError("community_provision_operator_timeout", {
        operator_request_id: input.requestId,
        community_id: String((input.body as Record<string, unknown>)?.community_id ?? ""),
      })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
