import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import type { CommunityDatabaseBindingRepository } from "./db-community-repository"
import { internalError, notFoundError } from "../errors"
import { decryptCommunityDbCredential } from "./community-db-credential-crypto"
import { buildLocalCommunityDbUrl, configureLocalCommunityDbClient, ensureCommunityDbSchema } from "./community-local-db"
import { ensureRemoteCommunityMembershipStateIndexes } from "./ensure-remote-community-membership-indexes"
import { ensureRemoteThreadCommentLockColumns } from "./ensure-remote-thread-comment-lock-columns"
import { ensureRemoteCommentGuestAuthorship } from "./ensure-remote-comment-guest-authorship"
import { ensureRemoteLiveRoomTables } from "./ensure-remote-live-room-tables"
import { ensureRemotePostLicensedPerformanceRightsBasis } from "./ensure-remote-post-licensed-performance-rights-basis"
import { ensureRemotePostSongTitleColumn } from "./ensure-remote-post-song-title-column"
import type { Env } from "../../env"

export type OpenCommunityDbOptions = {
  ensureRemoteMembershipStateIndexes?: (client: Client) => Promise<void>
  ensureRemoteThreadCommentLockColumns?: (client: Client) => Promise<void>
  ensureRemoteCommentGuestAuthorship?: (client: Client) => Promise<void>
  ensureRemoteLiveRoomTables?: (client: Client) => Promise<void>
  ensureRemotePostLicensedPerformanceRightsBasis?: (client: Client) => Promise<void>
  ensureRemotePostSongTitleColumn?: (client: Client) => Promise<void>
}

const remoteMembershipIndexPreflightComplete = new Set<string>()
const remoteThreadCommentLockColumnPreflightComplete = new Set<string>()
const remoteCommentGuestAuthorshipPreflightComplete = new Set<string>()
const remoteLicensedPerformanceRightsBasisPreflightComplete = new Set<string>()
const remoteLiveRoomTablePreflightComplete = new Set<string>()
const remotePostSongTitleColumnPreflightComplete = new Set<string>()
const remoteMembershipIndexPreflightInFlight = new Map<string, Promise<void>>()
const remoteThreadCommentLockColumnPreflightInFlight = new Map<string, Promise<void>>()
const remoteCommentGuestAuthorshipPreflightInFlight = new Map<string, Promise<void>>()
const remoteLicensedPerformanceRightsBasisPreflightInFlight = new Map<string, Promise<void>>()
const remoteLiveRoomTablePreflightInFlight = new Map<string, Promise<void>>()
const remotePostSongTitleColumnPreflightInFlight = new Map<string, Promise<void>>()

function formatPreflightError(error: unknown): Record<string, string> {
  if (!error || typeof error !== "object") {
    return { message: String(error) }
  }
  const record = error as Record<string, unknown>
  return {
    message: error instanceof Error ? error.message : String(record.message ?? error),
    code: typeof record.code === "string" ? record.code : "",
  }
}

async function runRemoteCommunityDbPreflight(input: {
  databaseUrl: string
  label: string
  complete: Set<string>
  inFlight: Map<string, Promise<void>>
  run: () => Promise<void>
}): Promise<void> {
  if (input.complete.has(input.databaseUrl)) {
    return
  }

  const existing = input.inFlight.get(input.databaseUrl)
  if (existing) {
    await existing
    return
  }

  const promise = (async () => {
    try {
      await input.run()
    } catch (error) {
      console.warn("[community-db-factory] remote community db preflight skipped", {
        label: input.label,
        ...formatPreflightError(error),
      })
    } finally {
      input.complete.add(input.databaseUrl)
    }
  })()

  input.inFlight.set(input.databaseUrl, promise)
  try {
    await promise
  } finally {
    input.inFlight.delete(input.databaseUrl)
  }
}

async function runRequiredRemoteCommunityDbPreflight(input: {
  databaseUrl: string
  complete: Set<string>
  inFlight: Map<string, Promise<void>>
  run: () => Promise<void>
}): Promise<void> {
  if (input.complete.has(input.databaseUrl)) {
    return
  }

  const existing = input.inFlight.get(input.databaseUrl)
  if (existing) {
    await existing
    return
  }

  const promise = (async () => {
    await input.run()
    input.complete.add(input.databaseUrl)
  })()

  input.inFlight.set(input.databaseUrl, promise)
  try {
    await promise
  } finally {
    input.inFlight.delete(input.databaseUrl)
  }
}

