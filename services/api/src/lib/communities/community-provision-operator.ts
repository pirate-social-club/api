import { badRequestError, internalError } from "../errors"
import { isLocalEnvironment } from "../helpers"
import type { Env } from "../../types"

export type CommunityProvisionOperatorResult = {
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
}

function parseTimeoutMs(value: string | undefined, fallbackMs: number): number {
  const parsed = Number(String(value || "").trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs
}

function operatorBaseUrl(env: Env): string | null {
  const configured = String(env.COMMUNITY_PROVISION_OPERATOR_BASE_URL || "").trim()
  return configured ? configured.replace(/\/+$/, "") : null
}

export function shouldUseCommunityProvisionOperator(env: Env): boolean {
  return Boolean(operatorBaseUrl(env))
}

export function allowLocalStubCommunityProvisioning(env: Env): boolean {
  return isLocalEnvironment(env.ENVIRONMENT) && !shouldUseCommunityProvisionOperator(env)
}

export function requireCommunityProvisionGroupLocation(env: Env): string {
  const groupLocation = String(env.COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION || "").trim()
  if (!groupLocation) {
    throw internalError("COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION is not configured")
  }
  return groupLocation
}

export function requireCommunityDbWrapKeyVersion(env: Env): number {
  const parsed = Number(String(env.TURSO_COMMUNITY_DB_WRAP_KEY_VERSION || "").trim())
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw internalError("TURSO_COMMUNITY_DB_WRAP_KEY_VERSION is not configured")
  }
  return parsed
}

async function fetchOperatorJson(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const baseUrl = operatorBaseUrl(env)
  if (!baseUrl) {
    throw internalError("COMMUNITY_PROVISION_OPERATOR_BASE_URL is not configured")
  }

  const authToken = String(env.COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN || "").trim()
  if (!authToken) {
    throw badRequestError(
      "COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN is required when COMMUNITY_PROVISION_OPERATOR_BASE_URL is configured",
    )
  }

  const controller = new AbortController()
  const timeoutMs = parseTimeoutMs(env.COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS, 60000)
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
      const errorCode = typeof parsed === "object" && parsed
        ? "error_code" in parsed
          ? String((parsed as Record<string, unknown>).error_code)
          : "code" in parsed
            ? String((parsed as Record<string, unknown>).code)
            : response.status === 401
              ? "community_provision_operator_unauthorized"
              : "community_provision_operator_http_error"
        : response.status === 401
          ? "community_provision_operator_unauthorized"
          : "community_provision_operator_http_error"
      throw internalError(errorCode)
    }

    if (!parsed || typeof parsed !== "object") {
      throw internalError("community_provision_operator_invalid_response")
    }

    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw internalError("community_provision_operator_timeout")
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function provisionCommunityWithOperator(
  env: Env,
  input: {
    communityId: string
    creatorUserId: string
    displayName: string
    namespaceVerificationId: string
    groupLocation: string
    createdAt: string
    bootstrapPayload: {
      description: string | null
      namespaceLabel: string
      membershipMode: "open" | "request" | "gated"
      defaultAgeGatePolicy: "none" | "18_plus"
      allowAnonymousIdentity: boolean
      anonymousIdentityScope: "community_stable" | "thread_stable" | "post_ephemeral" | null
      governanceMode: "centralized"
      handlePolicyTemplate: string
      pricingModel: null
      gateRules: Array<{
        scope: "membership" | "viewer" | "posting"
        gateFamily: "token_holding" | "identity_proof"
        gateType: string
        proofRequirementsJson: string | null
        chainNamespace: string | null
        gateConfigJson: string | null
      }>
    }
  },
): Promise<CommunityProvisionOperatorResult> {
  const payload = await fetchOperatorJson(env, "/internal/v0/community-provisioning/provision", {
    community_id: input.communityId,
    creator_user_id: input.creatorUserId,
    display_name: input.displayName,
    namespace_verification_id: input.namespaceVerificationId,
    group_location: input.groupLocation,
    created_at: input.createdAt,
    bootstrap_payload: {
      created_by_user_id: input.creatorUserId,
      created_at: input.createdAt,
      description: input.bootstrapPayload.description,
      namespace_label: input.bootstrapPayload.namespaceLabel,
      membership_mode: input.bootstrapPayload.membershipMode,
      default_age_gate_policy: input.bootstrapPayload.defaultAgeGatePolicy,
      allow_anonymous_identity: input.bootstrapPayload.allowAnonymousIdentity,
      anonymous_identity_scope: input.bootstrapPayload.anonymousIdentityScope,
      governance_mode: input.bootstrapPayload.governanceMode,
      handle_policy_template: input.bootstrapPayload.handlePolicyTemplate,
      pricing_model: input.bootstrapPayload.pricingModel,
      gate_rules: input.bootstrapPayload.gateRules.map((rule) => ({
        scope: rule.scope,
        gate_family: rule.gateFamily,
        gate_type: rule.gateType,
        proof_requirements_json: rule.proofRequirementsJson,
        chain_namespace: rule.chainNamespace,
        gate_config_json: rule.gateConfigJson,
      })),
    },
  })

  const organizationSlug = String(payload.organization_slug || "").trim()
  const groupName = String(payload.group_name || "").trim()
  const databaseName = String(payload.database_name || "").trim()
  const databaseUrl = String(payload.database_url || "").trim()
  const tokenName = String(payload.token_name || "").trim()
  const plaintextToken = String(payload.plaintext_token || "").trim()
  const issuedAt = String(payload.issued_at || input.createdAt).trim()

  if (!organizationSlug || !groupName || !databaseName || !databaseUrl || !tokenName || !plaintextToken) {
    throw internalError("community_provision_operator_invalid_response")
  }

  return {
    organizationSlug,
    groupName,
    groupId: payload.group_id == null ? null : String(payload.group_id),
    databaseName,
    databaseId: payload.database_id == null ? null : String(payload.database_id),
    databaseUrl,
    location: payload.location == null ? null : String(payload.location),
    tokenName,
    plaintextToken,
    issuedAt,
    expiresAt: payload.expires_at == null ? null : String(payload.expires_at),
  }
}
