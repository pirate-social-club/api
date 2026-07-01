import type { Env } from "../../../env"
import { providerUnavailable } from "../../errors"
import { sha256Hex } from "../../crypto"
import { buildS3SignedRequest, EMPTY_SHA256_HEX, type S3SigningConfig } from "../../storage/s3-signing"

export type LiveRoomRecordingRawArtifactRef = {
  provider: "agora_capture" | "filebase"
  bucket: string
  object_key: string
  endpoint: string
  content_hash: string
  ipfs_cid: string | null
  mime_type: string
  size_bytes: number
}

export const LIVE_ROOM_REPLAY_RAW_MAX_BYTES = 256 * 1024 * 1024

export async function ingestAgoraRecordingToPrivateStorage(input: {
  env: Env
  communityId: string
  liveRoomId: string
  recordingId: string
  agoraStopResponse: Record<string, unknown> | null
}): Promise<LiveRoomRecordingRawArtifactRef> {
  const sourceObjectKey = selectAgoraRecordingObjectKey(input.agoraStopResponse)
  if (!sourceObjectKey) {
    throw providerUnavailable("Agora recording stop response did not include a replay media file")
  }
  const source = await fetchCaptureObjectBytes({
    env: input.env,
    objectKey: sourceObjectKey,
    maxBytes: LIVE_ROOM_REPLAY_RAW_MAX_BYTES,
  })
  const mimeType = mimeTypeForObjectKey(sourceObjectKey)
  const captureConfig = resolveAgoraCaptureS3Config(input.env)
  return {
    provider: "agora_capture",
    bucket: captureConfig.bucket,
    object_key: sourceObjectKey,
    endpoint: captureConfig.endpoint.toString(),
    content_hash: `0x${await sha256Hex(source)}`,
    ipfs_cid: null,
    mime_type: mimeType,
    size_bytes: source.byteLength,
  }
}

export function serializeLiveRoomRecordingRawArtifactRef(ref: LiveRoomRecordingRawArtifactRef): string {
  return JSON.stringify(ref)
}

export function selectAgoraRecordingObjectKey(response: Record<string, unknown> | null): string | null {
  const candidates = collectAgoraFileNames(response)
  return candidates.find((candidate) => candidate.toLowerCase().endsWith(".mp4"))
    ?? candidates.find((candidate) => candidate.toLowerCase().endsWith(".m3u8"))
    ?? candidates[0]
    ?? null
}

function collectAgoraFileNames(value: unknown): string[] {
  const found: string[] = []
  visit(value)
  return [...new Set(found.map((item) => item.replace(/^\/+/, "")).filter(Boolean))]

  function visit(current: unknown): void {
    if (typeof current === "string") {
      if (looksLikeRecordingFile(current)) {
        found.push(current)
      }
      return
    }
    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item)
      }
      return
    }
    if (!current || typeof current !== "object") {
      return
    }
    const record = current as Record<string, unknown>
    for (const key of ["fileName", "filename", "file", "objectKey", "object_key"]) {
      visit(record[key])
    }
    for (const key of ["fileList", "file_list", "files", "serverResponse"]) {
      visit(record[key])
    }
  }
}

function looksLikeRecordingFile(value: string): boolean {
  return /\.(mp4|m3u8|aac|ts)$/i.test(value.trim())
}

async function fetchCaptureObjectBytes(input: {
  env: Env
  objectKey: string
  maxBytes?: number
}): Promise<Uint8Array> {
  const response = await fetchLiveRoomRecordingCaptureObject({
    env: input.env,
    objectKey: input.objectKey,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw providerUnavailable(
      `Agora capture artifact fetch failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }
  const contentLength = Number(response.headers.get("content-length") ?? "")
  if (input.maxBytes && Number.isFinite(contentLength) && contentLength > input.maxBytes) {
    throw providerUnavailable(`Replay recording exceeds the ${Math.floor(input.maxBytes / (1024 * 1024))}MB limit`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (input.maxBytes && bytes.byteLength > input.maxBytes) {
    throw providerUnavailable(`Replay recording exceeds the ${Math.floor(input.maxBytes / (1024 * 1024))}MB limit`)
  }
  return bytes
}

export async function fetchLiveRoomRecordingCaptureObject(input: {
  env: Env
  objectKey: string
  rangeHeader?: string | null
}): Promise<Response> {
  const rangeHeader = input.rangeHeader?.trim()
  const request = await buildS3SignedRequest({
    method: "GET",
    config: resolveAgoraCaptureS3Config(input.env),
    objectKey: input.objectKey,
    payloadHash: EMPTY_SHA256_HEX,
    headers: rangeHeader ? { range: rangeHeader } : undefined,
  })
  return await fetch(request)
}

function resolveAgoraCaptureS3Config(env: Env): S3SigningConfig {
  const endpoint = trimRequired(
    env.AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT,
    "AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT is not configured",
  )
  return {
    accessKey: trimRequired(
      env.AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY,
      "AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY is not configured",
    ),
    secretKey: trimRequired(
      env.AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY,
      "AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY is not configured",
    ),
    bucket: trimRequired(
      env.AGORA_CLOUD_RECORDING_STORAGE_BUCKET,
      "AGORA_CLOUD_RECORDING_STORAGE_BUCKET is not configured",
    ),
    endpoint: new URL(endpoint),
    region: trimRequired(
      env.AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION,
      "AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION is not configured",
    ),
  }
}

function mimeTypeForObjectKey(objectKey: string): string {
  const lower = objectKey.toLowerCase()
  if (lower.endsWith(".mp4")) {
    return "video/mp4"
  }
  if (lower.endsWith(".m3u8")) {
    return "application/vnd.apple.mpegurl"
  }
  if (lower.endsWith(".aac")) {
    return "audio/aac"
  }
  if (lower.endsWith(".ts")) {
    return "video/mp2t"
  }
  return "application/octet-stream"
}

function trimRequired(value: string | undefined, message: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw providerUnavailable(message)
  }
  return trimmed
}
