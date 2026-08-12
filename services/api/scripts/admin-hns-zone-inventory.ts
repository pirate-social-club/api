#!/usr/bin/env bun

import type { Env } from "../src/env"
import type { DbExecutor } from "../src/lib/db-helpers"
import type { QueryResultRow } from "../src/lib/sql-client"

/**
 * Read-only control-plane half of the HNS zone GC dry run.
 *
 * This intentionally does not call PowerDNS and has no write mode. The
 * companion Core script joins this snapshot with PowerDNS zones. Keeping the
 * two inventories separate prevents a DNS API outage from being interpreted
 * as an empty control-plane inventory, which would be unsafe for cleanup.
 */

export type HnsZoneControlPlaneRoot = {
  normalized_root_label: string
  active_attachment_count: number
  active_verification_count: number
  pending_session_count: number
  delegation_state_present: boolean
  canonical_routing_eligible: boolean
  routing_hard_denied: boolean
  challenge_txt_values: string[]
  active_challenge_txt_values: string[]
  last_activity_at: string | null
  protected: boolean
}

export type HnsZoneControlPlaneInventory = {
  schema_version: "hns-zone-control-plane-v1"
  generated_at: string
  roots: HnsZoneControlPlaneRoot[]
}

function integer(row: QueryResultRow, key: string): number {
  const value = Number(row[key])
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function bool(row: QueryResultRow, key: string): boolean {
  return row[key] === true || row[key] === 1 || row[key] === "1"
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

function parseJsonStrings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim())
  }
  if (typeof value !== "string" || !value.trim()) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.trim())
      : []
  } catch {
    return []
  }
}

export function buildHnsZoneControlPlaneInventory(
  rows: QueryResultRow[],
  generatedAt = new Date().toISOString(),
): HnsZoneControlPlaneInventory {
  return {
    schema_version: "hns-zone-control-plane-v1",
    generated_at: generatedAt,
    roots: rows.map((row) => {
      const activeAttachmentCount = integer(row, "active_attachment_count")
      const activeVerificationCount = integer(row, "active_verification_count")
      const pendingSessionCount = integer(row, "pending_session_count")
      const delegationStatePresent = bool(row, "delegation_state_present")
      const canonicalRoutingEligible = bool(row, "canonical_routing_eligible")
      const routingHardDenied = bool(row, "routing_hard_denied")
      const challengeTxtValues = [...new Set(parseJsonStrings(row.challenge_txt_values))].sort()
      const activeChallengeTxtValues = [...new Set(parseJsonStrings(row.active_challenge_txt_values))].sort()

      // A root is protected if any control-plane evidence says it is still
      // owned, attached, routing-authoritative, or in an unfinished session.
      // This is deliberately conservative: the dry run may report a review
      // candidate, but it must never infer that a zone is safe to delete from
      // a missing or malformed field.
      const protectedRoot = activeAttachmentCount > 0
        || activeVerificationCount > 0
        || pendingSessionCount > 0
        || delegationStatePresent
        || canonicalRoutingEligible
        || routingHardDenied
        || activeChallengeTxtValues.length > 0

      return {
        normalized_root_label: String(row.normalized_root_label ?? "").trim(),
        active_attachment_count: activeAttachmentCount,
        active_verification_count: activeVerificationCount,
        pending_session_count: pendingSessionCount,
        delegation_state_present: delegationStatePresent,
        canonical_routing_eligible: canonicalRoutingEligible,
        routing_hard_denied: routingHardDenied,
        challenge_txt_values: challengeTxtValues,
        active_challenge_txt_values: activeChallengeTxtValues,
        last_activity_at: stringOrNull(row.last_activity_at),
        protected: protectedRoot,
      }
    }).filter((root) => root.normalized_root_label.length > 0).sort((left, right) =>
      left.normalized_root_label.localeCompare(right.normalized_root_label)),
  }
}

