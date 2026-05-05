import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import type { CommunityDatabaseBindingRepository } from "./db-community-repository"
import { internalError, notFoundError } from "../errors"
import { decryptCommunityDbCredential } from "./community-db-credential-crypto"
import { buildLocalCommunityDbUrl, configureLocalCommunityDbClient, ensureCommunityDbSchema } from "./community-local-db"
import { ensureRemoteCommunityMembershipStateIndexes } from "./ensure-remote-community-membership-indexes"
import { ensureRemoteThreadCommentLockColumns } from "./ensure-remote-thread-comment-lock-columns"
import type { Env } from "../../env"

export type OpenCommunityDbOptions = {
  ensureRemoteMembershipStateIndexes?: (client: Client) => Promise<void>
  ensureRemoteThreadCommentLockColumns?: (client: Client) => Promise<void>
}

const remoteMembershipIndexPreflightComplete = new Set<string>()
const remoteThreadCommentLockColumnPreflightComplete = new Set<string>()

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
  } else {
    const ensureIndexes = options?.ensureRemoteMembershipStateIndexes ?? ensureRemoteCommunityMembershipStateIndexes
    if (!remoteMembershipIndexPreflightComplete.has(binding.database_url)) {
      await ensureIndexes(client)
      remoteMembershipIndexPreflightComplete.add(binding.database_url)
    }
    const ensureLockColumns = options?.ensureRemoteThreadCommentLockColumns ?? ensureRemoteThreadCommentLockColumns
    if (!remoteThreadCommentLockColumnPreflightComplete.has(binding.database_url)) {
      await ensureLockColumns(client)
      remoteThreadCommentLockColumnPreflightComplete.add(binding.database_url)
    }
  }
  return {
    client,
    databaseUrl: binding.database_url,
    close: () => client.close(),
  }
}
