import { badRequestError, internalError, providerUnavailable } from "../errors"
import type { Env } from "../../types"
import { sha256Hex } from "../crypto"
import { normalizeRootLabel } from "./labels"

export { normalizeRootLabel }

const SPACES_VERIFIER_TIMEOUT_MS = 8_000
const MAX_SPACES_ROOT_LABEL_LENGTH = 62

type SpacesInspectResponse = {
  root_exists?: boolean
  root_key_proof_verified?: boolean | null
  root_pubkey?: string | null
  control_class?: string | null
  operation_class?: string | null
  observation_provider?: string | null
  proof_payload?: Record<string, unknown> | null
  accepted_anchor_height?: number | null
  accepted_anchor_block_hash?: string | null
  accepted_anchor_root_hash?: string | null
  proof_root_hash?: string | null
  anchor_fresh_enough?: boolean | null
  failure_reason?: string | null
}

type SpacesVerifySignatureResponse = {
  valid_signature?: boolean
  wrong_signer?: boolean | null
  observation_provider?: string | null
  failure_reason?: string | null
}

export type SpacesInspection = {
  rootExists: boolean
  rootKeyProofVerified: boolean
  anchorFreshEnough: boolean | null
  acceptedAnchorHeight: number | null
  acceptedAnchorBlockHash: string | null
  acceptedAnchorRootHash: string | null
  proofRootHash: string | null
  rootPubkey: string | null
  controlClass: "single_holder_root" | "multisig_controlled_root" | "dao_controlled_root" | "burned_or_immutable_root" | null
  operationClass:
    | "owner_managed_namespace"
    | "routing_only_namespace"
    | "pirate_delegated_namespace"
    | "owner_signed_updates_namespace"
    | null
  observationProvider: string | null
  failureReason: string | null
  proofPayload: Record<string, unknown> | null
}

export type SpacesSignatureVerification = {
  validSignature: boolean
  wrongSigner: boolean
  observationProvider: string | null
  failureReason: string | null
}

export type SpacesChallengePayload = {
  kind: "schnorr_sign"
  domain: string
  root_label: string
  root_pubkey: string
  nonce: string
  issued_at: string
  expires_at: string
  message: string
  digest: string
}

function requireSpacesVerifierBaseUrl(env: Env): string {
  const baseUrl = String(env.SPACES_VERIFIER_BASE_URL || "").trim()
  if (!baseUrl) {
    throw internalError("SPACES_VERIFIER_BASE_URL is not configured")
  }
  return baseUrl
}

function getSpacesChallengeDomain(env: Env): string {
  return String(env.SPACES_VERIFIER_CHALLENGE_DOMAIN || "").trim() || "pirate.sc"
}

function assertSpacesRootLabel(value: string): void {
  if (!value || value.length > MAX_SPACES_ROOT_LABEL_LENGTH) {
    throw badRequestError("Spaces root label must be a protocol root label")
  }

  const verifyRange = value.startsWith("xn--") && value.length > "xn--".length
    ? value.slice("xn--".length)
    : value

  if (!verifyRange || verifyRange.startsWith("-") || verifyRange.endsWith("-") || verifyRange.includes("--")) {
    throw badRequestError("Spaces root label must be a protocol root label")
  }

  if (!/^[a-z0-9-]+$/u.test(verifyRange)) {
    throw badRequestError("Spaces root label must be a protocol root label")
  }
}

