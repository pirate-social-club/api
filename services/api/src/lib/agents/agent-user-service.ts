import type { Client } from "../sql-client"
import { getGlobalHandleRow, getProfileRow, listLinkedHandleRows } from "../auth/auth-db-user-queries"
import { assembleProfile } from "../auth/auth-serializers"
import { badRequestError, conflictError, eligibilityFailed, internalError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { unixSeconds } from "../../serializers/time"
import type {
  AgentHandle,
  UserAgent,
  UserAgentListResponse,
} from "./types"
import type { PublicAgentResolution } from "../../types"
import type { AgentHandleRow } from "./agent-db-rows"
import {
  serializeAgentHandle,
  serializeAgentOwnershipRecord,
  serializeContractAgentHandle,
  serializeUserAgent,
} from "./agent-serializers"
import {
  formatAgentHandleLabel,
  normalizeAgentHandleLookupLabel,
  normalizeDesiredAgentHandleLabel,
} from "./agent-handle-policy"
import {
  allocateInitialAgentHandle,
  getActiveAgentHandleRow,
  getAgentHandleRowById,
  getAgentHandleRowByLabel,
  getCurrentOwnershipRecordRowForAgent,
  getUserAgentRowById,
  getUserAgentRowForOwner,
  isAgentHandleAgentUniqueError,
  isAgentHandleLabelUniqueError,
  listUserAgentRowsForOwner,
} from "./agent-ownership-queries"

export async function getUserAgent(
  client: Client,
  agentId: string,
  userId: string,
): Promise<UserAgent | null> {
  const row = await getUserAgentRowForOwner(client, agentId, userId)
  if (!row) {
    return null
  }
  const currentOwnershipRow = await getCurrentOwnershipRecordRowForAgent(client, agentId, userId)
  const handleRow = await getActiveAgentHandleRow(client, agentId)
  return serializeUserAgent(
    row,
    currentOwnershipRow ? serializeAgentOwnershipRecord(currentOwnershipRow) : null,
    handleRow ? serializeAgentHandle(handleRow) : null,
  )
}

export async function listUserAgents(
  client: Client,
  userId: string,
  input: {
    cursor?: string | null
    limit: number
  },
): Promise<UserAgentListResponse> {
  const rows = await listUserAgentRowsForOwner(client, userId, {
    after: decodeAgentListCursor(input.cursor),
    limit: input.limit + 1,
  })
  const pageRows = rows.slice(0, input.limit)
  const items: UserAgent[] = []
  for (const row of pageRows) {
    const currentOwnershipRow = await getCurrentOwnershipRecordRowForAgent(client, row.agent_id, userId)
    const handleRow = await getActiveAgentHandleRow(client, row.agent_id)
    items.push(
      serializeUserAgent(
        row,
        currentOwnershipRow ? serializeAgentOwnershipRecord(currentOwnershipRow) : null,
        handleRow ? serializeAgentHandle(handleRow) : null,
      ),
    )
  }
  const hasMore = rows.length > input.limit
  const lastRow = pageRows[pageRows.length - 1] ?? null
  return {
    items,
    next_cursor: hasMore && lastRow ? encodeAgentListCursor(lastRow) : null,
  }
}

function encodeAgentListCursor(row: Pick<UserAgent, "agent_id" | "created_at">): string {
  return Buffer.from(JSON.stringify({
    agent_id: row.agent_id,
    created_at: row.created_at,
  }), "utf8").toString("base64url")
}

function decodeAgentListCursor(cursor: string | null | undefined): { agent_id: string; created_at: string } | null {
  if (!cursor) {
    return null
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      agent_id?: unknown
      created_at?: unknown
    }
    if (typeof parsed.agent_id !== "string" || !parsed.agent_id.trim()) {
      throw new Error("invalid cursor")
    }
    if (typeof parsed.created_at !== "string" || !parsed.created_at.trim()) {
      throw new Error("invalid cursor")
    }
    return {
      agent_id: parsed.agent_id,
      created_at: parsed.created_at,
    }
  } catch {
    throw badRequestError("Invalid agents cursor")
  }
}

