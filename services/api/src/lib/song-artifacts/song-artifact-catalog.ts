import type { Env } from "../../env"
import { trimEnv } from "../env-strings"
import type { SongArtifactBundle, SongArtifactUpload } from "../../types"
import { fetchSongArtifactBytes } from "./song-artifact-storage"

function extensionFromMimeType(mimeType: string | undefined): string {
  const normalized = String(mimeType || "").trim().toLowerCase()
  if (normalized === "audio/mpeg") {
    return "mp3"
  }
  if (normalized === "audio/wav" || normalized === "audio/x-wav") {
    return "wav"
  }
  if (normalized === "audio/flac") {
    return "flac"
  }
  if (normalized === "audio/aac") {
    return "aac"
  }
  return "bin"
}

function normalizeCatalogSyncResult(input: {
  bucketId: string
  synced: boolean
  attempted: boolean
  providerResult?: Record<string, unknown> | null
  error?: string | null
}): Record<string, unknown> {
  const providerResult = input.providerResult && typeof input.providerResult === "object"
    ? input.providerResult
    : null
  const data = providerResult && typeof providerResult.data === "object" && providerResult.data
    ? providerResult.data as Record<string, unknown>
    : null

  return {
    provider: "acrcloud_catalog",
    bucket_id: Number.parseInt(input.bucketId, 10) || input.bucketId,
    attempted: input.attempted,
    synced: input.synced,
    ...(typeof input.error === "string" && input.error ? { error: input.error } : {}),
    ...(data && "id" in data ? { file_id: data.id } : {}),
    ...(data && typeof data.acr_id === "string" ? { acr_id: data.acr_id } : {}),
    ...(data && typeof data.state === "number" ? { state: data.state } : {}),
    provider_result: providerResult,
  }
}

export async function syncSongBundleToAcrCloudCatalog(input: {
  env: Env
  communityId: string
  songArtifactBundleId: string
  bundle: SongArtifactBundle
  primaryAudioUpload?: SongArtifactUpload | null
}): Promise<Record<string, unknown>> {
  const token = trimEnv(input.env.ACRCLOUD_PERSONAL_ACCESS_TOKEN)
  const bucketId = trimEnv(input.env.ACRCLOUD_BUCKET_ID)
  const baseUrl = trimEnv(input.env.ACRCLOUD_CONSOLE_BASE_URL) || "https://api-v2.acrcloud.com/api"

  if (!token || !bucketId) {
    return normalizeCatalogSyncResult({
      bucketId,
      attempted: false,
      synced: false,
      error: "missing_configuration",
    })
  }

  const storageRef = String(input.bundle.primary_audio?.storage_ref || "").trim()
  if (!storageRef) {
    return normalizeCatalogSyncResult({
      bucketId,
      attempted: false,
      synced: false,
      error: "missing_primary_audio",
    })
  }

  try {
    const audioResponse = input.primaryAudioUpload?.storage_object_key
      ? await fetchSongArtifactBytes({
          env: input.env,
          objectKey: input.primaryAudioUpload.storage_object_key,
        })
      : await fetch(storageRef)
    if (!audioResponse.ok) {
      return normalizeCatalogSyncResult({
        bucketId,
        attempted: true,
        synced: false,
        error: `audio_fetch_http_${audioResponse.status}`,
      })
    }

    const audioBytes = await audioResponse.arrayBuffer()
    const mimeType = String(input.bundle.primary_audio?.mime_type || "application/octet-stream")
    const contentHash = String(input.bundle.primary_audio?.content_hash || "").trim()
    const title = String(input.bundle.title || "").trim() || `Pirate song ${input.songArtifactBundleId}`

    const body = new FormData()
    body.set(
      "file",
      new File([audioBytes], `${title}.${extensionFromMimeType(mimeType)}`, { type: mimeType }),
    )
    body.set("title", title)
    body.set("data_type", "audio")
    body.set("user_defined", JSON.stringify({
      source: "pirate",
      community_id: input.communityId,
      song_artifact_bundle_id: input.songArtifactBundleId,
      content_hash: contentHash || null,
      lyrics_sha256: input.bundle.lyrics_sha256 || null,
    }))

    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/buckets/${bucketId}/files`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
    })

    if (!response.ok) {
      return normalizeCatalogSyncResult({
        bucketId,
        attempted: true,
        synced: false,
        error: `http_${response.status}`,
      })
    }

    const providerResult = await response.json().catch(() => null)
    if (!providerResult || typeof providerResult !== "object") {
      return normalizeCatalogSyncResult({
        bucketId,
        attempted: true,
        synced: false,
        error: "invalid_response",
      })
    }

    return normalizeCatalogSyncResult({
      bucketId,
      attempted: true,
      synced: true,
      providerResult: providerResult as Record<string, unknown>,
    })
  } catch (error) {
    return normalizeCatalogSyncResult({
      bucketId,
      attempted: true,
      synced: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
