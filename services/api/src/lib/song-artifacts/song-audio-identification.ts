import type { Env, SongArtifactUpload } from "../../types"
import { fetchSongArtifactBytes } from "./song-artifact-storage"
import { trimEnv, type AudioIdentificationOutcome } from "./song-artifact-analysis-types"

async function buildAcrCloudSignature(
  secret: string,
  stringToSign: string,
): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(stringToSign))
  const bytes = new Uint8Array(signature)
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function identifyAudioWithAcrCloud(input: {
  env: Env
  upload: SongArtifactUpload
}): Promise<Record<string, unknown> | null> {
  const accessKey = trimEnv(input.env.ACRCLOUD_ACCESS_KEY)
  const accessSecret = trimEnv(input.env.ACRCLOUD_ACCESS_SECRET)
  const host = trimEnv(input.env.ACRCLOUD_HOST)
  if (!accessKey || !accessSecret || !host || !input.upload.storage_object_key) {
    return {
      provider: "acrcloud",
      error: "missing_configuration",
    }
  }

  const path = trimEnv(input.env.ACRCLOUD_IDENTIFY_PATH) || "/v1/identify"
  const endpoint = `https://${host.replace(/^https?:\/\//, "").replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`
  const timestamp = Math.floor(Date.now() / 1000).toString()
  const stringToSign = ["POST", path.startsWith("/") ? path : `/${path}`, accessKey, "audio", "1", timestamp].join("\n")
  const signature = await buildAcrCloudSignature(accessSecret, stringToSign)
  const contentResponse = await fetchSongArtifactBytes({
    env: input.env,
    objectKey: input.upload.storage_object_key,
  })
  const contentType = input.upload.mime_type || "application/octet-stream"
  const content = await contentResponse.arrayBuffer()
  const body = new FormData()
  body.set("access_key", accessKey)
  body.set("sample_bytes", String(content.byteLength))
  body.set("timestamp", timestamp)
  body.set("signature", signature)
  body.set("data_type", "audio")
  body.set("signature_version", "1")
  body.set("sample", new File([content], input.upload.filename || "audio.bin", { type: contentType }))

  const timeoutMs = Number.parseInt(trimEnv(input.env.ACRCLOUD_TIMEOUT_MS) || "", 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body,
      signal: controller.signal,
    })
    if (!response.ok) {
      return {
        provider: "acrcloud",
        error: `http_${response.status}`,
      }
    }
    const parsed = await response.json().catch(() => null)
    if (!parsed || typeof parsed !== "object") {
      return {
        provider: "acrcloud",
        error: "invalid_response",
      }
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    return {
      provider: "acrcloud",
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

export async function evaluateAudioIdentification(input: {
  env: Env
  primaryAudioUpload: SongArtifactUpload
}): Promise<AudioIdentificationOutcome> {
  const providerResult = await identifyAudioWithAcrCloud({
    env: input.env,
    upload: input.primaryAudioUpload,
  })
  const providerFailed = Boolean(providerResult && typeof providerResult.error === "string")
  const missingConfiguration = providerResult?.error === "missing_configuration"
  const metadata = (providerResult as {
    metadata?: {
      music?: unknown[]
      custom_files?: unknown[]
    }
  } | null)?.metadata
  const matchFound = Boolean(
    (Array.isArray(metadata?.music) && metadata.music.length)
    || (Array.isArray(metadata?.custom_files) && metadata.custom_files.length),
  )

  return {
    analysisState: providerFailed
      ? missingConfiguration
        ? "allow"
        : "review_required"
      : matchFound
        ? "allow_with_required_reference"
        : "allow",
    moderationStatus: providerFailed ? "failed" : "completed",
    moderationError: providerFailed ? String(providerResult?.error || "ACRCloud identification failed") : null,
    moderationResult: {
      provider: "acrcloud",
      provider_result: providerResult,
      match_found: matchFound,
    },
  }
}
