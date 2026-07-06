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

function assetKindForDerivativeSourceKind(kind: DerivativeSourceKind | null | undefined): Asset["asset_kind"] | null {
  if (kind === "song") return "song_audio"
  if (kind === "video") return "video_file"
  return null
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

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
  const filters = [
    "source_post_status = 'published'",
    "story_ip_id IS NOT NULL",
    "story_ip_id != ''",
    "story_license_terms_id IS NOT NULL",
    "story_license_terms_id != ''",
  ]
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