export async function openCommunityDb(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
  options?: OpenCommunityDbOptions,
): Promise<{ client: Client; close: () => void; databaseUrl: string }> {
  const binding = await repo.getPrimaryCommunityDatabaseBinding(communityId)
  if (!binding || binding.status !== "active") {
    const localRoot = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
    if (!localRoot) {
      throw notFoundError("Community database binding not found")
    }

    const databaseUrl = buildLocalCommunityDbUrl(localRoot, communityId)
    const client = createClient({ url: databaseUrl })
    await configureLocalCommunityDbClient(client)
    await ensureCommunityDbSchema(client)
    await ensureRemoteThreadCommentLockColumns(client)
    await ensureRemoteCommentGuestAuthorship(client)
    await ensureRemotePostSongTitleColumn(client)
    await ensureRemotePostLicensedPerformanceRightsBasis(client)
    return {
      client,
      databaseUrl,
      close: () => client.close(),
    }
  }
  if (!binding.database_url) {
    throw internalError("Community database URL is missing")
  }

  const activeCredential = await repo.getActiveCommunityDbCredential(binding.community_database_binding_id)
  const authToken = activeCredential
    ? decryptCommunityDbCredential({
        encryptedToken: activeCredential.encrypted_token,
        encryptionKeyVersion: activeCredential.encryption_key_version,
        wrapKey: String(env.TURSO_COMMUNITY_DB_WRAP_KEY || ""),
      })
    : undefined

  const client = createClient({
    url: binding.database_url,
    ...(authToken ? { authToken } : {}),
  })
  if (binding.database_url.startsWith("file:")) {
    await configureLocalCommunityDbClient(client)
    await ensureCommunityDbSchema(client)
    await ensureRemoteThreadCommentLockColumns(client)
    await ensureRemotePostSongTitleColumn(client)
    await ensureRemotePostLicensedPerformanceRightsBasis(client)
  } else {
    const ensureIndexes = options?.ensureRemoteMembershipStateIndexes ?? ensureRemoteCommunityMembershipStateIndexes
    await runRemoteCommunityDbPreflight({
      databaseUrl: binding.database_url,
      label: "membership_state_indexes",
      complete: remoteMembershipIndexPreflightComplete,
      inFlight: remoteMembershipIndexPreflightInFlight,
      run: () => ensureIndexes(client),
    })
    const ensureLockColumns = options?.ensureRemoteThreadCommentLockColumns ?? ensureRemoteThreadCommentLockColumns
    await runRemoteCommunityDbPreflight({
      databaseUrl: binding.database_url,
      label: "thread_comment_lock_columns",
      complete: remoteThreadCommentLockColumnPreflightComplete,
      inFlight: remoteThreadCommentLockColumnPreflightInFlight,
      run: () => ensureLockColumns(client),
    })
    const ensureGuestAuthorship = options?.ensureRemoteCommentGuestAuthorship ?? ensureRemoteCommentGuestAuthorship
    await runRequiredRemoteCommunityDbPreflight({
      databaseUrl: binding.database_url,
      complete: remoteCommentGuestAuthorshipPreflightComplete,
      inFlight: remoteCommentGuestAuthorshipPreflightInFlight,
      run: () => ensureGuestAuthorship(client),
    })
    const ensureSongTitleColumn = options?.ensureRemotePostSongTitleColumn ?? ensureRemotePostSongTitleColumn
    await runRemoteCommunityDbPreflight({
      databaseUrl: binding.database_url,
      label: "post_song_title_column",
      complete: remotePostSongTitleColumnPreflightComplete,
      inFlight: remotePostSongTitleColumnPreflightInFlight,
      run: () => ensureSongTitleColumn(client),
    })
    const ensureLicensedPerformanceRightsBasis =
      options?.ensureRemotePostLicensedPerformanceRightsBasis ?? ensureRemotePostLicensedPerformanceRightsBasis
    await runRequiredRemoteCommunityDbPreflight({
      databaseUrl: binding.database_url,
      complete: remoteLicensedPerformanceRightsBasisPreflightComplete,
      inFlight: remoteLicensedPerformanceRightsBasisPreflightInFlight,
      run: () => ensureLicensedPerformanceRightsBasis(client),
    })
    const ensureLiveRoomTables = options?.ensureRemoteLiveRoomTables ?? ensureRemoteLiveRoomTables
    await runRemoteCommunityDbPreflight({
      databaseUrl: binding.database_url,
      label: "live_room_tables",
      complete: remoteLiveRoomTablePreflightComplete,
      inFlight: remoteLiveRoomTablePreflightInFlight,
      run: () => ensureLiveRoomTables(client),
    })
  }
  return {
    client,
    databaseUrl: binding.database_url,
    close: () => client.close(),
  }
}
