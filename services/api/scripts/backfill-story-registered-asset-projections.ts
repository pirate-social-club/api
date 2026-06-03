import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { decodePublicCommunityId } from "../src/lib/public-ids"
import { upsertStoryRegisteredAssetProjection } from "../src/lib/communities/commerce/derivative-source-projection"
import type { Asset } from "../src/types"

type CandidateAsset = {
  asset_id: string
  community_id: string
  source_post_id: string
  display_title: string | null
  creator_user_id: string
  asset_kind: "song_audio" | "video_file"
  license_preset: Asset["license_preset"] | null
  commercial_rev_share_pct: number | null
  story_ip_id: string
  story_license_terms_id: string
  source_post_status: string
  asset_created_at: string
  asset_updated_at: string
}

type BackfillStats = {
  communities: number
  candidates: number
  projected: number
  failedCommunities: number
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer: ${value}`)
  }
  return parsed
}

function parseCommunityId(value: string | null): string | null {
  if (!value) return null
  return decodePublicCommunityId(value)
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "bigint") return Number(value)
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function parseCandidate(row: Record<string, unknown>): CandidateAsset | null {
  const assetId = stringValue(row.asset_id)
  const communityId = stringValue(row.community_id)
  const sourcePostId = stringValue(row.source_post_id)
  const creatorUserId = stringValue(row.creator_user_id)
  const assetKind = stringValue(row.asset_kind)
  const storyIpId = stringValue(row.story_ip_id)
  const storyLicenseTermsId = stringValue(row.story_license_terms_id)
  const sourcePostStatus = stringValue(row.source_post_status)
  const assetCreatedAt = stringValue(row.asset_created_at)
  const assetUpdatedAt = stringValue(row.asset_updated_at)

  if (
    !assetId
    || !communityId
    || !sourcePostId
    || !creatorUserId
    || (assetKind !== "song_audio" && assetKind !== "video_file")
    || !storyIpId
    || !storyLicenseTermsId
    || !sourcePostStatus
    || !assetCreatedAt
    || !assetUpdatedAt
  ) {
    return null
  }

  return {
    asset_id: assetId,
    community_id: communityId,
    source_post_id: sourcePostId,
    display_title: stringValue(row.display_title),
    creator_user_id: creatorUserId,
    asset_kind: assetKind,
    license_preset: stringValue(row.license_preset) as Asset["license_preset"] | null,
    commercial_rev_share_pct: numberValue(row.commercial_rev_share_pct),
    story_ip_id: storyIpId,
    story_license_terms_id: storyLicenseTermsId,
    source_post_status: sourcePostStatus,
    asset_created_at: assetCreatedAt,
    asset_updated_at: assetUpdatedAt,
  }
}

async function listCandidateAssets(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  limit: number | null
}): Promise<CandidateAsset[]> {
  const result = await input.client.execute({
    sql: `
      SELECT a.asset_id,
             a.community_id,
             a.source_post_id,
             a.display_title,
             a.creator_user_id,
             a.asset_kind,
             a.license_preset,
             a.commercial_rev_share_pct,
             a.story_ip_id,
             a.story_license_terms_id,
             p.status AS source_post_status,
             a.created_at AS asset_created_at,
             a.updated_at AS asset_updated_at
      FROM assets a
      INNER JOIN posts p
        ON p.community_id = a.community_id
       AND p.post_id = a.source_post_id
      WHERE a.community_id = ?1
        AND a.asset_kind IN ('song_audio', 'video_file')
        AND a.publication_status = 'story_published'
        AND a.story_status = 'published'
        AND a.story_royalty_registration_status = 'registered'
        AND a.story_ip_id IS NOT NULL
        AND a.story_ip_id != ''
        AND a.story_license_terms_id IS NOT NULL
        AND a.story_license_terms_id != ''
      ORDER BY a.updated_at DESC, a.asset_id DESC
      LIMIT ?2
    `,
    args: [input.communityId, input.limit ?? -1],
  })

  return result.rows.flatMap((row) => {
    if (!row || typeof row !== "object") return []
    const candidate = parseCandidate(row as Record<string, unknown>)
    return candidate ? [candidate] : []
  })
}

async function backfillCommunity(input: {
  communityId: string
  dryRun: boolean
  env: Env
  limit: number | null
  repository: ReturnType<typeof getCommunityRepository>
}): Promise<Omit<BackfillStats, "communities" | "failedCommunities">> {
  const db = await openCommunityDb(input.env, input.repository, input.communityId)
  try {
    const candidates = await listCandidateAssets({
      client: db.client,
      communityId: input.communityId,
      limit: input.limit,
    })

    if (!input.dryRun) {
      for (const candidate of candidates) {
        await upsertStoryRegisteredAssetProjection({
          env: input.env,
          projection: {
            communityId: candidate.community_id,
            assetId: candidate.asset_id,
            displayTitle: candidate.display_title,
            creatorUserId: candidate.creator_user_id,
            assetKind: candidate.asset_kind,
            licensePreset: candidate.license_preset,
            commercialRevSharePct: candidate.commercial_rev_share_pct,
            storyIpId: candidate.story_ip_id,
            storyLicenseTermsId: candidate.story_license_terms_id,
            sourcePostId: candidate.source_post_id,
            sourcePostStatus: candidate.source_post_status,
            sourceUpdatedAt: candidate.asset_updated_at,
            createdAt: candidate.asset_created_at,
          },
        })
      }
    }

    return {
      candidates: candidates.length,
      projected: candidates.length,
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
  const communityId = parseCommunityId(readArg("--community-id"))
  const limit = parsePositiveInt(readArg("--limit"))
  const repository = getCommunityRepository(env)
  const communities = communityId
    ? [await repository.getCommunityById(communityId)].filter((community): community is NonNullable<typeof community> => community !== null)
    : await repository.listActiveCommunities()
  const stats: BackfillStats = {
    communities: 0,
    candidates: 0,
    projected: 0,
    failedCommunities: 0,
  }

  for (const community of communities) {
    const id = community.community_id
    stats.communities += 1
    try {
      const communityStats = await backfillCommunity({
        communityId: id,
        dryRun,
        env,
        limit,
        repository,
      })
      stats.candidates += communityStats.candidates
      stats.projected += communityStats.projected
      console.log(`${id}: candidates=${communityStats.candidates} ${dryRun ? "would_project" : "projected"}=${communityStats.projected}`)
    } catch (error) {
      stats.failedCommunities += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${id}: failed ${message}`)
    }
  }

  await repository.close?.()
  console.log([
    `summary: mode=${dryRun ? "dry-run" : "execute"}`,
    `communities=${stats.communities}`,
    `candidates=${stats.candidates}`,
    `${dryRun ? "would_project" : "projected"}=${stats.projected}`,
    `failed_communities=${stats.failedCommunities}`,
  ].join(" "))

  if (stats.failedCommunities > 0) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
