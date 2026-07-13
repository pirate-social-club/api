import { readDevVarsFromCwd } from "./_lib/dev-vars"
import { createHash } from "node:crypto"
import type { Env } from "../src/env"
import { nowIso } from "../src/lib/helpers"
import { withStandaloneControlPlaneClient } from "../src/lib/runtime-deps"
import { markSongArtifactUploadContentHashServerVerified } from "../src/lib/song-artifacts/song-artifact-repository"
import { fetchSongArtifactBytes } from "../src/lib/song-artifacts/song-artifact-storage"
import type { Client } from "../src/lib/sql-client"

export type ContentHashBackfillCandidate = {
  communityId: string
  songArtifactUploadId: string
  storageObjectKey: string
  expectedContentHash: string
  declaredSizeBytes: number | null
}

export type ContentHashBackfillOutcome = {
  status: "matched" | "mismatched" | "updated"
  computedContentHash: string
  actualSizeBytes: number
}

export type ContentHashBackfillDigest = {
  computedContentHash: string
  actualSizeBytes: number
}

type BackfillStats = {
  candidates: number
  bytesHashed: number
  matched: number
  mismatched: number
  updated: number
  failed: number
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function optionalString(value: string | null): string | null {
  return value?.trim() || null
}

function parseLimit(value: string | null): number {
  if (!value) return 100
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --limit value: ${value}`)
  }
  return Math.min(parsed, 500)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) ? parsed : null
  }
  return null
}

function storedSongArtifactUploadId(value: string): string {
  return value.startsWith("sau_sau_") ? value.slice("sau_".length) : value
}

export function publicSongArtifactUploadIdFromStored(value: string): string {
  return `sau_${storedSongArtifactUploadId(value)}`
}

export async function listContentHashBackfillCandidates(input: {
  client: Client
  communityId: string | null
  uploadId: string | null
  afterCommunityId: string | null
  afterUploadId: string | null
  limit: number
}): Promise<ContentHashBackfillCandidate[]> {
  if (Boolean(input.afterCommunityId) !== Boolean(input.afterUploadId)) {
    throw new Error("--after-community-id and --after-upload-id must be provided together")
  }

  // Deliberately not scoped to direct-multipart uploads. Verification here means
  // "hash the stored bytes and compare", which is valid whatever path the upload
  // arrived by. Scoping to multipart would strand any proxy upload that landed
  // between migration 0141 and the deploy that started stamping
  // content_hash_verified_at: those rows are unverified and nothing else would
  // ever pick them up.
  const filters = [
    "upload.status = 'uploaded'",
    "upload.artifact_kind = 'primary_audio'",
    "upload.storage_object_key IS NOT NULL",
    "upload.storage_object_key <> ''",
    "upload.content_hash IS NOT NULL",
    "upload.content_hash <> ''",
    "upload.content_hash_verified_at IS NULL",
  ]
  const args: unknown[] = []

  if (input.communityId) {
    args.push(input.communityId)
    filters.push(`upload.community_id = ?${args.length}`)
  }
  if (input.uploadId) {
    args.push(storedSongArtifactUploadId(input.uploadId))
    filters.push(`upload.song_artifact_upload_id = ?${args.length}`)
  }
  if (input.afterCommunityId && input.afterUploadId) {
    args.push(input.afterCommunityId, storedSongArtifactUploadId(input.afterUploadId))
    const communityArg = args.length - 1
    const uploadArg = args.length
    filters.push(`(
      upload.community_id > ?${communityArg}
      OR (
        upload.community_id = ?${communityArg}
        AND upload.song_artifact_upload_id > ?${uploadArg}
      )
    )`)
  }
  args.push(input.limit)

  const result = await input.client.execute({
    sql: `
      SELECT upload.community_id,
             upload.song_artifact_upload_id,
             upload.storage_object_key,
             upload.content_hash,
             upload.size_bytes
      FROM song_artifact_uploads AS upload
      WHERE ${filters.join("\n        AND ")}
      ORDER BY upload.community_id ASC, upload.song_artifact_upload_id ASC
      LIMIT ?${args.length}
    `,
    args,
  })

  return result.rows.flatMap((row) => {
    const communityId = stringValue(row.community_id)
    const songArtifactUploadId = stringValue(row.song_artifact_upload_id)
    const storageObjectKey = stringValue(row.storage_object_key)
    const expectedContentHash = stringValue(row.content_hash)
    if (!communityId || !songArtifactUploadId || !storageObjectKey || !expectedContentHash) {
      return []
    }
    return [{
      communityId,
      songArtifactUploadId,
      storageObjectKey,
      expectedContentHash,
      declaredSizeBytes: numberValue(row.size_bytes),
    }]
  })
}

export async function verifyContentHashBackfillCandidate(input: {
  candidate: ContentHashBackfillCandidate
  execute: boolean
  loadDigest: (objectKey: string) => Promise<ContentHashBackfillDigest>
  markVerified: (candidate: ContentHashBackfillCandidate, computedContentHash: string) => Promise<boolean>
}): Promise<ContentHashBackfillOutcome> {
  const { actualSizeBytes, computedContentHash } = await input.loadDigest(input.candidate.storageObjectKey)
  if (computedContentHash !== input.candidate.expectedContentHash) {
    return {
      status: "mismatched",
      computedContentHash,
      actualSizeBytes,
    }
  }
  if (!input.execute) {
    return {
      status: "matched",
      computedContentHash,
      actualSizeBytes,
    }
  }
  const updated = await input.markVerified(input.candidate, computedContentHash)
  if (!updated) {
    throw new Error("Upload changed before the verified hash could be recorded")
  }
  return {
    status: "updated",
    computedContentHash,
    actualSizeBytes,
  }
}

export async function hashContentResponse(response: Response): Promise<ContentHashBackfillDigest> {
  if (!response.body) {
    throw new Error("Song artifact response did not include a body")
  }
  const hasher = createHash("sha256")
  const reader = response.body.getReader()
  let actualSizeBytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    actualSizeBytes += chunk.value.byteLength
    hasher.update(chunk.value)
  }
  return {
    computedContentHash: `0x${hasher.digest("hex")}`,
    actualSizeBytes,
  }
}

async function main(): Promise<void> {
  const env = {
    ...readDevVarsFromCwd(),
    ...process.env,
  } as unknown as Env
  const execute = hasFlag("--execute")
  await withStandaloneControlPlaneClient(env, async (client) => {
    const options = {
      communityId: optionalString(readArg("--community-id")),
      uploadId: optionalString(readArg("--upload-id")),
      afterCommunityId: optionalString(readArg("--after-community-id")),
      afterUploadId: optionalString(readArg("--after-upload-id")),
      limit: parseLimit(readArg("--limit")),
    }
    const candidates = await listContentHashBackfillCandidates({ client, ...options })
    const stats: BackfillStats = {
      candidates: candidates.length,
      bytesHashed: 0,
      matched: 0,
      mismatched: 0,
      updated: 0,
      failed: 0,
    }

    for (const candidate of candidates) {
      const ref = `${candidate.communityId}/${candidate.songArtifactUploadId}`
      try {
        const outcome = await verifyContentHashBackfillCandidate({
          candidate,
          execute,
          loadDigest: async (objectKey) => {
            const response = await fetchSongArtifactBytes({ env, objectKey })
            return hashContentResponse(response)
          },
          markVerified: (matchedCandidate, computedContentHash) =>
            markSongArtifactUploadContentHashServerVerified({
              client,
              communityId: matchedCandidate.communityId,
              songArtifactUploadId: publicSongArtifactUploadIdFromStored(matchedCandidate.songArtifactUploadId),
              contentHash: computedContentHash,
              verifiedAt: nowIso(),
            }),
        })
        stats.bytesHashed += outcome.actualSizeBytes
        if (outcome.status === "mismatched") {
          stats.mismatched += 1
          console.error("[song-content-hash-backfill] mismatch", {
            ref,
            expected_content_hash: candidate.expectedContentHash,
            computed_content_hash: outcome.computedContentHash,
            declared_size_bytes: candidate.declaredSizeBytes,
            actual_size_bytes: outcome.actualSizeBytes,
          })
        } else if (outcome.status === "updated") {
          stats.updated += 1
          console.log(`[song-content-hash-backfill] verified ${ref}`)
        } else {
          stats.matched += 1
          console.log(`[song-content-hash-backfill] would verify ${ref}`)
        }
      } catch (error) {
        stats.failed += 1
        console.error(`[song-content-hash-backfill] failed ${ref}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const lastCandidate = candidates.at(-1) ?? null
    console.log(JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      limit: options.limit,
      stats,
      next: candidates.length === options.limit && lastCandidate
        ? {
            after_community_id: lastCandidate.communityId,
            after_upload_id: lastCandidate.songArtifactUploadId,
          }
        : null,
    }, null, 2))

    if (stats.failed > 0 || stats.mismatched > 0) {
      process.exitCode = 1
    }
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
