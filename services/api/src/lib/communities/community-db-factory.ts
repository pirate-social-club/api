import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import { AsyncLocalStorage } from "node:async_hooks"
import type { CommunityDatabaseBindingRepository } from "./db-community-repository"
import { internalError, notFoundError } from "../errors"
import { decryptCommunityDbCredential } from "./community-db-credential-crypto"
import { buildLocalCommunityDbUrl, configureLocalCommunityDbClient, ensureCommunityDbSchema } from "./community-local-db"
import { ensureRemoteCommunityMembershipStateIndexes } from "./ensure-remote-community-membership-indexes"
import { ensureRemoteThreadCommentLockColumns } from "./ensure-remote-thread-comment-lock-columns"
import { ensureRemoteCommentGuestAuthorship } from "./ensure-remote-comment-guest-authorship"
import { ensureRemoteLiveRoomTables } from "./ensure-remote-live-room-tables"
import { ensureRemotePostSongTitleColumn } from "./ensure-remote-post-song-title-column"
import { ensureRemoteCommunityKaraokeEnabledColumn } from "./ensure-remote-community-karaoke-enabled-column"
import { ensureRemoteCommunityKaraokeScoringColumns } from "./ensure-remote-community-karaoke-scoring-columns"
import type { Env } from "../../env"

async function ensureRemoteCommunityKaraokeColumns(client: Client): Promise<void> {
  await ensureRemoteCommunityKaraokeEnabledColumn(client)
  await ensureRemoteCommunityKaraokeScoringColumns(client)
}

export type OpenCommunityDbOptions = {
  ensureRemoteMembershipStateIndexes?: (client: Client) => Promise<void>
  ensureRemoteThreadCommentLockColumns?: (client: Client) => Promise<void>
  ensureRemoteCommentGuestAuthorship?: (client: Client) => Promise<void>
  ensureRemoteLiveRoomTables?: (client: Client) => Promise<void>
  ensureRemotePostSongTitleColumn?: (client: Client) => Promise<void>
}

const remoteMembershipIndexPreflightComplete = new Set<string>()
const remoteThreadCommentLockColumnPreflightComplete = new Set<string>()
const remoteCommentGuestAuthorshipPreflightComplete = new Set<string>()
const remoteLiveRoomTablePreflightComplete = new Set<string>()
const remotePostSongTitleColumnPreflightComplete = new Set<string>()
const remoteKaraokeColumnsPreflightComplete = new Set<string>()
const remoteMembershipIndexPreflightInFlight = new Map<string, Promise<void>>()
const remoteThreadCommentLockColumnPreflightInFlight = new Map<string, Promise<void>>()
const remoteCommentGuestAuthorshipPreflightInFlight = new Map<string, Promise<void>>()
const remoteLiveRoomTablePreflightInFlight = new Map<string, Promise<void>>()
const remotePostSongTitleColumnPreflightInFlight = new Map<string, Promise<void>>()
const remoteKaraokeColumnsPreflightInFlight = new Map<string, Promise<void>>()

export type CommunityDbHandle = { client: Client; close: () => void; databaseUrl: string }

type RequestCommunityDbStore = {
  clients: Map<string, CommunityDbHandle>
  // Opens in progress, keyed by cache key. Concurrent opens for the same
  // community share this promise instead of each creating a separate client.
  inflight: Map<string, Promise<CommunityDbHandle>>
}

const requestCommunityDbStore = new AsyncLocalStorage<RequestCommunityDbStore>()

/**
 * Caller-facing handle for a request-shared client: the close is a no-op so a
 * caller's `finally { db.close() }` does not tear down a handle that sibling
 * callers in the same request still share. The request store owns the single
 * real close, run once at request end.
 */
function sharedCommunityDbHandle(entry: CommunityDbHandle): CommunityDbHandle {
  return { client: entry.client, close: () => {}, databaseUrl: entry.databaseUrl }
}

function closeRequestCommunityDbClients(store: RequestCommunityDbStore): void {
  const entries = [...store.clients.values()]
  store.clients.clear()
  for (const entry of entries) {
    try {
      entry.close()
    } catch (error) {
      console.error("[community-db-factory] request-scoped community db close failed", error)
    }
  }
}

