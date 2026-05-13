import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { getControlPlaneClient } from "../src/lib/runtime-deps"
import { decodePublicCommunityId } from "../src/lib/public-ids"

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
  env: Env
}): Promise<BundlePresentation | null> {
  const row = (await getControlPlaneClient(input.env).execute({
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
  return {
    title: stringValue(row.title),
    coverArtRef: stringValue(coverArt?.storage_ref),
    durationMs: numberValue(primaryAudio?.duration_ms),
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

    for (const candidate of candidates) {
      const presentation = await getBundlePresentation({
        communityId: input.communityId,
        songArtifactBundleId: candidate.song_artifact_bundle_id,
        env: input.env,
      })
      if (!presentation) {
        missingBundles += 1
        continue
      }
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
    }
  } finally {
    db.close()
  }
}

async function main(): Promise<void> {
  const env = {
    ...readDevVarsFromCwd(),
    ...process.env,
  } as unknown as Env
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
    console.log(`${communityId}: candidates=${communityStats.candidatePosts} ${dryRun ? "would_update" : "updated"}=${communityStats.updatedPosts} missing_bundles=${communityStats.missingBundles} unchanged=${communityStats.unchangedPosts}`)
  }

  await repository.close?.()
  console.log(`summary: mode=${dryRun ? "dry-run" : "execute"} communities=${stats.communities} candidates=${stats.candidatePosts} ${dryRun ? "would_update" : "updated"}=${stats.updatedPosts} missing_bundles=${stats.missingBundles} unchanged=${stats.unchangedPosts}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
