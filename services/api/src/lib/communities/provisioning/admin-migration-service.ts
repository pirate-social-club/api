import type { Env } from "../../../env"
import { internalError, notFoundError } from "../../errors"
import { publicCommunityId } from "../../public-ids"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import { decryptCommunityDbCredential } from "../community-db-credential-crypto"
import { migrateCommunityDatabaseViaOperator } from "./operator-client"

export async function migrateProvisionedCommunityDatabase(input: {
  env: Env
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<{
  community: string
  database_url: string
  applied: number
  skipped: number
}> {
  const binding = await input.communityRepository.getPrimaryCommunityDatabaseBinding(input.communityId)
  if (!binding || binding.status !== "active") {
    throw notFoundError("Community database binding not found")
  }
  if (!binding.database_url || binding.database_url.startsWith("file:")) {
    throw internalError("Community database migration requires an active remote database binding")
  }

  const credential = await input.communityRepository.getActiveCommunityDbCredential(binding.community_database_binding_id)
  if (!credential) {
    throw internalError("Active community database credential not found")
  }

  const databaseAuthToken = decryptCommunityDbCredential({
    encryptedToken: credential.encrypted_token,
    encryptionKeyVersion: credential.encryption_key_version,
    wrapKey: String(input.env.TURSO_COMMUNITY_DB_WRAP_KEY || ""),
  })

  const result = await migrateCommunityDatabaseViaOperator({
    env: input.env,
    communityId: input.communityId,
    databaseUrl: binding.database_url,
    databaseAuthToken,
  })

  return {
    community: publicCommunityId(input.communityId),
    database_url: binding.database_url,
    applied: result.applied,
    skipped: result.skipped,
  }
}
