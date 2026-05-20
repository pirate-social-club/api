import type { Env } from "../src/env"
import { getUserRepository } from "../src/lib/auth/repositories"
import { retryStoryRoyaltyRegistrationForAsset } from "../src/lib/communities/commerce/service"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { decodePublicAssetId, decodePublicCommunityId } from "../src/lib/public-ids"

type Candidate = {
  asset_id: string
  display_title: string | null
  story_royalty_registration_status: string
  story_error: string | null
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function usage(): never {
  console.error("Usage: bun scripts/retry-story-royalty-registration.ts --community <com_...|cmt_...> [--asset <asset_...|ast_...>] [--limit 25] [--dry-run]")
  process.exit(1)
}

function parseLimit(value: string | null): number {
  if (!value) return 25
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Invalid --limit")
  }
  return Math.min(parsed, 100)
}

async function listCandidates(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  assetId: string | null
  limit: number
}): Promise<Candidate[]> {
  const args: Array<string | number> = [input.communityId]
  const filters = [
    "community_id = ?1",
    "asset_kind IN ('song_audio', 'video_file')",
    "rights_basis IN ('original', 'derivative')",
    "(asset_kind <> 'song_audio' OR song_artifact_bundle_id IS NOT NULL)",
    "story_royalty_registration_status IN ('none', 'failed', 'pending')",
  ]
  if (input.assetId) {
    args.push(input.assetId)
    filters.push(`asset_id = ?${args.length}`)
  }
  args.push(input.limit)

  const result = await input.client.execute({
    sql: `
      SELECT asset_id, display_title, story_royalty_registration_status, story_error
      FROM assets
      WHERE ${filters.join("\n        AND ")}
      ORDER BY updated_at ASC, asset_id ASC
      LIMIT ?${args.length}
    `,
    args,
  })

  return result.rows.map((row) => ({
    asset_id: String(row.asset_id),
    display_title: typeof row.display_title === "string" ? row.display_title : null,
    story_royalty_registration_status: String(row.story_royalty_registration_status),
    story_error: typeof row.story_error === "string" ? row.story_error : null,
  }))
}

const rawCommunity = readArg("--community")
if (!rawCommunity) usage()

const communityId = decodePublicCommunityId(rawCommunity)
const assetId = readArg("--asset")
const normalizedAssetId = assetId ? decodePublicAssetId(assetId) : null
const limit = parseLimit(readArg("--limit"))
const dryRun = hasFlag("--dry-run")
const env = process.env as unknown as Env
const communityRepository = getCommunityRepository(env)
const userRepository = getUserRepository(env)
const db = await openCommunityDb(env, communityRepository, communityId)

try {
  const candidates = await listCandidates({
    client: db.client,
    communityId,
    assetId: normalizedAssetId,
    limit,
  })
  console.log(`found ${candidates.length} retryable Story royalty asset(s) in com_${communityId}`)
  for (const candidate of candidates) {
    const publicAssetId = `asset_${candidate.asset_id}`
    if (dryRun) {
      console.log(`dry-run ${publicAssetId}: ${candidate.display_title ?? "Untitled"} (${candidate.story_error ?? "no error"})`)
      continue
    }
    const asset = await retryStoryRoyaltyRegistrationForAsset({
      env,
      client: db.client,
      communityId,
      assetId: candidate.asset_id,
      userRepository,
    })
    console.log(`${publicAssetId}: ${asset.story_royalty_registration_status}${asset.story_error ? ` (${asset.story_error})` : ""}`)
  }
} finally {
  db.close()
}
