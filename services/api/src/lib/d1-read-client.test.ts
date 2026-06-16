import { describe, expect, test } from "bun:test"
import { D1ReadClientAdapter, D1ReadSession, type D1DatabaseLike } from "./d1-read-client"

type RecordedPrepare = {
  sql: string
  args: unknown[]
}

type D1MockResponse = {
  rows?: Record<string, unknown>[]
  changes?: number
  lastRowId?: number
  servedByRegion?: string
  servedByPrimary?: boolean
  error?: Error
}

function buildMeta(response: D1MockResponse) {
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: response.lastRowId ?? 0,
    changed_db: response.changes !== undefined && response.changes > 0,
    changes: response.changes ?? 0,
    served_by_region: response.servedByRegion,
    served_by_primary: response.servedByPrimary,
  }
}

class FakePreparedStatement {
  readonly bindArgs: unknown[] = []
  constructor(
    sql: string,
    private readonly recorder: { prepared: RecordedPrepare[] },
    private readonly response: D1MockResponse,
  ) {
    this.recorder.prepared.push({ sql, args: [] })
  }

  bind(...values: unknown[]): FakePreparedStatement {
    this.bindArgs.push(...values)
    const last = this.recorder.prepared[this.recorder.prepared.length - 1]
    if (last) {
      last.args = [...values]
    }
    return this
  }

  all<T extends Record<string, unknown>>(): Promise<D1Result<T>> {
    if (this.response.error) {
      return Promise.reject(this.response.error)
    }
    return Promise.resolve({
      results: (this.response.rows ?? []) as T[],
      success: true,
      meta: buildMeta(this.response),
    } as unknown as D1Result<T>)
  }

  run<T extends Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>()
  }
}

class FakeD1Database {
  readonly prepared: RecordedPrepare[] = []
  readonly batchCalls: FakePreparedStatement[][] = []
  readonly sessionConstraints: (string | undefined)[] = []
  private readonly responseBySql = new Map<string, D1MockResponse>()
  private readonly defaultResponse: D1MockResponse = { rows: [] }
  supportsSessions = true
  bookmark: string | null = "bookmark-0"

  setResponse(sql: string, response: D1MockResponse): void {
    this.responseBySql.set(sql, response)
  }

  prepare(query: string): FakePreparedStatement {
    const response = this.responseBySql.get(query) ?? this.defaultResponse
    return new FakePreparedStatement(query, { prepared: this.prepared }, response)
  }

  batch<T = unknown>(statements: FakePreparedStatement[]): Promise<D1Result<T>[]> {
    this.batchCalls.push(statements)
    return Promise.all(statements.map((stmt) => stmt.all<Record<string, unknown>>())) as Promise<D1Result<T>[]>
  }
}

function asD1DatabaseLike(db: FakeD1Database): D1DatabaseLike {
  return {
    prepare: (sql) => db.prepare(sql) as unknown as D1PreparedStatement,
    batch: <T = unknown>(statements: D1PreparedStatement[]) =>
      db.batch(statements as unknown as FakePreparedStatement[]) as Promise<D1Result<T>[]>,
    withSession: db.supportsSessions
      ? (constraintOrBookmark) => {
          db.sessionConstraints.push(constraintOrBookmark)
          return {
            prepare: (sql) => db.prepare(sql) as unknown as D1PreparedStatement,
            batch: <T = unknown>(statements: D1PreparedStatement[]) =>
              db.batch(statements as unknown as FakePreparedStatement[]) as Promise<D1Result<T>[]>,
            getBookmark: () => db.bookmark,
          }
        }
      : undefined,
  }
}

