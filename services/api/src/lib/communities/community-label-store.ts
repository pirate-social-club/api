import type { DbExecutor } from "../db-helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Community, PostLabel } from "../../types"

type CommunityLabelRow = {
  label_id: string
  community_id: string
  label: string
  description: string | null
  color_token: string | null
  status: "active" | "archived"
  created_at: string
  updated_at: string
}

function toCommunityLabelRow(row: unknown): CommunityLabelRow {
  return {
    label_id: requiredString(row, "label_id"),
    community_id: requiredString(row, "community_id"),
    label: requiredString(row, "label"),
    description: stringOrNull(rowValue(row, "description")),
    color_token: stringOrNull(rowValue(row, "color_token")),
    status: requiredString(row, "status") as CommunityLabelRow["status"],
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function serializeCommunityPostLabel(row: Pick<CommunityLabelRow, "label_id" | "label" | "color_token" | "status">): PostLabel {
  return {
    label_id: row.label_id,
    label: row.label,
    color_token: row.color_token,
    status: row.status,
  }
}

export async function listCommunityLabels(input: {
  executor: DbExecutor
  communityId: string
  includeArchived?: boolean
}): Promise<CommunityLabelRow[]> {
  const result = await input.executor.execute({
    sql: `
      SELECT label_id, community_id, label, description, color_token, status, created_at, updated_at
      FROM labels
      WHERE community_id = ?1
        AND (?2 = 1 OR status = 'active')
      ORDER BY created_at ASC, label_id ASC
    `,
    args: [input.communityId, input.includeArchived ? 1 : 0],
  })

  return result.rows.map(toCommunityLabelRow)
}

export async function getCommunityLabelById(input: {
  executor: DbExecutor
  communityId: string
  labelId: string
}): Promise<CommunityLabelRow | null> {
  const result = await input.executor.execute({
    sql: `
      SELECT label_id, community_id, label, description, color_token, status, created_at, updated_at
      FROM labels
      WHERE community_id = ?1
        AND label_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.labelId],
  })

  const row = result.rows[0]
  return row ? toCommunityLabelRow(row) : null
}

export async function syncCommunityLabels(input: {
  executor: DbExecutor
  communityId: string
  definitions: Array<{
    label_id: string
    label: string
    description?: string | null
    color_token?: string | null
    status: NonNullable<Community["label_policy"]>["definitions"][number]["status"]
  }>
  now: string
}): Promise<void> {
  const existing = await listCommunityLabels({
    executor: input.executor,
    communityId: input.communityId,
    includeArchived: true,
  })
  const existingById = new Map(existing.map((row) => [row.label_id, row] as const))
  const incomingIds = new Set<string>()

  for (const definition of input.definitions) {
    incomingIds.add(definition.label_id)

    const existingRow = existingById.get(definition.label_id)
    await input.executor.execute({
      sql: `
        INSERT INTO labels (
          label_id, community_id, label, description, color_token, status, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
        )
        ON CONFLICT(label_id) DO UPDATE SET
          community_id = excluded.community_id,
          label = excluded.label,
          description = excluded.description,
          color_token = excluded.color_token,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
      args: [
        definition.label_id,
        input.communityId,
        definition.label,
        definition.description ?? existingRow?.description ?? null,
        definition.color_token ?? null,
        definition.status,
        existingRow?.created_at ?? input.now,
      ],
    })
  }

  for (const row of existing) {
    if (incomingIds.has(row.label_id) || row.status === "archived") {
      continue
    }

    await input.executor.execute({
      sql: `
        UPDATE labels
        SET status = 'archived',
            updated_at = ?3
        WHERE community_id = ?1
          AND label_id = ?2
      `,
      args: [input.communityId, row.label_id, input.now],
    })
  }
}
