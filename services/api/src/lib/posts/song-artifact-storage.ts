import { readFile } from "node:fs/promises"
import type { Env } from "../../types"
import { internalError } from "../errors"
import { resolveLocalSongArtifactUploadPath } from "./local-song-artifact-upload-storage"

const DEFAULT_IPFS_GATEWAY_URL = "https://psc.myfilebase.com/ipfs"

export function storageRefToFetchUrl(env: Env, storageRef: string): string {
  const trimmed = storageRef.trim()
  if (!trimmed) {
    throw new Error("artifact_storage_ref_missing")
  }
  if (trimmed.startsWith("ipfs://")) {
    return `${String(env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY_URL).trim().replace(/\/+$/, "")}/${trimmed.slice("ipfs://".length)}`
  }
  return trimmed
}

export async function readStoredSongArtifactBytes(env: Env, storageRef: string): Promise<Uint8Array> {
  const trimmed = storageRef.trim()
  if (!trimmed) {
    throw new Error("song_audio_storage_ref_missing")
  }

  const localStubPrefix = "ipfs://local-song-artifact-upload/"
  if (trimmed.startsWith(localStubPrefix)) {
    const uploadId = trimmed.slice(localStubPrefix.length)
    if (!uploadId) {
      throw new Error("local_song_audio_missing")
    }
    return new Uint8Array(await readFile(await resolveLocalSongArtifactUploadPath({
      env,
      uploadId,
    })))
  }

  const response = await fetch(storageRefToFetchUrl(env, trimmed))
  if (!response.ok) {
    throw new Error(`song_audio_fetch_failed:${response.status}`)
  }
  return new Uint8Array(await response.arrayBuffer())
}

export function requireStoredSongArtifactUploadId(storageRef: string): string {
  const trimmed = storageRef.trim()
  const localStubPrefix = "ipfs://local-song-artifact-upload/"
  if (!trimmed.startsWith(localStubPrefix)) {
    throw internalError("Local song artifact upload id is unavailable for this storage ref")
  }
  const uploadId = trimmed.slice(localStubPrefix.length)
  if (!uploadId) {
    throw internalError("Local song artifact upload id is missing")
  }
  return uploadId
}
