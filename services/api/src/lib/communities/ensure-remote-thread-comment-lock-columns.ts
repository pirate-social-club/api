import type { Client } from "@libsql/client"

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

export async function ensureRemoteThreadCommentLockColumns(client: Client): Promise<void> {
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
