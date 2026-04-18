import { internalError } from "../errors"
import type { Env } from "../../types"

type OperatorBootstrapPayload = {
  description?: string | null
  membership_mode?: "open" | "request" | "gated"
  default_age_gate_policy?: "none" | "18_plus"
  membership_unique_human_provider?: "self" | "very" | null
  posting_unique_human_provider?: "self" | "very" | null
  handle_policy_template?: "standard" | "premium" | "membership_gated" | "custom"
  handle_pricing_model?: string | null
  namespace_label?: string | null
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

export function isCommunityProvisionOperatorConfigured(env: Env): boolean {
  return trim(env.COMMUNITY_PROVISION_OPERATOR_BASE_URL).length > 0
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
  const baseUrl = normalizeBaseUrl(input.env)
  const authToken = requireText(
    input.env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN,
    "COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN",
  )
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort("timeout"),
    parseTimeoutMs(input.env.COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS, 60000),
  )

  try {
    const response = await fetch(`${baseUrl}/internal/v0/community-provisioning/provision`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        community_id: input.communityId,
        creator_user_id: input.creatorUserId,
        display_name: input.displayName,
        namespace_verification_id: input.namespaceVerificationId,
        group_location: input.groupLocation,
        bootstrap_payload: input.bootstrapPayload,
      }),
      signal: controller.signal,
    })

    const raw = await response.text()
    let parsed: unknown = null
    try {
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = { raw }
    }

    if (!response.ok) {
      const errorCode = typeof parsed === "object" && parsed && "error_code" in parsed
        ? String((parsed as Record<string, unknown>).error_code)
        : response.status === 401
          ? "community_provision_operator_unauthorized"
          : "community_provision_operator_http_error"
      throw internalError(errorCode)
    }

    if (!parsed || typeof parsed !== "object") {
      throw internalError("community_provision_operator_invalid_response")
    }

    const body = parsed as Record<string, unknown>
    const nullableText = (value: unknown): string | null =>
      value == null ? null : String(value)

    return {
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
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw internalError("community_provision_operator_timeout")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
