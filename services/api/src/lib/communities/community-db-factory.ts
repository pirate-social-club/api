import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import type { CommunityRepository } from "./control-plane-community-repository"
import { applyCommunityTemplateMigrations } from "./community-local-db"
import { internalError, notFoundError } from "../errors"

export async function openCommunityDb(
  repo: CommunityRepository,
  communityId: string,
): Promise<{ client: Client; close: () => void; databaseUrl: string }> {
  const binding = await repo.getPrimaryCommunityDatabaseBinding(communityId)
  if (!binding || binding.status !== "active") {
    throw notFoundError("Community database binding not found")
  }
  if (!binding.database_url) {
    throw internalError("Community database URL is missing")
  }

  const client = createClient({ url: binding.database_url })
  if (binding.database_url.startsWith("file:")) {
    await applyCommunityTemplateMigrations(client)
  }
  return {
    client,
    databaseUrl: binding.database_url,
    close: () => client.close(),
  }
}
