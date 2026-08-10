import type { Env } from "../../env"
import { codedConflictError } from "../errors"
import { getCommunityRepository } from "../communities/db-community-repository"
import { bulkCommunityRead, bulkCommunityWrite, openCommunityWriteClient } from "../communities/community-read-access"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client, Transaction } from "../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"

export type AccountMergeBlockReason =
  | "distinct_verified_humans"
  | "community_authority"
  | "authored_content"
  | "purchase_activity"
  | "booking_activity"
  | "cashout_in_flight"

type MergeRecord = {
  id: string
  sourceUserId: string
  canonicalUserId: string
  status: "migrating" | "finalizing" | "completed" | "blocked"
  blockReason: AccountMergeBlockReason | null
}

function mergeConflict(reason: AccountMergeBlockReason): Error {
  const messages: Record<AccountMergeBlockReason, string> = {
    distinct_verified_humans: "Both accounts belong to different verified people and cannot be merged",
    community_authority: "The Telegram account owns or administers a community and requires manual review",
    authored_content: "The Telegram account has authored content and requires manual review",
    purchase_activity: "The Telegram account has purchases and requires manual review",
    booking_activity: "The Telegram account has bookings and requires manual review",
    cashout_in_flight: "Wait for the active reward cashout to finish before linking these accounts",
  }
  return codedConflictError(`telegram_account_merge_${reason}`, messages[reason])
}

function decodeMerge(row: unknown): MergeRecord | null {
  const id = stringOrNull(rowValue(row, "user_account_merge_id"))
  const sourceUserId = stringOrNull(rowValue(row, "source_user_id"))
  const canonicalUserId = stringOrNull(rowValue(row, "canonical_user_id"))
  const status = stringOrNull(rowValue(row, "status")) as MergeRecord["status"] | null
  const blockReason = stringOrNull(rowValue(row, "block_reason")) as AccountMergeBlockReason | null
  return id && sourceUserId && canonicalUserId && status
    ? { id, sourceUserId, canonicalUserId, status, blockReason }
    : null
}

async function activeVerifiedIdentityCount(exec: Pick<Client | Transaction, "execute">, userId: string): Promise<number> {
  const result = await exec.execute({
    sql: "SELECT COUNT(*) AS count FROM identity_nullifiers WHERE user_id = ?1 AND status = 'active'",
    args: [userId],
  })
  return requiredNumber(result.rows[0], "count")
}

async function controlPlaneBlockReason(
  tx: Transaction,
  sourceUserId: string,
  canonicalUserId: string,
): Promise<AccountMergeBlockReason | null> {
  const sourceVerified = await activeVerifiedIdentityCount(tx, sourceUserId)
  const canonicalVerified = await activeVerifiedIdentityCount(tx, canonicalUserId)
  if (sourceVerified > 0 && canonicalVerified > 0) return "distinct_verified_humans"

  const authority = await tx.execute({
    sql: `SELECT 1 FROM communities WHERE creator_user_id = ?1 LIMIT 1`,
    args: [sourceUserId],
  })
  if (authority.rows.length > 0) return "community_authority"

  const authored = await tx.execute({
    sql: `SELECT 1 FROM community_post_projections WHERE author_user_id = ?1 LIMIT 1`,
    args: [sourceUserId],
  })
  if (authored.rows.length > 0) return "authored_content"

  const cashout = await tx.execute({
    sql: `
      SELECT 1 FROM reward_payout_effects
      WHERE user_id IN (?1, ?2) AND status = 'submitted'
      LIMIT 1
    `,
    args: [sourceUserId, canonicalUserId],
  })
  return cashout.rows.length > 0 ? "cashout_in_flight" : null
}

export async function shardBlockReason(client: Client, sourceUserId: string): Promise<AccountMergeBlockReason | null> {
  const hasRow = async (sql: string): Promise<boolean> => {
    const result = await client.execute({ sql, args: [sourceUserId] })
    return result.rows.length > 0
  }

  // These shard tables may be partitioned views. Combining them with UNION
  // expands their definitions and can exceed SQLite's compound-select limit.
  // Keep the checks separate and ordered to preserve block-reason precedence.
  if (await hasRow(`
    SELECT 1 FROM community_roles
    WHERE user_id = ?1 AND status = 'active' AND role IN ('owner', 'admin', 'moderator')
    LIMIT 1
  `)) return "community_authority"
  if (await hasRow(`SELECT 1 FROM communities WHERE created_by_user_id = ?1 LIMIT 1`)) {
    return "community_authority"
  }
  if (await hasRow(`SELECT 1 FROM posts WHERE author_user_id = ?1 LIMIT 1`)) return "authored_content"
  if (await hasRow(`SELECT 1 FROM comments WHERE author_user_id = ?1 LIMIT 1`)) return "authored_content"
  if (await hasRow(`SELECT 1 FROM purchases WHERE buyer_user_id = ?1 LIMIT 1`)) return "purchase_activity"
  try {
    if (await hasRow(`
      SELECT 1 FROM bookings WHERE host_user_id = ?1 OR booker_user_id = ?1 LIMIT 1
    `)) return "booking_activity"
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // Older provisioned shards predate bookings. An absent table cannot hold
    // booking activity, but every other query failure must keep the merge closed.
    if (!/no such table:\s*(?:main\.)?bookings\b/iu.test(message)) throw error
  }
  return null
}

