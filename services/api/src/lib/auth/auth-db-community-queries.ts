import type { DbExecutor } from "../db-helpers"
import { makeId } from "../helpers"
import {
  type CommunityCommentProjectionRow,
  type CommunityDbCredentialRow,
  type CommunityDatabaseBindingRow,
  type CommunityFollowProjectionRow,
  type CommunityMembershipProjectionRow,
  type CommunityPostProjectionRow,
  type CommunityRow,
  type JobRow,
  toCommunityCommentProjectionRow,
  toCommunityDatabaseBindingRow,
  toCommunityDbCredentialRow,
  toCommunityFollowProjectionRow,
  toCommunityMembershipProjectionRow,
  toCommunityPostProjectionRow,
  toCommunityRow,
  toJobRow,
} from "./auth-db-rows"
import { firstRow, isMissingColumnError, isMissingTableError } from "./auth-db-query-helpers"

const COMMUNITY_ROW_COLUMNS = `
  community_id, creator_user_id, display_name, status, provisioning_state,
  transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id,
  primary_database_binding_id, follower_count, created_at, updated_at
`

const PROJECTED_FOLLOWER_COUNT_COMMUNITY_ROW_COLUMNS = `
  community_id, creator_user_id, display_name, status, provisioning_state,
  transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id,
  primary_database_binding_id, projected_follower_count, created_at, updated_at
`

const LEGACY_COMMUNITY_ROW_COLUMNS = `
  community_id, creator_user_id, display_name, status, provisioning_state,
  transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id,
  primary_database_binding_id, NULL AS follower_count, created_at, updated_at
`

async function firstCommunityRow(
  executor: DbExecutor,
  buildSql: (columns: string) => string,
  args: unknown[],
): Promise<unknown | null> {
  try {
    return await firstRow(executor, {
      sql: buildSql(COMMUNITY_ROW_COLUMNS),
      args,
    })
  } catch (error) {
    if (!isMissingColumnError(error, "follower_count")) {
      throw error
    }
    try {
      return await firstRow(executor, {
        sql: buildSql(PROJECTED_FOLLOWER_COUNT_COMMUNITY_ROW_COLUMNS),
        args,
      })
    } catch (fallbackError) {
      if (!isMissingColumnError(fallbackError, "projected_follower_count")) {
        throw fallbackError
      }
      return await firstRow(executor, {
        sql: buildSql(LEGACY_COMMUNITY_ROW_COLUMNS),
        args,
      })
    }
  }
}

async function listCommunityRows(
  executor: DbExecutor,
  buildSql: (columns: string) => string,
  args: unknown[] = [],
): Promise<CommunityRow[]> {
  try {
    const result = await executor.execute({
      sql: buildSql(COMMUNITY_ROW_COLUMNS),
      args,
    })
    return result.rows.map((row) => toCommunityRow(row))
  } catch (error) {
    if (!isMissingColumnError(error, "follower_count")) {
      throw error
    }
    try {
      const result = await executor.execute({
        sql: buildSql(PROJECTED_FOLLOWER_COUNT_COMMUNITY_ROW_COLUMNS),
        args,
      })
      return result.rows.map((row) => toCommunityRow(row))
    } catch (fallbackError) {
      if (!isMissingColumnError(fallbackError, "projected_follower_count")) {
        throw fallbackError
      }
      const result = await executor.execute({
        sql: buildSql(LEGACY_COMMUNITY_ROW_COLUMNS),
        args,
      })
      return result.rows.map((row) => toCommunityRow(row))
    }
  }
}

