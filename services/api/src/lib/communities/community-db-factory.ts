import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import type { CommunityRepository } from "./db-community-repository"
import { internalError, notFoundError } from "../errors"
import { decryptCommunityDbCredential } from "./community-db-credential-crypto"
import { buildLocalCommunityDbUrl, ensureCommunityDbSchema } from "./community-local-db"
import type { Env } from "../../types"

type CommunityDbRepository = Pick<CommunityRepository, "getPrimaryCommunityDatabaseBinding" | "getActiveCommunityDbCredential">

export async function openCommunityDb(
  env: Env,
  repo: CommunityDbRepository,
  communityId: string,
): Promise<{ client: Client; close: () => void; databaseUrl: string }> {
  const binding = await repo.getPrimaryCommunityDatabaseBinding(communityId)
  if (!binding || binding.status !== "active") {
    const localRoot = String(env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
    if (!localRoot) {
      throw notFoundError("Community database binding not found")
    }

    const databaseUrl = buildLocalCommunityDbUrl(localRoot, communityId)
    const client = createClient({ url: databaseUrl })
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
  await ensureCommunityDbSchema(client)
  return {
    client,
    databaseUrl: binding.database_url,
    close: () => client.close(),
  }
}