const BULK_BLOCK_CHECK_STATEMENTS = [
  `SELECT 1 FROM community_roles WHERE user_id = ?1 AND status = 'active' AND role IN ('owner', 'admin', 'moderator') LIMIT 1`,
  `SELECT 1 FROM communities WHERE created_by_user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM posts WHERE author_user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM comments WHERE author_user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM purchases WHERE buyer_user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM bookings WHERE host_user_id = ?1 OR booker_user_id = ?1 LIMIT 1`,
]

/** Fleet equivalent of shardBlockReason; one bulk RPC covers a shard Worker. */
async function bulkShardBlockReasons(input: {
  env: Env
  repository: ReturnType<typeof getCommunityRepository>
  communityIds: string[]
  sourceUserId: string
}): Promise<Map<string, AccountMergeBlockReason>> {
  const rowsByCommunity = await bulkCommunityRead(
    input.env,
    input.repository,
    input.communityIds.map((communityId) => ({
      communityId,
      statements: BULK_BLOCK_CHECK_STATEMENTS.map((sql) => ({ sql, args: [input.sourceUserId] })),
      allowMissingTables: ["bookings"],
    })),
  )
  const reasons = new Map<string, AccountMergeBlockReason>()
  for (const communityId of input.communityIds) {
    const results = rowsByCommunity.get(communityId) ?? []
    const index = results.findIndex((result) => result.rows.length > 0)
    if (index === 0 || index === 1) reasons.set(communityId, "community_authority")
    else if (index === 2 || index === 3) reasons.set(communityId, "authored_content")
    else if (index === 4) reasons.set(communityId, "purchase_activity")
    else if (index === 5) reasons.set(communityId, "booking_activity")
  }
  return reasons
}

async function markBlocked(client: Client, merge: MergeRecord, reason: AccountMergeBlockReason): Promise<never> {
  const now = nowIso()
  await client.execute({
    sql: `
      UPDATE user_account_merges
      SET status = 'blocked', block_reason = ?2,
          block_detail_json = ?3, updated_at = ?4
      WHERE user_account_merge_id = ?1 AND status <> 'completed'
    `,
    args: [merge.id, reason, JSON.stringify({ reason }), now],
  })
  throw mergeConflict(reason)
}

async function ensureMergeRecord(input: {
  client: Client
  linkIntentId: string
  sourceUserId: string
  canonicalUserId: string
}): Promise<MergeRecord> {
  const existing = await input.client.execute({
    sql: `
      SELECT user_account_merge_id, source_user_id, canonical_user_id, status, block_reason
      FROM user_account_merges WHERE source_user_id = ?1 LIMIT 1
    `,
    args: [input.sourceUserId],
  })
  const decoded = decodeMerge(existing.rows[0])
  if (decoded) {
    if (decoded.canonicalUserId !== input.canonicalUserId) {
      throw codedConflictError(
        "telegram_account_merge_target_conflict",
        "This Telegram account is already being linked to another account",
      )
    }
    if (decoded.status === "blocked" && decoded.blockReason) throw mergeConflict(decoded.blockReason)
    return decoded
  }

  const now = nowIso()
  const id = makeId("uam")
  await input.client.execute({
    sql: `
      INSERT INTO user_account_merges (
        user_account_merge_id, source_user_id, canonical_user_id, link_intent_id,
        status, attempt_count, started_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, 'migrating', 1, ?5, ?5, ?5)
    `,
    args: [id, input.sourceUserId, input.canonicalUserId, input.linkIntentId, now],
  })
  return { id, sourceUserId: input.sourceUserId, canonicalUserId: input.canonicalUserId, status: "migrating", blockReason: null }
}

type MembershipMergePlan = { sourceMembershipId: string; targetMember: boolean } | null

async function loadMembershipMergePlan(client: Client, sourceUserId: string, canonicalUserId: string): Promise<MembershipMergePlan> {
  const memberships = await client.execute({
    sql: `SELECT membership_id, user_id, status FROM community_memberships WHERE user_id IN (?1, ?2)`,
    args: [sourceUserId, canonicalUserId],
  })
  const source = memberships.rows.find((row) => String(rowValue(row, "user_id")) === sourceUserId)
  if (!source) return null
  const targetMember = memberships.rows.some((row) =>
    String(rowValue(row, "user_id")) === canonicalUserId && String(rowValue(row, "status")) === "member")
  return { sourceMembershipId: requiredString(source, "membership_id"), targetMember }
}

async function applyMembershipMergePlan(
  tx: Transaction,
  plan: MembershipMergePlan,
  sourceUserId: string,
  canonicalUserId: string,
  now: string,
): Promise<void> {
  if (!plan) return
  if (plan.targetMember) {
    await tx.execute({
      sql: `UPDATE community_memberships SET status = 'left', left_at = ?2, updated_at = ?2 WHERE membership_id = ?1`,
      args: [plan.sourceMembershipId, now],
    })
  } else {
    await tx.execute({
      sql: `UPDATE community_memberships SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1`,
      args: [sourceUserId, canonicalUserId, now],
    })
  }
}