describe("D1ReadClientAdapter reads", () => {
  test("execute prepares and binds args, then maps the result rows", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT id, name FROM widgets WHERE id = ?1", {
      rows: [{ id: "w-1", name: "alpha" }],
    })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    const result = await adapter.execute({ sql: "SELECT id, name FROM widgets WHERE id = ?1", args: ["w-1"] })

    expect(result.rows).toEqual([{ id: "w-1", name: "alpha" }])
    expect(db.prepared[0]).toEqual({ sql: "SELECT id, name FROM widgets WHERE id = ?1", args: ["w-1"] })
  })

  test("execute allows read introspection via PRAGMA table_info", async () => {
    const db = new FakeD1Database()
    db.setResponse("PRAGMA table_info(posts)", { rows: [{ name: "id" }, { name: "title" }] })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    const result = await adapter.execute("PRAGMA table_info(posts)")
    expect(result.rows).toEqual([{ name: "id" }, { name: "title" }])
  })

  test("execute accepts a raw SQL string without args and skips bind", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT 42 AS answer", { rows: [{ answer: 42 }] })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    const result = await adapter.execute("SELECT 42 AS answer")
    expect(result.rows).toEqual([{ answer: 42 }])
    expect(db.prepared[0]).toEqual({ sql: "SELECT 42 AS answer", args: [] })
  })

  test("batch reads run through db.batch and map each result in order", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT id FROM a WHERE id = ?1", { rows: [{ id: "a-1" }] })
    db.setResponse("SELECT id FROM b WHERE id = ?1", { rows: [{ id: "b-1" }] })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    const results = await adapter.batch(
      [
        { sql: "SELECT id FROM a WHERE id = ?1", args: ["a-1"] },
        { sql: "SELECT id FROM b WHERE id = ?1", args: ["b-1"] },
      ],
      "read",
    )

    expect(db.batchCalls).toHaveLength(1)
    expect(results.map((r) => r.rows)).toEqual([[{ id: "a-1" }], [{ id: "b-1" }]])
    expect(db.prepared.map((p) => p.args)).toEqual([["a-1"], ["b-1"]])
  })

  test("batch defaults to read mode", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT 1 AS one", { rows: [{ one: 1 }] })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    const results = await adapter.batch([{ sql: "SELECT 1 AS one", args: [] }])
    expect(results).toEqual([{ rows: [{ one: 1 }], rowsAffected: 0, lastInsertRowid: 0 }])
  })

  test("batch with an empty list returns [] and never calls db.batch", async () => {
    const db = new FakeD1Database()
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    expect(await adapter.batch([], "read")).toEqual([])
    expect(db.batchCalls).toHaveLength(0)
  })

  test("execute propagates errors from D1", async () => {
    const db = new FakeD1Database()
    const failure = new Error("D1 SQLITE_ERROR: no such table")
    db.setResponse("SELECT * FROM missing", { error: failure })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    expect(adapter.execute("SELECT * FROM missing")).rejects.toBe(failure)
  })
})

describe("D1ReadClientAdapter read-only enforcement", () => {
  const writes = [
    "INSERT INTO a (id) VALUES (?1)",
    "UPDATE a SET id = ?1",
    "DELETE FROM a WHERE id = ?1",
    "REPLACE INTO a (id) VALUES (?1)",
    "CREATE TABLE a (id TEXT)",
    "DROP TABLE a",
    "ALTER TABLE a ADD COLUMN b TEXT",
    "  -- leading comment\n  DELETE FROM a",
    "WITH doomed AS (SELECT id FROM a) DELETE FROM a",
  ]

  for (const sql of writes) {
    test(`execute rejects write: ${sql.slice(0, 24).replace(/\n/g, " ")}`, async () => {
      const adapter = new D1ReadClientAdapter(asD1DatabaseLike(new FakeD1Database()))
      await expect(adapter.execute(sql)).rejects.toMatchObject({ code: "read_only_violation" })
    })
  }

  test("a write statement is never prepared against the database", async () => {
    const db = new FakeD1Database()
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))
    await expect(adapter.execute("DELETE FROM a")).rejects.toMatchObject({ code: "read_only_violation" })
    expect(db.prepared).toHaveLength(0)
  })

  test("batch in write mode is rejected", async () => {
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(new FakeD1Database()))
    await expect(
      adapter.batch([{ sql: "INSERT INTO a (id) VALUES (?1)", args: ["a-1"] }], "write"),
    ).rejects.toMatchObject({ code: "read_only_violation" })
  })

  test("batch in read mode rejects a write statement", async () => {
    const db = new FakeD1Database()
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))
    await expect(
      adapter.batch(
        [
          { sql: "SELECT id FROM a", args: [] },
          { sql: "UPDATE a SET id = ?1", args: ["x"] },
        ],
        "read",
      ),
    ).rejects.toMatchObject({ code: "read_only_violation" })
    expect(db.batchCalls).toHaveLength(0)
  })
})

describe("D1ReadClientAdapter hardened guard", () => {
  const rejected = [
    // Statement batching — a leading SELECT must not smuggle a second statement.
    "SELECT id FROM a; DROP TABLE a",
    "SELECT 1; SELECT 2",
    // DDL / connection verbs beyond the original write set.
    "ATTACH DATABASE 'x.db' AS x",
    "DETACH DATABASE x",
    "VACUUM",
    "REINDEX a",
    "ANALYZE a",
    // A CTE that wraps DDL (not just a DML write).
    "WITH doomed AS (SELECT id FROM a) DROP TABLE a",
  ]

  for (const sql of rejected) {
    test(`rejects: ${sql.slice(0, 32)}`, async () => {
      const db = new FakeD1Database()
      const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))
      await expect(adapter.execute(sql)).rejects.toMatchObject({ code: "read_only_violation" })
      expect(db.prepared).toHaveLength(0)
    })
  }

  const allowed = [
    "SELECT id FROM a", // no semicolon
    "SELECT id FROM a;", // single trailing semicolon is fine
    "SELECT id FROM a; ", // trailing semicolon + whitespace
    "WITH live AS (SELECT id FROM a) SELECT * FROM live", // read-only CTE still allowed
  ]

  for (const sql of allowed) {
    test(`allows: ${sql.slice(0, 40)}`, async () => {
      const adapter = new D1ReadClientAdapter(asD1DatabaseLike(new FakeD1Database()))
      const result = await adapter.execute(sql)
      expect(result.rows).toEqual([])
    })
  }
})

