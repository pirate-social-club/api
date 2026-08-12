export const BOOTSTRAP_STATE_TABLE_NAME = "_pirate_bootstrap_state"

export const BOOTSTRAP_STATE_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS "${BOOTSTRAP_STATE_TABLE_NAME}" (` +
  "community_id TEXT PRIMARY KEY, snapshot_digest TEXT NOT NULL, completed_at TEXT NOT NULL)"

export const SCHEMA_ATTESTATION_INVENTORY_SQL = `
  SELECT type, name, sql
  FROM sqlite_master
  WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
  ORDER BY type, name
`

export const SCHEMA_ATTESTATION_MIGRATION_LEDGER_SQL = `
  SELECT migration_name, checksum
  FROM schema_migrations
  ORDER BY migration_name
`

export type ShardSchemaInventoryRow = {
  type: "index" | "table"
  name: string
  sql: string | null
}

export type ShardMigrationLedgerRow = {
  migration_name: string
  checksum: string
}

export type ShardSchemaObservationProof = {
  format_version: 1
  kind: "raw"
  schema_fingerprint: string
  migration_ledger_digest: string
  canonical_inventory_digest: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    )
  }
  return value
}

export function stableSchemaAttestationJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

export async function schemaAttestationDigest(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableSchemaAttestationJson(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function unquoteSqlIdentifier(value: string): string {
  const trimmed = value.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("`") && trimmed.endsWith("`"))) {
    return trimmed.slice(1, -1)
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1)
  return trimmed
}

function splitCreateTableColumns(sql: string): string[] {
  const open = sql.indexOf("(")
  const close = sql.lastIndexOf(")")
  if (open < 0 || close <= open) return []
  const body = sql.slice(open + 1, close)
  const parts: string[] = []
  let current = ""
  let depth = 0
  let quote: string | null = null
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    const next = body[index + 1]
    current += char
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          current += next
          index += 1
        } else {
          quote = null
        }
      }
      continue
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char
      continue
    }
    if (char === "[") {
      quote = "]"
      continue
    }
    if (char === "(") depth += 1
    else if (char === ")") depth = Math.max(0, depth - 1)
    else if (char === "," && depth === 0) {
      parts.push(current.slice(0, -1).trim())
      current = ""
    }
  }
  if (current.trim()) parts.push(current.trim())
  const constraint = /^(?:CONSTRAINT\b|PRIMARY\s+KEY\b|FOREIGN\s+KEY\b|UNIQUE\b|CHECK\b)/iu
  return parts
    .filter((part) => !constraint.test(part))
    .map((part) => {
      const match = part.match(/^(?:"(?:""|[^"])+"|`(?:``|[^`])+`|\[[^\]]+\]|[^\s]+)/u)
      return match ? unquoteSqlIdentifier(match[0]) : ""
    })
    .filter(Boolean)
}

export function schemaArtifactsFromInventoryRows(rows: readonly ShardSchemaInventoryRow[]): string[] {
  const artifacts = new Set<string>()
  for (const row of rows) {
    if (row.type === "index") {
      artifacts.add(`index:${row.name}`)
      continue
    }
    artifacts.add(`table:${row.name}`)
    for (const column of splitCreateTableColumns(row.sql ?? "")) {
      artifacts.add(`column:${row.name}.${column}`)
    }
  }
  return [...artifacts].sort()
}

export async function shardSchemaObservationProof(input: {
  schemaRows: readonly ShardSchemaInventoryRow[]
  migrationLedgerRows: readonly ShardMigrationLedgerRow[]
}): Promise<ShardSchemaObservationProof> {
  const schemaRows = [...input.schemaRows]
    .map(({ type, name, sql }) => ({ type, name, sql }))
    .sort((left, right) => left.type.localeCompare(right.type) || left.name.localeCompare(right.name))
  const migrationLedgerRows = [...input.migrationLedgerRows]
    .map(({ migration_name, checksum }) => ({ migration_name, checksum }))
    .sort((left, right) => left.migration_name.localeCompare(right.migration_name))
  return {
    format_version: 1,
    kind: "raw",
    schema_fingerprint: await schemaAttestationDigest(schemaRows),
    migration_ledger_digest: await schemaAttestationDigest(migrationLedgerRows),
    canonical_inventory_digest: await schemaAttestationDigest(schemaArtifactsFromInventoryRows(schemaRows)),
  }
}

export function isShardSchemaObservationProof(value: unknown): value is ShardSchemaObservationProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const proof = value as Partial<ShardSchemaObservationProof>
  return (
    proof.format_version === 1 &&
    proof.kind === "raw" &&
    /^[0-9a-f]{64}$/u.test(proof.schema_fingerprint ?? "") &&
    /^[0-9a-f]{64}$/u.test(proof.migration_ledger_digest ?? "") &&
    /^[0-9a-f]{64}$/u.test(proof.canonical_inventory_digest ?? "")
  )
}
