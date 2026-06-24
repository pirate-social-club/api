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
import { insertPost } from "../src/lib/posts/community-post-create-store"
import { getPostById } from "../src/lib/posts/community-post-query-store"
import { resolvePostProjectionSchema } from "../src/lib/posts/community-post-projection"
import type { Post } from "../src/types"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type {
  CommunityCommentProjectionRow,
  CommunityDatabaseBindingRow,
  CommunityPostProjectionRow,
  CommunityRow,
} from "../src/lib/auth/auth-db-rows"
import type { UserRepository } from "../src/lib/auth/repositories"
import type { Env, User } from "../src/types"

/**
 * Test-only convenience: `insertPost` is now write-only (returns a draft, requires
 * a pre-resolved projection schema) so it is D1-buffer-safe in production. Tests
 * run on libSQL (in-tx reads work), so this wrapper resolves the schema, inserts,
 * and reads back the full hydrated Post — preserving the old `insertPost` ergonomics.
 */
export async function insertPostForTest(
  input: Omit<Parameters<typeof insertPost>[0], "projectionSchema">,
): Promise<Post> {
  const projectionSchema = await resolvePostProjectionSchema(input.client)
  const draft = await insertPost({ ...input, projectionSchema })
  const post = await getPostById(input.client, draft.post_id)
  if (!post) {
    throw new Error("insertPostForTest: post row missing after insert")
  }
  return post
}

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
    async getWalletAttachmentById() {
      return null
    },
    async setIdentityWallet(userId: string) {
      return users[userId] ?? null
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
    description: null,
    avatar_ref: null,
    banner_ref: null,
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
  & CommunityPostProjectionRepository
  & CommunityCommentProjectionRepository
  & {
    projections: Map<string, CommunityCommentProjectionRow>
    postProjections: Map<string, CommunityPostProjectionRow>
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
  const postProjections = new Map<string, CommunityPostProjectionRow>()
  const now = new Date().toISOString()
  const community = buildCommunityRow({
    communityId: input.communityId,
    now,
    displayName: input.displayName,
    primaryDatabaseBindingId: input.primaryDatabaseBindingId,
  })
  const repo = {
    projections,
    postProjections,
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
    async updateCommunityPostProjectionStatus(input: {
      postId: string
      status: CommunityPostProjectionRow["status"]
      updatedAt: string
    }) {
      const existing = repo.postProjections.get(input.postId)
      if (existing) {
        repo.postProjections.set(input.postId, {
          ...existing,
          status: input.status,
          updated_at: input.updatedAt,
        })
      }
    },
    async updateCommunityPostProjectionPayload(input: {
      postId: string
      projectedPayloadJson: string
      updatedAt: string
    }) {
      const existing = repo.postProjections.get(input.postId)
      if (existing) {
        repo.postProjections.set(input.postId, {
          ...existing,
          projected_payload_json: input.projectedPayloadJson,
          projection_version: existing.projection_version + 1,
          updated_at: input.updatedAt,
        })
      }
    },
    async recordCommunityPostProjection(input: {
      communityId: string
      sourcePostId: string
      authorUserId: string | null
      identityMode: "public" | "anonymous"
      postType: "text" | "image" | "video" | "link" | "song"
      status: "draft" | "published" | "hidden" | "removed" | "deleted"
      visibility: "public" | "members_only"
      sourceCreatedAt: string
      projectedPayloadJson: string
      actorUserId: string
      createdAt: string
    }) {
      if (repo.failProjectionWrites) {
        throw new Error("projection unavailable")
      }
      const existing = repo.postProjections.get(input.sourcePostId)
      const row: CommunityPostProjectionRow = {
        projection_id: existing?.projection_id ?? `cpp_${input.sourcePostId}`,
        community_id: input.communityId,
        source_post_id: input.sourcePostId,
        author_user_id: input.authorUserId,
        identity_mode: input.identityMode,
        post_type: input.postType,
        status: input.status,
        visibility: input.visibility,
        source_created_at: input.sourceCreatedAt,
        projected_payload_json: input.projectedPayloadJson,
        upvote_count: existing?.upvote_count ?? 0,
        downvote_count: existing?.downvote_count ?? 0,
        comment_count: existing?.comment_count ?? 0,
        like_count: existing?.like_count ?? 0,
        projection_version: existing?.projection_version ?? 1,
        created_at: existing?.created_at ?? input.createdAt,
        updated_at: input.createdAt,
      }
      repo.postProjections.set(input.sourcePostId, row)
      return row
    },
    async getCommunityPostProjectionByPostId(postId: string) {
      return repo.postProjections.get(postId) ?? null
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

    const post = await insertPostForTest({
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
