import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import type { ProfileRepository } from "../auth/repositories"
import type { Client } from "../sql-client"
import type { Asset, DerivativeSourceKind, LocalizedPostResponse, PostDerivativeSource } from "../../types"
import type { Env } from "../../env"
import { findStoryRegisteredAssetProjectionSources } from "../communities/commerce/derivative-source-projection"
import {
  numberOrNull,
  requiredString,
  stringOrNull,
} from "../communities/commerce/row-types"

const STORY_IP_REF_PATTERN = /^story:ip:(0x[a-fA-F0-9]{40})#licenseTermsId=(\d+)$/
const STORY_ASSET_REF_PATTERN = /^story:asset:(asset_)?(.+)$/

type ParsedUpstreamRef =
  | { sourceRef: string; kind: "asset"; assetId: string }
  | { sourceRef: string; kind: "story_ip"; storyIp: string; licenseTermsId: string }
  | { sourceRef: string; kind: "unknown" }

type UpstreamSourceRow = {
  asset_id: string
  community_id: string
  source_post_id: string
  display_title: string | null
  creator_user_id: string
  asset_kind: Asset["asset_kind"]
  license_preset: Asset["license_preset"] | null
  commercial_rev_share_pct: number | null
  story_ip_id: string | null
  story_license_terms_id: string | null
}

type UpstreamSourceHydrationDependencies = {
  findStoryRegisteredAssetProjectionSources: typeof findStoryRegisteredAssetProjectionSources
}

const upstreamSourceHydrationDependencies: UpstreamSourceHydrationDependencies = {
  findStoryRegisteredAssetProjectionSources,
}

function parseUpstreamRef(sourceRef: string): ParsedUpstreamRef {
  const normalized = sourceRef.trim()
  const storyIpMatch = STORY_IP_REF_PATTERN.exec(normalized)
  if (storyIpMatch) {
    return {
      sourceRef: normalized,
      kind: "story_ip",
      storyIp: storyIpMatch[1],
      licenseTermsId: storyIpMatch[2],
    }
  }

  const assetMatch = STORY_ASSET_REF_PATTERN.exec(normalized)
  if (assetMatch) {
    return {
      sourceRef: normalized,
      kind: "asset",
      assetId: assetMatch[2],
    }
  }

  return { sourceRef: normalized, kind: "unknown" }
}

function derivativeSourceKindFromAssetKind(assetKind: Asset["asset_kind"]): DerivativeSourceKind {
  return assetKind === "video_file" ? "video" : "song"
}

function sourceRefForRow(row: Pick<UpstreamSourceRow, "story_ip_id" | "story_license_terms_id" | "asset_id">): string {
  if (row.story_ip_id?.trim() && row.story_license_terms_id?.trim()) {
    return `story:ip:${row.story_ip_id}#licenseTermsId=${row.story_license_terms_id}`
  }
  return `story:asset:${row.asset_id}`
}

function relationshipForSourceKind(
  kind: DerivativeSourceKind,
  consumerPostType: LocalizedPostResponse["post"]["post_type"],
): PostDerivativeSource["relationship_type"] {
  if (consumerPostType === "video" && kind === "song") return "references_song"
  return kind === "video" ? "references_video" : "remix_of"
}

function shortStoryIp(storyIp: string): string {
  return storyIp.length > 12 ? `${storyIp.slice(0, 6)}...${storyIp.slice(-4)}` : storyIp
}

async function findUpstreamSourceRows(input: {
  client: Client
  communityId: string
  refs: ParsedUpstreamRef[]
}): Promise<UpstreamSourceRow[]> {
  const assetIds = Array.from(new Set(input.refs
    .filter((ref): ref is Extract<ParsedUpstreamRef, { kind: "asset" }> => ref.kind === "asset")
    .map((ref) => ref.assetId)
    .filter(Boolean)))
  const storyRefs = Array.from(new Map(input.refs
    .filter((ref): ref is Extract<ParsedUpstreamRef, { kind: "story_ip" }> => ref.kind === "story_ip")
    .map((ref) => [`${ref.storyIp.toLowerCase()}:${ref.licenseTermsId}`, ref] as const)).values())

  const clauses: string[] = []
  const args: Array<string | number> = [input.communityId]
  let nextArg = 2

  if (assetIds.length > 0) {
    const placeholders = assetIds.map((_, index) => `?${nextArg + index}`).join(", ")
    clauses.push(`a.asset_id IN (${placeholders})`)
    args.push(...assetIds)
    nextArg += assetIds.length
  }

  for (const ref of storyRefs) {
    clauses.push(`(LOWER(a.story_ip_id) = LOWER(?${nextArg}) AND a.story_license_terms_id = ?${nextArg + 1})`)
    args.push(ref.storyIp, ref.licenseTermsId)
    nextArg += 2
  }

  if (clauses.length === 0) {
    return []
  }

  const result = await input.client.execute({
    sql: `
      SELECT a.asset_id, a.community_id, a.source_post_id, a.display_title, a.creator_user_id,
             a.asset_kind, a.license_preset, a.commercial_rev_share_pct, a.story_ip_id,
             a.story_license_terms_id
      FROM assets a
      INNER JOIN posts p
        ON p.community_id = a.community_id
       AND p.post_id = a.source_post_id
      WHERE a.community_id = ?1
        AND p.status = 'published'
        AND (${clauses.join(" OR ")})
    `,
    args,
  })

  return result.rows.map((row) => ({
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    display_title: stringOrNull(row, "display_title"),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    license_preset: stringOrNull(row, "license_preset") as Asset["license_preset"] | null,
    commercial_rev_share_pct: numberOrNull(row, "commercial_rev_share_pct"),
    story_ip_id: stringOrNull(row, "story_ip_id"),
    story_license_terms_id: stringOrNull(row, "story_license_terms_id"),
  }))
}