export async function getCommunityRowById(executor: DbExecutor, communityId: string): Promise<CommunityRow | null> {
  const row = await firstCommunityRow(
    executor,
    (columns) => `
      SELECT ${columns}
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    [communityId],
  )

  return row ? toCommunityRow(row) : null
}

export async function getCommunityRowByRouteSlug(
  executor: DbExecutor,
  routeSlug: string,
): Promise<CommunityRow | null> {
  const row = await firstCommunityRow(
    executor,
    (columns) => `
      SELECT ${columns}
      FROM communities
      WHERE route_slug = ?1
      LIMIT 1
    `,
    [routeSlug],
  )

  return row ? toCommunityRow(row) : null
}

export async function getCommunityRowByNamespaceVerificationId(
  executor: DbExecutor,
  namespaceVerificationId: string,
): Promise<CommunityRow | null> {
  const row = await firstCommunityRow(
    executor,
    (columns) => `
      SELECT ${columns}
      FROM communities
      WHERE namespace_verification_id = ?1
      LIMIT 1
    `,
    [namespaceVerificationId],
  )

  return row ? toCommunityRow(row) : null
}

export async function listCreatedCommunityRowsByCreatorUserId(
  executor: DbExecutor,
  creatorUserId: string,
): Promise<CommunityRow[]> {
  return listCommunityRows(
    executor,
    (columns) => `
      SELECT ${columns}
      FROM communities
      WHERE creator_user_id = ?1
        AND status = 'active'
        AND provisioning_state = 'active'
      ORDER BY created_at DESC
    `,
    [creatorUserId],
  )
}

export async function listActiveCommunityRows(executor: DbExecutor): Promise<CommunityRow[]> {
  return listCommunityRows(
    executor,
    (columns) => `
      SELECT ${columns}
      FROM communities
      WHERE status = 'active'
        AND provisioning_state = 'active'
      ORDER BY created_at ASC, community_id ASC
    `,
  )
}

export async function getCommunityDatabaseBindingRowById(
  executor: DbExecutor,
  communityDatabaseBindingId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
             database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
      FROM community_database_bindings
      WHERE community_database_binding_id = ?1
      LIMIT 1
    `,
    args: [communityDatabaseBindingId],
  })

  return row ? toCommunityDatabaseBindingRow(row) : null
}

export async function getPrimaryCommunityDatabaseBindingRow(
  executor: DbExecutor,
  communityId: string,
): Promise<CommunityDatabaseBindingRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_database_binding_id, community_id, binding_role, organization_slug, group_name, group_id,
             database_name, database_id, database_url, location, status, transferred_at, created_at, updated_at
      FROM community_database_bindings
      WHERE community_id = ?1
        AND binding_role = 'primary'
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toCommunityDatabaseBindingRow(row) : null
}

export async function getActiveCommunityDbCredentialRow(
  executor: DbExecutor,
  communityDatabaseBindingId: string,
): Promise<CommunityDbCredentialRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT community_db_credential_id, community_database_binding_id, credential_kind, token_name,
             encrypted_token, encryption_key_version, token_scope, status, issued_at, invalidated_at,
             expires_at, created_at, updated_at
      FROM community_db_credentials
      WHERE community_database_binding_id = ?1
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityDatabaseBindingId],
  })

  return row ? toCommunityDbCredentialRow(row) : null
}

export async function getJobRowById(executor: DbExecutor, jobId: string): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE job_id = ?1
      LIMIT 1
    `,
    args: [jobId],
  })

  return row ? toJobRow(row) : null
}

export async function getLatestCommunityProvisioningJobRow(executor: DbExecutor, communityId: string): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE community_id = ?1
        AND job_type = 'community_provisioning'
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [communityId],
  })

  return row ? toJobRow(row) : null
}

export async function getLatestJobRowBySubjectAndType(
  executor: DbExecutor,
  input: {
    subjectType: string
    subjectId: string
    jobType: JobRow["job_type"]
  },
): Promise<JobRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
             result_ref, error_code, attempt_count, available_at, created_at, updated_at
      FROM jobs
      WHERE subject_type = ?1
        AND subject_id = ?2
        AND job_type = ?3
      ORDER BY created_at DESC, job_id DESC
      LIMIT 1
    `,
    args: [input.subjectType, input.subjectId, input.jobType],
  }).catch((error) => {
    if (isMissingTableError(error, "jobs")) {
      return null
    }
    throw error
  })

  return row ? toJobRow(row) : null
}

export async function getCommunityPostProjectionRowByPostId(
  executor: DbExecutor,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT projection_id, community_id, source_post_id, author_user_id, identity_mode, post_type, status, visibility,
             source_created_at, projected_payload_json, upvote_count, downvote_count, comment_count, like_count,
             projection_version, created_at, updated_at
      FROM community_post_projections
      WHERE source_post_id = ?1
        AND projection_version = 1
      LIMIT 1
    `,
    args: [postId],
  })

  return row ? toCommunityPostProjectionRow(row) : null
}

export async function listCommunityMembershipProjectionRowsByUserId(
  executor: DbExecutor,
  userId: string,
): Promise<CommunityMembershipProjectionRow[]> {
  const result = await executor.execute({
    sql: `
      SELECT projection_id, community_id, user_id, membership_state, role_summary_json, source_updated_at, created_at, updated_at
      FROM community_membership_projections
      WHERE user_id = ?1
      ORDER BY updated_at DESC, projection_id DESC
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "community_membership_projections")) {
      return { rows: [] }
    }
    throw error
  })

  return result.rows.map((row) => toCommunityMembershipProjectionRow(row))
}