type AttemptMove = { id: string; attemptNumber: number; idempotencyKey: string }

async function loadAttemptMoves(
  client: Client,
  mergeId: string,
  sourceUserId: string,
  canonicalUserId: string,
): Promise<AttemptMove[]> {
  const attempts = await client.execute({
    sql: `
      SELECT id, exercise_id FROM song_study_attempt
      WHERE user_id = ?1 ORDER BY exercise_id, created_at, id
    `,
    args: [sourceUserId],
  })
  const nextByExercise = new Map<string, number>()
  const moves: AttemptMove[] = []
  for (const row of attempts.rows) {
    const exerciseId = requiredString(row, "exercise_id")
    if (!nextByExercise.has(exerciseId)) {
      const maximum = await client.execute({
        sql: `SELECT COALESCE(MAX(attempt_number), 0) AS value FROM song_study_attempt WHERE user_id = ?1 AND exercise_id = ?2`,
        args: [canonicalUserId, exerciseId],
      })
      nextByExercise.set(exerciseId, requiredNumber(maximum.rows[0], "value") + 1)
    }
    const id = requiredString(row, "id")
    const attemptNumber = nextByExercise.get(exerciseId)!
    nextByExercise.set(exerciseId, attemptNumber + 1)
    moves.push({ id, attemptNumber, idempotencyKey: `merge:${mergeId}:${id}` })
  }
  return moves
}

async function applyAttemptMoves(tx: Transaction, moves: AttemptMove[], canonicalUserId: string): Promise<void> {
  for (const move of moves) {
    await tx.execute({
      sql: `
        UPDATE song_study_attempt
        SET user_id = ?2, attempt_number = ?3, idempotency_key = ?4
        WHERE id = ?1
      `,
      args: [move.id, canonicalUserId, move.attemptNumber, move.idempotencyKey],
    })
  }
}

type StreakMetadata = {
  createdAt: string
  timezone: string | null
  timezoneUpdatedAt: string | null
  activeUntilAt: string | null
}

type StreakRebuild = {
  postId: string
  communityId: string
  dates: string[]
  metadata: StreakMetadata | null
}

type StreakRebuildPlan = { affectedPostIds: string[]; rebuilds: StreakRebuild[] }

async function loadStreakRebuildBatch(
  client: Client,
  sourceUserId: string,
  canonicalUserId: string,
  affectedPostIds: string[],
): Promise<StreakRebuild[]> {
  const metadataPostPlaceholders = affectedPostIds.map((_, index) => `?${index + 3}`).join(", ")
  const existingStreaks = await client.execute({
    sql: `
      SELECT user_id, post_id, created_at, timezone, timezone_updated_at, active_until_at
      FROM song_streaks
      WHERE user_id IN (?1, ?2) AND post_id IN (${metadataPostPlaceholders})
      ORDER BY CASE WHEN user_id = ?2 THEN 0 ELSE 1 END
    `,
    args: [sourceUserId, canonicalUserId, ...affectedPostIds],
  })
  const metadataByPost = new Map<string, StreakMetadata>()
  for (const row of existingStreaks.rows) {
    const postId = requiredString(row, "post_id")
    if (metadataByPost.has(postId)) continue
    metadataByPost.set(postId, {
      createdAt: requiredString(row, "created_at"),
      timezone: stringOrNull(rowValue(row, "timezone")),
      timezoneUpdatedAt: stringOrNull(rowValue(row, "timezone_updated_at")),
      activeUntilAt: stringOrNull(rowValue(row, "active_until_at")),
    })
  }

  const rows = await client.execute({
    sql: `
      SELECT post_id, community_id, activity_date
      FROM song_engagement_days
      WHERE user_id IN (?1, ?2) AND qualified = 1
        AND post_id IN (${metadataPostPlaceholders})
      ORDER BY post_id, activity_date, CASE WHEN user_id = ?2 THEN 0 ELSE 1 END
    `,
    args: [sourceUserId, canonicalUserId, ...affectedPostIds],
  })
  const byPost = new Map<string, { communityId: string; dates: Set<string> }>()
  for (const row of rows.rows) {
    const postId = requiredString(row, "post_id")
    const entry = byPost.get(postId) ?? { communityId: requiredString(row, "community_id"), dates: new Set() }
    entry.dates.add(requiredString(row, "activity_date"))
    byPost.set(postId, entry)
  }
  return [...byPost].map(([postId, entry]) => ({
    postId,
    communityId: entry.communityId,
    dates: [...entry.dates].sort(),
    metadata: metadataByPost.get(postId) ?? null,
  }))
}

