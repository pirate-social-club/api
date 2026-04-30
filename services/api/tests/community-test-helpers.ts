import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import type {
  CommunityCommentProjectionRepository,
  CommunityDatabaseBindingRepository,
  CommunityPostProjectionRepository,
  CommunityReadRepository,
} from "../src/lib/communities/db-community-repository"
import { insertPost } from "../src/lib/posts/community-post-store"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { CommunityCommentProjectionRow, CommunityDatabaseBindingRow, CommunityRow } from "../src/lib/auth/auth-db-rows"
import type { UserRepository } from "../src/lib/auth/repositories"
import type { Env, User } from "../src/types"

export async function cleanupCommunityTestArtifacts(cleanupPaths: string[]): Promise<void> {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}

export async function createCommunityTestRoot(cleanupPaths: string[], prefix: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  cleanupPaths.push(rootDir)
  return rootDir
}

export function buildVerifiedUser(userId: string): User {
  const capabilities = buildDefaultVerificationCapabilities()
  const now = new Date().toISOString()
  capabilities.unique_human = {
    state: "verified",
    provider: "self",
    proof_type: "unique_human",
    mechanism: "mock",
    verified_at: Math.floor(Date.now() / 1000),
  }

  return {
    user_id: userId,
    verification_state: "verified",
    capability_provider: "self",
    verification_capabilities: capabilities,
    created_at: now,
    updated_at: now,
  }
}

export function buildUserRepository(users: Record<string, User>): UserRepository {
  return {
    async getUserById(userId: string) {
      return users[userId] ?? null
    },
    async getWalletAttachmentsByUserId() {
      return []
    },
  }
}

function buildCommunityRow(input: {
  communityId: string
  now: string
  displayName: string
  primaryDatabaseBindingId: string
}): CommunityRow {
  return {
    community_id: input.communityId,
    creator_user_id: "usr_owner",
    display_name: input.displayName,
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: null,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: input.primaryDatabaseBindingId,
    follower_count: 0,
    created_at: input.now,
    updated_at: input.now,
  }
}

export type TestCommunityRepository =
  & CommunityReadRepository
  & CommunityDatabaseBindingRepository
  & Pick<CommunityPostProjectionRepository, "updateCommunityPostProjectionMetrics">
  & CommunityCommentProjectionRepository
  & {
    projections: Map<string, CommunityCommentProjectionRow>
    failProjectionWrites: boolean
  }

export function buildTestCommunityRepository(input: {
  databasePath: string
  communityId: string
  displayName: string
  primaryDatabaseBindingId: string
  databaseName: string
}): TestCommunityRepository {
  const projections = new Map<string, CommunityCommentProjectionRow>()
  const now = new Date().toISOString()
  const community = buildCommunityRow({
    communityId: input.communityId,
    now,
    displayName: input.displayName,
    primaryDatabaseBindingId: input.primaryDatabaseBindingId,
  })
  const repo = {
    projections,
    failProjectionWrites: false,
    async getCommunityById(requestedCommunityId: string) {
      return requestedCommunityId === input.communityId ? community : null
    },
    async getCommunityByRouteSlug() {
      return null
    },
    async getCommunityByNamespaceVerificationId() {
      return null
    },
    async listActiveCommunities() {
      return [community]
    },
    async searchActiveCommunities(searchInput: { query: string; limit: number }) {
      const normalizedQuery = searchInput.query.trim().toLowerCase()
      const matchesCommunity = community.display_name.toLowerCase().includes(normalizedQuery)
        || community.route_slug?.toLowerCase().includes(normalizedQuery)
      return matchesCommunity ? [community].slice(0, searchInput.limit) : []
    },
    async getPrimaryCommunityDatabaseBinding(requestedCommunityId: string): Promise<CommunityDatabaseBindingRow | null> {
      if (requestedCommunityId !== input.communityId) {
        return null
      }
      return {
        community_database_binding_id: input.primaryDatabaseBindingId,
        community_id: input.communityId,
        binding_role: "primary",
        organization_slug: "local",
        group_name: "local",
        group_id: null,
        database_name: input.databaseName,
        database_id: null,
        database_url: `file:${input.databasePath}`,
        location: null,
        requires_credentials: false,
        status: "active",
        transferred_at: null,
        created_at: now,
        updated_at: now,
      }
    },
    async getActiveCommunityDbCredential() {
      return null
    },
    async updateCommunityPostProjectionMetrics() {
      return undefined
    },
    async recordCommunityCommentProjection(input: {
      communityId: string
      threadRootPostId: string
      sourceCommentId: string
      parentCommentId: string | null
      depth: number
      status: "published" | "hidden" | "removed" | "deleted"
      sourceCreatedAt: string
      actorUserId: string
      createdAt: string
    }) {
      if (repo.failProjectionWrites) {
        throw new Error("projection unavailable")
      }
      const existing = repo.projections.get(input.sourceCommentId)
      const row: CommunityCommentProjectionRow = {
        projection_id: existing?.projection_id ?? `ccp_${input.sourceCommentId}`,
        community_id: input.communityId,
        thread_root_post_id: input.threadRootPostId,
        source_comment_id: input.sourceCommentId,
        parent_comment_id: input.parentCommentId,
        depth: input.depth,
        status: input.status,
        source_created_at: input.sourceCreatedAt,
        created_at: existing?.created_at ?? input.createdAt,
        updated_at: input.createdAt,
      }
      repo.projections.set(input.sourceCommentId, row)
      return row
    },
    async getCommunityCommentProjectionByCommentId(commentId: string) {
      return repo.projections.get(commentId) ?? null
    },
  }

  return repo satisfies TestCommunityRepository
}

export async function seedTestCommunityState(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  memberUserIds: string[]
  displayName: string
  rootPostTitle: string
  membershipMode?: "open" | "request" | "gated"
}): Promise<{ postId: string }> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    const now = new Date().toISOString()
    await db.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, display_name, description, status, artist_identity_id, artist_governance_state,
          membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
          donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
          settings_json, created_by_user_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, NULL, 'active', NULL, 'fan_run',
          ?3, 'none', 1, 'thread_stable',
          NULL, 'none', 'unconfigured', 'centralized',
          NULL, ?4, ?5, ?5
        )
      `,
      args: [input.communityId, input.displayName, input.membershipMode ?? "request", "usr_owner", now],
    })

    for (const userId of input.memberUserIds) {
      await db.client.execute({
        sql: `
          INSERT INTO community_memberships (
            membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
          )
        `,
        args: [`mbr_${userId}`, input.communityId, userId, now],
      })
    }

    const post = await insertPost({
      client: db.client,
      communityId: input.communityId,
      authorUserId: "usr_owner",
      body: {
        post_type: "text",
        title: input.rootPostTitle,
        body: "Top level post body",
        idempotency_key: `seed-post-${input.communityId}`,
      },
      createdAt: now,
    })

    return { postId: post.post_id }
  } finally {
    db.close()
  }
}
