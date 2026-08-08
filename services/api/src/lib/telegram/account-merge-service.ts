import type { Env } from "../../env"
import { codedConflictError } from "../errors"
import { getCommunityRepository } from "../communities/db-community-repository"
import { openCommunityWriteClient } from "../communities/community-read-access"
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
  const [sourceVerified, canonicalVerified] = await Promise.all([
    activeVerifiedIdentityCount(tx, sourceUserId),
    activeVerifiedIdentityCount(tx, canonicalUserId),
  ])
  if (sourceVerified > 0 && canonicalVerified > 0) return "distinct_verified_humans"

  const authority = await tx.execute({
    sql: `SELECT 1 FROM communities WHERE creator_user_id = ?1 LIMIT 1`,
    args: [sourceUserId],
  })
  if (authority.rows.length > 0) return "community_authority"

  const authored = await tx.execute({
    sql: `
      SELECT 1 FROM (
        SELECT author_user_id FROM community_post_projections
        UNION ALL
        SELECT author_user_id FROM community_comment_projections
      ) authored
      WHERE author_user_id = ?1
      LIMIT 1
    `,
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

async function shardBlockReason(client: Client, sourceUserId: string): Promise<AccountMergeBlockReason | null> {
  const result = await client.execute({
    sql: `
      SELECT reason FROM (
        SELECT 'community_authority' AS reason, 1 AS priority
        FROM community_roles
        WHERE user_id = ?1 AND status = 'active' AND role IN ('owner', 'admin', 'moderator')
        UNION ALL
        SELECT 'community_authority', 1 FROM communities WHERE created_by_user_id = ?1
        UNION ALL
        SELECT 'authored_content', 2 FROM posts WHERE author_user_id = ?1
        UNION ALL
        SELECT 'authored_content', 2 FROM comments WHERE author_user_id = ?1
        UNION ALL
        SELECT 'purchase_activity', 3 FROM purchases WHERE buyer_user_id = ?1
        UNION ALL
        SELECT 'booking_activity', 4 FROM bookings
        WHERE host_user_id = ?1 OR booker_user_id = ?1
      ) blocked
      ORDER BY priority ASC
      LIMIT 1
    `,
    args: [sourceUserId],
  })
  return stringOrNull(rowValue(result.rows[0], "reason")) as AccountMergeBlockReason | null
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

async function mergeMembership(tx: Transaction, sourceUserId: string, canonicalUserId: string, now: string): Promise<void> {
  const memberships = await tx.execute({
    sql: `SELECT membership_id, user_id, status FROM community_memberships WHERE user_id IN (?1, ?2)`,
    args: [sourceUserId, canonicalUserId],
  })
  const source = memberships.rows.find((row) => String(rowValue(row, "user_id")) === sourceUserId)
  if (!source) return
  const targetMember = memberships.rows.some((row) =>
    String(rowValue(row, "user_id")) === canonicalUserId && String(rowValue(row, "status")) === "member")
  if (targetMember) {
    await tx.execute({
      sql: `UPDATE community_memberships SET status = 'left', left_at = ?2, updated_at = ?2 WHERE membership_id = ?1`,
      args: [requiredString(source, "membership_id"), now],
    })
  } else {
    await tx.execute({
      sql: `UPDATE community_memberships SET user_id = ?2, updated_at = ?3 WHERE user_id = ?1`,
      args: [sourceUserId, canonicalUserId, now],
    })
  }
}

async function renumberAndMoveAttempts(
  tx: Transaction,
  mergeId: string,
  sourceUserId: string,
  canonicalUserId: string,
): Promise<void> {
  const attempts = await tx.execute({
    sql: `
      SELECT id, exercise_id FROM song_study_attempt
      WHERE user_id = ?1 ORDER BY exercise_id, created_at, id
    `,
    args: [sourceUserId],
  })
  const nextByExercise = new Map<string, number>()
  for (const row of attempts.rows) {
    const exerciseId = requiredString(row, "exercise_id")
    if (!nextByExercise.has(exerciseId)) {
      const maximum = await tx.execute({
        sql: `SELECT COALESCE(MAX(attempt_number), 0) AS value FROM song_study_attempt WHERE user_id = ?1 AND exercise_id = ?2`,
        args: [canonicalUserId, exerciseId],
      })
      nextByExercise.set(exerciseId, requiredNumber(maximum.rows[0], "value") + 1)
    }
    const id = requiredString(row, "id")
    const attemptNumber = nextByExercise.get(exerciseId)!
    nextByExercise.set(exerciseId, attemptNumber + 1)
    await tx.execute({
      sql: `
        UPDATE song_study_attempt
        SET user_id = ?2, attempt_number = ?3, idempotency_key = ?4
        WHERE id = ?1
      `,
      args: [id, canonicalUserId, attemptNumber, `merge:${mergeId}:${id}`],
    })
  }
}

async function recomputeStreaks(tx: Transaction, canonicalUserId: string, now: string): Promise<void> {
  const rows = await tx.execute({
    sql: `
      SELECT post_id, community_id, activity_date
      FROM song_engagement_days
      WHERE user_id = ?1
      ORDER BY post_id, activity_date
    `,
    args: [canonicalUserId],
  })
  const byPost = new Map<string, { communityId: string; dates: string[] }>()
  for (const row of rows.rows) {
    const postId = requiredString(row, "post_id")
    const entry = byPost.get(postId) ?? { communityId: requiredString(row, "community_id"), dates: [] }
    entry.dates.push(requiredString(row, "activity_date"))
    byPost.set(postId, entry)
  }
  await tx.execute({ sql: `DELETE FROM song_streaks WHERE user_id = ?1`, args: [canonicalUserId] })
  for (const [postId, entry] of byPost) {
    let best = entry.dates.length > 0 ? 1 : 0
    let run = best
    let runStart = entry.dates[0]
    let bestRunStart = runStart
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
        bestRunStart = runStart
      }
    }
    await tx.execute({
      sql: `
        INSERT INTO song_streaks (
          user_id, post_id, community_id, current_streak, best_streak,
          last_qualified_date, streak_started_date, total_qualified_days,
          created_at, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
      `,
      args: [
        canonicalUserId, postId, entry.communityId, run, best,
        entry.dates.at(-1), bestRunStart, entry.dates.length, now,
      ],
    })
  }
}

async function migrateShard(client: Client, merge: MergeRecord): Promise<void> {
  const existing = await client.execute({
    sql: `SELECT 1 FROM user_account_merge_receipts WHERE user_account_merge_id = ?1 LIMIT 1`,
    args: [merge.id],
  })
  if (existing.rows.length > 0) return

  const now = nowIso()
  const tx = await client.transaction("write")
  try {
    await mergeMembership(tx, merge.sourceUserId, merge.canonicalUserId, now)

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
    await renumberAndMoveAttempts(tx, merge.id, merge.sourceUserId, merge.canonicalUserId)

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
    await tx.execute({ sql: `DELETE FROM song_streaks WHERE user_id = ?1`, args: [merge.sourceUserId] })
    await recomputeStreaks(tx, merge.canonicalUserId, now)

    await tx.execute({
      sql: `
        DELETE FROM reward_qualification_outbox AS source
        WHERE source.user_id = ?1 AND EXISTS (
          SELECT 1 FROM reward_qualification_outbox target
          WHERE target.user_id = ?2
            AND target.post_id = source.post_id
            AND target.activity = source.activity
            AND target.reward_period_key = source.reward_period_key
        )
      `,
      args: [merge.sourceUserId, merge.canonicalUserId],
    })
    await tx.execute({
      sql: `UPDATE reward_qualification_outbox SET user_id = ?2 WHERE user_id = ?1`,
      args: [merge.sourceUserId, merge.canonicalUserId],
    })
    await tx.execute({
      sql: `
        INSERT INTO user_account_merge_receipts (
          user_account_merge_id, source_user_id, canonical_user_id, completed_at, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?4)
      `,
      args: [merge.id, merge.sourceUserId, merge.canonicalUserId, now],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
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
      const [sourceVerified, canonicalVerified] = await Promise.all([
        activeVerifiedIdentityCount(tx, input.merge.sourceUserId),
        activeVerifiedIdentityCount(tx, input.merge.canonicalUserId),
      ])
      if (sourceVerified > 0 && canonicalVerified > 0) throw mergeConflict("distinct_verified_humans")

      if (sourceVerified > 0) {
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
            UPDATE users target SET
              verification_state = source.verification_state,
              capability_provider = source.capability_provider,
              verification_capabilities_json = source.verification_capabilities_json,
              verified_at = source.verified_at,
              current_verification_session_id = source.current_verification_session_id,
              updated_at = ?3
            FROM users source
            WHERE target.user_id = ?2 AND source.user_id = ?1
          `,
          args: [input.merge.sourceUserId, input.merge.canonicalUserId, now],
        })
      }

      await tx.execute({
        sql: `
          UPDATE reward_pending_qualifications source
          SET status = 'ineligible', terminal_reason = 'identity_duplicate', updated_at = ?3
          WHERE source.user_id = ?1 AND source.status IN ('pending_verification', 'reconciling')
            AND EXISTS (
              SELECT 1 FROM reward_pending_qualifications target
              WHERE target.user_id = ?2
                AND target.community_id = source.community_id
                AND target.post_id = source.post_id
                AND target.reward_period_key = source.reward_period_key
                AND target.reward_kind = source.reward_kind
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
            source_updated_at = GREATEST(
              community_membership_projections.source_updated_at,
              excluded.source_updated_at
            ),
            updated_at = GREATEST(
              community_membership_projections.updated_at,
              excluded.updated_at
            )
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
            source_updated_at = GREATEST(
              community_follow_projections.source_updated_at,
              excluded.source_updated_at
            ),
            unfollowed_at = CASE
              WHEN community_follow_projections.follow_state = 'active'
                OR excluded.follow_state = 'active' THEN NULL
              ELSE community_follow_projections.unfollowed_at
            END,
            updated_at = GREATEST(
              community_follow_projections.updated_at,
              excluded.updated_at
            )
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
  const merge = await ensureMergeRecord({
    client,
    linkIntentId: input.linkIntentId,
    sourceUserId: input.sourceUserId,
    canonicalUserId: input.canonicalUserId,
  })
  if (merge.status === "completed") return

  const tx = await client.transaction("write")
  try {
    const blocked = await controlPlaneBlockReason(tx, merge.sourceUserId, merge.canonicalUserId)
    await tx.rollback()
    if (blocked) await markBlocked(client, merge, blocked)
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  }

  const repository = getCommunityRepository(input.env)
  const communityIds = (await repository.listActiveCommunities({ requireReadyRouting: true }))
    .map((community) => community.community_id)

  // Complete a read-only fleet preflight before mutating any shard.
  for (const communityId of communityIds) {
    const db = await openCommunityWriteClient(input.env, repository, communityId)
    try {
      const blocked = await shardBlockReason(db.client, merge.sourceUserId)
      if (blocked) await markBlocked(client, merge, blocked)
    } finally {
      await db.close()
    }
  }

  const now = nowIso()
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

  await finalizeControlPlane({
    client,
    merge,
    providerSubject: input.providerSubject,
    telegramUserId: input.telegramUserId,
  })
}
