import type { Client } from "@libsql/client"

const VINYL_RELEASE_LISTINGS_MIGRATION_NAME = "1094_vinyl_release_listings.sql"
const VINYL_RELEASE_LISTINGS_MIGRATION_CHECKSUM = "04680b4600a34ce5275e33294b2e8d91d2fd869d66d0d82583dc1fe03d60cf1b"

async function getColumnNames(client: Client, tableName: "listings" | "purchases"): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`)
  return new Set(result.rows.map((row) => String(row.name)))
}

async function addColumnIfMissing(input: {
  client: Client
  tableName: "listings" | "purchases"
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

export async function ensureRemoteCommerceVinylReleaseColumns(client: Client): Promise<void> {
  const listingColumns = await getColumnNames(client, "listings")
  await addColumnIfMissing({
    client,
    tableName: "listings",
    columnNames: listingColumns,
    columnName: "vinyl_release_provider",
    definition: "vinyl_release_provider TEXT CHECK (vinyl_release_provider IS NULL OR vinyl_release_provider IN ('elasticstage'))",
  })
  await addColumnIfMissing({
    client,
    tableName: "listings",
    columnNames: listingColumns,
    columnName: "vinyl_release_url",
    definition: "vinyl_release_url TEXT",
  })

  const purchaseColumns = await getColumnNames(client, "purchases")
  await addColumnIfMissing({
    client,
    tableName: "purchases",
    columnNames: purchaseColumns,
    columnName: "vinyl_release_provider",
    definition: "vinyl_release_provider TEXT CHECK (vinyl_release_provider IS NULL OR vinyl_release_provider IN ('elasticstage'))",
  })
  await addColumnIfMissing({
    client,
    tableName: "purchases",
    columnNames: purchaseColumns,
    columnName: "vinyl_release_url",
    definition: "vinyl_release_url TEXT",
  })

  await client.batch([
    {
      sql: `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration_name TEXT PRIMARY KEY,
          migration_label TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `,
      args: [],
    },
    {
      sql: `
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [VINYL_RELEASE_LISTINGS_MIGRATION_NAME, VINYL_RELEASE_LISTINGS_MIGRATION_CHECKSUM],
    },
  ], "write")
}
