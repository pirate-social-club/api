import { createHmac } from "node:crypto"
import type { Env } from "../types"

export const ACRCLOUD_IDENTIFY_PATH = "/v1/identify"
export const ACRCLOUD_IDENTIFY_HOST = "identify-ap-southeast-1.acrcloud.com"
export const DEFAULT_ACRCLOUD_IDENTIFY_MAX_BYTES = 5_000_000
export const DEFAULT_ACRCLOUD_IDENTIFY_TIMEOUT_MS = 10_000

type AcrcloudResultObject = Record<string, unknown>

function requireNonEmptyEnv(value: string | undefined, name: string): string {
  const normalized = String(value || "").trim()
  if (!normalized) throw new Error(`${name}_missing`)
  return normalized
}

function arrayBufferToBinaryString(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let out = ""
  for (const byte of bytes) out += String.fromCharCode(byte)
  return out
}

async function hmacSha1Base64(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload))
  return btoa(arrayBufferToBinaryString(signature))
}

function buildIdentifySignaturePayload(accessKey: string, timestamp: string): string {
  return [
    "POST",
    ACRCLOUD_IDENTIFY_PATH,
    accessKey,
    "audio",
    "1",
    timestamp,
  ].join("\n")
}

function normalizeResultObjects(value: unknown): AcrcloudResultObject[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is AcrcloudResultObject => (
    !!entry && typeof entry === "object" && !Array.isArray(entry)
  ))
}

function asJsonObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function isAcrcloudEnabled(env: Env): boolean {
  return String(env.ACRCLOUD_ENABLED || "").trim() === "1"
}

export function isAcrcloudFailOpen(env: Env): boolean {
  return String(env.ACRCLOUD_FAIL_OPEN || "").trim() === "1"
}

export function resolveAcrcloudIdentifyMaxBytes(env: Env): number {
  const parsed = Number(String(env.ACRCLOUD_IDENTIFY_MAX_BYTES || "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACRCLOUD_IDENTIFY_MAX_BYTES
  return Math.trunc(parsed)
}

export function resolveAcrcloudIdentifyTimeoutMs(env: Env): number {
  const parsed = Number(String(env.ACRCLOUD_IDENTIFY_TIMEOUT_MS || "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ACRCLOUD_IDENTIFY_TIMEOUT_MS
  return Math.trunc(parsed)
}

export async function identifyAudioAgainstAcrcloud(params: {
  env: Env
  audioBytes: Uint8Array
}): Promise<{
  raw: unknown
  musicMatches: AcrcloudResultObject[]
  customMatches: AcrcloudResultObject[]
}> {
  const accessKey = requireNonEmptyEnv(params.env.ACR_ACCESS_KEY, "ACR_ACCESS_KEY")
  const accessSecret = requireNonEmptyEnv(params.env.ACR_SECRET_KEY, "ACR_SECRET_KEY")
  const maxBytes = resolveAcrcloudIdentifyMaxBytes(params.env as Env)
  if (params.audioBytes.byteLength > maxBytes) {
    throw new Error(`acrcloud_identify_payload_too_large:${params.audioBytes.byteLength}`)
  }

  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = await hmacSha1Base64(
    accessSecret,
    buildIdentifySignaturePayload(accessKey, timestamp),
  )

  const sampleBuffer = new Uint8Array(params.audioBytes).buffer as ArrayBuffer
  const sample = new File([sampleBuffer], "sample.mp3", { type: "audio/mpeg" })
  const form = new FormData()
  form.set("sample", sample)
  form.set("sample_bytes", String(params.audioBytes.byteLength))
  form.set("access_key", accessKey)
  form.set("data_type", "audio")
  form.set("signature_version", "1")
  form.set("signature", signature)
  form.set("timestamp", timestamp)

  const timeoutMs = resolveAcrcloudIdentifyTimeoutMs(params.env as Env)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`https://${ACRCLOUD_IDENTIFY_HOST}${ACRCLOUD_IDENTIFY_PATH}`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    })
    const text = await response.text()
    let raw: unknown = null
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error(`acrcloud_identify_invalid_json:${response.status}`)
    }
    if (!response.ok) {
      throw new Error(`acrcloud_identify_http_${response.status}`)
    }
    const parsed = asJsonObject(raw)
    const status = asJsonObject(parsed?.status)
    if (Number(status?.code ?? -1) !== 0) {
      throw new Error(`acrcloud_identify_status_${String(status?.code ?? "unknown")}`)
    }
    const metadata = asJsonObject(parsed?.metadata)
    return {
      raw,
      musicMatches: normalizeResultObjects(metadata?.music),
      customMatches: normalizeResultObjects(metadata?.custom_files),
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("acrcloud_identify_timeout")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export async function uploadAudioToAcrcloudBucket(params: {
  env: Env
  audioBytes: Uint8Array
  title: string
  userDefined?: Record<string, unknown>
}): Promise<{
  fileId: string | null
  acrid: string | null
  bucketState: number | null
  raw: unknown
}> {
  const token = requireNonEmptyEnv(params.env.ACR_CONSOLE_TOKEN, "ACR_CONSOLE_TOKEN")
  const bucketId = requireNonEmptyEnv(params.env.ACRCLOUD_CUSTOM_BUCKET_ID, "ACRCLOUD_CUSTOM_BUCKET_ID")

  const fileBuffer = new Uint8Array(params.audioBytes).buffer as ArrayBuffer
  const file = new File([fileBuffer], "master.mp3", { type: "audio/mpeg" })
  const form = new FormData()
  form.set("file", file)
  form.set("title", params.title.trim() || "Untitled")
  form.set("data_type", "audio")
  if (params.userDefined && Object.keys(params.userDefined).length > 0) {
    form.set("user_defined", JSON.stringify(params.userDefined))
  }

  const response = await fetch(`https://api-v2.acrcloud.com/api/buckets/${bucketId}/files`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: form,
  })
  const text = await response.text()
  let raw: unknown = null
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`acrcloud_bucket_upload_invalid_json:${response.status}`)
  }
  if (!response.ok) {
    throw new Error(`acrcloud_bucket_upload_http_${response.status}`)
  }
  const parsed = asJsonObject(raw)
  const data = asJsonObject(parsed?.data)
  return {
    fileId: data?.id == null ? null : String(data.id),
    acrid: typeof data?.acr_id === "string" ? data.acr_id : null,
    bucketState: typeof data?.state === "number" ? data.state : null,
    raw,
  }
}