describe("D1ReadClientAdapter PRAGMA boundary", () => {
  test("approved introspection pragmas are allowed", async () => {
    const db = new FakeD1Database()
    db.setResponse("PRAGMA index_list(posts)", { rows: [{ name: "idx_posts" }] })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))
    const result = await adapter.execute("PRAGMA index_list(posts)")
    expect(result.rows).toEqual([{ name: "idx_posts" }])
  })

  const rejectedPragmas = [
    "PRAGMA user_version = 1",
    "PRAGMA foreign_keys = ON",
    "PRAGMA journal_mode = WAL",
    "PRAGMA user_version", // read, but not on the approved introspection allowlist
    "PRAGMA optimize",
  ]

  for (const sql of rejectedPragmas) {
    test(`rejects pragma: ${sql}`, async () => {
      const db = new FakeD1Database()
      const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))
      await expect(adapter.execute(sql)).rejects.toMatchObject({ code: "read_only_violation" })
      expect(db.prepared).toHaveLength(0)
    })
  }
})

describe("D1ReadSession", () => {
  test("withSession passes the constraint and returns a read session", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT 1 AS one", { rows: [{ one: 1 }], servedByRegion: "weur", servedByPrimary: false })
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))

    const session = adapter.withSession("first-unconstrained")
    expect(session).toBeInstanceOf(D1ReadSession)
    expect(db.sessionConstraints).toEqual(["first-unconstrained"])

    await session.execute("SELECT 1 AS one")
    expect(session.lastReadMeta).toEqual({ servedByRegion: "weur", servedByPrimary: false })
  })

  test("lastReadMeta reflects a primary-served read", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT 2 AS two", { rows: [{ two: 2 }], servedByRegion: "enam", servedByPrimary: true })
    const session = new D1ReadClientAdapter(asD1DatabaseLike(db)).withSession("first-primary")

    await session.execute("SELECT 2 AS two")
    expect(session.lastReadMeta).toEqual({ servedByRegion: "enam", servedByPrimary: true })
  })

  test("batch captures per-query served-by metadata, not just the last", async () => {
    const db = new FakeD1Database()
    db.setResponse("SELECT 1 AS one", { rows: [{ one: 1 }], servedByRegion: "enam", servedByPrimary: true })
    db.setResponse("SELECT 2 AS two", { rows: [{ two: 2 }], servedByRegion: "weur", servedByPrimary: false })
    const session = new D1ReadClientAdapter(asD1DatabaseLike(db)).withSession("first-primary")

    await session.batch(
      [
        { sql: "SELECT 1 AS one", args: [] },
        { sql: "SELECT 2 AS two", args: [] },
      ],
      "read",
    )

    // first-primary only guarantees the FIRST query on primary; per-query meta differs
    expect(session.lastReadMetas).toEqual([
      { servedByRegion: "enam", servedByPrimary: true },
      { servedByRegion: "weur", servedByPrimary: false },
    ])
    expect(session.lastReadMeta).toEqual({ servedByRegion: "weur", servedByPrimary: false })
  })

  test("getBookmark surfaces the session bookmark", async () => {
    const db = new FakeD1Database()
    db.bookmark = "bookmark-42"
    const session = new D1ReadClientAdapter(asD1DatabaseLike(db)).withSession()
    expect(session.getBookmark()).toBe("bookmark-42")
  })

  test("a session is still read-only", async () => {
    const db = new FakeD1Database()
    const session = new D1ReadClientAdapter(asD1DatabaseLike(db)).withSession()
    await expect(session.execute("DELETE FROM a")).rejects.toMatchObject({ code: "read_only_violation" })
  })

  test("withSession throws when the binding does not support sessions", () => {
    const db = new FakeD1Database()
    db.supportsSessions = false
    const adapter = new D1ReadClientAdapter(asD1DatabaseLike(db))
    expect(() => adapter.withSession()).toThrow("does not support sessions")
  })
})
