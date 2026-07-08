import type { Client } from "../sql-client"

export function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  return normalized.includes("duplicate column")
    || normalized.includes("already exists")
    || normalized.includes("42701")
}

function isMissingColumnError(error: unknown, columnName: string): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  const normalizedColumn = columnName.toLowerCase()
  return normalized.includes("no such column")
    || normalized.includes(`column "${normalizedColumn}" does not exist`)
    || normalized.includes(`column ${normalizedColumn} does not exist`)
    || normalized.includes("42703")
}

export async function hasReadableSongArtifactBundleColumn(
  client: Client,
  columnName: "alignment_reason" | "genius_annotations_url" | "karaoke_revision_id" | "title",
): Promise<boolean> {
  try {
    await client.execute(`SELECT ${columnName} FROM song_artifact_bundles LIMIT 0`)
    return true
  } catch (error) {
    if (isMissingColumnError(error, columnName)) {
      return false
    }
    throw error
  }
}
