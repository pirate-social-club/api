import type { ProfileRepository } from "../../auth/repositories"
import { getProfilePublicHandleLabel } from "../../auth/auth-serializers"
import { openCommunityReadClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import { listStoryRegisteredAssetProjectionRows } from "./derivative-source-projection"
import {
  listDerivativeSourceRows,
  requireCommunityMember,
  type DerivativeSourceRow,
} from "./shared"
import type {
  DerivativeSource,
  DerivativeSourceKind,
  DerivativeSourceListResponse,
  Env,
} from "../../../types"

function derivativeSourceKindFromAssetKind(assetKind: DerivativeSourceRow["asset_kind"]): DerivativeSourceKind {
  return assetKind === "video_file" ? "video" : "song"
}

function derivativeSourceStoryRef(row: DerivativeSourceRow): string | null {
  const storyIpId = row.story_ip_id?.trim()
  const storyLicenseTermsId = row.story_license_terms_id?.trim()
  if (!storyIpId || !storyLicenseTermsId) return null
  return `story:ip:${storyIpId}#licenseTermsId=${storyLicenseTermsId}`
}

export type DerivativeSourceScope = "community" | "global"

function derivativeSourceComposerUserIdCandidates(userId: string): string[] {
  const trimmed = userId.trim()
  if (!trimmed) return [userId]
  const internalUserId = trimmed.replace(/^(usr_)+/, "")
  return Array.from(new Set([trimmed, internalUserId, `usr_${internalUserId}`, `usr_${trimmed}`]))
}

async function requireDerivativeSourceComposerCommunity(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<void> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    let lastError: unknown = null
    for (const candidateUserId of derivativeSourceComposerUserIdCandidates(input.userId)) {
      try {
        await requireCommunityMember(db.client, input.communityId, candidateUserId)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  } finally {
    db.close()
  }
}

async function derivativeSourceRowsToResponse(input: {
  rows: DerivativeSourceRow[]
  profileRepository: ProfileRepository
}): Promise<DerivativeSourceListResponse> {
  const creatorUserIds = Array.from(new Set(input.rows.map((row) => row.creator_user_id)))
  const profilesByUserId = new Map(await Promise.all(creatorUserIds.map(async (userId) => [
    userId,
    await input.profileRepository.getProfileByUserId(userId).catch(() => null),
  ] as const)))
  const items: DerivativeSource[] = input.rows.map((row) => {
    const profile = profilesByUserId.get(row.creator_user_id) ?? null
    const sourceRef = derivativeSourceStoryRef(row)
    if (!sourceRef) throw new Error("Derivative source is missing Story registration fields")
    return {
      id: `asset_${row.asset_id}`,
      object: "derivative_source",
      community: `com_${row.community_id}`,
      asset: `asset_${row.asset_id}`,
      source_ref: sourceRef,
      title: row.display_title?.trim() || "Untitled asset",
      kind: derivativeSourceKindFromAssetKind(row.asset_kind),
      story_ip: row.story_ip_id!,
      story_license_terms: row.story_license_terms_id!,
      license_preset: row.license_preset,
      commercial_rev_share_pct: row.commercial_rev_share_pct,
      creator_user: `usr_${row.creator_user_id}`,
      creator_handle: profile ? getProfilePublicHandleLabel(profile) : null,
      creator_display_name: profile?.display_name ?? null,
    }
  })
  return { items, next_cursor: null }
}

export async function listCommunityDerivativeSources(input: {
  env: Env
  userId: string
  communityId: string
  kind?: DerivativeSourceKind | null
  query?: string | null
  limit: number
  communityRepository: CommunityDatabaseBindingRepository
  profileRepository: ProfileRepository
}): Promise<DerivativeSourceListResponse> {
  return await listDerivativeSources({ ...input, scope: "community" })
}

export async function listDerivativeSources(input: {
  env: Env
  userId: string
  scope: DerivativeSourceScope
  communityId: string
  kind?: DerivativeSourceKind | null
  query?: string | null
  limit: number
  communityRepository: CommunityDatabaseBindingRepository
  profileRepository: ProfileRepository
}): Promise<DerivativeSourceListResponse> {
  let rows: DerivativeSourceRow[]
  if (input.scope === "global") {
    await requireDerivativeSourceComposerCommunity(input)
    rows = await listStoryRegisteredAssetProjectionRows({
      env: input.env,
      kind: input.kind,
      query: input.query,
      limit: input.limit,
    })
  } else {
    const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
    try {
      await requireCommunityMember(db.client, input.communityId, input.userId)
      rows = await listDerivativeSourceRows({
        client: db.client,
        communityId: input.communityId,
        kind: input.kind,
        query: input.query,
        limit: input.limit,
      })
    } finally {
      db.close()
    }
  }
  return await derivativeSourceRowsToResponse({ rows, profileRepository: input.profileRepository })
}
