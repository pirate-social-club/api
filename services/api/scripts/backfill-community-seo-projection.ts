import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { loadCommunityLocalSnapshot } from "../src/lib/communities/create/repository"
import { decodePublicCommunityId } from "../src/lib/public-ids"
import { nowIso } from "../src/lib/helpers"

type BackfillStats = {
  communities: number
  updated: number
  unchanged: number
  missingLocalSnapshot: number
  failed: number
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function normalizeNullableString(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim()
  return normalized ? normalized : null
}

function matchesProjection(input: {
  current: {
    description: string | null
    avatar_ref: string | null
    banner_ref: string | null
  }
  next: {
    description: string | null
    avatarRef: string | null
    bannerRef: string | null
  }
}): boolean {
  return normalizeNullableString(input.current.description) === input.next.description
    && normalizeNullableString(input.current.avatar_ref) === input.next.avatarRef
    && normalizeNullableString(input.current.banner_ref) === input.next.bannerRef
}

async function main(): Promise<void> {
  const env = {
    ...readDevVarsFromCwd(),
    ...process.env,
  } as unknown as Env
  const dryRun = !hasFlag("--execute")
  const communityArg = readArg("--community-id")
  const repository = getCommunityRepository(env)
  const communityId = communityArg ? decodePublicCommunityId(communityArg) : null
  const communities = communityId
    ? [await repository.getCommunityById(communityId)].filter((community): community is NonNullable<typeof community> => community !== null)
    : await repository.listActiveCommunities()
  const stats: BackfillStats = {
    communities: 0,
    updated: 0,
    unchanged: 0,
    missingLocalSnapshot: 0,
    failed: 0,
  }

  for (const community of communities) {
    const communityId = community.community_id
    stats.communities += 1

    try {
      const localSnapshot = await loadCommunityLocalSnapshot(env, repository, communityId)
      if (!localSnapshot) {
        stats.missingLocalSnapshot += 1
        console.log(`${communityId}: missing_local_snapshot`)
        continue
      }

      const next = {
        description: normalizeNullableString(localSnapshot.description),
        avatarRef: normalizeNullableString(localSnapshot.avatar_ref),
        bannerRef: normalizeNullableString(localSnapshot.banner_ref),
      }
      if (matchesProjection({ current: community, next })) {
        stats.unchanged += 1
        console.log(`${communityId}: unchanged`)
        continue
      }

      if (!dryRun) {
        await repository.updateCommunitySeoProjection({
          communityId,
          ...next,
          updatedAt: nowIso(),
        })
      }
      stats.updated += 1
      console.log(`${communityId}: ${dryRun ? "would_update" : "updated"}`)
    } catch (error) {
      stats.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${communityId}: failed ${message}`)
    }
  }

  await repository.close?.()
  console.log(`summary: mode=${dryRun ? "dry-run" : "execute"} communities=${stats.communities} ${dryRun ? "would_update" : "updated"}=${stats.updated} unchanged=${stats.unchanged} missing_local_snapshot=${stats.missingLocalSnapshot} failed=${stats.failed}`)
  if (stats.failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
