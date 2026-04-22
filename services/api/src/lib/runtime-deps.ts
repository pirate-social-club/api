import { createClient as createLibsqlClient } from "@libsql/client"
import type { Client as LibsqlClient, Transaction as LibsqlTransaction } from "@libsql/client"
import { Pool, neonConfig } from "@neondatabase/serverless"
import { globalSingleton } from "./db-helpers"
import { requireControlPlaneDbUrl } from "./auth/auth-db-queries"
import type { Client, InStatement, QueryResult, QueryResultRow, Transaction } from "./sql-client"
import type { Env } from "../types"

type PostgresQueryable = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }>
}

neonConfig.poolQueryViaFetch = true

export function isPostgresControlPlaneUrl(value: string): boolean {
  return value.startsWith("postgres://") || value.startsWith("postgresql://")
}

function normalizeStatement(statement: InStatement | string): InStatement {
  if (typeof statement === "string") {
    return { sql: statement, args: [] }
  }
  return {
    sql: statement.sql,
    args: statement.args ?? [],
  }
}

function normalizeArgs(args: unknown[]): unknown[] {
  return args.map((value) => value === undefined ? null : value)
}

function normalizeRowValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString()
  }
  return value
}

function normalizeRows(rows: unknown[]): QueryResultRow[] {
  return rows.map((row) => {
    if (!row || typeof row !== "object") {
      return {}
    }
    return Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, normalizeRowValue(value)]),
    )
  })
}

export function postgresifySql(sql: string): string {
  const normalized = sql.replace(/\?(\d+)/g, (_, index: string) => `$${index}`)

  if (/INSERT OR IGNORE INTO (wallet_attachments|notification_receipts)\b/i.test(normalized)) {
    return normalized.replace(
      /INSERT OR IGNORE INTO (\w+)\b([\s\S]*?)\)\s*$/i,
      "INSERT INTO $1$2)\n      ON CONFLICT DO NOTHING",
    )
  }

  if (/INSERT OR REPLACE INTO namespace_verification_capabilities\b/i.test(normalized)) {
    const insertSql = normalized.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/i, "INSERT INTO")
    return `${insertSql}
      ON CONFLICT (capability_record_id) DO UPDATE SET
        namespace_verification_session_id = EXCLUDED.namespace_verification_session_id,
        namespace_verification_id = EXCLUDED.namespace_verification_id,
        family = EXCLUDED.family,
        capability_name = EXCLUDED.capability_name,
        capability_value = EXCLUDED.capability_value,
        source_evidence_bundle_id = EXCLUDED.source_evidence_bundle_id,
        status = EXCLUDED.status,
        first_accepted_at = EXCLUDED.first_accepted_at,
        last_revalidated_at = EXCLUDED.last_revalidated_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at`
  }

  if (/INSERT OR REPLACE INTO namespace_verifications\b/i.test(normalized)) {
    const insertSql = normalized.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/i, "INSERT INTO")
    return `${insertSql}
      ON CONFLICT (namespace_verification_id) DO UPDATE SET
        source_namespace_verification_session_id = EXCLUDED.source_namespace_verification_session_id,
        user_id = EXCLUDED.user_id,
        family = EXCLUDED.family,
        normalized_root_label = EXCLUDED.normalized_root_label,
        status = EXCLUDED.status,
        root_exists = EXCLUDED.root_exists,
        root_control_verified = EXCLUDED.root_control_verified,
        expiry_horizon_sufficient = EXCLUDED.expiry_horizon_sufficient,
        routing_enabled = EXCLUDED.routing_enabled,
        pirate_dns_authority_verified = EXCLUDED.pirate_dns_authority_verified,
        club_attach_allowed = EXCLUDED.club_attach_allowed,
        pirate_web_routing_allowed = EXCLUDED.pirate_web_routing_allowed,
        pirate_subdomain_issuance_allowed = EXCLUDED.pirate_subdomain_issuance_allowed,
        control_class = EXCLUDED.control_class,
        operation_class = EXCLUDED.operation_class,
        observation_provider = EXCLUDED.observation_provider,
        evidence_bundle_ref = EXCLUDED.evidence_bundle_ref,
        accepted_at = EXCLUDED.accepted_at,
        expires_at = EXCLUDED.expires_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        anchor_height = EXCLUDED.anchor_height,
        anchor_block_hash = EXCLUDED.anchor_block_hash,
        anchor_root_hash = EXCLUDED.anchor_root_hash,
        proof_root_hash = EXCLUDED.proof_root_hash`
  }

  return normalized
}

