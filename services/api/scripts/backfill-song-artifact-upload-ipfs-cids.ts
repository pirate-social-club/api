import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getControlPlaneClient } from "../src/lib/runtime-deps"
import { resolveFilebaseConfig } from "../src/lib/storage/filebase-config"
import { buildS3SignedRequest, EMPTY_SHA256_HEX } from "../src/lib/storage/s3-signing"
import { FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER } from "../src/lib/song-artifacts/song-artifact-storage-provider"

type CandidateUpload = {
  communityId: string
  songArtifactUploadId: string
  storageObjectKey: string
}

type Stats = {
  candidates: number
  updated: number
  dryRunMatches: number
  missingCid: number
  failed: number
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseLimit(value: string | null): number {
  if (!value) return 500
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --limit value: ${value}`)
  }
  return Math.min(parsed, 5000)
}

function normalizeOptionalArg(value: string | null): string | null {
  return value?.trim() || null
}

async function listCandidates(input: {
  communityId: string | null
  env: Env
  limit: number
  uploadId: string | null
}): Promise<CandidateUpload[]> {
  const filters: string[] = [
    "status = 'uploaded'",
    "storage_provider = ?1",
    "storage_object_key IS NOT NULL",
    "storage_object_key <> ''",
    "(ipfs_cid IS NULL OR ipfs_cid = '')",
  ]
  const args: unknown[] = [FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER]

  if (input.communityId) {
    args.push(input.communityId)
    filters.push(`community_id = ?${args.length}`)
  }
  if (input.uploadId) {
    args.push(input.uploadId)
    filters.push(`song_artifact_upload_id = ?${args.length}`)
  }
  args.push(input.limit)

  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT community_id, song_artifact_upload_id, storage_object_key
      FROM song_artifact_uploads
      WHERE ${filters.join("\n        AND ")}
      ORDER BY updated_at DESC, song_artifact_upload_id DESC
      LIMIT ?${args.length}
    `,
    args,
  })

  return result.rows.flatMap((row) => {
    const communityId = stringValue(row.community_id)
    const songArtifactUploadId = stringValue(row.song_artifact_upload_id)
    const storageObjectKey = stringValue(row.storage_object_key)
    return communityId && songArtifactUploadId && storageObjectKey
      ? [{ communityId, songArtifactUploadId, storageObjectKey }]
      : []
  })
}

async function readFilebaseIpfsCid(input: {
  env: Env
  storageObjectKey: string
}): Promise<string | null> {
  const request = await buildS3SignedRequest({
    method: "HEAD",
    config: resolveFilebaseConfig(input.env),
    objectKey: input.storageObjectKey,
    payloadHash: EMPTY_SHA256_HEX,
  })
  const response = await fetch(request)
  if (!response.ok) {
    throw new Error(`Filebase HEAD failed with status ${response.status}`)
  }
  return response.headers.get("x-amz-meta-cid")?.trim() || null
}

async function updateIpfsCid(input: {
  communityId: string
  env: Env
  ipfsCid: string
  songArtifactUploadId: string
}): Promise<void> {
  await getControlPlaneClient(input.env).execute({
    sql: `
      UPDATE song_artifact_uploads
      SET ipfs_cid = ?3,
          updated_at = CURRENT_TIMESTAMP
      WHERE community_id = ?1
        AND song_artifact_upload_id = ?2
    `,
    args: [input.communityId, input.songArtifactUploadId, input.ipfsCid],
  })
}

async function main(): Promise<void> {
  const env = {
    ...readDevVarsFromCwd(),
    ...process.env,
  } as unknown as Env
  const dryRun = !hasFlag("--execute")
  const communityId = normalizeOptionalArg(readArg("--community-id"))
  const uploadId = normalizeOptionalArg(readArg("--upload-id"))
  const limit = parseLimit(readArg("--limit"))
  const candidates = await listCandidates({ communityId, env, limit, uploadId })
  const stats: Stats = {
    candidates: candidates.length,
    dryRunMatches: 0,
    failed: 0,
    missingCid: 0,
    updated: 0,
  }

  for (const candidate of candidates) {
    try {
      const ipfsCid = await readFilebaseIpfsCid({
        env,
        storageObjectKey: candidate.storageObjectKey,
      })
      if (!ipfsCid) {
        stats.missingCid += 1
        console.warn(`[song-ipfs-backfill] missing cid ${candidate.communityId}/${candidate.songArtifactUploadId}`)
        continue
      }
      if (dryRun) {
        stats.dryRunMatches += 1
        console.log(`[song-ipfs-backfill] would update ${candidate.communityId}/${candidate.songArtifactUploadId} -> ${ipfsCid}`)
        continue
      }
      await updateIpfsCid({
        communityId: candidate.communityId,
        env,
        ipfsCid,
        songArtifactUploadId: candidate.songArtifactUploadId,
      })
      stats.updated += 1
      console.log(`[song-ipfs-backfill] updated ${candidate.communityId}/${candidate.songArtifactUploadId} -> ${ipfsCid}`)
    } catch (error) {
      stats.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[song-ipfs-backfill] failed ${candidate.communityId}/${candidate.songArtifactUploadId}: ${message}`)
    }
  }

  console.log(JSON.stringify({ dryRun, limit, stats }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
