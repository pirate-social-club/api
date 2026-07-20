import { makeId } from "../helpers"
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
  const period = utcPeriod(input.now)
  const result = await input.client.execute({
    sql: `
      INSERT INTO reward_qualification_outbox (
        event_id, user_id, community_id, post_id, song_artifact_bundle_id,
        activity, qualified_at, reward_period_key, qualification_policy_version,
        evidence_summary_json, created_at
      )
      SELECT ?1, ?2, ?3, ?4, p.song_artifact_bundle_id, ?5, ?6, ?7, ?8, ?9, ?6
      FROM posts p
      WHERE p.post_id = ?4 AND p.song_artifact_bundle_id IS NOT NULL
      ON CONFLICT (user_id, post_id, activity, reward_period_key) DO NOTHING
    `,
    args: [
      makeId("rqo"), input.userId, input.communityId, input.postId,
      input.activity, input.now, period.key, input.policyVersion, JSON.stringify(input.evidence),
    ],
  })
  return (result.rowsAffected ?? 0) > 0
}

export async function emitStudyQualificationIfComplete(input: {
  client: Executor
  communityId: string
  completedExerciseCount: number
  firstPassCorrectCount: number
  now: string
  postId: string
  requiredCorrectCount: number
  sessionId: string
  userId: string
}): Promise<boolean> {
  if (input.completedExerciseCount <= 0
    || input.firstPassCorrectCount < input.requiredCorrectCount) return false
  const period = utcPeriod(input.now)
  const result = await input.client.execute({
    sql: `
      INSERT INTO reward_qualification_outbox (
        event_id, user_id, community_id, post_id, song_artifact_bundle_id,
        activity, qualified_at, reward_period_key, qualification_policy_version,
        evidence_summary_json, created_at
      )
      SELECT
        ?1, ?2, ?3, ?4, p.song_artifact_bundle_id,
        'study', ?5, ?6, 'study_session_first_pass_v2',
        json_object(
          'study_session_id', ?7,
          'completed_exercises', CAST(?8 AS INTEGER),
          'first_pass_correct', CAST(?9 AS INTEGER),
          'required_correct', CAST(?10 AS INTEGER)
        ),
        ?5
      FROM posts p
      WHERE p.post_id = ?4
        AND p.song_artifact_bundle_id IS NOT NULL
      ON CONFLICT (user_id, post_id, activity, reward_period_key) DO NOTHING
    `,
    args: [
      makeId("rqo"), input.userId, input.communityId, input.postId, input.now,
      period.key, input.sessionId, input.completedExerciseCount,
      input.firstPassCorrectCount, input.requiredCorrectCount,
    ],
  })
  return (result.rowsAffected ?? 0) > 0
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