async function loadStreakRebuildPlan(
  client: Client,
  sourceUserId: string,
  canonicalUserId: string,
): Promise<StreakRebuildPlan> {
  const affected = await client.execute({
    sql: `SELECT DISTINCT post_id FROM song_engagement_days WHERE user_id = ?1 ORDER BY post_id`,
    args: [sourceUserId],
  })
  const affectedPostIds = affected.rows.map((row) => requiredString(row, "post_id"))
  const rebuilds: StreakRebuild[] = []
  const batchSize = 80
  for (let offset = 0; offset < affectedPostIds.length; offset += batchSize) {
    rebuilds.push(...await loadStreakRebuildBatch(
      client,
      sourceUserId,
      canonicalUserId,
      affectedPostIds.slice(offset, offset + batchSize),
    ))
  }
  return { affectedPostIds, rebuilds }
}

async function applyStreakRebuildPlan(
  tx: Transaction,
  canonicalUserId: string,
  plan: StreakRebuildPlan,
  now: string,
): Promise<void> {
  const batchSize = 80
  for (let offset = 0; offset < plan.affectedPostIds.length; offset += batchSize) {
    const postIds = plan.affectedPostIds.slice(offset, offset + batchSize)
    const postPlaceholders = postIds.map((_, index) => `?${index + 2}`).join(", ")
    await tx.execute({
      sql: `DELETE FROM song_streaks WHERE user_id = ?1 AND post_id IN (${postPlaceholders})`,
      args: [canonicalUserId, ...postIds],
    })
  }
  for (const entry of plan.rebuilds) {
    let best = entry.dates.length > 0 ? 1 : 0
    let run = best
    let runStart = entry.dates[0]
    for (let index = 1; index < entry.dates.length; index += 1) {
      const previous = new Date(`${entry.dates[index - 1]}T00:00:00Z`)
      const current = new Date(`${entry.dates[index]}T00:00:00Z`)
      if (current.getTime() - previous.getTime() === 86_400_000) run += 1
      else {
        run = 1
        runStart = entry.dates[index]
      }
      if (run > best) {
        best = run
      }
    }
    const metadata = entry.metadata
    await tx.execute({
      sql: `
        INSERT INTO song_streaks (
          user_id, post_id, community_id, current_streak, best_streak,
          last_qualified_date, streak_started_date, total_qualified_days,
          created_at, updated_at, timezone, timezone_updated_at, active_until_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      `,
      args: [
        canonicalUserId, entry.postId, entry.communityId, run, best,
        entry.dates.at(-1), runStart, entry.dates.length,
        metadata?.createdAt ?? now, now, metadata?.timezone ?? null,
        metadata?.timezoneUpdatedAt ?? null, metadata?.activeUntilAt ?? null,
      ],
    })
  }
}

