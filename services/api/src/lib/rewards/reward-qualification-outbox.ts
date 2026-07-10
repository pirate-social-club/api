import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { rowValue, stringOrNull } from "../sql-row"
import type { InStatement, QueryResult } from "../sql-client"

type Executor = { execute(statement: InStatement | string): Promise<QueryResult> }

function utcPeriod(now: string): { key: string; start: string; end: string } {
  const millis = Date.parse(now)
  if (!Number.isFinite(millis)) throw new Error("Reward qualification timestamp is invalid")
  const key = new Date(millis).toISOString().slice(0, 10)
  const start = `${key}T00:00:00.000Z`
  const end = new Date(Date.parse(start) + 86_400_000).toISOString()
  return { key, start, end }
}

async function songArtifactBundleId(client: Executor, postId: string): Promise<string | null> {
  const row = await executeFirst(client, {
    sql: "SELECT song_artifact_bundle_id FROM posts WHERE post_id = ?1 LIMIT 1",
    args: [postId],
  })
  return stringOrNull(rowValue(row, "song_artifact_bundle_id"))
}

async function emit(input: {
  activity: "study" | "karaoke"
  client: Executor
  communityId: string
  evidence: Record<string, unknown>
  now: string
  policyVersion: string
  postId: string
  userId: string
}): Promise<boolean> {
  const artifactBundleId = await songArtifactBundleId(input.client, input.postId)
  if (!artifactBundleId) return false
  const period = utcPeriod(input.now)
  const result = await input.client.execute({
    sql: `
      INSERT INTO reward_qualification_outbox (
        event_id, user_id, community_id, post_id, song_artifact_bundle_id,
        activity, qualified_at, reward_period_key, qualification_policy_version,
        evidence_summary_json, created_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?7)
      ON CONFLICT (user_id, post_id, activity, reward_period_key) DO NOTHING
    `,
    args: [
      makeId("rqo"), input.userId, input.communityId, input.postId, artifactBundleId,
      input.activity, input.now, period.key, input.policyVersion, JSON.stringify(input.evidence),
    ],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function emitStudyQualificationIfComplete(input: {
  client: Executor
  communityId: string
  now: string
  postId: string
  targetCount: number
  userId: string
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.targetCount) || input.targetCount <= 0) return false
  const period = utcPeriod(input.now)
  const row = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(DISTINCT exercise_id) AS completed_exercises
      FROM song_study_attempt
      WHERE user_id = ?1 AND post_id = ?2 AND created_at >= ?3 AND created_at < ?4
    `,
    args: [input.userId, input.postId, period.start, period.end],
  })
  const completedExercises = Number(rowValue(row, "completed_exercises") ?? 0)
  if (!Number.isSafeInteger(completedExercises) || completedExercises < input.targetCount) return false
  return emit({
    activity: "study",
    client: input.client,
    communityId: input.communityId,
    evidence: { completed_exercises: completedExercises, target_exercises: input.targetCount },
    now: input.now,
    policyVersion: "study_completed_distinct_set_v1",
    postId: input.postId,
    userId: input.userId,
  })
}

export async function emitKaraokeQualification(input: {
  attemptId: string
  client: Executor
  communityId: string
  finalScoreBps: number
  karaokeRevisionId: string
  now: string
  postId: string
  scoringVersion: number
  sessionId: string
  userId: string
}): Promise<boolean> {
  return emit({
    activity: "karaoke",
    client: input.client,
    communityId: input.communityId,
    evidence: {
      attempt_id: input.attemptId,
      final_score_bps: input.finalScoreBps,
      karaoke_revision_id: input.karaokeRevisionId,
      scoring_version: input.scoringVersion,
      session_id: input.sessionId,
    },
    now: input.now,
    policyVersion: "karaoke_rank_eligible_v1",
    postId: input.postId,
    userId: input.userId,
  })
}
