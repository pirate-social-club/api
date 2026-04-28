import { badRequestError, providerUnavailable } from "../errors"
import { isProductionEnv } from "../helpers"
import type { Env } from "../../types"

export type HnsInspectResult = {
  root_label?: string
  zone_name?: string
  challenge_name?: string
  zone_exists?: boolean
  challenge_present?: boolean
  root_exists?: boolean | null
  root_control_verified?: boolean | null
  expiry_horizon_sufficient?: boolean | null
  routing_enabled?: boolean | null
  pirate_dns_authority_verified?: boolean | null
  control_class?: "single_holder_root" | "multisig_controlled_root" | "dao_controlled_root" | "burned_or_immutable_root" | null
  operation_class?: "owner_managed_namespace" | "routing_only_namespace" | "pirate_delegated_namespace" | "owner_signed_updates_namespace" | null
  nameservers?: string[]
  observation_provider?: string | null
  failure_reason?: string | null
}

export type HnsPublishTxtResult = {
  root_label?: string
  zone_name?: string
  challenge_name?: string
  challenge_txt_value?: string
  zone_created?: boolean
  nameservers?: string[]
  observation_provider?: string | null
}

export type HnsEnsureZoneResult = {
  root_label?: string
  zone_name?: string
  zone_created?: boolean
  nameservers?: string[]
  observation_provider?: string | null
}

export type HnsVerifyTxtResult = {
  verified?: boolean
  observation_provider?: string | null
  failure_reason?: string | null
  observed_values?: string[]
  root_exists?: boolean | null
  root_control_verified?: boolean | null
  expiry_horizon_sufficient?: boolean | null
  routing_enabled?: boolean | null
  pirate_dns_authority_verified?: boolean | null
  control_class?: "single_holder_root" | "multisig_controlled_root" | "dao_controlled_root" | "burned_or_immutable_root" | null
  operation_class?: "owner_managed_namespace" | "routing_only_namespace" | "pirate_delegated_namespace" | "owner_signed_updates_namespace" | null
  root_label?: string
  zone_name?: string
  challenge_name?: string
}

const MAX_HNS_ROOT_LABEL_LENGTH = 63
const PLATFORM_MANAGED_HNS_ROOTS = new Set(["pirate", "clawitzer"])

export function assertHnsRootLabel(value: string): void {
  if (!value || value.length > MAX_HNS_ROOT_LABEL_LENGTH) {
    throw badRequestError("HNS root label must be a protocol root label")
  }

  if (value.startsWith("-") || value.endsWith("-") || value.includes(".") || value.includes("--")) {
    throw badRequestError("HNS root label must be a protocol root label")
  }

  if (!/^[a-z0-9-]+$/u.test(value)) {
    throw badRequestError("HNS root label must be a protocol root label")
  }
}

export function getHnsVerifierBaseUrl(env: Env): string | null {
  const raw = env.HNS_VERIFIER_BASE_URL?.trim()
  if (!raw) {
    return null
  }

  const normalized = raw.replace(/\/+$/, "")
  if (
    normalized.endsWith("/inspect")
    || normalized.endsWith("/publish-txt")
    || normalized.endsWith("/verify-txt")
  ) {
    throw providerUnavailable(`HNS_VERIFIER_BASE_URL must be the base URL without a path suffix. Got: ${raw}`)
  }

  return normalized
}

function getHnsVerifierAuthToken(env: Env): string | null {
  const raw = env.HNS_VERIFIER_AUTH_TOKEN?.trim()
  return raw || null
}

export function isHnsVerifierConfigured(env: Env): boolean {
  return getHnsVerifierBaseUrl(env) != null
}

export function shouldAutoProvisionHnsRoot(env: Env, rootLabel: string): boolean {
  const normalized = rootLabel.trim().toLowerCase()
  if (PLATFORM_MANAGED_HNS_ROOTS.has(normalized)) {
    return true
  }
  const configured = env.HNS_AUTO_PROVISION_ROOTS?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean) ?? []
  return configured.includes(normalized)
}

async function request<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const baseUrl = getHnsVerifierBaseUrl(env)
  if (!baseUrl) {
    throw providerUnavailable("HNS verifier is not configured")
  }

  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init?.body ? { "content-type": "application/json" } : {}),
  }

  const authToken = getHnsVerifierAuthToken(env)
  if (!authToken && isProductionEnv(env)) {
    throw providerUnavailable("HNS verifier auth token is not configured")
  }
  if (authToken) {
    headers.authorization = `Bearer ${authToken}`
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(10_000),
    headers: {
      ...headers,
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  const body = text.length > 0 ? JSON.parse(text) as T & { error?: string } : null

  if (!response.ok) {
    const message = body?.error || `HNS verifier request failed with status ${response.status}`
    throw providerUnavailable(message)
  }

  return body as T
}

export async function inspectHnsRoot(
  env: Env,
  input: {
    rootLabel: string
    challengeHost?: string | null
  },
): Promise<HnsInspectResult> {
  assertHnsRootLabel(input.rootLabel)
  const params = new URLSearchParams({
    root_label: input.rootLabel,
  })
  if (input.challengeHost?.trim()) {
    params.set("challenge_host", input.challengeHost.trim())
  }
  return request<HnsInspectResult>(env, `/inspect?${params.toString()}`)
}

export async function publishHnsTxtRecord(
  env: Env,
  input: {
    rootLabel: string
    challengeHost?: string | null
    challengeTxtValue: string
  },
): Promise<HnsPublishTxtResult> {
  assertHnsRootLabel(input.rootLabel)
  return request<HnsPublishTxtResult>(env, "/publish-txt", {
    method: "POST",
    body: JSON.stringify({
      root_label: input.rootLabel,
      challenge_host: input.challengeHost ?? null,
      challenge_txt_value: input.challengeTxtValue,
    }),
  })
}

export async function ensureHnsZone(
  env: Env,
  input: {
    rootLabel: string
  },
): Promise<HnsEnsureZoneResult> {
  assertHnsRootLabel(input.rootLabel)
  return request<HnsEnsureZoneResult>(env, "/ensure-zone", {
    method: "POST",
    body: JSON.stringify({
      root_label: input.rootLabel,
    }),
  })
}

export async function verifyHnsTxtRecord(
  env: Env,
  input: {
    rootLabel: string
    challengeHost?: string | null
    challengeTxtValue: string
  },
): Promise<HnsVerifyTxtResult> {
  assertHnsRootLabel(input.rootLabel)
  return request<HnsVerifyTxtResult>(env, "/verify-txt", {
    method: "POST",
    body: JSON.stringify({
      root_label: input.rootLabel,
      challenge_host: input.challengeHost ?? null,
      challenge_txt_value: input.challengeTxtValue,
    }),
  })
}