async function migrateShardData(client: Client, merge: MergeRecord, recordReceipt: boolean): Promise<void> {
  const membershipPlan = await loadMembershipMergePlan(client, merge.sourceUserId, merge.canonicalUserId)
  const attemptMoves = await loadAttemptMoves(client, merge.id, merge.sourceUserId, merge.canonicalUserId)
  const streakPlan = await loadStreakRebuildPlan(client, merge.sourceUserId, merge.canonicalUserId)
  const now = nowIso()
  const tx = await client.transaction("write")
  try {
    await applyMembershipMergePlan(tx, membershipPlan, merge.sourceUserId, merge.canonicalUserId, now)

    await tx.execute({
      sql: `
        INSERT INTO song_study_review_state (
          user_id, post_id, line_id, exercise_type, target_language, state,
          stability, difficulty, due_at, last_reviewed_at, reps, lapses,
          fsrs_params_version, updated_at
        )
        SELECT ?2, post_id, line_id, exercise_type, target_language, state,
               stability, difficulty, due_at, last_reviewed_at, reps, lapses,
               fsrs_params_version, updated_at
        FROM song_study_review_state WHERE user_id = ?1
        ON CONFLICT(user_id, post_id, line_id, exercise_type, target_language)
        DO UPDATE SET
          state = excluded.state,
          stability = excluded.stability,
          difficulty = excluded.difficulty,
          due_at = excluded.due_at,
          last_reviewed_at = excluded.last_reviewed_at,
          reps = excluded.reps,
          lapses = excluded.lapses,
          fsrs_params_version = excluded.fsrs_params_version,
          updated_at = excluded.updated_at
        WHERE excluded.updated_at > song_study_review_state.updated_at
      `,
      args: [merge.sourceUserId, merge.canonicalUserId],
    })
    await tx.execute({ sql: `DELETE FROM song_study_review_state WHERE user_id = ?1`, args: [merge.sourceUserId] })

    await tx.execute({
      sql: `UPDATE song_study_session SET status = 'expired', updated_at = ?2 WHERE user_id = ?1 AND status = 'active'`,
      args: [merge.sourceUserId, now],
    })
    await tx.execute({
      sql: `UPDATE song_study_session SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1`,
      args: [merge.sourceUserId, merge.canonicalUserId, now],
    })
    await applyAttemptMoves(tx, attemptMoves, merge.canonicalUserId)

    await tx.execute({
      sql: `
        INSERT INTO song_engagement_days (
          user_id, post_id, community_id, activity_date, study_attempt_count,
          study_correct_count, study_target_count, karaoke_pass_count, qualified,
          created_at, updated_at, activity_timezone
        )
        SELECT ?2, post_id, community_id, activity_date, study_attempt_count,
               study_correct_count, study_target_count, karaoke_pass_count, qualified,
               created_at, updated_at, activity_timezone
        FROM song_engagement_days WHERE user_id = ?1
        ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
          study_attempt_count = song_engagement_days.study_attempt_count + excluded.study_attempt_count,
          study_correct_count = MAX(song_engagement_days.study_correct_count, excluded.study_correct_count),
          study_target_count = MAX(song_engagement_days.study_target_count, excluded.study_target_count),
          karaoke_pass_count = song_engagement_days.karaoke_pass_count + excluded.karaoke_pass_count,
          qualified = MAX(song_engagement_days.qualified, excluded.qualified),
          updated_at = MAX(song_engagement_days.updated_at, excluded.updated_at),
          activity_timezone = COALESCE(song_engagement_days.activity_timezone, excluded.activity_timezone)
      `,
      args: [merge.sourceUserId, merge.canonicalUserId],
    })
    await tx.execute({ sql: `DELETE FROM song_engagement_days WHERE user_id = ?1`, args: [merge.sourceUserId] })
    await applyStreakRebuildPlan(tx, merge.canonicalUserId, streakPlan, now)
    await tx.execute({ sql: `DELETE FROM song_streaks WHERE user_id = ?1`, args: [merge.sourceUserId] })

    await tx.execute({
      sql: `
        DELETE FROM reward_qualification_outbox
        WHERE user_id = ?1 AND EXISTS (
          SELECT 1 FROM reward_qualification_outbox target
          WHERE target.user_id = ?2
            AND target.post_id = reward_qualification_outbox.post_id
            AND target.activity = reward_qualification_outbox.activity
            AND target.reward_period_key = reward_qualification_outbox.reward_period_key
        )
      `,
      args: [merge.sourceUserId, merge.canonicalUserId],
    })
    await tx.execute({
      sql: `UPDATE reward_qualification_outbox SET user_id = ?2 WHERE user_id = ?1`,
      args: [merge.sourceUserId, merge.canonicalUserId],
    })
    if (recordReceipt) {
      await tx.execute({
        sql: `
          INSERT INTO user_account_merge_receipts (
            user_account_merge_id, source_user_id, canonical_user_id, completed_at, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?4)
        `,
        args: [merge.id, merge.sourceUserId, merge.canonicalUserId, now],
      })
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  }
}

export async function migrateShard(client: Client, merge: MergeRecord): Promise<void> {
  const existing = await client.execute({
    sql: `SELECT 1 FROM user_account_merge_receipts WHERE user_account_merge_id = ?1 LIMIT 1`,
    args: [merge.id],
  })
  if (existing.rows.length > 0) return
  await migrateShardData(client, merge, true)
}

// Do not combine these probes with UNION ALL. Several community tables are
// partitioned views, and SQLite expands their definitions before enforcing its
// compound-select term limit. Seven bounded statements are still one bulk RPC
// operation, while remaining safe on the largest deployed view expansion.
const MIGRATABLE_SOURCE_ROW_STATEMENTS = [
  `SELECT 1 FROM community_memberships WHERE user_id = ?1 AND status <> 'left' LIMIT 1`,
  `SELECT 1 FROM song_study_review_state WHERE user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM song_study_session WHERE user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM song_study_attempt WHERE user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM song_engagement_days WHERE user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM song_streaks WHERE user_id = ?1 LIMIT 1`,
  `SELECT 1 FROM reward_qualification_outbox WHERE user_id = ?1 LIMIT 1`,
] as const

export async function shardHasMigratableSourceRows(client: Client, sourceUserId: string): Promise<boolean> {
  for (const sql of MIGRATABLE_SOURCE_ROW_STATEMENTS) {
    const result = await client.execute({ sql, args: [sourceUserId] })
    if (result.rows.length > 0) return true
  }
  return false
}

export async function migrateShardResiduals(client: Client, merge: MergeRecord): Promise<void> {
  if (!await shardHasMigratableSourceRows(client, merge.sourceUserId)) return
  await migrateShardData(client, merge, false)
  if (await shardHasMigratableSourceRows(client, merge.sourceUserId)) {
    throw new Error(`Account merge ${merge.id} left migratable source rows in a shard`)
  }
}

async function bulkCommunitiesWithMigratableSourceRows(input: {
  env: Env
  repository: ReturnType<typeof getCommunityRepository>
  communityIds: string[]
  sourceUserId: string
}): Promise<Set<string>> {
  const rowsByCommunity = await bulkCommunityRead(
    input.env,
    input.repository,
    input.communityIds.map((communityId) => ({
      communityId,
      statements: MIGRATABLE_SOURCE_ROW_STATEMENTS.map((sql) => ({ sql, args: [input.sourceUserId] })),
    })),
  )
  return new Set(input.communityIds.filter((communityId) =>
    rowsByCommunity.get(communityId)?.some((result) => result.rows.length > 0),
  ))
}

// Residual repair and its completion gate are read-heavy scans over the whole
// fleet. Keep the writes on each individual shard atomic, but overlap a small
// bounded number of independent shard calls so an operator repair cannot hit
// the Worker request wall while walking a large fleet sequentially.
const RESIDUAL_SCAN_CONCURRENCY = 32

async function forEachCommunityBatch(
  communityIds: string[],
  callback: (communityId: string) => Promise<void>,
): Promise<void> {
  for (let offset = 0; offset < communityIds.length; offset += RESIDUAL_SCAN_CONCURRENCY) {
    const batch = communityIds.slice(offset, offset + RESIDUAL_SCAN_CONCURRENCY)
    await Promise.all(batch.map(callback))
  }
}

async function finalizeControlPlane(input: {
  client: Client
  merge: MergeRecord
  providerSubject: string
  telegramUserId: string
}): Promise<void> {
  const now = nowIso()
  const tx = await input.client.transaction("write")
  try {
    const already = await tx.execute({
      sql: `SELECT 1 FROM user_account_aliases WHERE source_user_id = ?1 AND status = 'active' LIMIT 1`,
      args: [input.merge.sourceUserId],
    })
    if (already.rows.length === 0) {
      const sourceVerified = await activeVerifiedIdentityCount(tx, input.merge.sourceUserId)
      const canonicalVerified = await activeVerifiedIdentityCount(tx, input.merge.canonicalUserId)
      if (sourceVerified > 0 && canonicalVerified > 0) throw mergeConflict("distinct_verified_humans")

      if (sourceVerified > 0) {
        const sourceUser = await tx.execute({
          sql: `
            SELECT verification_state, capability_provider, verification_capabilities_json,
                   verified_at, current_verification_session_id
            FROM users WHERE user_id = ?1 LIMIT 1
          `,
          args: [input.merge.sourceUserId],
        })
        const verification = sourceUser.rows[0]
        if (!verification) throw new Error("Source user disappeared during account merge")
        await tx.execute({
          sql: `UPDATE identity_nullifiers SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1 AND status = 'active'`,
          args: [input.merge.sourceUserId, input.merge.canonicalUserId, now],
        })
        await tx.execute({
          sql: `UPDATE reward_identity_bindings SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1 AND status = 'active'`,
          args: [input.merge.sourceUserId, input.merge.canonicalUserId, now],
        })
        await tx.execute({
          sql: `
            UPDATE users SET
              verification_state = ?2,
              capability_provider = ?3,
              verification_capabilities_json = ?4,
              verified_at = ?5,
              current_verification_session_id = ?6,
              updated_at = ?7
            WHERE user_id = ?1
          `,
          args: [
            input.merge.canonicalUserId,
            rowValue(verification, "verification_state"),
            rowValue(verification, "capability_provider"),
            rowValue(verification, "verification_capabilities_json"),
            rowValue(verification, "verified_at"),
            rowValue(verification, "current_verification_session_id"),
            now,
          ],
        })
      }

      await tx.execute({
        sql: `
          UPDATE reward_pending_qualifications
          SET status = 'ineligible', terminal_reason = 'identity_duplicate', updated_at = ?3
          WHERE user_id = ?1 AND status IN ('pending_verification', 'reconciling')
            AND EXISTS (
              SELECT 1 FROM reward_pending_qualifications target
              WHERE target.user_id = ?2
                AND target.community_id = reward_pending_qualifications.community_id
                AND target.post_id = reward_pending_qualifications.post_id
                AND target.reward_period_key = reward_pending_qualifications.reward_period_key
                AND target.reward_kind = reward_pending_qualifications.reward_kind
                AND target.status IN ('pending_verification', 'reconciling', 'credited')
            )
        `,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, now],
      })
      await tx.execute({
        sql: `
          UPDATE reward_pending_qualifications SET user_id = ?2, updated_at = ?3
          WHERE user_id = ?1 AND status IN ('pending_verification', 'reconciling')
        `,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, now],
      })
      await tx.execute({
        sql: `
          INSERT INTO user_account_aliases (
            source_user_id, canonical_user_id, user_account_merge_id, status,
            activated_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, 'active', ?4, ?4, ?4)
        `,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, input.merge.id, now],
      })
      await tx.execute({
        sql: `
          INSERT INTO reward_ownership_transfers (
            reward_ownership_transfer_id, user_account_merge_id, source_user_id,
            canonical_user_id, effective_at, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
        `,
        args: [makeId("rot"), input.merge.id, input.merge.sourceUserId, input.merge.canonicalUserId, now],
      })

      await tx.execute({
        sql: `UPDATE auth_provider_links SET status = 'revoked', revoked_at = ?2, updated_at = ?2 WHERE user_id = ?1 AND status = 'active' AND NOT (provider = 'telegram' AND provider_subject = ?3)`,
        args: [input.merge.sourceUserId, now, input.providerSubject],
      })
      await tx.execute({
        sql: `UPDATE auth_provider_links SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1 AND provider = 'telegram' AND provider_subject = ?4 AND status = 'active'`,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, now, input.providerSubject],
      })
      await tx.execute({
        sql: `UPDATE telegram_accounts SET user_id = ?2, updated_at = ?3 WHERE telegram_user_id = ?4 AND user_id = ?1`,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, now, input.telegramUserId],
      })
      await tx.execute({
        sql: `UPDATE global_handles SET status = 'retired', replaced_at = ?2, updated_at = ?2 WHERE user_id = ?1 AND status = 'active' AND tier = 'generated' AND issuance_source = 'generated_signup'`,
        args: [input.merge.sourceUserId, now],
      })
      await tx.execute({
        sql: `UPDATE telegram_chat_study_sessions SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1`,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, now],
      })
      await tx.execute({
        sql: `
          INSERT INTO community_membership_projections (
            projection_id, community_id, user_id, membership_state,
            role_summary_json, source_updated_at, created_at, updated_at
          )
          SELECT ?3 || ':' || community_id, community_id, ?2, membership_state,
                 role_summary_json, source_updated_at, created_at, updated_at
          FROM community_membership_projections WHERE user_id = ?1
          ON CONFLICT(community_id, user_id) DO UPDATE SET
            membership_state = CASE
              WHEN community_membership_projections.membership_state = 'member'
                OR excluded.membership_state = 'member' THEN 'member'
              ELSE community_membership_projections.membership_state
            END,
            source_updated_at = CASE
              WHEN community_membership_projections.source_updated_at >= excluded.source_updated_at
                THEN community_membership_projections.source_updated_at
              ELSE excluded.source_updated_at
            END,
            updated_at = CASE
              WHEN community_membership_projections.updated_at >= excluded.updated_at
                THEN community_membership_projections.updated_at
              ELSE excluded.updated_at
            END
        `,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, `cmp_merge_${input.merge.id}`],
      })
      await tx.execute({
        sql: `DELETE FROM community_membership_projections WHERE user_id = ?1`,
        args: [input.merge.sourceUserId],
      })
      await tx.execute({
        sql: `
          INSERT INTO community_follow_projections (
            projection_id, community_id, user_id, follow_state,
            source_updated_at, unfollowed_at, created_at, updated_at
          )
          SELECT ?3 || ':' || community_id, community_id, ?2, follow_state,
                 source_updated_at, unfollowed_at, created_at, updated_at
          FROM community_follow_projections WHERE user_id = ?1
          ON CONFLICT(community_id, user_id) DO UPDATE SET
            follow_state = CASE
              WHEN community_follow_projections.follow_state = 'active'
                OR excluded.follow_state = 'active' THEN 'active'
              ELSE community_follow_projections.follow_state
            END,
            source_updated_at = CASE
              WHEN community_follow_projections.source_updated_at >= excluded.source_updated_at
                THEN community_follow_projections.source_updated_at
              ELSE excluded.source_updated_at
            END,
            unfollowed_at = CASE
              WHEN community_follow_projections.follow_state = 'active'
                OR excluded.follow_state = 'active' THEN NULL
              ELSE community_follow_projections.unfollowed_at
            END,
            updated_at = CASE
              WHEN community_follow_projections.updated_at >= excluded.updated_at
                THEN community_follow_projections.updated_at
              ELSE excluded.updated_at
            END
        `,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId, `cfp_merge_${input.merge.id}`],
      })
      await tx.execute({
        sql: `DELETE FROM community_follow_projections WHERE user_id = ?1`,
        args: [input.merge.sourceUserId],
      })
      await tx.execute({
        sql: `
          INSERT INTO user_study_preferences (
            user_id, helper_language, delivery_mode, created_at, updated_at
          )
          SELECT ?2, helper_language, delivery_mode, created_at, updated_at
          FROM user_study_preferences WHERE user_id = ?1
          ON CONFLICT(user_id) DO NOTHING
        `,
        args: [input.merge.sourceUserId, input.merge.canonicalUserId],
      })
      await tx.execute({
        sql: `DELETE FROM user_study_preferences WHERE user_id = ?1`,
        args: [input.merge.sourceUserId],
      })
    }

    await tx.execute({
      sql: `UPDATE user_account_merges SET status = 'completed', completed_at = ?2, updated_at = ?2 WHERE user_account_merge_id = ?1`,
      args: [input.merge.id, now],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  }
}