async function spacesVerifierRequest<T>(
  env: Env,
  input: {
    path: string
    method?: "GET" | "POST"
    body?: unknown
  },
): Promise<T> {
  const baseUrl = requireSpacesVerifierBaseUrl(env)
  const authToken = String(env.SPACES_VERIFIER_AUTH_TOKEN || "").trim()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SPACES_VERIFIER_TIMEOUT_MS)

  try {
    const url = new URL(baseUrl)
    const basePath = url.pathname.replace(/\/$/, "")
    const [pathname, search] = input.path.split("?", 2)
    url.pathname = `${basePath}${pathname}`
    url.search = search ? `?${search}` : ""

    const response = await fetch(url.toString(), {
      method: input.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(input.body ? { "content-type": "application/json" } : {}),
        ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    })

    const body = await response.json().catch(() => null)
    if (!response.ok) {
      const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
        ? body.error
        : "Spaces verifier request failed"
      if (response.status >= 500) {
        throw providerUnavailable(message)
      }
      if (response.status >= 400 && response.status < 500) {
        throw badRequestError(message)
      }
      throw internalError(message)
    }
    if (body == null || typeof body !== "object") {
      throw internalError("Spaces verifier returned an invalid response")
    }

    return body as T
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw providerUnavailable("Spaces verifier request timed out")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function inspectSpacesNamespace(env: Env, rootLabel: string): Promise<SpacesInspection> {
  const normalizedRootLabel = normalizeRootLabel(rootLabel)
  assertSpacesRootLabel(normalizedRootLabel)
  const result = await spacesVerifierRequest<SpacesInspectResponse>(env, {
    path: `/inspect?root_label=${encodeURIComponent(normalizedRootLabel)}`,
  })

  if (!("root_exists" in result)) {
    throw internalError("Spaces verifier inspect response missing root_exists")
  }

  return {
    rootExists: result.root_exists === true,
    rootKeyProofVerified: result.root_key_proof_verified === true,
    anchorFreshEnough: typeof result.anchor_fresh_enough === "boolean" ? result.anchor_fresh_enough : null,
    acceptedAnchorHeight: typeof result.accepted_anchor_height === "number" ? result.accepted_anchor_height : null,
    acceptedAnchorBlockHash: typeof result.accepted_anchor_block_hash === "string" ? result.accepted_anchor_block_hash : null,
    acceptedAnchorRootHash: typeof result.accepted_anchor_root_hash === "string" ? result.accepted_anchor_root_hash : null,
    proofRootHash: typeof result.proof_root_hash === "string" ? result.proof_root_hash : null,
    rootPubkey: typeof result.root_pubkey === "string" ? result.root_pubkey : null,
    controlClass: (result.control_class as SpacesInspection["controlClass"]) ?? null,
    operationClass: (result.operation_class as SpacesInspection["operationClass"]) ?? null,
    observationProvider: typeof result.observation_provider === "string" ? result.observation_provider : null,
    failureReason: typeof result.failure_reason === "string" ? result.failure_reason : null,
    proofPayload: result.proof_payload && typeof result.proof_payload === "object" ? result.proof_payload : null,
  }
}

export async function verifySpacesSignature(
  env: Env,
  input: {
    digest: string
    signature: string
    rootPubkey: string
    signerPubkey?: string | null
  },
): Promise<SpacesSignatureVerification> {
  const result = await spacesVerifierRequest<SpacesVerifySignatureResponse>(env, {
    path: "/verify-signature",
    method: "POST",
    body: {
      digest: input.digest,
      signature: input.signature,
      root_pubkey: input.rootPubkey,
      signer_pubkey: input.signerPubkey ?? null,
    },
  })

  if (!("valid_signature" in result)) {
    throw internalError("Spaces verifier signature response missing valid_signature")
  }

  return {
    validSignature: result.valid_signature === true,
    wrongSigner: result.wrong_signer === true,
    observationProvider: typeof result.observation_provider === "string" ? result.observation_provider : null,
    failureReason: typeof result.failure_reason === "string" ? result.failure_reason : null,
  }
}

function randomNonceHex(bytes = 16): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(value, (part) => part.toString(16).padStart(2, "0")).join("")
}

export async function mintSpacesChallenge(
  env: Env,
  normalizedRootLabel: string,
  rootPubkey: string,
  sessionId: string,
): Promise<{
  challengeExpiresAt: string
  challengePayload: SpacesChallengePayload
}> {
  if (!rootPubkey.trim()) {
    throw internalError("cannot mint Spaces challenge without a root public key")
  }

  const issuedAt = new Date()
  const challengeExpiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000).toISOString()
  const domain = getSpacesChallengeDomain(env)
  const nonce = `pirate-space-verify=${sessionId}:${randomNonceHex()}`
  const issuedAtIso = issuedAt.toISOString()
  const message = [
    "pirate.space.verify",
    `root=@${normalizeRootLabel(normalizedRootLabel)}`,
    `root_pubkey=${rootPubkey}`,
    `nonce=${nonce}`,
    `issued_at=${issuedAtIso}`,
    `expires_at=${challengeExpiresAt}`,
    `domain=${domain}`,
  ].join("\n")

  return {
    challengeExpiresAt,
    challengePayload: {
      kind: "schnorr_sign",
      domain,
      root_label: normalizeRootLabel(normalizedRootLabel),
      root_pubkey: rootPubkey,
      nonce,
      issued_at: issuedAtIso,
      expires_at: challengeExpiresAt,
      message,
      digest: await sha256Hex(message),
    },
  }
}
