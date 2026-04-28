import type { Client } from "../sql-client"
import { getGlobalHandleRow, getProfileRow, listLinkedHandleRows } from "../auth/auth-db-user-queries"
import { assembleProfile } from "../auth/auth-serializers"
import { conflictError, eligibilityFailed, internalError } from "../errors"
import { makeId, nowIso } from "../helpers"
import type {
  AgentHandle,
  PublicAgentResolution,
  UserAgent,
} from "./types"
import type { AgentHandleRow } from "./agent-db-rows"
import {
  serializeAgentHandle,
  serializeAgentOwnershipRecord,
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
): Promise<UserAgent[]> {
  const rows = await listUserAgentRowsForOwner(client, userId)
  const items: UserAgent[] = []
  for (const row of rows) {
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
  return items
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
    } catch {}
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
      agent_id: agentRow.agent_id,
      display_name: agentRow.display_name,
      handle: serializeAgentHandle(resolvedHandleRow),
      ownership_provider: currentOwnershipRow?.ownership_provider ?? null,
      created_at: agentRow.created_at,
      updated_at: agentRow.updated_at,
    },
    owner: {
      user_id: agentRow.owner_user_id,
      display_name: profileRow.display_name,
      global_handle: ownerProfile.global_handle,
      primary_public_handle: ownerProfile.primary_public_handle ?? null,
    },
  }
}