export async function readHnsZoneControlPlaneInventory(
  executor: DbExecutor,
  generatedAt?: string,
): Promise<HnsZoneControlPlaneInventory> {
  const result = await executor.execute({
    sql: `
      WITH roots AS (
        SELECT normalized_root_label
        FROM namespace_verification_sessions
        WHERE family = 'hns' AND normalized_root_label IS NOT NULL
        UNION
        SELECT normalized_root_label
        FROM namespace_verifications
        WHERE family = 'hns'
        UNION
        SELECT normalized_root_label
        FROM hns_root_delegation_state
      ),
      active_bindings AS (
        SELECT
          nv.normalized_root_label,
          COUNT(*) AS active_attachment_count,
          COUNT(*) FILTER (WHERE nv.status IN ('verified', 'stale')) AS active_verification_count
        FROM namespace_verifications AS nv
        JOIN community_namespace_bindings AS binding
          ON binding.namespace_verification_id = nv.namespace_verification_id
         AND binding.status = 'active'
        JOIN communities AS community
          ON community.community_id = binding.community_id
         AND community.status = 'active'
        WHERE nv.family = 'hns'
          AND nv.expires_at > CURRENT_TIMESTAMP
          AND nv.club_attach_allowed = 1
        GROUP BY nv.normalized_root_label
      ),
      pending_sessions AS (
        SELECT
          normalized_root_label,
          COUNT(*) AS pending_session_count
        FROM namespace_verification_sessions
        WHERE family = 'hns'
          AND normalized_root_label IS NOT NULL
          AND status IN ('draft', 'inspecting', 'dns_setup_required', 'challenge_required', 'challenge_pending', 'verifying')
          AND expires_at > CURRENT_TIMESTAMP
        GROUP BY normalized_root_label
      ),
      challenges AS (
        SELECT
          normalized_root_label,
          json_agg(DISTINCT challenge_txt_value) FILTER (WHERE challenge_txt_value IS NOT NULL) AS challenge_txt_values,
          json_agg(DISTINCT challenge_txt_value) FILTER (
            WHERE challenge_txt_value IS NOT NULL
              AND status IN ('draft', 'inspecting', 'dns_setup_required', 'challenge_required', 'challenge_pending', 'verifying')
              AND expires_at > CURRENT_TIMESTAMP
          ) AS active_challenge_txt_values,
          MAX(updated_at) AS last_session_activity_at
        FROM namespace_verification_sessions
        WHERE family = 'hns' AND normalized_root_label IS NOT NULL
        GROUP BY normalized_root_label
      ),
      activity AS (
        SELECT normalized_root_label, MAX(last_activity_at) AS last_activity_at
        FROM (
          SELECT normalized_root_label, last_session_activity_at AS last_activity_at FROM challenges
          UNION ALL
          SELECT normalized_root_label, updated_at AS last_activity_at FROM namespace_verifications
          UNION ALL
          SELECT normalized_root_label, updated_at AS last_activity_at FROM hns_root_delegation_state
        ) AS events
        GROUP BY normalized_root_label
      )
      SELECT
        roots.normalized_root_label,
        COALESCE(active_bindings.active_attachment_count, 0) AS active_attachment_count,
        COALESCE(active_bindings.active_verification_count, 0) AS active_verification_count,
        COALESCE(pending_sessions.pending_session_count, 0) AS pending_session_count,
        CASE WHEN delegation.normalized_root_label IS NULL THEN 0 ELSE 1 END AS delegation_state_present,
        COALESCE(delegation.canonical_routing_eligible, 0) AS canonical_routing_eligible,
        COALESCE(delegation.routing_hard_denied, 0) AS routing_hard_denied,
        COALESCE(challenges.challenge_txt_values, '[]'::json) AS challenge_txt_values,
        COALESCE(challenges.active_challenge_txt_values, '[]'::json) AS active_challenge_txt_values,
        activity.last_activity_at
      FROM roots
      LEFT JOIN active_bindings ON active_bindings.normalized_root_label = roots.normalized_root_label
      LEFT JOIN pending_sessions ON pending_sessions.normalized_root_label = roots.normalized_root_label
      LEFT JOIN challenges ON challenges.normalized_root_label = roots.normalized_root_label
      LEFT JOIN hns_root_delegation_state AS delegation
        ON delegation.normalized_root_label = roots.normalized_root_label
      LEFT JOIN activity ON activity.normalized_root_label = roots.normalized_root_label
      ORDER BY roots.normalized_root_label
    `,
    args: [],
  })
  return buildHnsZoneControlPlaneInventory(result.rows, generatedAt)
}

function valueAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag)
  const value = index >= 0 ? args[index + 1]?.trim() : ""
  if (!value) throw new Error(`${flag} is required`)
  return value
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun run scripts/admin-hns-zone-inventory.ts --output PATH")
    process.exit(0)
  }

  const databaseUrl = process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL?.trim()
    ?? process.env.CONTROL_PLANE_DATABASE_URL?.trim()
  if (!databaseUrl) {
    throw new Error("CONTROL_PLANE_MIGRATOR_DATABASE_URL or CONTROL_PLANE_DATABASE_URL is required")
  }

  const outputPath = valueAfter(args, "--output")
  const env = {
    ...process.env,
    ENVIRONMENT: "operator",
    CONTROL_PLANE_DATABASE_URL: databaseUrl,
  } as Env

  const { withStandaloneControlPlaneClient } = await import("../src/lib/runtime-deps")
  const inventory = await withStandaloneControlPlaneClient(env, (client) =>
    readHnsZoneControlPlaneInventory(client))
  await Bun.write(outputPath, `${JSON.stringify(inventory, null, 2)}\n`)
  console.log(JSON.stringify({ output: outputPath, roots: inventory.roots.length, read_only: true }, null, 2))
}
