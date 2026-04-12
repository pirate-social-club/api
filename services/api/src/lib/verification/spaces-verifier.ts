import { internalError, notImplementedError } from "../errors"
import { isLocalEnvironment } from "../helpers"
import type { Env } from "../../types"

export type SpacesNamespaceObservation = {
  rootExists: boolean
  rootKeyProofVerified: boolean
  anchorFreshEnough: boolean
  acceptedAnchorHeight: number | null
  acceptedAnchorBlockHash: string | null
  acceptedAnchorRootHash: string | null
  proofRootHash: string | null
  rootPubkey: string | null
  controlClass: "single_holder_root" | "multisig_controlled_root" | "dao_controlled_root" | "burned_or_immutable_root" | null
  operationClass: "owner_managed_namespace" | "routing_only_namespace" | "pirate_delegated_namespace" | "owner_signed_updates_namespace" | null
  observationProvider: string
  evidenceBundleRef: string | null
  failureReason: string | null
  proofPayload: string | null
}

export type SpacesSignatureVerification = {
  validSignature: boolean
  wrongSigner: boolean
  observationProvider: string
  failureReason: string | null
}

type SpacesVerifierInspectResponse = {
  root_exists?: boolean
  root_key_proof_verified?: boolean
  anchor_fresh_enough?: boolean
  accepted_anchor_height?: number | null
  accepted_anchor_block_hash?: string | null
  accepted_anchor_root_hash?: string | null
  proof_root_hash?: string | null
  root_pubkey?: string | null
  control_class?: SpacesNamespaceObservation["controlClass"]
  operation_class?: SpacesNamespaceObservation["operationClass"]
  observation_provider?: string | null
  evidence_bundle_ref?: string | null
  failure_reason?: string | null
  proof_payload?: unknown
}

type SpacesVerifierVerifyResponse = {
  valid_signature?: boolean
  wrong_signer?: boolean
  observation_provider?: string | null
  failure_reason?: string | null
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean"
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value)
}

function appendQuery(url: string, key: string, value: string) {
  return `${url}${url.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(value)}`
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "")
}

function normalizeVerifierServiceBaseUrl(value: string) {
  const trimmed = trimTrailingSlash(value.trim())
  if (trimmed.endsWith("/inspect")) {
    return trimmed.slice(0, -"/inspect".length)
  }
  if (trimmed.endsWith("/verify-signature")) {
    return trimmed.slice(0, -"/verify-signature".length)
  }
  return trimmed
}

function buildInspectUrl(verifierBaseUrl: string, normalizedRootLabel: string) {
  return appendQuery(`${normalizeVerifierServiceBaseUrl(verifierBaseUrl)}/inspect`, "root_label", normalizedRootLabel)
}

function buildVerifySignatureUrl(verifierBaseUrl: string) {
  return `${normalizeVerifierServiceBaseUrl(verifierBaseUrl)}/verify-signature`
}

export function buildStubSpacesRootPubkey(normalizedRootLabel: string) {
  return `stub-spaces-pubkey:${normalizedRootLabel}`
}

export function buildStubSpacesSignature(input: {
  digest: string
  rootPubkey: string
}) {
  return `stub-schnorr:${input.rootPubkey}:${input.digest}`
}

function stubVerificationEnabled(env: Env) {
  const enabled = env.ALLOW_STUB_NAMESPACE_VERIFICATION === "true"
  if (enabled && !isLocalEnvironment(env.ENVIRONMENT)) {
    throw internalError("ALLOW_STUB_NAMESPACE_VERIFICATION is only allowed in local environments")
  }
  return enabled
}