async function executePostgresStatement(queryable: PostgresQueryable, statement: InStatement | string): Promise<QueryResult> {
  const normalized = normalizeStatement(statement)
  const result = await queryable.query(postgresqlDdlCompat(postgresifySql(normalized.sql)), normalizeArgs(normalized.args ?? []))
  return {
    rows: normalizeRows(result.rows),
    rowsAffected: result.rowCount ?? undefined,
  }
}

function postgresqlDdlCompat(sql: string): string {
  return sql
}

class LibsqlTransactionAdapter implements Transaction {
  constructor(private readonly tx: LibsqlTransaction) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const result = await this.tx.execute(statement as never)
    return {
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  async batch(statements: InStatement[], _mode: "read" | "write" = "write"): Promise<QueryResult[]> {
    const results = await this.tx.batch(statements as never)
    return results.map((result) => ({
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }))
  }

  async commit(): Promise<void> {
    await this.tx.commit()
  }

  async rollback(): Promise<void> {
    await this.tx.rollback()
  }

  close(): void {
    this.tx.close()
  }
}

class LibsqlClientAdapter implements Client {
  constructor(
    private readonly client: LibsqlClient,
    private readonly shouldCloseClient = true,
  ) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const result = await this.client.execute(statement as never)
    return {
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }
  }

  async batch(statements: InStatement[], mode: "read" | "write" = "write"): Promise<QueryResult[]> {
    const results = await this.client.batch(statements as never, mode)
    return results.map((result) => ({
      rows: result.rows as QueryResultRow[],
      rowsAffected: result.rowsAffected,
      lastInsertRowid: result.lastInsertRowid,
    }))
  }

  async transaction(mode: "read" | "write" = "write"): Promise<Transaction> {
    const tx = await this.client.transaction(mode)
    return new LibsqlTransactionAdapter(tx)
  }

  close(): void {
    if (this.shouldCloseClient) {
      this.client.close()
    }
  }
}

class PostgresTransactionAdapter implements Transaction {
  constructor(private readonly tx: PostgresQueryable & { release: () => void }) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return await executePostgresStatement(this.tx, statement)
  }

  async batch(statements: InStatement[]): Promise<QueryResult[]> {
    const results: QueryResult[] = []
    for (const statement of statements) {
      results.push(await this.execute(statement))
    }
    return results
  }

  async commit(): Promise<void> {
    await this.tx.query("COMMIT")
  }

  async rollback(): Promise<void> {
    await this.tx.query("ROLLBACK")
  }

  close(): void {
    this.tx.release()
  }
}

class PostgresClientAdapter implements Client {
  constructor(private readonly pool: Pool) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return await executePostgresStatement(this.pool, statement)
  }

  async batch(statements: InStatement[]): Promise<QueryResult[]> {
    const tx = await this.transaction()
    try {
      const results = await tx.batch(statements, "write")
      await tx.commit()
      return results
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }
  }

  async transaction(_mode: "read" | "write" = "write"): Promise<Transaction> {
    const client = await this.pool.connect()
    try {
      await client.query("BEGIN")
    } catch (error) {
      client.release()
      throw error
    }
    return new PostgresTransactionAdapter(client)
  }

  close(): void {
    void this.pool.end()
  }
}

export function getControlPlaneCacheKey(env: Env): string {
  return requireControlPlaneDbUrl(env)
}

function getControlPlaneClient(env: Env): Client {
  const url = requireControlPlaneDbUrl(env)
  if (isPostgresControlPlaneUrl(url)) {
    // In Cloudflare Workers, Postgres I/O objects must stay request-scoped.
    // Reusing a cached Neon pool across requests can trigger cross-request I/O failures.
    return new PostgresClientAdapter(new Pool({ connectionString: url, max: 4 }))
  }

  const cacheKey = `cp:${getControlPlaneCacheKey(env)}`
  return globalSingleton("controlPlaneClient", cacheKey, () => new LibsqlClientAdapter(createLibsqlClient({
    url,
  }), false))
}

export { getControlPlaneClient }