export async function updateUserAgentDisplayName(
  client: Client,
  input: {
    agentId: string
    userId: string
    displayName: string
  },
): Promise<UserAgent | null> {
  const existingRow = await getUserAgentRowForOwner(client, input.agentId, input.userId)
  if (!existingRow) {
    return null
  }

  const updatedAt = nowIso()
  await client.execute({
    sql: `
      UPDATE user_agents
      SET display_name = ?3,
          updated_at = ?4
      WHERE agent_id = ?1
        AND owner_user_id = ?2
    `,
    args: [input.agentId, input.userId, input.displayName.trim(), updatedAt],
  })

  const row = await getUserAgentRowForOwner(client, input.agentId, input.userId)
  if (!row) {
    throw internalError("Updated agent row is missing")
  }
  const currentOwnershipRow = await getCurrentOwnershipRecordRowForAgent(client, input.agentId, input.userId)
  const handleRow = await getActiveAgentHandleRow(client, input.agentId)
  return serializeUserAgent(
    row,
    currentOwnershipRow ? serializeAgentOwnershipRecord(currentOwnershipRow) : null,
    handleRow ? serializeAgentHandle(handleRow) : null,
  )
}

export async function seedUserAgentForAdmin(
  client: Client,
  input: {
    userId: string
    displayName: string
    desiredLabel?: string | null
  },
): Promise<UserAgent> {
  const profileRow = await getProfileRow(client, input.userId)
  if (!profileRow) {
    throw eligibilityFailed("Owner profile is not available")
  }
  const globalHandleRow = await getGlobalHandleRow(client, profileRow.global_handle_id)
  if (!globalHandleRow || globalHandleRow.status !== "active") {
    throw eligibilityFailed("Owner global handle is not active")
  }

  const trimmedDisplayName = input.displayName.trim()
  const desired = input.desiredLabel ? normalizeDesiredAgentHandleLabel(input.desiredLabel) : null
  if (desired) {
    const existingLabelRow = await getAgentHandleRowByLabel(client, desired.labelNormalized)
    if (existingLabelRow) {
      throw conflictError("Desired agent handle is unavailable")
    }
  }

  const agentId = makeId("agt")
  const createdAt = nowIso()
  await client.execute({
    sql: `
      INSERT INTO user_agents (
        agent_id, owner_user_id, display_name, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'active', ?4, ?4)
    `,
    args: [agentId, input.userId, trimmedDisplayName, createdAt],
  })

  await allocateInitialAgentHandle(client, {
    agentId,
    displayName: trimmedDisplayName,
    createdAt,
  })

  if (desired) {
    await claimUserAgentHandle(client, {
      agentId,
      userId: input.userId,
      desiredLabel: desired.labelDisplay,
    })
  }

  const row = await getUserAgentRowForOwner(client, agentId, input.userId)
  if (!row) {
    throw internalError("Seeded agent row is missing")
  }
  const handleRow = await getActiveAgentHandleRow(client, agentId)
  if (!handleRow) {
    throw internalError("Seeded agent handle row is missing")
  }
  return serializeUserAgent(row, null, serializeAgentHandle(handleRow))
}

export async function getUserAgentHandle(
  client: Client,
  input: {
    agentId: string
    userId: string
  },
): Promise<AgentHandle | null> {
  const agentRow = await getUserAgentRowForOwner(client, input.agentId, input.userId)
  if (!agentRow) {
    return null
  }

  const handleRow = await getActiveAgentHandleRow(client, input.agentId)
  return handleRow ? serializeAgentHandle(handleRow) : null
}