export async function inspectSpacesNamespace(input: {
  env: Env
  normalizedRootLabel: string
}): Promise<SpacesNamespaceObservation> {
  if (stubVerificationEnabled(input.env)) {
    return {
      rootExists: true,
      rootKeyProofVerified: true,
      anchorFreshEnough: true,
      acceptedAnchorHeight: 1_000_000,
      acceptedAnchorBlockHash: "stub-spaces-anchor-block",
      acceptedAnchorRootHash: "stub-spaces-anchor-root",
      proofRootHash: "stub-spaces-proof-root",
      rootPubkey: buildStubSpacesRootPubkey(input.normalizedRootLabel),
      controlClass: "single_holder_root",
      operationClass: "owner_managed_namespace",
      observationProvider: "explicit_stub",
      evidenceBundleRef: null,
      failureReason: null,
      proofPayload: JSON.stringify({
        root_label: input.normalizedRootLabel,
        proof: "stub",
      }),
    }
  }

  const verifierBaseUrl = input.env.SPACES_VERIFIER_BASE_URL?.trim()
  if (!verifierBaseUrl) {
    throw notImplementedError("Spaces verifier is not configured")
  }

  let response: Response
  try {
    response = await fetch(buildInspectUrl(verifierBaseUrl, input.normalizedRootLabel), {
      headers: {
        accept: "application/json",
        ...(input.env.SPACES_VERIFIER_AUTH_TOKEN
          ? {
              authorization: `Bearer ${input.env.SPACES_VERIFIER_AUTH_TOKEN}`,
            }
          : {}),
      },
    })
  } catch {
    throw internalError("Spaces verifier request failed")
  }

  let body: SpacesVerifierInspectResponse | null = null
  try {
    body = await response.json() as SpacesVerifierInspectResponse
  } catch {
    body = null
  }

  if (!response.ok || !body) {
    throw internalError("Spaces verifier returned an invalid response")
  }

  if (
    !isBoolean(body.root_exists)
    || !isBoolean(body.root_key_proof_verified)
    || !isBoolean(body.anchor_fresh_enough)
    || typeof body.observation_provider !== "string"
    || body.observation_provider.trim() === ""
  ) {
    throw internalError("Spaces verifier response is incomplete")
  }

  return {
    rootExists: body.root_exists,
    rootKeyProofVerified: body.root_key_proof_verified,
    anchorFreshEnough: body.anchor_fresh_enough,
    acceptedAnchorHeight: body.accepted_anchor_height == null
      ? null
      : isInteger(body.accepted_anchor_height)
        ? body.accepted_anchor_height
        : null,
    acceptedAnchorBlockHash: typeof body.accepted_anchor_block_hash === "string" ? body.accepted_anchor_block_hash : null,
    acceptedAnchorRootHash: typeof body.accepted_anchor_root_hash === "string" ? body.accepted_anchor_root_hash : null,
    proofRootHash: typeof body.proof_root_hash === "string" ? body.proof_root_hash : null,
    rootPubkey: typeof body.root_pubkey === "string" ? body.root_pubkey : null,
    controlClass: body.control_class ?? null,
    operationClass: body.operation_class ?? null,
    observationProvider: body.observation_provider,
    evidenceBundleRef: body.evidence_bundle_ref ?? null,
    failureReason: body.failure_reason ?? null,
    proofPayload: body.proof_payload == null ? null : JSON.stringify(body.proof_payload),
  }
}

export async function verifySpacesNamespaceSignature(input: {
  env: Env
  normalizedRootLabel: string
  digest: string
  signature: string
  rootPubkey: string
  signerPubkey?: string | null
  algorithm?: string | null
}): Promise<SpacesSignatureVerification> {
  if (stubVerificationEnabled(input.env)) {
    const expectedSignature = buildStubSpacesSignature({
      digest: input.digest,
      rootPubkey: input.rootPubkey,
    })
    return {
      validSignature: input.signature === expectedSignature,
      wrongSigner: input.signerPubkey != null && input.signerPubkey !== input.rootPubkey,
      observationProvider: "explicit_stub",
      failureReason: input.signature === expectedSignature
        ? null
        : input.signerPubkey != null && input.signerPubkey !== input.rootPubkey
          ? "wrong_signer"
          : "invalid_signature",
    }
  }

  const verifierBaseUrl = input.env.SPACES_VERIFIER_BASE_URL?.trim()
  if (!verifierBaseUrl) {
    throw notImplementedError("Spaces verifier is not configured")
  }

  let response: Response
  try {
    response = await fetch(buildVerifySignatureUrl(verifierBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(input.env.SPACES_VERIFIER_AUTH_TOKEN
          ? {
              authorization: `Bearer ${input.env.SPACES_VERIFIER_AUTH_TOKEN}`,
            }
          : {}),
      },
      body: JSON.stringify({
        digest: input.digest,
        signature: input.signature,
        root_pubkey: input.rootPubkey,
        signer_pubkey: input.signerPubkey ?? null,
        algorithm: input.algorithm ?? null,
      }),
    })
  } catch {
    throw internalError("Spaces verifier signature check failed")
  }

  let body: SpacesVerifierVerifyResponse | null = null
  try {
    body = await response.json() as SpacesVerifierVerifyResponse
  } catch {
    body = null
  }

  if (!response.ok || !body || !isBoolean(body.valid_signature)) {
    throw internalError("Spaces verifier signature response is invalid")
  }

  return {
    validSignature: body.valid_signature,
    wrongSigner: body.wrong_signer === true,
    observationProvider: typeof body.observation_provider === "string" && body.observation_provider.trim() !== ""
      ? body.observation_provider
      : "spaces_verifier",
    failureReason: body.failure_reason ?? null,
  }
}
