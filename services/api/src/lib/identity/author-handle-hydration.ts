import type { ProfileRepository } from "../auth/repositories"
import { getProfilePublicHandleLabel } from "../auth/auth-serializers"
import type { DbExecutor } from "../db-helpers"
import { rowValue } from "../sql-row"
import type { Profile } from "../../types"

const COMMUNITY_HANDLE_AUTHOR_CHUNK_SIZE = 80

export type PublicHumanAuthorHandleTarget = {
  author_user_id?: string | null
  identity_mode: string
  authorship_mode: string
  author_public_handle?: string | null
}

export type AuthorHandleSurface =
  | { kind: "global" }
  | { kind: "community"; client: DbExecutor; communityId: string }

function formatCommunityHandle(label: string, namespaceLabel: string): string {
  const normalizedNamespace = namespaceLabel.trim()
  if (normalizedNamespace.startsWith("@")) {
    return `${label}@${normalizedNamespace.slice(1)}`
  }
  return `${label}.${normalizedNamespace}`
}

async function listPrimaryCommunityHandles(input: {
  client: DbExecutor
  communityId: string
  userIds: readonly string[]
}): Promise<Map<string, string>> {
  const handles = new Map<string, string>()
  for (let offset = 0; offset < input.userIds.length; offset += COMMUNITY_HANDLE_AUTHOR_CHUNK_SIZE) {
    const userIds = input.userIds.slice(offset, offset + COMMUNITY_HANDLE_AUTHOR_CHUNK_SIZE)
    const placeholders = userIds.map((_, index) => `?${index + 2}`).join(", ")
    const result = await input.client.execute({
      sql: `
        SELECT ch.user_id, ch.label_display, nb.display_label AS namespace_label
        FROM community_handles ch
        JOIN namespace_bindings nb
          ON nb.namespace_id = ch.namespace_id
        WHERE ch.community_id = ?1
          AND nb.community_id = ?1
          AND ch.status = 'active'
          AND nb.status = 'active'
          AND nb.namespace_role = 'primary'
          AND ch.user_id IN (${placeholders})
      `,
      args: [input.communityId, ...userIds],
    })
    for (const row of result.rows) {
      const userId = rowValue(row, "user_id")
      const label = rowValue(row, "label_display")
      const namespaceLabel = rowValue(row, "namespace_label")
      if (typeof userId === "string" && typeof label === "string" && typeof namespaceLabel === "string") {
        handles.set(userId, formatCommunityHandle(label, namespaceLabel))
      }
    }
  }
  return handles
}

async function listGlobalHandles(
  profileRepository: ProfileRepository | null | undefined,
  userIds: readonly string[],
  prefetchedProfilesByUserId?: ReadonlyMap<string, Profile | null>,
): Promise<Map<string, string>> {
  const profilesByUserId = new Map<string, Profile | null>()
  const missingUserIds: string[] = []
  for (const userId of userIds) {
    if (prefetchedProfilesByUserId?.has(userId)) {
      profilesByUserId.set(userId, prefetchedProfilesByUserId.get(userId) ?? null)
    } else {
      missingUserIds.push(userId)
    }
  }
  if (!profileRepository || missingUserIds.length === 0) {
    return handlesFromProfiles(userIds, profilesByUserId)
  }

  const loadedProfiles = profileRepository.listProfilesByUserIds
    ? await profileRepository.listProfilesByUserIds(missingUserIds).catch(() => new Map())
    : new Map(await Promise.all(missingUserIds.map(async (userId): Promise<[
        string,
        Awaited<ReturnType<ProfileRepository["getProfileByUserId"]>>,
      ]> => [
        userId,
        await profileRepository.getProfileByUserId(userId).catch(() => null),
      ])))
  for (const userId of missingUserIds) {
    profilesByUserId.set(userId, loadedProfiles.get(userId) ?? null)
  }

  return handlesFromProfiles(userIds, profilesByUserId)
}

function handlesFromProfiles(
  userIds: readonly string[],
  profilesByUserId: ReadonlyMap<string, Profile | null>,
): Map<string, string> {
  const handles = new Map<string, string>()
  for (const userId of userIds) {
    const profile = profilesByUserId.get(userId) ?? null
    if (profile) handles.set(userId, getProfilePublicHandleLabel(profile))
  }
  return handles
}

/**
 * Hydrates public human bylines according to the read surface. Community reads
 * prefer the author's active primary-namespace handle and fall back to the
 * current global handle. Mixed/global surfaces resolve only the global handle.
 */
export async function hydratePublicHumanAuthorHandles(input: {
  authors: readonly PublicHumanAuthorHandleTarget[]
  prefetchedProfilesByUserId?: ReadonlyMap<string, Profile | null>
  profileRepository?: ProfileRepository | null
  surface?: AuthorHandleSurface
}): Promise<void> {
  const surface = input.surface ?? { kind: "global" as const }
  if (surface.kind === "global" && !input.profileRepository && !input.prefetchedProfilesByUserId) return

  const eligibleAuthors = input.authors.filter((author): author is PublicHumanAuthorHandleTarget & {
    author_user_id: string
  } => author.identity_mode === "public"
    && author.authorship_mode === "human_direct"
    && Boolean(author.author_user_id))
  const userIds = [...new Set(eligibleAuthors.map((author) => author.author_user_id))]
  if (userIds.length === 0) return

  const [communityHandles, globalHandles] = await Promise.all([
    surface.kind === "community"
      ? listPrimaryCommunityHandles({
        client: surface.client,
        communityId: surface.communityId,
        userIds,
      }).catch(() => new Map<string, string>())
      : Promise.resolve(new Map<string, string>()),
    listGlobalHandles(input.profileRepository, userIds, input.prefetchedProfilesByUserId),
  ])

  for (const author of eligibleAuthors) {
    author.author_public_handle = communityHandles.get(author.author_user_id)
      ?? globalHandles.get(author.author_user_id)
      ?? null
  }
}