export async function claimUserAgentHandle(
  client: Client,
  input: {
    agentId: string
    userId: string
    desiredLabel: string
  },
): Promise<AgentHandle | null> {
  const agentRow = await getUserAgentRowForOwner(client, input.agentId, input.userId)
  if (!agentRow) {
    return null
  }
  if (agentRow.status !== "active") {
    throw eligibilityFailed("Agent is not active")
  }

  const desired = normalizeDesiredAgentHandleLabel(input.desiredLabel)
  const existingLabelRow = await getAgentHandleRowByLabel(client, desired.labelNormalized)
  if (existingLabelRow && existingLabelRow.agent_id !== input.agentId) {
    throw conflictError("Desired agent handle is unavailable")
  }

  const activeRow = await getActiveAgentHandleRow(client, input.agentId)
  if (activeRow?.label_normalized === desired.labelNormalized) {
    return serializeAgentHandle(activeRow)
  }
  if (existingLabelRow) {
    throw conflictError("Desired agent handle is unavailable")
  }

  const tx = await client.transaction()
  try {
    const now = nowIso()
    const nextHandleId = makeId("agh")

    if (activeRow) {
      await tx.execute({
        sql: `
          UPDATE agent_handles
          SET status = 'redirect',
              replaced_at = ?2,
              updated_at = ?2
          WHERE agent_handle_id = ?1
        `,
        args: [activeRow.agent_handle_id, now],
      })
    }

    await tx.execute({
      sql: `
        INSERT INTO agent_handles (
          agent_handle_id, agent_id, label_normalized, label_display, status,
          redirect_target_agent_handle_id, issued_at, replaced_at, created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, 'active', NULL, ?5, NULL, ?5, ?5)
      `,
      args: [nextHandleId, input.agentId, desired.labelNormalized, desired.labelDisplay, now],
    })

    if (activeRow) {
      await tx.execute({
        sql: `
          UPDATE agent_handles
          SET redirect_target_agent_handle_id = ?2,
              updated_at = ?3
          WHERE agent_handle_id = ?1
        `,
        args: [activeRow.agent_handle_id, nextHandleId, now],
      })
    }

    await tx.commit()
    tx.close()
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[agents] rollback failed while updating agent handle", rollbackError)
    }
    tx.close()
    if (isAgentHandleLabelUniqueError(error) || isAgentHandleAgentUniqueError(error)) {
      throw conflictError("Desired agent handle is unavailable")
    }
    throw error
  }

  const handleRow = await getActiveAgentHandleRow(client, input.agentId)
  if (!handleRow) {
    throw internalError("Agent handle row is missing after claim")
  }
  return serializeAgentHandle(handleRow)
}

async function resolveAgentHandleChain(
  client: Client,
  startHandleRow: AgentHandleRow,
): Promise<AgentHandleRow | null> {
  const seen = new Set<string>()
  let current: AgentHandleRow | null = startHandleRow

  while (current) {
    if (current.status === "active") {
      return current
    }

    if (current.status !== "redirect" || !current.redirect_target_agent_handle_id) {
      return null
    }

    if (seen.has(current.agent_handle_id)) {
      return null
    }

    seen.add(current.agent_handle_id)
    current = await getAgentHandleRowById(client, current.redirect_target_agent_handle_id)
  }

  return null
}

export async function resolvePublicAgentByHandle(
  client: Client,
  handleLabel: string,
): Promise<PublicAgentResolution | null> {
  const requestedLabelNormalized = normalizeAgentHandleLookupLabel(handleLabel)
  const requestedHandleRow = await getAgentHandleRowByLabel(client, requestedLabelNormalized)
  if (!requestedHandleRow) {
    return null
  }

  const resolvedHandleRow = await resolveAgentHandleChain(client, requestedHandleRow)
  if (!resolvedHandleRow) {
    return null
  }

  const agentRow = await getUserAgentRowById(client, resolvedHandleRow.agent_id)
  if (!agentRow || agentRow.status !== "active") {
    return null
  }

  const profileRow = await getProfileRow(client, agentRow.owner_user_id)
  if (!profileRow) {
    return null
  }
  const globalHandleRow = await getGlobalHandleRow(client, profileRow.global_handle_id)
  if (!globalHandleRow || globalHandleRow.status !== "active") {
    return null
  }
  const linkedHandleRows = await listLinkedHandleRows(client, agentRow.owner_user_id)
  const ownerProfile = assembleProfile(profileRow, globalHandleRow, linkedHandleRows)
  const currentOwnershipRow = await getCurrentOwnershipRecordRowForAgent(client, agentRow.agent_id, agentRow.owner_user_id)

  return {
    is_canonical: requestedHandleRow.agent_handle_id === resolvedHandleRow.agent_handle_id,
    requested_handle_label: formatAgentHandleLabel(requestedLabelNormalized),
    resolved_handle_label: resolvedHandleRow.label_display,
    agent: {
      agent: agentRow.agent_id,
      display_name: agentRow.display_name,
      handle: serializeContractAgentHandle(resolvedHandleRow),
      ownership_provider: currentOwnershipRow?.ownership_provider ?? null,
      created: unixSeconds(agentRow.created_at),
    },
    owner: {
      user: ownerProfile.id,
      display_name: profileRow.display_name,
      global_handle: ownerProfile.global_handle,
      primary_public_handle: ownerProfile.primary_public_handle ?? null,
    },
  }
}
