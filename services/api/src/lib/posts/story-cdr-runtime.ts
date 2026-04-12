import type { AssetAccessProofResponse, Env } from "../../types"
import type { LockedDeliveryPayload } from "./community-asset-store"

const STORY_CDR_FETCH_TIMEOUT_MS = 15_000

function maybe(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim()
  return trimmed || null
}

function requireBytes32(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized.toLowerCase()
}

function requireAddress(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized
}

function requirePositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}_invalid`)
  }
  return value
}

function requireUintString(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized
}

function requireApiConfig(env: Env): { baseUrl: string; apiKey: string } {
  const baseUrl = maybe(env.STORY_CDR_API_BASE_URL)
  const apiKey = maybe(env.STORY_CDR_API_KEY)
  if (!baseUrl) {
    throw new Error("story_cdr_api_base_url_missing")
  }
  if (!apiKey) {
    throw new Error("story_cdr_api_key_missing")
  }
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
  }
}

export function hasStoryCdrApiConfigured(env: Env): boolean {
  return Boolean(maybe(env.STORY_CDR_API_BASE_URL) && maybe(env.STORY_CDR_API_KEY))
}

function createStoryCdrTimeoutSignal(): AbortSignal {
  return AbortSignal.timeout(STORY_CDR_FETCH_TIMEOUT_MS)
}

export async function writeLockedDeliveryToStoryCdr(input: {
  env: Env
  asset: {
    asset_id: string
    community_id: string
    story_asset_version_id: string | null
    story_namespace: string | null
  }
  storyCdrVaultUuid: number
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  lockedDeliveryPayload: LockedDeliveryPayload
}): Promise<string> {
  const { baseUrl, apiKey } = requireApiConfig(input.env)
  const storyAssetVersionId = requireBytes32(input.asset.story_asset_version_id, "story_asset_version_id")
  const storyNamespace = requireBytes32(input.asset.story_namespace, "story_namespace")
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/locked-assets/write`, {
      method: "POST",
      signal: createStoryCdrTimeoutSignal(),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        asset_id: input.asset.asset_id,
        community_id: input.asset.community_id,
        story_asset_version_id: storyAssetVersionId,
        story_namespace: storyNamespace,
        cdr_vault_uuid: requirePositiveInt(input.storyCdrVaultUuid, "story_cdr_vault_uuid"),
        entitlement_token_id: requireUintString(input.storyEntitlementTokenId, "story_entitlement_token_id"),
        read_condition: requireAddress(input.storyReadCondition, "story_read_condition"),
        write_condition: requireAddress(input.storyWriteCondition, "story_write_condition"),
        // The private CDR adapter currently receives the recovery key over this authenticated channel.
        // If the adapter is compromised, it can decrypt locked assets for which it stores recovery payloads.
        recovery_payload: {
          encrypted_blob_ref: input.lockedDeliveryPayload.encrypted_blob_ref,
          encrypted_blob_hash: input.lockedDeliveryPayload.encrypted_blob_hash,
          encrypted_blob_size_bytes: input.lockedDeliveryPayload.encrypted_blob_size_bytes,
          algorithm: input.lockedDeliveryPayload.algorithm,
          iv_base64: input.lockedDeliveryPayload.iv_base64,
          auth_tag_base64: input.lockedDeliveryPayload.auth_tag_base64,
          content_key_base64: input.lockedDeliveryPayload.content_key_base64,
          source_mime_type: input.lockedDeliveryPayload.source_mime_type,
          source_size_bytes: input.lockedDeliveryPayload.source_size_bytes,
          source_content_hash: input.lockedDeliveryPayload.source_content_hash,
          source_storage_ref: input.lockedDeliveryPayload.source_storage_ref,
        },
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("story_cdr_write_timeout")
    }
    throw error
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`story_cdr_write_http_error:${response.status}:${raw.slice(0, 500)}`)
  }
  const payload = raw ? JSON.parse(raw) as { delivery_ref?: unknown } : null
  const deliveryRef = String(payload?.delivery_ref || "").trim()
  if (!deliveryRef) {
    throw new Error("story_cdr_write_delivery_ref_missing")
  }
  return deliveryRef
}

export async function readLockedDeliveryFromStoryCdr(input: {
  env: Env
  deliveryRef: string
  accessProof: AssetAccessProofResponse
}): Promise<{
  contentKeyBase64: string
}> {
  const { baseUrl, apiKey } = requireApiConfig(input.env)
  let response: Response
  try {
    response = await fetch(`${baseUrl}/v1/locked-assets/read`, {
      method: "POST",
      signal: createStoryCdrTimeoutSignal(),
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        delivery_ref: String(input.deliveryRef || "").trim(),
        access_proof: {
          signer_family: input.accessProof.signer_family,
          signer_address: input.accessProof.signer_address,
          verifier_contract: input.accessProof.verifier_contract,
          vault_uuid: input.accessProof.vault_uuid,
          namespace: input.accessProof.namespace,
          access_ref: input.accessProof.access_ref,
          scope: input.accessProof.scope,
          expiry: input.accessProof.expiry,
          digest: input.accessProof.digest,
          condition_data: input.accessProof.condition_data,
          access_aux_data: input.accessProof.access_aux_data,
          signature: input.accessProof.signature,
          proof: input.accessProof.proof,
        },
      }),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("story_cdr_read_timeout")
    }
    throw error
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`story_cdr_read_http_error:${response.status}:${raw.slice(0, 500)}`)
  }
  const payload = raw ? JSON.parse(raw) as {
    recovery_payload?: { content_key_base64?: unknown }
  } : null
  const contentKeyBase64 = String(payload?.recovery_payload?.content_key_base64 || "").trim()
  if (!contentKeyBase64) {
    throw new Error("story_cdr_read_content_key_missing")
  }
  return { contentKeyBase64 }
}
