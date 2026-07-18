import { makeId, nowIso } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import type { Asset, DerivativeSourceKind, Env } from "../../../types"
import type { DerivativeSourceRow } from "./shared"
import { numberOrNull, requiredString, stringOrNull } from "./row-types"

export type StoryRegisteredAssetProjection = {
  communityId: string
  assetId: string
  displayTitle: string | null
  creatorUserId: string
  assetKind: "song_audio" | "video_file"
  licensePreset: Asset["license_preset"] | null
  commercialRevSharePct: number | null
  storyIpId: string
  storyLicenseTermsId: string | null
  sourcePostId: string
  sourcePostStatus: string
  sourceUpdatedAt: string
  createdAt: string
}

export type EligibleStoryParentProjection = {
  communityId: string
  assetId: string
  storyIpId: string
  storyLicenseTermsId: string
}

export type EligibleStoryParentAssetResolution =
  | { status: "resolved"; parent: EligibleStoryParentProjection }
  | { status: "not_found" }
  | { status: "ambiguous" }

function assetKindForDerivativeSourceKind(kind: DerivativeSourceKind | null | undefined): Asset["asset_kind"] | null {
  if (kind === "song") return "song_audio"
  if (kind === "video") return "video_file"
  return null
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

const ELIGIBLE_STORY_PARENT_FILTERS = [
  "source_post_status = 'published'",
  "license_preset = 'commercial-remix'",
  "commercial_rev_share_pct > 0",
  "story_ip_id IS NOT NULL",
  "story_ip_id != ''",
  "story_license_terms_id IS NOT NULL",
  "story_license_terms_id != ''",
] as const

function derivativeSourceLikePattern(value: string): string {
  return `%${escapeLikePattern(value.slice(0, 48).toLowerCase())}%`
}

export async function upsertStoryRegisteredAssetProjection(input: {
  env: Env
  projection: StoryRegisteredAssetProjection
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  const p = input.projection
  const updatedAt = nowIso()
  await client.execute({
    sql: `
      INSERT INTO story_registered_asset_projections (
        projection_id, community_id, asset_id, display_title, creator_user_id,
        asset_kind, license_preset, commercial_rev_share_pct,
        story_ip_id, story_license_terms_id,
        source_post_id, source_post_status, source_updated_at,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8,
        ?9, ?10,
        ?11, ?12, ?13,
        ?14, ?15
      )
      ON CONFLICT (community_id, asset_id) DO UPDATE SET
        display_title = excluded.display_title,
        creator_user_id = excluded.creator_user_id,
        asset_kind = excluded.asset_kind,
        license_preset = excluded.license_preset,
        commercial_rev_share_pct = excluded.commercial_rev_share_pct,
        story_ip_id = excluded.story_ip_id,
        story_license_terms_id = excluded.story_license_terms_id,
        source_post_id = excluded.source_post_id,
        source_post_status = excluded.source_post_status,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("srap"),
      p.communityId,
      p.assetId,
      p.displayTitle,
      p.creatorUserId,
      p.assetKind,
      p.licensePreset,
      p.commercialRevSharePct,
      p.storyIpId,
      p.storyLicenseTermsId,
      p.sourcePostId,
      p.sourcePostStatus,
      p.sourceUpdatedAt,
      p.createdAt,
      updatedAt,
    ],
  })
}

export async function updateStoryRegisteredAssetPostStatus(input: {
  env: Env
  communityId: string
  sourcePostId: string
  sourcePostStatus: string
  updatedAt?: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  await client.execute({
    sql: `
      UPDATE story_registered_asset_projections
      SET source_post_status = ?1, updated_at = ?2
      WHERE community_id = ?3
        AND source_post_id = ?4
    `,
    args: [
      input.sourcePostStatus,
      input.updatedAt ?? nowIso(),
      input.communityId,
      input.sourcePostId,
    ],
  })
}

export async function listStoryRegisteredAssetProjectionRows(input: {
  env: Env
  kind?: DerivativeSourceKind | null
  query?: string | null
  limit: number
}): Promise<DerivativeSourceRow[]> {
  const client = getControlPlaneClient(input.env)
  const filters: string[] = [...ELIGIBLE_STORY_PARENT_FILTERS]
  const args: Array<string | number> = []
  let nextArg = 1
  const assetKind = assetKindForDerivativeSourceKind(input.kind)
  const query = input.query?.trim()

  if (assetKind) {
    filters.push(`asset_kind = ?${nextArg}`)
    args.push(assetKind)
    nextArg += 1
  }
  if (query) {
    filters.push(`LOWER(COALESCE(display_title, asset_id)) LIKE ?${nextArg} ESCAPE '\\'`)
    args.push(derivativeSourceLikePattern(query))
    nextArg += 1
  }
  args.push(input.limit)

  const result = await client.execute({
    sql: `
      SELECT asset_id, community_id, display_title, creator_user_id, asset_kind,
             license_preset, commercial_rev_share_pct, story_ip_id, story_license_terms_id,
             updated_at
      FROM story_registered_asset_projections
      WHERE ${filters.join("\n        AND ")}
      ORDER BY updated_at DESC, asset_id DESC
      LIMIT ?${nextArg}
    `,
    args,
  })

  return result.rows.map((row) => ({
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    display_title: stringOrNull(row, "display_title"),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    license_preset: stringOrNull(row, "license_preset") as Asset["license_preset"] | null,
    commercial_rev_share_pct: numberOrNull(row, "commercial_rev_share_pct"),
    story_ip_id: requiredString(row, "story_ip_id"),
    story_license_terms_id: requiredString(row, "story_license_terms_id"),
    updated_at: requiredString(row, "updated_at"),
  }))
}

function eligibleStoryParentFromRow(row: Record<string, unknown>): EligibleStoryParentProjection {
  return {
    communityId: requiredString(row, "community_id"),
    assetId: requiredString(row, "asset_id"),
    storyIpId: requiredString(row, "story_ip_id"),
    storyLicenseTermsId: requiredString(row, "story_license_terms_id"),
  }
}

export async function findEligibleStoryParentProjectionByRef(input: {
  env: Env
  storyIpId: string
  storyLicenseTermsId: string
}): Promise<EligibleStoryParentProjection | null> {
  const client = getControlPlaneClient(input.env)
  const result = await client.execute({
    sql: `
      SELECT community_id, asset_id, story_ip_id, story_license_terms_id
      FROM story_registered_asset_projections
      WHERE ${ELIGIBLE_STORY_PARENT_FILTERS.join("\n        AND ")}
        AND LOWER(story_ip_id) = ?1
        AND story_license_terms_id = ?2
      LIMIT 1
    `,
    args: [input.storyIpId.trim().toLowerCase(), input.storyLicenseTermsId.trim()],
  })
  return result.rows[0] ? eligibleStoryParentFromRow(result.rows[0]) : null
}

export async function resolveEligibleStoryParentProjectionByAssetId(input: {
  env: Env
  assetId: string
}): Promise<EligibleStoryParentAssetResolution> {
  const client = getControlPlaneClient(input.env)
  const result = await client.execute({
    sql: `
      SELECT community_id, asset_id, story_ip_id, story_license_terms_id
      FROM story_registered_asset_projections
      WHERE ${ELIGIBLE_STORY_PARENT_FILTERS.join("\n        AND ")}
        AND asset_id = ?1
      ORDER BY updated_at DESC, community_id ASC
      LIMIT 2
    `,
    args: [input.assetId],
  })
  if (result.rows.length === 0) return { status: "not_found" }
  if (result.rows.length > 1) return { status: "ambiguous" }
  return { status: "resolved", parent: eligibleStoryParentFromRow(result.rows[0]) }
}

export async function findZeroRevenueShareStoryParentIpIds(input: {
  env: Env
  storyIpIds: string[]
}): Promise<Set<string>> {
  const storyIpIds = Array.from(new Set(input.storyIpIds
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)))
  if (storyIpIds.length === 0) return new Set()

  const client = getControlPlaneClient(input.env)
  const placeholders = storyIpIds.map((_, index) => `?${index + 1}`).join(", ")
  const result = await client.execute({
    sql: `
      SELECT LOWER(story_ip_id) AS story_ip_id
      FROM story_registered_asset_projections
      WHERE LOWER(story_ip_id) IN (${placeholders})
      GROUP BY LOWER(story_ip_id)
      HAVING MAX(COALESCE(commercial_rev_share_pct, 0)) <= 0
    `,
    args: storyIpIds,
  })
  return new Set(result.rows.map((row) => requiredString(row, "story_ip_id").toLowerCase()))
}
