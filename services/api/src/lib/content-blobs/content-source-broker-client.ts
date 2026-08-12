import type { Env } from "../../env"
import {
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  contentSourceObjectKey,
} from "@pirate/content-source-protocol"
import { conflictError, providerUnavailable } from "../errors"

export const CONTENT_SOURCE_STORAGE_PROVIDER = "cloudflare_r2_private"
export { CONTENT_SOURCE_STORAGE_NAMESPACE }
export const CONTENT_SOURCE_STORAGE_ENDPOINT = "service://content-source-broker"

type StoredContentSource = {
  object: "content_source_object"
  content_blob: string
  status: "stored"
  storage_namespace: string
  storage_object_key: string
  size_bytes: number
  content_sha256: string
}

function requireBroker(env: Env): { service: Fetcher; secret: string } {
  const secret = env.CONTENT_SOURCE_BROKER_SHARED_SECRET?.trim() ?? ""
  if (!env.CONTENT_SOURCE_BROKER || !secret) {
    throw providerUnavailable("Content source storage is not configured")
  }
  return { service: env.CONTENT_SOURCE_BROKER, secret }
}

export function assertContentSourceBrokerConfigured(env: Env): void {
  requireBroker(env)
}

function isStoredContentSource(value: unknown, expected: {
  contentBlobId: string
  sizeBytes: number
  sha256: string
}): value is StoredContentSource {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return record.object === "content_source_object"
    && record.content_blob === expected.contentBlobId
    && record.status === "stored"
    && record.storage_namespace === CONTENT_SOURCE_STORAGE_NAMESPACE
    && record.storage_object_key === contentSourceObjectKey(expected.contentBlobId)
    && record.size_bytes === expected.sizeBytes
    && record.content_sha256 === expected.sha256
}

export async function storeContentSource(input: {
  env: Env
  contentBlobId: string
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
}): Promise<{
  storageProvider: string
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  contentHash: string
}> {
  const { service, secret } = requireBroker(input.env)
  let response: Response
  try {
    response = await service.fetch(new Request(
      `https://content-source-broker.internal/objects/${encodeURIComponent(input.contentBlobId)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/octet-stream",
          "content-length": String(input.bytes.byteLength),
          "x-content-sha256": input.sha256,
          "x-content-size": String(input.bytes.byteLength),
        },
        body: input.bytes,
      },
    ))
  } catch {
    throw providerUnavailable("Content source storage is unavailable")
  }
  if (response.status === 409) {
    throw conflictError("Content source storage conflicts with the verified upload")
  }
  if (!response.ok) {
    throw providerUnavailable(`Content source storage failed with status ${response.status}`)
  }

  const result = await response.json().catch(() => null)
  if (!isStoredContentSource(result, {
    contentBlobId: input.contentBlobId,
    sizeBytes: input.bytes.byteLength,
    sha256: input.sha256,
  })) {
    throw providerUnavailable("Content source storage returned invalid evidence")
  }
  return {
    storageProvider: CONTENT_SOURCE_STORAGE_PROVIDER,
    storageBucket: CONTENT_SOURCE_STORAGE_NAMESPACE,
    storageObjectKey: result.storage_object_key,
    storageEndpoint: CONTENT_SOURCE_STORAGE_ENDPOINT,
    contentHash: `0x${input.sha256}`,
  }
}