export async function listCommunityFollowProjectionRowsByUserId(
  executor: DbExecutor,
  userId: string,
): Promise<CommunityFollowProjectionRow[]> {
  const result = await executor.execute({
    sql: `
      SELECT projection_id, community_id, user_id, follow_state, source_updated_at, unfollowed_at, created_at, updated_at
      FROM community_follow_projections
      WHERE user_id = ?1
      ORDER BY updated_at DESC, projection_id DESC
    `,
    args: [userId],
  }).catch((error) => {
    if (isMissingTableError(error, "community_follow_projections")) {
      return { rows: [] }
    }
    throw error
  })

  return result.rows.map((row) => toCommunityFollowProjectionRow(row))
}

export async function upsertCommunityMembershipProjectionRow(input: {
  executor: DbExecutor
  communityId: string
  userId: string
  membershipState: CommunityMembershipProjectionRow["membership_state"]
  sourceUpdatedAt: string
  createdAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT INTO community_membership_projections (
        projection_id, community_id, user_id, membership_state, role_summary_json, source_updated_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, NULL, ?5, ?6, ?6
      )
      ON CONFLICT(community_id, user_id) DO UPDATE SET
        membership_state = excluded.membership_state,
        source_updated_at = excluded.source_updated_at,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("cmp"),
      input.communityId,
      input.userId,
      input.membershipState,
      input.sourceUpdatedAt,
      input.createdAt,
    ],
  })
}

export async function upsertCommunityFollowProjectionRow(input: {
  executor: DbExecutor
  communityId: string
  userId: string
  followState: CommunityFollowProjectionRow["follow_state"]
  sourceUpdatedAt: string
  unfollowedAt: string | null
  createdAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT INTO community_follow_projections (
        projection_id, community_id, user_id, follow_state, source_updated_at, unfollowed_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7
      )
      ON CONFLICT(community_id, user_id) DO UPDATE SET
        follow_state = excluded.follow_state,
        source_updated_at = excluded.source_updated_at,
        unfollowed_at = excluded.unfollowed_at,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("cfp"),
      input.communityId,
      input.userId,
      input.followState,
      input.sourceUpdatedAt,
      input.unfollowedAt,
      input.createdAt,
    ],
  })
}

export async function incrementCommunityFollowerCountRow(input: {
  executor: DbExecutor
  communityId: string
  delta: 1 | -1
  updatedAt: string
}): Promise<void> {
  const args = [input.communityId, input.delta, input.updatedAt]
  try {
    await input.executor.execute({
      sql: `
        UPDATE communities
        SET follower_count = CASE
              WHEN COALESCE(follower_count, 0) + ?2 < 0 THEN 0
              ELSE COALESCE(follower_count, 0) + ?2
            END,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args,
    })
  } catch (error) {
    if (!isMissingColumnError(error, "follower_count")) {
      throw error
    }
    await input.executor.execute({
      sql: `
        UPDATE communities
        SET projected_follower_count = CASE
              WHEN COALESCE(projected_follower_count, 0) + ?2 < 0 THEN 0
              ELSE COALESCE(projected_follower_count, 0) + ?2
            END,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args,
    })
  }
}

export async function updateCommunityPostProjectionStatusRow(input: {
  executor: DbExecutor
  postId: string
  status: CommunityPostProjectionRow["status"]
  updatedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE community_post_projections
      SET status = ?2,
          updated_at = ?3
      WHERE source_post_id = ?1
        AND projection_version = 1
    `,
    args: [input.postId, input.status, input.updatedAt],
  })
}

export async function updateCommunityPostProjectionMetricsRow(input: {
  executor: DbExecutor
  postId: string
  upvoteCount: number
  downvoteCount: number
  commentCount: number
  likeCount: number
  updatedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE community_post_projections
      SET upvote_count = ?2,
          downvote_count = ?3,
          comment_count = ?4,
          like_count = ?5,
          updated_at = ?6
      WHERE source_post_id = ?1
        AND projection_version = 1
    `,
    args: [
      input.postId,
      input.upvoteCount,
      input.downvoteCount,
      input.commentCount,
      input.likeCount,
      input.updatedAt,
    ],
  }).catch((error) => {
    if (isMissingColumnError(error, "upvote_count")) {
      return
    }
    throw error
  })
}

export async function getCommunityCommentProjectionRowByCommentId(
  executor: DbExecutor,
  commentId: string,
): Promise<CommunityCommentProjectionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT projection_id, community_id, thread_root_post_id, source_comment_id, parent_comment_id, depth, status,
             source_created_at, created_at, updated_at
      FROM comment_projections
      WHERE source_comment_id = ?1
      LIMIT 1
    `,
    args: [commentId],
  }).catch((error) => {
    if (isMissingTableError(error, "comment_projections")) {
      return null
    }
    throw error
  })

  return row ? toCommunityCommentProjectionRow(row) : null
}