export async function mergeTelegramAccountIntoCanonical(input: {
  env: Env
  linkIntentId: string
  sourceUserId: string
  canonicalUserId: string
  providerSubject: string
  telegramUserId: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  let merge = await ensureMergeRecord({
    client,
    linkIntentId: input.linkIntentId,
    sourceUserId: input.sourceUserId,
    canonicalUserId: input.canonicalUserId,
  })
  const repository = getCommunityRepository(input.env)
  const communityIds = (await repository.listActiveCommunities({ requireReadyRouting: true }))
    .map((community) => community.community_id)

  if (merge.status === "migrating") {
    const tx = await client.transaction("write")
    try {
      const blocked = await controlPlaneBlockReason(tx, merge.sourceUserId, merge.canonicalUserId)
      await tx.rollback()
      if (blocked) await markBlocked(client, merge, blocked)
    } catch (error) {
      await tx.rollback().catch(() => undefined)
      throw error
    }

    // Complete a read-only fleet preflight before making the source identity
    // irreversible. Once `finalizing` is committed, authentication resolves
    // the source to the canonical account and failures must resume, not block.
    const blockedByCommunity = await bulkShardBlockReasons({
      env: input.env,
      repository,
      communityIds,
      sourceUserId: merge.sourceUserId,
    })
    for (const communityId of communityIds) {
      const blocked = blockedByCommunity.get(communityId)
      if (blocked) await markBlocked(client, merge, blocked)
    }
    const fencedAt = nowIso()
    await client.execute({
      sql: `
        UPDATE user_account_merges
        SET status = 'finalizing', updated_at = ?2
        WHERE user_account_merge_id = ?1 AND status = 'migrating'
      `,
      args: [merge.id, fencedAt],
    })
    merge = { ...merge, status: "finalizing" }
  }

  // Identify shards that contain source-owned state before opening any
  // per-community write client. Empty communities still receive a
  // control-plane receipt, but spend no Service Binding invocation.
  const sourceCommunities = await bulkCommunitiesWithMigratableSourceRows({
    env: input.env,
    repository,
    communityIds,
    sourceUserId: merge.sourceUserId,
  })

  const now = nowIso()
  const emptyCommunities: string[] = []
  for (const communityId of communityIds) {
    await client.execute({
      sql: `
        INSERT INTO user_account_merge_shards (
          user_account_merge_id, community_id, status, attempt_count, created_at, updated_at
        ) VALUES (?1, ?2, 'pending', 0, ?3, ?3)
        ON CONFLICT(user_account_merge_id, community_id) DO NOTHING
      `,
      args: [merge.id, communityId, now],
    })
    const receipt = await client.execute({
      sql: `
        SELECT status
        FROM user_account_merge_shards
        WHERE user_account_merge_id = ?1 AND community_id = ?2
        LIMIT 1
      `,
      args: [merge.id, communityId],
    })
    if (stringOrNull(rowValue(receipt.rows[0], "status")) === "completed") continue
    if (!sourceCommunities.has(communityId)) {
      emptyCommunities.push(communityId)
      continue
    }
    const db = await openCommunityWriteClient(input.env, repository, communityId)
    try {
      await migrateShard(db.client, merge)
      const completedAt = nowIso()
      await client.execute({
        sql: `
          UPDATE user_account_merge_shards
          SET status = 'completed', attempt_count = attempt_count + 1,
              last_error_code = NULL, completed_at = ?3, updated_at = ?3
          WHERE user_account_merge_id = ?1 AND community_id = ?2
        `,
        args: [merge.id, communityId, completedAt],
      })
    } catch (error) {
      await client.execute({
        sql: `
          UPDATE user_account_merge_shards
          SET status = 'failed', attempt_count = attempt_count + 1,
              last_error_code = ?3, updated_at = ?4
          WHERE user_account_merge_id = ?1 AND community_id = ?2
        `,
        args: [merge.id, communityId, error instanceof Error ? error.message.slice(0, 200) : "unknown", nowIso()],
      })
      throw error
    } finally {
      await db.close()
    }
  }

  if (emptyCommunities.length > 0) {
    await bulkCommunityWrite(
      input.env,
      repository,
      emptyCommunities.map((communityId) => ({
        communityId,
        statements: [{
          sql: `
            INSERT INTO user_account_merge_receipts (
              user_account_merge_id, source_user_id, canonical_user_id, completed_at, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?4)
            ON CONFLICT(user_account_merge_id) DO NOTHING
          `,
          args: [merge.id, merge.sourceUserId, merge.canonicalUserId, now],
        }],
      })),
    )
    for (const communityId of emptyCommunities) {
      const completedAt = nowIso()
      await client.execute({
        sql: `
          UPDATE user_account_merge_shards
          SET status = 'completed', attempt_count = attempt_count + 1,
              last_error_code = NULL, completed_at = ?3, updated_at = ?3
          WHERE user_account_merge_id = ?1 AND community_id = ?2
        `,
        args: [merge.id, communityId, completedAt],
      })
    }
  }

  // Receipts deliberately suppress the original migration on replay. A
  // distinct residual pass captures requests that authenticated immediately
  // before the fence and wrote after their shard's first pass.
  const residualCommunities = await bulkCommunitiesWithMigratableSourceRows({
    env: input.env,
    repository,
    communityIds,
    sourceUserId: merge.sourceUserId,
  })
  await forEachCommunityBatch([...residualCommunities], async (communityId) => {
    const db = await openCommunityWriteClient(input.env, repository, communityId)
    try {
      await migrateShardResiduals(db.client, merge)
    } finally {
      await db.close()
    }
  })

  // Keep completion structurally impossible while any mutable source-owned
  // row remains. This is separate from the migration pass so a faulty no-op
  // residual implementation cannot certify itself.
  const remainingCommunities = await bulkCommunitiesWithMigratableSourceRows({
    env: input.env,
    repository,
    communityIds,
    sourceUserId: merge.sourceUserId,
  })
  if (remainingCommunities.size > 0) {
    throw new Error(`Account merge ${merge.id} cannot complete with migratable source rows`)
  }

  await finalizeControlPlane({
    client,
    merge,
    providerSubject: input.providerSubject,
    telegramUserId: input.telegramUserId,
  })
}
