import type { Env } from "../../env"
import type { CommunityDatabaseBindingRepository } from "../communities/db-community-repository"
import { resolveCommunityAvatarRef } from "../communities/community-identity-media"
import { getControlPlaneClient } from "../runtime-deps"
import { publicCommunityId } from "../public-ids"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"

export type PostableCommunityAction = "compose" | "unlock"

export type PostableCommunitySummary = {
  community_id: string
  display_name: string
  avatar_ref: string | null
  route_slug: string | null
  action: PostableCommunityAction
}

export type PostableCommunitiesResponse = {
  communities: PostableCommunitySummary[]
}

type CommunityCandidateRow = {
  community_id: string
  display_name: string
  avatar_ref: string | null
  route_slug: string | null
  follower_count: number | null
  created_at: string
  membership_has_altcha_pow: boolean
}

function toCommunityCandidateRow(row: unknown): CommunityCandidateRow {
  return {
    community_id: requiredString(row, "community_id"),
    display_name: requiredString(row, "display_name"),
    avatar_ref: stringOrNull(rowValue(row, "avatar_ref")),
    route_slug: stringOrNull(rowValue(row, "route_slug")),
    follower_count: numberOrNull(rowValue(row, "follower_count")),
    created_at: requiredString(row, "created_at"),
    membership_has_altcha_pow: numberOrNull(rowValue(row, "membership_has_altcha_pow")) === 1,
  }
}

function serializePostableCommunity(
  row: CommunityCandidateRow,
  action: PostableCommunityAction,
  avatarRef?: string | null,
): PostableCommunitySummary {
  return {
    community_id: publicCommunityId(row.community_id),
    display_name: row.display_name,
    avatar_ref: avatarRef ?? resolveCommunityAvatarRef({
      communityId: row.community_id,
      displayName: row.display_name,
      avatarRef: row.avatar_ref,
    }),
    route_slug: row.route_slug,
    action,
  }
}

async function listMemberCommunities(input: {
  env: Env
  userId: string
}): Promise<CommunityCandidateRow[]> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT c.community_id, c.display_name, c.avatar_ref, c.route_slug, c.follower_count,
             c.created_at, c.membership_has_altcha_pow
      FROM community_membership_projections cmp
      JOIN communities c ON c.community_id = cmp.community_id
      WHERE cmp.user_id = ?1
        AND cmp.membership_state = 'member'
        AND c.status = 'active'
        AND c.provisioning_state = 'active'
      ORDER BY lower(c.display_name) ASC, c.community_id ASC
      LIMIT 50
    `,
    args: [input.userId],
  })
  return result.rows.map(toCommunityCandidateRow)
}

async function listCreatedCommunities(input: {
  env: Env
  userId: string
}): Promise<CommunityCandidateRow[]> {
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT community_id, display_name, avatar_ref, route_slug, follower_count,
             created_at, membership_has_altcha_pow
      FROM communities
      WHERE creator_user_id = ?1
        AND status = 'active'
        AND provisioning_state = 'active'
      ORDER BY lower(display_name) ASC, community_id ASC
      LIMIT 50
    `,
    args: [input.userId],
  })
  return result.rows.map(toCommunityCandidateRow)
}

async function listUnlockCandidates(input: {
  env: Env
  excludedCommunityIds: Set<string>
}): Promise<CommunityCandidateRow[]> {
  const excluded = Array.from(input.excludedCommunityIds)
  const exclusionSql = excluded.length === 0
    ? ""
    : `AND community_id NOT IN (${excluded.map((_, index) => `?${index + 1}`).join(", ")})`
  const limitArgIndex = excluded.length + 1
  const result = await getControlPlaneClient(input.env).execute({
    sql: `
      SELECT community_id, display_name, avatar_ref, route_slug, follower_count,
             created_at, membership_has_altcha_pow
      FROM communities
      WHERE status = 'active'
        AND provisioning_state = 'active'
        AND membership_has_altcha_pow = 1
        ${exclusionSql}
      ORDER BY COALESCE(follower_count, 0) DESC, created_at DESC, community_id ASC
      LIMIT ?${limitArgIndex}
    `,
    args: [...excluded, 20],
  })
  return result.rows.map(toCommunityCandidateRow)
}

export async function getPostableCommunities(input: {
  env: Env
  repository: CommunityDatabaseBindingRepository
  userId: string
}): Promise<PostableCommunitiesResponse> {
  const [memberRows, createdRows] = await Promise.all([
    listMemberCommunities({
      env: input.env,
      userId: input.userId,
    }),
    listCreatedCommunities({
      env: input.env,
      userId: input.userId,
    }),
  ])

  const composeById = new Map<string, CommunityCandidateRow>()
  for (const row of [...memberRows, ...createdRows]) {
    composeById.set(row.community_id, row)
  }

  const compose = Array.from(composeById.values())
    .sort((left, right) => left.display_name.localeCompare(right.display_name))
    .map((row) => serializePostableCommunity(row, "compose"))

  const unlockCandidates = await listUnlockCandidates({
    env: input.env,
    excludedCommunityIds: new Set(composeById.keys()),
  })

  const unlock = unlockCandidates.map((row) => serializePostableCommunity(row, "unlock"))

  return {
    communities: [...compose, ...unlock],
  }
}
