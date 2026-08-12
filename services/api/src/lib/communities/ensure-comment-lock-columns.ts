import type { Client } from "@libsql/client"

// Schema source for the comment/post lock columns on file-backed (local dev
// and test) community databases. This is deliberately NOT a pair of ordinary
// template migrations: 1064_thread_comment_locks.sql and
// 1080_post_comment_locks.sql are ledger-only stubs because production
// communities already carried these columns without a schema_migrations entry,
// and plain ALTER statements would fail fleet replay with duplicate-column
// errors. SQLite has no ADD COLUMN IF NOT EXISTS, so the conditional checks
// below are the compatibility path.
//
// D1-backed community databases never receive these columns at all: they are
// absent from the provisioning schema snapshot, and this preflight only runs
// on file: bindings. Reads on the D1 fleet are guarded by
// resolvePostProjectionSchema (src/lib/posts/community-post-projection.ts),
// which substitutes constants when the columns are missing.
//
// Removal condition: a fleet-safe table-rebuild migration lands that puts the
// lock columns under normal template-migration control for every community
// database backend, at which point this preflight can be deleted.

async function getColumnNames(client: Client, tableName: "posts" | "comments"): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`)
  return new Set(result.rows.map((row) => String(row.name)))
}

async function addColumnIfMissing(input: {
  client: Client
  tableName: "posts" | "comments"
  columnNames: Set<string>
  columnName: string
  definition: string
}): Promise<void> {
  if (input.columnNames.has(input.columnName)) {
    return
  }

  try {
    await input.client.execute(`ALTER TABLE ${input.tableName} ADD COLUMN ${input.definition}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!message.toLowerCase().includes("duplicate column")) {
      throw error
    }
  }
}

export async function ensureCommentLockColumns(client: Client): Promise<void> {
  const postColumns = await getColumnNames(client, "posts")
  await addColumnIfMissing({
    client,
    tableName: "posts",
    columnNames: postColumns,
    columnName: "comments_locked",
    definition: "comments_locked INTEGER NOT NULL DEFAULT 0 CHECK (comments_locked IN (0, 1))",
  })
  await addColumnIfMissing({
    client,
    tableName: "posts",
    columnNames: postColumns,
    columnName: "comments_locked_at",
    definition: "comments_locked_at TEXT",
  })
  await addColumnIfMissing({
    client,
    tableName: "posts",
    columnNames: postColumns,
    columnName: "comments_locked_by_user_id",
    definition: "comments_locked_by_user_id TEXT",
  })
  await addColumnIfMissing({
    client,
    tableName: "posts",
    columnNames: postColumns,
    columnName: "comments_lock_reason",
    definition: "comments_lock_reason TEXT",
  })

  const commentColumns = await getColumnNames(client, "comments")
  await addColumnIfMissing({
    client,
    tableName: "comments",
    columnNames: commentColumns,
    columnName: "replies_locked",
    definition: "replies_locked INTEGER NOT NULL DEFAULT 0 CHECK (replies_locked IN (0, 1))",
  })
  await addColumnIfMissing({
    client,
    tableName: "comments",
    columnNames: commentColumns,
    columnName: "replies_locked_at",
    definition: "replies_locked_at TEXT",
  })
  await addColumnIfMissing({
    client,
    tableName: "comments",
    columnNames: commentColumns,
    columnName: "replies_locked_by_user_id",
    definition: "replies_locked_by_user_id TEXT",
  })
  await addColumnIfMissing({
    client,
    tableName: "comments",
    columnNames: commentColumns,
    columnName: "replies_lock_reason",
    definition: "replies_lock_reason TEXT",
  })
}
