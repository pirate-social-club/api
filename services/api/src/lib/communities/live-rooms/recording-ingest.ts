import type { Env } from "../../../env"
import { providerUnavailable } from "../../errors"
import { uploadFilebaseObject } from "../../song-artifacts/song-artifact-storage"
import { buildS3SignedRequest, EMPTY_SHA256_HEX, type S3SigningConfig } from "../../storage/s3-signing"

export type LiveRoomRecordingRawArtifactRef = {
  provider: "filebase"
  bucket: string
  object_key: string
  endpoint: string
  content_hash: string
  ipfs_cid: string
  mime_type: string
  size_bytes: number
}

export async function ingestAgoraRecordingToFilebase(input: {
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
  })
  const mimeType = mimeTypeForObjectKey(sourceObjectKey)
  const destinationObjectKey = buildLiveRoomRecordingFilebaseObjectKey({
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
    recordingId: input.recordingId,
    sourceObjectKey,
  })
  const uploaded = await uploadFilebaseObject({
    env: input.env,
    objectKey: destinationObjectKey,
    mimeType,
    bytes: source,
  })
  return {
    provider: "filebase",
    bucket: uploaded.storageBucket,
    object_key: uploaded.storageObjectKey,
    endpoint: uploaded.storageEndpoint,
    content_hash: uploaded.contentHash,
    ipfs_cid: uploaded.ipfsCid,
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
}): Promise<Uint8Array> {
  const request = await buildS3SignedRequest({
    method: "GET",
    config: resolveAgoraCaptureS3Config(input.env),
    objectKey: input.objectKey,
    payloadHash: EMPTY_SHA256_HEX,
  })
  const response = await fetch(request)
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw providerUnavailable(
      `Agora capture artifact fetch failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
    )
  }
  return new Uint8Array(await response.arrayBuffer())
}

function resolveAgoraCaptureS3Config(env: Env): S3SigningConfig {
  const endpoint = trimRequired(env.AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT, "AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT is not configured")
  return {
    accessKey: trimRequired(env.AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY, "AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY is not configured"),
    secretKey: trimRequired(env.AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY, "AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY is not configured"),
    bucket: trimRequired(env.AGORA_CLOUD_RECORDING_STORAGE_BUCKET, "AGORA_CLOUD_RECORDING_STORAGE_BUCKET is not configured"),
    endpoint: new URL(endpoint),
    region: trimRequired(env.AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION, "AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION is not configured"),
  }
}

function buildLiveRoomRecordingFilebaseObjectKey(input: {
  communityId: string
  liveRoomId: string
  recordingId: string
  sourceObjectKey: string
}): string {
  const filename = input.sourceObjectKey.split("/").filter(Boolean).at(-1) ?? "recording.mp4"
  return [
    "livestream-recordings",
    sanitizePathSegment(input.communityId),
    sanitizePathSegment(input.liveRoomId),
    sanitizePathSegment(input.recordingId),
    sanitizePathSegment(filename),
  ].join("/")
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

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown"
}

function trimRequired(value: string | undefined, message: string): string {
  const trimmed = value?.trim()
  if (!trimmed) {
    throw providerUnavailable(message)
  }
  return trimmed
}