function findRowForRef(parsed: ParsedUpstreamRef, rows: UpstreamSourceRow[]): UpstreamSourceRow | null {
  if (parsed.kind === "asset") {
    return rows.find((row) => row.asset_id === parsed.assetId) ?? null
  }
  if (parsed.kind === "story_ip") {
    return rows.find((row) =>
      row.story_ip_id?.toLowerCase() === parsed.storyIp.toLowerCase()
      && row.story_license_terms_id === parsed.licenseTermsId
    ) ?? null
  }
  return null
}

function fallbackSource(parsed: ParsedUpstreamRef): PostDerivativeSource | null {
  if (parsed.kind !== "story_ip") {
    return null
  }
  return {
    source_ref: parsed.sourceRef,
    title: `Story IP ${shortStoryIp(parsed.storyIp)}`,
    kind: "song",
    relationship_type: "remix_of",
    story_ip: parsed.storyIp,
    story_license_terms: parsed.licenseTermsId,
  }
}

export async function hydrateDerivativeSourcesForResponses(input: {
  client: Client
  communityId: string
  env?: Env | null
  responses: LocalizedPostResponse[]
  profileRepository?: ProfileRepository | null
}, dependencies: UpstreamSourceHydrationDependencies = upstreamSourceHydrationDependencies): Promise<void> {
  const refs = Array.from(new Set(input.responses.flatMap((response) => response.post.upstream_asset_refs ?? [])))
    .map(parseUpstreamRef)
    .filter((ref) => ref.sourceRef.length > 0)
    .slice(0, 25)

  if (refs.length === 0) {
    return
  }

  const localRows = await findUpstreamSourceRows({
    client: input.client,
    communityId: input.communityId,
    refs,
  })
  const unresolvedStoryRefs = refs.filter((ref): ref is Extract<ParsedUpstreamRef, { kind: "story_ip" }> =>
    ref.kind === "story_ip" && !findRowForRef(ref, localRows)
  )
  const globalRows = unresolvedStoryRefs.length > 0 && input.env
    ? await dependencies.findStoryRegisteredAssetProjectionSources({
        env: input.env,
        refs: unresolvedStoryRefs.map((ref) => ({
          storyIp: ref.storyIp,
          licenseTermsId: ref.licenseTermsId,
        })),
      })
    : []
  const localAssetKeys = new Set(localRows.map((row) => `${row.community_id}:${row.asset_id}`))
  const rows: UpstreamSourceRow[] = [
    ...localRows,
    ...globalRows.filter((row) => !localAssetKeys.has(`${row.community_id}:${row.asset_id}`)),
  ]
  const creatorUserIds = Array.from(new Set(rows.map((row) => row.creator_user_id)))
  const profilesByUserId = input.profileRepository
    ? new Map(await Promise.all(creatorUserIds.map(async (userId) => [
        userId,
        await input.profileRepository!.getProfileByUserId(userId).catch(() => null),
      ] as const)))
    : new Map()

  for (const response of input.responses) {
    const postRefs = (response.post.upstream_asset_refs ?? [])
      .map(parseUpstreamRef)
      .filter((ref) => ref.sourceRef.length > 0)

    if (postRefs.length === 0) {
      response.derivative_sources = null
      continue
    }

    response.derivative_sources = postRefs.map((parsed) => {
      const row = findRowForRef(parsed, rows)
      if (!row) {
        return fallbackSource(parsed)
      }
      const profile = profilesByUserId.get(row.creator_user_id) ?? null
      const kind = derivativeSourceKindFromAssetKind(row.asset_kind)
      return {
        source_ref: sourceRefForRow(row),
        title: row.display_title?.trim() || "Untitled asset",
        kind,
        relationship_type: relationshipForSourceKind(kind, response.post.post_type),
        community: `com_${row.community_id}`,
        asset: `asset_${row.asset_id}`,
        source_post: `post_${row.source_post_id}`,
        story_ip: row.story_ip_id,
        story_license_terms: row.story_license_terms_id,
        license_preset: row.license_preset,
        commercial_rev_share_pct: row.commercial_rev_share_pct,
        creator_user: `usr_${row.creator_user_id}`,
        creator_handle: profile ? getProfilePublicHandleLabel(profile) : null,
        creator_display_name: profile?.display_name ?? null,
      }
    }).filter((source): source is PostDerivativeSource => source != null)
  }
}
