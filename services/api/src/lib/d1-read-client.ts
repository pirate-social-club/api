import type { ReadClient, InStatement, QueryResult, QueryResultRow } from "./sql-client"
import { HttpError } from "./errors"
import { isReadOnlyStatement, readOnlyVerb } from "@pirate/api-shared"

/** The read surface shared by a D1 database binding and a D1 session. */
export interface D1ReadTarget {
  prepare(query: string): D1PreparedStatement
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>
}

export interface D1DatabaseLike extends D1ReadTarget {
  /**
   * Open a D1 Sessions read session. `constraintOrBookmark` is either a
   * starting constraint (`"first-primary"` | `"first-unconstrained"`) or a
   * bookmark from a previous session. Optional: not every binding/runtime
   * exposes sessions, so callers must handle its absence.
   */
  withSession?(constraintOrBookmark?: string): D1DatabaseSessionLike
}

export interface D1DatabaseSessionLike extends D1ReadTarget {
  getBookmark(): string | null
}

/** Replica-vs-primary signal surfaced by D1 Sessions on each result. */
export type D1ReadMeta = {
  servedByRegion: string | null
  servedByPrimary: boolean | null
}

const EMPTY_READ_META: D1ReadMeta = { servedByRegion: null, servedByPrimary: null }

// Read-only enforcement lives in @pirate/api-shared (`isReadOnlyStatement`) so the
// API's D1 read client and the community D1 shard Worker run the identical strict
// allowlist. See that module for the guard's scope and known fail-closed limits.
function readOnlyViolation(sql: string): HttpError {
  return new HttpError(
    500,
    "read_only_violation",
    `Statement rejected by read-only D1 client (not on the read allowlist): ${readOnlyVerb(sql)}`,
  )
}

function assertReadOnly(sql: string): void {
  if (!isReadOnlyStatement(sql)) {
    throw readOnlyViolation(sql)
  }
}

function normalizeStatement(statement: InStatement | string): { sql: string; args: unknown[] } {
  if (typeof statement === "string") {
    return { sql: statement, args: [] }
  }
  return {
    sql: statement.sql,
    args: statement.args ?? [],
  }
}

function toQueryResult(result: D1Result): QueryResult {
  return {
    rows: (result.results ?? []) as QueryResultRow[],
    rowsAffected: result.meta?.changes,
    lastInsertRowid: result.meta?.last_row_id,
  }
}

function readMetaFrom(meta: D1Result["meta"] | undefined): D1ReadMeta {
  if (!meta) {
    return EMPTY_READ_META
  }
  const raw = meta as { served_by_region?: unknown; served_by_primary?: unknown }
  return {
    servedByRegion: typeof raw.served_by_region === "string" ? raw.served_by_region : null,
    servedByPrimary: typeof raw.served_by_primary === "boolean" ? raw.served_by_primary : null,
  }
}

function prepareReadStatement(target: D1ReadTarget, statement: InStatement | string): D1PreparedStatement {
  const normalized = normalizeStatement(statement)
  assertReadOnly(normalized.sql)
  const prepared = target.prepare(normalized.sql)
  return normalized.args.length > 0 ? prepared.bind(...normalized.args) : prepared
}

async function readExecute(
  target: D1ReadTarget,
  statement: InStatement | string,
  onMetas: (metas: (D1Result["meta"] | undefined)[]) => void,
): Promise<QueryResult> {
  const prepared = prepareReadStatement(target, statement)
  const result = await prepared.all()
  onMetas([result.meta])
  return toQueryResult(result)
}

async function readBatch(
  target: D1ReadTarget,
  statements: InStatement[],
  mode: "read" | "write",
  onMetas: (metas: (D1Result["meta"] | undefined)[]) => void,
): Promise<QueryResult[]> {
  if (mode === "write") {
    throw new HttpError(500, "read_only_violation", "Write batch rejected by read-only D1 client")
  }
  if (statements.length === 0) {
    return []
  }
  const prepared = statements.map((statement) => prepareReadStatement(target, statement))
  const results = await target.batch(prepared)
  // Capture per-query metadata: with `first-primary` only the first query is
  // guaranteed on primary, so per-query `served_by_primary` can differ.
  onMetas(results.map((result) => result.meta))
  return results.map((result) => toQueryResult(result))
}

/**
 * Read-only `ReadClient` over a D1 binding. Every statement is validated to be
 * read-only; `batch` rejects write mode. Use `withSession` for the
 * primary-vs-replica benchmark — the returned session carries `lastReadMeta`
 * (`served_by_region` / `served_by_primary`) and a bookmark.
 */
export class D1ReadClientAdapter implements ReadClient {
  constructor(private readonly db: D1DatabaseLike) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return readExecute(this.db, statement, () => {})
  }

  async batch(statements: InStatement[], mode: "read" | "write" = "read"): Promise<QueryResult[]> {
    return readBatch(this.db, statements, mode, () => {})
  }

  /**
   * Open a D1 Sessions read session. `constraintOrBookmark` accepts a starting
   * constraint or a prior bookmark:
   *   - `"first-primary"`: the FIRST query runs on the primary; later queries in
   *     the session may still be served by a replica. It is NOT a primary-only
   *     session — read `D1ReadSession.lastReadMetas` per query to see placement.
   *   - `"first-unconstrained"` (default): any region may serve the first query.
   */
  withSession(constraintOrBookmark?: string): D1ReadSession {
    if (!this.db.withSession) {
      throw new HttpError(500, "d1_session_unsupported", "D1 binding does not support sessions")
    }
    return new D1ReadSession(this.db.withSession(constraintOrBookmark))
  }
}

/**
 * A read-only `ReadClient` bound to a D1 Sessions session. Tracks the per-query
 * served-by metadata of the most recent read (a batch yields one entry per
 * statement) and exposes the session bookmark for read-your-writes sequencing
 * and primary-vs-replica benchmarking.
 */
export class D1ReadSession implements ReadClient {
  private lastMetas: D1ReadMeta[] = []

  constructor(private readonly session: D1DatabaseSessionLike) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    return readExecute(this.session, statement, (metas) => {
      this.lastMetas = metas.map(readMetaFrom)
    })
  }

  async batch(statements: InStatement[], mode: "read" | "write" = "read"): Promise<QueryResult[]> {
    return readBatch(this.session, statements, mode, (metas) => {
      this.lastMetas = metas.map(readMetaFrom)
    })
  }

  /** Per-query served-by signal from the most recent read (one entry per statement). */
  get lastReadMetas(): readonly D1ReadMeta[] {
    return this.lastMetas
  }

  /** Served-by signal of the most recent single read (last statement of a batch). */
  get lastReadMeta(): D1ReadMeta {
    return this.lastMetas[this.lastMetas.length - 1] ?? EMPTY_READ_META
  }

  /** Bookmark for the next session that needs to read its own writes. */
  getBookmark(): string | null {
    return this.session.getBookmark()
  }
}
