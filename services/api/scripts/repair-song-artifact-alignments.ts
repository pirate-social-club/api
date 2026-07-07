import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getControlPlaneClient } from "../src/lib/runtime-deps"
import { decodePublicCommunityId, decodePublicSongArtifactBundleId } from "../src/lib/public-ids"
import { analyzeSongAlignment } from "../src/lib/song-artifacts/song-artifact-analysis"
import {
  findUploadedSongArtifactByStorageRef,
  getSongArtifactBundle,
  updateSongArtifactBundleAlignment,
} from "../src/lib/song-artifacts/song-artifact-repository"
import { nowIso } from "../src/lib/helpers"

type CandidateBundle = {
  communityId: string
  songArtifactBundleId: string
}

type Stats = {
  candidates: number
  repaired: number
  dryRunMatches: number
  missingBundle: number
  missingUpload: number
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
  if (!value) return 100
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --limit value: ${value}`)
  }
  return Math.min(parsed, 1000)
}

function normalizeCommunityId(value: string | null): string | null {
  if (!value?.trim()) return null
  return value.startsWith("com_") ? decodePublicCommunityId(value) : value
}

function normalizeBundleId(value: string | null): string | null {
  if (!value?.trim()) return null
  return value.startsWith("sab_") ? decodePublicSongArtifactBundleId(value) : value
}

async function listCandidates(input: {
  client: ReturnType<typeof getControlPlaneClient>
  communityId: string | null
  limit: number
  songArtifactBundleId: string | null
}): Promise<CandidateBundle[]> {
  const filters = [
    "alignment_status = 'failed'",
    "(alignment_reason IS NULL OR alignment_reason = '')",
  ]
  const args: unknown[] = []
  if (input.communityId) {
    args.push(input.communityId)
    filters.push(`community_id = ?${args.length}`)
  }
  if (input.songArtifactBundleId) {
    args.push(input.songArtifactBundleId)
    filters.push(`song_artifact_bundle_id = ?${args.length}`)
  }
  args.push(input.limit)

  const result = await input.client.execute({
    sql: `
      SELECT community_id, song_artifact_bundle_id
      FROM song_artifact_bundles
      WHERE ${filters.join("\n        AND ")}
      ORDER BY updated_at ASC, song_artifact_bundle_id ASC
      LIMIT ?${args.length}
    `,
    args,
  })

  return result.rows.flatMap((row) => {
    const communityId = stringValue(row.community_id)
    const songArtifactBundleId = stringValue(row.song_artifact_bundle_id)
    return communityId && songArtifactBundleId
      ? [{ communityId, songArtifactBundleId }]
      : []
  })
}

async function repairCandidate(input: {
  candidate: CandidateBundle
  client: ReturnType<typeof getControlPlaneClient>
  dryRun: boolean
  env: Env
}): Promise<"dry_run" | "failed" | "missing_bundle" | "missing_upload" | "repaired"> {
  const { candidate, client, dryRun, env } = input
  const bundle = await getSongArtifactBundle(client, candidate.communityId, candidate.songArtifactBundleId)
  if (!bundle) return "missing_bundle"
  const storageRef = bundle.primary_audio.storage_ref?.trim()
  if (!storageRef) return "missing_upload"
  const primaryAudioUpload = await findUploadedSongArtifactByStorageRef({
    client,
    communityId: candidate.communityId,
    storageRef,
    artifactKind: "primary_audio",
  })
  if (!primaryAudioUpload) return "missing_upload"

  if (dryRun) {
    console.log("[repair-song-alignments] dry-run match", {
      community_id: candidate.communityId,
      song_artifact_bundle_id: candidate.songArtifactBundleId,
      previous_alignment_error: bundle.alignment_error,
    })
    return "dry_run"
  }

  const alignment = await analyzeSongAlignment({
    communityId: candidate.communityId,
    env,
    lyrics: bundle.lyrics,
    primaryAudioUpload,
  })
  await updateSongArtifactBundleAlignment({
    client,
    communityId: candidate.communityId,
    songArtifactBundleId: candidate.songArtifactBundleId,
    alignmentStatus: alignment.alignmentStatus,
    alignmentError: alignment.alignmentError,
    alignmentReason: alignment.alignmentReason,
    timedLyricsRef: null,
    timedLyrics: alignment.timedLyrics,
    updatedAt: nowIso(),
  })
  console.log("[repair-song-alignments] repaired", {
    alignment_reason: alignment.alignmentReason,
    alignment_status: alignment.alignmentStatus,
    community_id: candidate.communityId,
    song_artifact_bundle_id: candidate.songArtifactBundleId,
  })
  return "repaired"
}

async function main() {
  const env = readDevVarsFromCwd() as Env
  const dryRun = !hasFlag("--execute")
  const communityId = normalizeCommunityId(readArg("--community"))
  const songArtifactBundleId = normalizeBundleId(readArg("--bundle"))
  const limit = parseLimit(readArg("--limit"))
  const client = getControlPlaneClient(env)
  const candidates = await listCandidates({
    client,
    communityId,
    limit,
    songArtifactBundleId,
  })
  const stats: Stats = {
    candidates: candidates.length,
    repaired: 0,
    dryRunMatches: 0,
    missingBundle: 0,
    missingUpload: 0,
    failed: 0,
  }

  console.log("[repair-song-alignments] starting", {
    community_id: communityId,
    dry_run: dryRun,
    limit,
    song_artifact_bundle_id: songArtifactBundleId,
  })
  for (const candidate of candidates) {
    try {
      const result = await repairCandidate({ candidate, client, dryRun, env })
      if (result === "dry_run") stats.dryRunMatches += 1
      if (result === "repaired") stats.repaired += 1
      if (result === "missing_bundle") stats.missingBundle += 1
      if (result === "missing_upload") stats.missingUpload += 1
      if (result === "failed") stats.failed += 1
    } catch (error) {
      stats.failed += 1
      console.error("[repair-song-alignments] failed", {
        community_id: candidate.communityId,
        error: error instanceof Error ? error.message : String(error),
        song_artifact_bundle_id: candidate.songArtifactBundleId,
      })
    }
  }
  console.log("[repair-song-alignments] complete", stats)
  if (stats.failed > 0) {
    process.exitCode = 1
  }
}

await main()
