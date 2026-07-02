import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import { AsyncLocalStorage } from "node:async_hooks"
import type { CommunityDatabaseBindingRepository } from "./db-community-repository"
import { internalError, notFoundError } from "../errors"
import { buildLocalCommunityDbUrl, configureLocalCommunityDbClient, ensureCommunityDbSchema } from "./community-local-db"
import { ensureRemoteThreadCommentLockColumns } from "./ensure-remote-thread-comment-lock-columns"
import { ensureRemoteCommentGuestAuthorship } from "./ensure-remote-comment-guest-authorship"
import { ensureRemotePostSongTitleColumn } from "./ensure-remote-post-song-title-column"
import { ensureRemoteCommerceVinylReleaseColumns } from "./ensure-remote-commerce-vinyl-release-columns"
import type { Env } from "../../env"

export type OpenCommunityDbOptions = {
  ensureRemoteThreadCommentLockColumns?: (client: Client) => Promise<void>
  ensureRemoteCommentGuestAuthorship?: (client: Client) => Promise<void>
  ensureRemotePostSongTitleColumn?: (client: Client) => Promise<void>
  ensureRemoteCommerceVinylReleaseColumns?: (client: Client) => Promise<void>
}

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
  const localRoot = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (localRoot) {
    const databaseUrl = buildLocalCommunityDbUrl(localRoot, communityId)
    const client = createClient({ url: databaseUrl })
    await configureLocalCommunityDbClient(client)
    await ensureCommunityDbSchema(client)
    await ensureRemoteThreadCommentLockColumns(client)
    await ensureRemoteCommentGuestAuthorship(client)
    await ensureRemotePostSongTitleColumn(client)
    await ensureRemoteCommerceVinylReleaseColumns(client)
    return {
      client,
      databaseUrl,
      close: () => client.close(),
    }
  }

  const binding = await repo.getPrimaryCommunityDatabaseBinding(communityId)
  if (!binding || binding.status !== "active") {
    throw notFoundError("Community database binding not found")
  }
  if (!binding.database_url) {
    throw internalError("Community database URL is missing")
  }
  if (!binding.database_url.startsWith("file:")) {
    throw internalError("Remote community database bindings are no longer opened through openCommunityDb")
  }

  const client = createClient({
    url: binding.database_url,
  })
  await configureLocalCommunityDbClient(client)
  await ensureCommunityDbSchema(client)
  await (options?.ensureRemoteThreadCommentLockColumns ?? ensureRemoteThreadCommentLockColumns)(client)
  await (options?.ensureRemoteCommentGuestAuthorship ?? ensureRemoteCommentGuestAuthorship)(client)
  await (options?.ensureRemotePostSongTitleColumn ?? ensureRemotePostSongTitleColumn)(client)
  await (options?.ensureRemoteCommerceVinylReleaseColumns ?? ensureRemoteCommerceVinylReleaseColumns)(client)
  return { client, close: () => client.close(), databaseUrl: binding.database_url }
}
