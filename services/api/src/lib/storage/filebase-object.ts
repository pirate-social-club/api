import type { Env } from "../../env"
import { sha256Hex, toArrayBuffer } from "../crypto"
import { badRequestError, providerUnavailable } from "../errors"
import { readFilebaseCid } from "./filebase-cid"
import { resolveFilebaseConfig } from "./filebase-config"
import { fetchFilebaseWithTimeout } from "./filebase-multipart"
import { buildS3SignedRequest } from "./s3-signing"

export async function uploadFilebaseObject(input: {
  env: Env
  objectKey: string
  mimeType: string
  bytes: Uint8Array
  payloadHashHex?: string | null
}): Promise<{
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  contentHash: string
  ipfsCid: string
}> {
  const normalizedMimeType = input.mimeType.trim().toLowerCase()
  const suppliedHash = input.payloadHashHex?.trim().replace(/^0x/i, "").toLowerCase() || null
  if (suppliedHash && !/^[a-f0-9]{64}$/.test(suppliedHash)) {
    throw badRequestError("payloadHashHex must be a SHA-256 hex digest")
  }
  const payloadHash = suppliedHash ?? await sha256Hex(input.bytes)
  const request = await buildS3SignedRequest({
    method: "PUT",
    config: resolveFilebaseConfig(input.env),
    objectKey: input.objectKey,
    payloadHash,
    headers: {
      "content-type": normalizedMimeType,
    },
    body: toArrayBuffer(input.bytes),
  })
  const response = await fetchFilebaseWithTimeout(request, "Filebase object upload")
  if (!response.ok) {
    const responseText = await response.text().catch(() => "")
    throw providerUnavailable(
      `Filebase object upload failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  const ipfsCid = await readFilebaseCid({ response })
  const config = resolveFilebaseConfig(input.env)
  return {
    storageBucket: config.bucket,
    storageObjectKey: input.objectKey,
    storageEndpoint: config.endpoint.toString(),
    contentHash: `0x${payloadHash}`,
    ipfsCid,
  }
}
