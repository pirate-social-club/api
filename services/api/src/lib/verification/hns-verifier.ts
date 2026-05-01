import { badRequestError, providerUnavailable } from "../errors"
import { isProductionEnv } from "../helpers"
import type { Env } from "../../env"

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
const HNS_VERIFIER_TIMEOUT_MS = 12_000

export function normalizeHnsRootLabel(value: string): string {
  const normalized = value.trim().normalize("NFKC").toLowerCase()
  if (!normalized || normalized.includes(".")) {
    return normalized
  }

  if (/^[\x00-\x7F]+$/u.test(normalized) && !normalized.startsWith("xn--")) {
    return normalized
  }

  try {
    const hostname = new URL(`http://${normalized}.invalid`).hostname
    if (!hostname.endsWith(".invalid")) {
      return normalized
    }

    const asciiLabel = hostname.slice(0, -".invalid".length)
    return normalized.startsWith("xn--") && asciiLabel !== normalized ? normalized : asciiLabel
  } catch {
    return normalized
  }
}

export function assertHnsRootLabel(value: string): void {
  if (!value || value.length > MAX_HNS_ROOT_LABEL_LENGTH) {
    throw badRequestError("HNS root label must be a protocol root label")
  }

  if (value.startsWith("xn--")) {
    try {
      const hostname = new URL(`http://${value}.invalid`).hostname
      if (hostname !== `${value}.invalid`) {
        throw new Error("non-canonical IDNA root label")
      }
    } catch {
      throw badRequestError("HNS root label must be canonical IDNA ASCII")
    }
  }

  const verifyRange = value.startsWith("xn--") && value.length > "xn--".length
    ? value.slice("xn--".length)
    : value

  if (!verifyRange || verifyRange.startsWith("-") || verifyRange.endsWith("-") || value.includes(".") || verifyRange.includes("--")) {
    throw badRequestError("HNS root label must be a protocol root label")
  }

  if (!/^[a-z0-9-]+$/u.test(verifyRange)) {
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
    || normalized.endsWith("/inspect-public")
    || normalized.endsWith("/verify-txt")
    || normalized.endsWith("/verify-txt-public")
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

  let response: Response
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(HNS_VERIFIER_TIMEOUT_MS),
      headers: {
        ...headers,
        ...(init?.headers ?? {}),
      },
    })
  } catch (error) {
    if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
      throw providerUnavailable("HNS verifier request timed out")
    }
    throw error
  }

  const text = await response.text()
  let body: (T & { error?: string }) | null = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text) as T & { error?: string }
    } catch {
      const contentType = response.headers.get("content-type") ?? "unknown"
      throw providerUnavailable(
        `HNS verifier returned non-JSON response with status ${response.status} (${contentType})`,
        {
          verifier_origin: baseUrl,
          verifier_path: path,
        },
      )
    }
  }

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
  return request<HnsInspectResult>(env, `/inspect-public?${params.toString()}`)
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
  return request<HnsVerifyTxtResult>(env, "/verify-txt-public", {
    method: "POST",
    body: JSON.stringify({
      root_label: input.rootLabel,
      challenge_host: input.challengeHost ?? null,
      challenge_txt_value: input.challengeTxtValue,
    }),
  })
}
