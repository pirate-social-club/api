/**
 * Attested community-schema guarantees.
 *
 * Why this exists
 * ---------------
 * `REQUIRED_COMMUNITY_DB_MIGRATION` is a single scalar floor (1079). It is the
 * honest floor and it must stay honest: as of the 2026-08-04 fleet audit, the
 * production fleet still has real gaps above it — 12 shards without the booking
 * suite (1101-1108), 75 without live-room replay (1110-1113), and a 1099-1107
 * checksum-drift cohort. Raising the scalar past any of those would declare
 * them "guaranteed" when they are not: the same max()-as-head error that let
 * two shards sit un-migrated for a month while reporting the same ledger head
 * as healthy ones.
 *
 * But a scalar is not the only way to earn a guarantee. `community-schema-
 * requirements.json` already declares, per API commit, which community-template
 * migrations this API requires — and the release schema gate
 * (core/scripts/community/verify-community-schema-requirements.ts) verifies
 * every listed migration against every LIVE shard before the pin ships. An
 * entry there is not a comment with a review date; it is a claim something
 * re-checks on every release and fails closed on.
 *
 * So: the floor is the scalar, PLUS whatever the manifest declares
 * unconditional. That set is what this module exposes, so the guard lint and
 * the N-1 harness read one source of truth rather than a hand-maintained copy.
 *
 * Invariant worth preserving: a migration is covered by the guard lint OR by
 * the release gate, never by neither. Adding a migration to `unconditional`
 * moves it from the first to the second — it does not exempt it from both.
 */

import { readFileSync } from "node:fs"

export type CommunitySchemaGuarantees = {
  /** Migrations this API commit requires unconditionally on every live shard. */
  unconditional: ReadonlySet<string>
  /** Migrations required only when a named feature bundle is being enabled. */
  featureGated: ReadonlySet<string>
}

function assertMigrationName(value: unknown, owner: string): string {
  if (typeof value !== "string" || !/^\d{4}_[a-z0-9_]+\.sql$/u.test(value)) {
    throw new Error(`${owner}: expected a community-template migration filename, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Pure parse over already-read manifest JSON, so the policy is testable without
 * touching the filesystem. Fails closed: an unreadable shape throws rather than
 * silently yielding an empty guarantee set (an empty set would make the guard
 * lint *more* permissive exactly when the manifest is broken).
 */
export function parseCommunitySchemaGuarantees(manifest: unknown): CommunitySchemaGuarantees {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("community-schema-requirements: manifest must be an object")
  }
  const record = manifest as Record<string, unknown>

  const rawUnconditional = record.unconditional
  if (!Array.isArray(rawUnconditional)) {
    throw new Error("community-schema-requirements: `unconditional` must be an array")
  }
  const unconditional = new Set(
    rawUnconditional.map((entry) => assertMigrationName(entry, "unconditional entry")),
  )

  const featureGated = new Set<string>()
  const rawFeatures = record.features
  if (rawFeatures !== undefined) {
    if (!rawFeatures || typeof rawFeatures !== "object" || Array.isArray(rawFeatures)) {
      throw new Error("community-schema-requirements: `features` must be an object")
    }
    for (const [feature, value] of Object.entries(rawFeatures as Record<string, unknown>)) {
      const migrations = (value as { migrations?: unknown })?.migrations ?? value
      if (!Array.isArray(migrations)) {
        throw new Error(`community-schema-requirements: feature ${feature} must declare an array of migrations`)
      }
      for (const entry of migrations) {
        featureGated.add(assertMigrationName(entry, `feature ${feature}`))
      }
    }
  }

  for (const name of featureGated) {
    if (unconditional.has(name)) {
      throw new Error(
        `community-schema-requirements: ${name} is declared both unconditional and feature-gated; `
          + "one classification only",
      )
    }
  }

  return { unconditional, featureGated }
}

export function loadCommunitySchemaGuarantees(manifestPath: string): CommunitySchemaGuarantees {
  return parseCommunitySchemaGuarantees(JSON.parse(readFileSync(manifestPath, "utf8")))
}

/**
 * True when the API may read this migration's columns without a runtime schema
 * guard: the release gate proves every live shard carries it before the pin
 * ships. Feature-gated migrations deliberately do NOT qualify — the fleet only
 * has to satisfy those when the feature is being enabled, so runtime code must
 * still tolerate their absence.
 */
export function isAttestedGuaranteedMigration(
  guarantees: CommunitySchemaGuarantees,
  migrationName: string,
): boolean {
  return guarantees.unconditional.has(migrationName)
}
