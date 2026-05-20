import type { Env } from "../src/env"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { nowIso } from "../src/lib/helpers"
import { decodePublicAssetId, decodePublicCommunityId } from "../src/lib/public-ids"

type Candidate = {
  asset_id: string
  display_title: string | null
  license_preset: string | null
  commercial_rev_share_pct: number | null
  story_royalty_registration_status: string
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function usage(exitCode = 1): never {
  console.error([
    "Usage: bun scripts/set-story-royalty-share-for-existing-songs.ts --community <com_...|cmt_...> --pct <0-100> [options]",
    "",
    "Options:",
    "  --asset <asset_...|ast_...>   Limit to one asset.",
    "  --include-registered          Also update already-registered rows. Avoid unless on-chain terms are known to match.",
    "  --apply                       Write changes. Without this, the script only prints a dry run.",
    "  --help                        Show this help.",
  ].join("\n"))
  process.exit(exitCode)
}

function parsePct(raw: string | null): number {
  if (!raw) usage()
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--pct must be an integer from 0 to 100")
  }
  return parsed
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null
}

async function listCandidates(input: {
  client: Awaited<ReturnType<typeof openCommunityDb>>["client"]
  communityId: string
  assetId: string | null
  includeRegistered: boolean
  pct: number
}): Promise<Candidate[]> {
  const args: Array<string | number> = [input.communityId, "commercial-remix", input.pct]
  const filters = [
    "community_id = ?1",
    "asset_kind = 'song_audio'",
    "rights_basis = 'original'",
    "song_artifact_bundle_id IS NOT NULL",
    "(license_preset IS NULL OR license_preset <> ?2 OR commercial_rev_share_pct IS NULL OR commercial_rev_share_pct <> ?3)",
  ]

  if (!input.includeRegistered) {
    filters.push("story_royalty_registration_status <> 'registered'")
  }
  if (input.assetId) {
    args.push(input.assetId)
    filters.push(`asset_id = ?${args.length}`)
  }

  const result = await input.client.execute({
    sql: `
      SELECT asset_id, display_title, license_preset, commercial_rev_share_pct, story_royalty_registration_status
      FROM assets
      WHERE ${filters.join("\n        AND ")}
      ORDER BY updated_at DESC, asset_id DESC
    `,
    args,
  })

  return result.rows.map((row) => ({
    asset_id: String(row.asset_id),
    display_title: stringOrNull(row.display_title),
    license_preset: stringOrNull(row.license_preset),
    commercial_rev_share_pct: numberOrNull(row.commercial_rev_share_pct),
    story_royalty_registration_status: String(row.story_royalty_registration_status),
  }))
}

if (hasFlag("--help") || hasFlag("-h")) usage(0)

const rawCommunity = readArg("--community")
if (!rawCommunity) usage()

const pct = parsePct(readArg("--pct"))
const apply = hasFlag("--apply")
const includeRegistered = hasFlag("--include-registered")
const communityId = decodePublicCommunityId(rawCommunity)
const assetIdArg = readArg("--asset")
const assetId = assetIdArg ? decodePublicAssetId(assetIdArg) : null
const env = process.env as unknown as Env
const communityRepository = getCommunityRepository(env)
const db = await openCommunityDb(env, communityRepository, communityId)

try {
  const candidates = await listCandidates({
    client: db.client,
    communityId,
    assetId,
    includeRegistered,
    pct,
  })

  console.log(`found ${candidates.length} original song asset(s) to set to ${pct}% in com_${communityId}`)
  for (const candidate of candidates) {
    console.log([
      apply ? "update" : "dry-run",
      `asset_${candidate.asset_id}`,
      candidate.display_title ?? "Untitled",
      `${candidate.license_preset ?? "null"}:${candidate.commercial_rev_share_pct ?? "null"}`,
      `status=${candidate.story_royalty_registration_status}`,
    ].join(" | "))
  }

  if (apply && candidates.length > 0) {
    const now = nowIso()
    for (const candidate of candidates) {
      await db.client.execute({
        sql: `
          UPDATE assets
          SET license_preset = 'commercial-remix',
              commercial_rev_share_pct = ?3,
              updated_at = ?4
          WHERE community_id = ?1
            AND asset_id = ?2
        `,
        args: [communityId, candidate.asset_id, pct, now],
      })
    }
  }
} finally {
  db.close()
}