export async function withRequestCommunityDbClients<T>(operation: () => Promise<T>): Promise<T> {
  const existingStore = requestCommunityDbStore.getStore()
  if (existingStore) {
    return operation()
  }

  const store: RequestCommunityDbStore = { clients: new Map(), inflight: new Map() }
  return requestCommunityDbStore.run(store, async () => {
    try {
      return await operation()
    } finally {
      closeRequestCommunityDbClients(store)
    }
  })
}

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
): Promise<CommunityDbHandle> {
  const store = requestCommunityDbStore.getStore()
  if (!store) {
    // No request scope: the caller owns the client lifecycle (real close).
    return openCommunityDbEntry(env, repo, communityId, options)
  }

  const cacheKey = `community:${communityId}`
  const cached = store.clients.get(cacheKey)
  if (cached) {
    return sharedCommunityDbHandle(cached)
  }

  // Dedupe concurrent opens for the same community: the first caller registers
  // the in-flight open and every other concurrent caller awaits the same
  // promise, so exactly one underlying client is created per request.
  let pending = store.inflight.get(cacheKey)
  if (!pending) {
    pending = openCommunityDbEntry(env, repo, communityId, options).then((entry) => {
      store.clients.set(cacheKey, entry)
      return entry
    })
    store.inflight.set(cacheKey, pending)
    // Clear the slot once settled so a failed open can be retried in the same
    // request. The cached entry (set on success) keeps later callers off this path.
    void pending
      .catch(() => {})
      .finally(() => {
        if (store.inflight.get(cacheKey) === pending) {
          store.inflight.delete(cacheKey)
        }
      })
  }

  const entry = await pending
  return sharedCommunityDbHandle(entry)
}

async function openCommunityDbEntry(
  env: Env,
  repo: CommunityDatabaseBindingRepository,
  communityId: string,
  options?: OpenCommunityDbOptions,
): Promise<CommunityDbHandle> {
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
    await ensureRemoteCommunityKaraokeColumns(client)
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
    await ensureRemoteCommunityKaraokeColumns(client)
  } else {
    const ensureIndexes = options?.ensureRemoteMembershipStateIndexes ?? ensureRemoteCommunityMembershipStateIndexes
    const ensureLockColumns = options?.ensureRemoteThreadCommentLockColumns ?? ensureRemoteThreadCommentLockColumns
    const ensureGuestAuthorship = options?.ensureRemoteCommentGuestAuthorship ?? ensureRemoteCommentGuestAuthorship
    const ensureSongTitleColumn = options?.ensureRemotePostSongTitleColumn ?? ensureRemotePostSongTitleColumn
    const ensureLiveRoomTables = options?.ensureRemoteLiveRoomTables ?? ensureRemoteLiveRoomTables
    await Promise.all([
      runRemoteCommunityDbPreflight({
        databaseUrl: binding.database_url,
        label: "membership_state_indexes",
        complete: remoteMembershipIndexPreflightComplete,
        inFlight: remoteMembershipIndexPreflightInFlight,
        run: () => ensureIndexes(client),
      }),
      runRemoteCommunityDbPreflight({
        databaseUrl: binding.database_url,
        label: "thread_comment_lock_columns",
        complete: remoteThreadCommentLockColumnPreflightComplete,
        inFlight: remoteThreadCommentLockColumnPreflightInFlight,
        run: () => ensureLockColumns(client),
      }),
      runRequiredRemoteCommunityDbPreflight({
        databaseUrl: binding.database_url,
        complete: remoteCommentGuestAuthorshipPreflightComplete,
        inFlight: remoteCommentGuestAuthorshipPreflightInFlight,
        run: () => ensureGuestAuthorship(client),
      }),
      runRemoteCommunityDbPreflight({
        databaseUrl: binding.database_url,
        label: "post_song_title_column",
        complete: remotePostSongTitleColumnPreflightComplete,
        inFlight: remotePostSongTitleColumnPreflightInFlight,
        run: () => ensureSongTitleColumn(client),
      }),
      runRemoteCommunityDbPreflight({
        databaseUrl: binding.database_url,
        label: "live_room_tables",
        complete: remoteLiveRoomTablePreflightComplete,
        inFlight: remoteLiveRoomTablePreflightInFlight,
        run: () => ensureLiveRoomTables(client),
      }),
      runRemoteCommunityDbPreflight({
        databaseUrl: binding.database_url,
        label: "karaoke_columns",
        complete: remoteKaraokeColumnsPreflightComplete,
        inFlight: remoteKaraokeColumnsPreflightInFlight,
        run: () => ensureRemoteCommunityKaraokeColumns(client),
      }),
    ])
  }
  return { client, close: () => client.close(), databaseUrl: binding.database_url }
}
