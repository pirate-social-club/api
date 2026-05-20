import type { Env } from "../src/env"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { isStoryRoyaltyRegistrationConfigured } from "../src/lib/story/story-royalty-registration-service"
import { decodePublicCommunityId } from "../src/lib/public-ids"

type AuditIssue = {
  issue_kinds: string[]
  community_id: string
  asset_id: string
  display_title: string | null
  asset_kind: string
  rights_basis: string
  access_mode: string
  license_preset: string | null
  commercial_rev_share_pct: number | null
  story_ip_id: string | null
  story_license_terms_id: string | null
  story_royalty_registration_status: string
  story_error: string | null
  updated_at: string
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function printUsage(): void {
  console.error("Usage: bun scripts/audit-story-royalty-registration.ts [--community <com_...|cmt_...>] [--limit 100] [--json] [--fail-on-issues]")
}

function parseLimit(value: string | null): number {
  if (!value) return 100
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Invalid --limit")
  }
  return Math.min(parsed, 1000)
}

function stringOrNull(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" ? String(row[key]) : null
}

function numberOrNull(row: Record<string, unknown>, key: string): number | null {
  return typeof row[key] === "number" ? Number(row[key]) : null
}

function issueKindsFromRow(row: Record<string, unknown>): string[] {
  const kinds: string[] = []
  const status = String(row.story_royalty_registration_status || "none")
  const rightsBasis = String(row.rights_basis || "")
  const licensePreset = stringOrNull(row, "license_preset")
  const commercialRevSharePct = numberOrNull(row, "commercial_rev_share_pct")
  const storyIpId = stringOrNull(row, "story_ip_id")?.trim() ?? ""
  const storyLicenseTermsId = stringOrNull(row, "story_license_terms_id")?.trim() ?? ""

  if (status === "failed") kinds.push("registration_failed")
  if (status === "pending") kinds.push("registration_pending")
  if (status === "none") kinds.push("registration_missing")
  if (status === "registered" && !storyIpId) {
    kinds.push("registered_missing_story_ip")
  }
  if (status === "registered" && rightsBasis === "original" && !storyLicenseTermsId) {
    kinds.push("registered_original_missing_license_terms")
  }
  if (
    rightsBasis === "original"
    && licensePreset === "commercial-remix"
    && (
      commercialRevSharePct == null
      || !Number.isInteger(commercialRevSharePct)
      || commercialRevSharePct < 0
      || commercialRevSharePct > 100
    )
  ) {
    kinds.push("commercial_remix_share_invalid")
  }

  return kinds
}

function issueFromRow(communityId: string, row: Record<string, unknown>): AuditIssue {
  return {
    issue_kinds: issueKindsFromRow(row),
    community_id: `com_${communityId}`,
    asset_id: `asset_${String(row.asset_id)}`,
    display_title: stringOrNull(row, "display_title"),
    asset_kind: String(row.asset_kind),
    rights_basis: String(row.rights_basis),
    access_mode: String(row.access_mode),
    license_preset: stringOrNull(row, "license_preset"),
    commercial_rev_share_pct: numberOrNull(row, "commercial_rev_share_pct"),
    story_ip_id: stringOrNull(row, "story_ip_id"),
    story_license_terms_id: stringOrNull(row, "story_license_terms_id"),
    story_royalty_registration_status: String(row.story_royalty_registration_status),
    story_error: stringOrNull(row, "story_error"),
    updated_at: String(row.updated_at),
  }
}

async function auditCommunity(input: {
  env: Env
  communityId: string
  communityRepository: ReturnType<typeof getCommunityRepository>
  limit: number
}): Promise<AuditIssue[]> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT
          asset_id, display_title, asset_kind, rights_basis, access_mode, license_preset,
          commercial_rev_share_pct, story_ip_id, story_license_terms_id,
          story_royalty_registration_status, story_error, updated_at
        FROM assets
        WHERE asset_kind IN ('song_audio', 'video_file')
          AND rights_basis IN ('original', 'derivative')
          AND (asset_kind <> 'song_audio' OR song_artifact_bundle_id IS NOT NULL)
          AND (
            story_royalty_registration_status IN ('none', 'failed', 'pending')
            OR (
              story_royalty_registration_status = 'registered'
              AND (
                TRIM(COALESCE(story_ip_id, '')) = ''
                OR (rights_basis = 'original' AND TRIM(COALESCE(story_license_terms_id, '')) = '')
              )
            )
            OR (
              rights_basis = 'original'
              AND license_preset = 'commercial-remix'
              AND (
                commercial_rev_share_pct IS NULL
                OR commercial_rev_share_pct != CAST(commercial_rev_share_pct AS INTEGER)
                OR commercial_rev_share_pct < 0
                OR commercial_rev_share_pct > 100
              )
            )
          )
        ORDER BY updated_at DESC, asset_id DESC
        LIMIT ?1
      `,
      args: [input.limit],
    })
    return result.rows.map((row) => issueFromRow(input.communityId, row as Record<string, unknown>))
  } finally {
    db.close()
  }
}

const requestedCommunity = readArg("--community")
const limit = parseLimit(readArg("--limit"))
const json = hasFlag("--json")
const failOnIssues = hasFlag("--fail-on-issues")
const help = hasFlag("--help") || hasFlag("-h")
if (help) {
  printUsage()
  process.exit(0)
}

const env = process.env as unknown as Env
const communityRepository = getCommunityRepository(env)
const communityIds = requestedCommunity
  ? [decodePublicCommunityId(requestedCommunity)]
  : (await communityRepository.listActiveCommunities()).map((community) => community.community_id)
const issues: AuditIssue[] = []

for (const communityId of communityIds) {
  try {
    issues.push(...await auditCommunity({
      env,
      communityId,
      communityRepository,
      limit,
    }))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    issues.push({
      community_id: `com_${communityId}`,
      issue_kinds: ["audit_failed"],
      asset_id: "",
      display_title: null,
      asset_kind: "",
      rights_basis: "",
      access_mode: "",
      license_preset: null,
      commercial_rev_share_pct: null,
      story_ip_id: null,
      story_license_terms_id: null,
      story_royalty_registration_status: "audit_failed",
      story_error: message,
      updated_at: new Date().toISOString(),
    })
  }
}

const summary = {
  story_royalty_configured: isStoryRoyaltyRegistrationConfigured(env),
  communities_scanned: communityIds.length,
  issues_found: issues.length,
  issues,
}

if (json) {
  console.log(JSON.stringify(summary, null, 2))
} else {
  console.log(`Story royalty configured: ${summary.story_royalty_configured ? "yes" : "no"}`)
  console.log(`Scanned ${summary.communities_scanned} community(s); found ${summary.issues_found} issue(s).`)
  for (const issue of issues) {
    const title = issue.display_title ?? "Untitled"
    const error = issue.story_error ? ` (${issue.story_error})` : ""
    console.log(`${issue.community_id} ${issue.asset_id || "audit"} ${issue.issue_kinds.join(",")}: ${title}${error}`)
  }
}

if (failOnIssues && issues.length > 0) {
  process.exit(1)
}
