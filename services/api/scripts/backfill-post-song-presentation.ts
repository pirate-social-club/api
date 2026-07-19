import { spawn } from "bun"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { getControlPlaneClient, withRequestControlPlaneClients } from "../src/lib/runtime-deps"
import { decodePublicCommunityId } from "../src/lib/public-ids"
import { findUploadedSongArtifactByStorageRef } from "../src/lib/song-artifacts/song-artifact-upload-repository"
import { fetchSongArtifactBytes } from "../src/lib/song-artifacts/song-artifact-storage"

type BundlePresentation = {
  title: string | null
  coverArtRef: string | null
  durationMs: number | null
}

type CandidatePost = {
  post_id: string
  song_artifact_bundle_id: string
}

type BackfillStats = {
  communities: number
  candidatePosts: number
  updatedPosts: number
  missingBundles: number
  unchangedPosts: number
  durationsProbed: number
  durationProbeFailures: number
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string" || !value.trim()) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

export function parseFfprobeDurationMs(output: string): number | null {
  try {
    const parsed = JSON.parse(output) as { format?: { duration?: unknown } }
    const seconds = Number(parsed.format?.duration)
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null
  } catch {
    return null
  }
}

async function probeAudioDurationMs(bytes: Uint8Array): Promise<number | null> {
  const process = spawn([
    "ffprobe",
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "json",
    "pipe:0",
  ], {
    stdin: new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = setTimeout(() => process.kill(), 30_000)
  try {
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ])
    return exitCode === 0 ? parseFfprobeDurationMs(stdout) : null
  } finally {
    clearTimeout(timeout)
  }
}

async function listCandidatePosts(client: Awaited<ReturnType<typeof openCommunityDb>>["client"]): Promise<CandidatePost[]> {
  const result = await client.execute({
    sql: `
      SELECT post_id, song_artifact_bundle_id
      FROM posts
      WHERE post_type = 'song'
        AND song_artifact_bundle_id IS NOT NULL
        AND song_artifact_bundle_id <> ''
        AND (
          song_title IS NULL
          OR song_title = ''
          OR
          song_cover_art_ref IS NULL
          OR song_cover_art_ref = ''
          OR song_duration_ms IS NULL
        )
      ORDER BY created_at ASC, post_id ASC
    `,
    args: [],
  })

  return result.rows.flatMap((row) => {
    const postId = stringValue(row.post_id)
    const bundleId = stringValue(row.song_artifact_bundle_id)
    return postId && bundleId ? [{ post_id: postId, song_artifact_bundle_id: bundleId }] : []
  })
}

async function getBundlePresentation(input: {
  communityId: string
  songArtifactBundleId: string
  dryRun: boolean
  env: Env
}): Promise<(BundlePresentation & { durationProbed: boolean; durationProbeFailed: boolean }) | null> {
  const client = getControlPlaneClient(input.env)
  const row = (await client.execute({
    sql: `
      SELECT cover_art_json, primary_audio_json
           , title
      FROM song_artifact_bundles
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.songArtifactBundleId],
  })).rows[0]

  if (!row) {
    return null
  }

  const coverArt = parseJsonObject(row.cover_art_json)
  const primaryAudio = parseJsonObject(row.primary_audio_json)
  let durationMs = numberValue(primaryAudio?.duration_ms)
  let durationProbed = false
  let durationProbeFailed = false
  if (durationMs === null) {
    try {
      const storageRef = stringValue(primaryAudio?.storage_ref)
      const upload = storageRef
        ? await findUploadedSongArtifactByStorageRef({
            client,
            communityId: input.communityId,
            storageRef,
            artifactKind: "primary_audio",
          })
        : null
      if (upload?.storage_object_key) {
        const response = await fetchSongArtifactBytes({
          env: input.env,
          objectKey: upload.storage_object_key,
        })
        durationMs = await probeAudioDurationMs(new Uint8Array(await response.arrayBuffer()))
      }
    } catch (error) {
      console.warn(`${input.communityId}/${input.songArtifactBundleId}: duration probe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    durationProbed = durationMs !== null
    durationProbeFailed = durationMs === null
    if (durationMs !== null && !input.dryRun && primaryAudio) {
      await client.execute({
        sql: `
          UPDATE song_artifact_bundles
          SET primary_audio_json = ?3,
              updated_at = CURRENT_TIMESTAMP
          WHERE community_id = ?1
            AND song_artifact_bundle_id = ?2
        `,
        args: [
          input.communityId,
          input.songArtifactBundleId,
          JSON.stringify({ ...primaryAudio, duration_ms: durationMs }),
        ],
      })
    }
  }
  return {
    title: stringValue(row.title),
    coverArtRef: stringValue(coverArt?.storage_ref),
    durationMs,
    durationProbed,
    durationProbeFailed,
  }
}

async function backfillCommunity(input: {
  communityId: string
  dryRun: boolean
  env: Env
  repository: ReturnType<typeof getCommunityRepository>
}): Promise<Omit<BackfillStats, "communities">> {
  const db = await openCommunityDb(input.env, input.repository, input.communityId)
  try {
    const candidates = await listCandidatePosts(db.client)
    let updatedPosts = 0
    let missingBundles = 0
    let unchangedPosts = 0
    let durationsProbed = 0
    let durationProbeFailures = 0

    for (const candidate of candidates) {
      const presentation = await getBundlePresentation({
        communityId: input.communityId,
        songArtifactBundleId: candidate.song_artifact_bundle_id,
        dryRun: input.dryRun,
        env: input.env,
      })
      if (!presentation) {
        missingBundles += 1
        continue
      }
      if (presentation.durationProbed) durationsProbed += 1
      if (presentation.durationProbeFailed) durationProbeFailures += 1
      if (!presentation.title && !presentation.coverArtRef && presentation.durationMs === null) {
        unchangedPosts += 1
        continue
      }
      if (!input.dryRun) {
        await db.client.execute({
          sql: `
            UPDATE posts
            SET song_title = COALESCE(NULLIF(song_title, ''), ?2),
                song_cover_art_ref = COALESCE(NULLIF(song_cover_art_ref, ''), ?3),
                song_duration_ms = COALESCE(song_duration_ms, ?4),
                updated_at = CURRENT_TIMESTAMP
            WHERE post_id = ?1
          `,
          args: [candidate.post_id, presentation.title, presentation.coverArtRef, presentation.durationMs],
        })
      }
      updatedPosts += 1
    }

    return {
      candidatePosts: candidates.length,
      updatedPosts,
      missingBundles,
      unchangedPosts,
      durationsProbed,
      durationProbeFailures,
    }
  } finally {
    db.close()
  }
}

async function run(env: Env): Promise<void> {
  const dryRun = !hasFlag("--execute")
  const communityArg = readArg("--community-id")
  const repository = getCommunityRepository(env)
  const communities = communityArg
    ? [{ community_id: decodePublicCommunityId(communityArg) }]
    : await repository.listActiveCommunities()
  const stats: BackfillStats = {
    communities: 0,
    candidatePosts: 0,
    updatedPosts: 0,
    missingBundles: 0,
    unchangedPosts: 0,
    durationsProbed: 0,
    durationProbeFailures: 0,
  }

  for (const community of communities) {
    const communityId = community.community_id
    const communityStats = await backfillCommunity({
      communityId,
      dryRun,
      env,
      repository,
    })
    stats.communities += 1
    stats.candidatePosts += communityStats.candidatePosts
    stats.updatedPosts += communityStats.updatedPosts
    stats.missingBundles += communityStats.missingBundles
    stats.unchangedPosts += communityStats.unchangedPosts
    stats.durationsProbed += communityStats.durationsProbed
    stats.durationProbeFailures += communityStats.durationProbeFailures
    console.log(`${communityId}: candidates=${communityStats.candidatePosts} ${dryRun ? "would_update" : "updated"}=${communityStats.updatedPosts} durations_probed=${communityStats.durationsProbed} duration_probe_failures=${communityStats.durationProbeFailures} missing_bundles=${communityStats.missingBundles} unchanged=${communityStats.unchangedPosts}`)
  }

  await repository.close?.()
  console.log(`summary: mode=${dryRun ? "dry-run" : "execute"} communities=${stats.communities} candidates=${stats.candidatePosts} ${dryRun ? "would_update" : "updated"}=${stats.updatedPosts} durations_probed=${stats.durationsProbed} duration_probe_failures=${stats.durationProbeFailures} missing_bundles=${stats.missingBundles} unchanged=${stats.unchangedPosts}`)
}

async function main(): Promise<void> {
  const env = {
    ...readDevVarsFromCwd(),
    ...process.env,
  } as unknown as Env
  await withRequestControlPlaneClients(() => run(env))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
