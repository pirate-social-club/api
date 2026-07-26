// Phase 1 of docs/video-feed-ranking-spec.md.
//
// Ranking for the vertical video feed. This module is pure and synchronous: no
// I/O, no clock, no environment. That is deliberate and load-bearing. Ordering
// previously lived in a SQL ORDER BY that had to be portable across the
// Postgres and D1/libsql control-plane runtimes, and the recency term was
// deleted outright when D1 rejected its date arithmetic
// (home-feed-service.ts:195-198). Keeping scoring out of the query plan makes
// that class of regression impossible and makes the scorer unit-testable.
//
// Nothing here may import from the serving path; the dependency points one way.

export const VIDEO_SCORER_VERSION = "v1"

export type VideoDurationBucket = "lt_10s" | "10_30s" | "30_60s" | "gt_60s"

/**
 * Behavioral aggregates for one post. Null until Phase 2 lands the Tinybird
 * feature sync; every consumer must treat absence as "no evidence", not as
 * "zero engagement".
 */
export type VideoCandidateStats = {
  validImpressions: number
  validPlays: number
  completions: number
  longWatches: number
  replays: number
  fastSkips: number
}

export type VideoCandidateInput = {
  postId: string
  communityId: string
  authorUserId: string | null
  createdAtMs: number
  durationSeconds: number | null
  upvotes: number
  comments: number
  stats: VideoCandidateStats | null
}

/**
 * Every field is in [0,1]. This is a hard contract, not a convention: the
 * feature vector is logged per impression and compared across scorer versions,
 * so an unbounded field silently changes the meaning of every historical
 * comparison. `explicit` is the one feature whose natural form is unbounded —
 * see `explicitEngagement` below.
 */
export type VideoScorerFeatures = {
  completion: number
  longWatch: number
  replay: number
  negative: number
  explicit: number
  freshness: number
  uncertainty: number
}

export type ScoredVideoCandidate = {
  candidate: VideoCandidateInput
  score: number
  features: VideoScorerFeatures
}

const WEIGHT_COMPLETION = 0.45
const WEIGHT_LONG_WATCH = 0.30
const WEIGHT_REPLAY = 0.15
const WEIGHT_EXPLICIT = 0.10
const WEIGHT_NEGATIVE = 0.45

// Additive and bounded, never multiplicative. A multiplicative decay term such
// as the surviving `(score + 1) / (age + 2)^1.5` drives evergreen content
// asymptotically to zero no matter how good it is; a bounded bonus expresses
// "new things get a leg up" without also expressing "old things are worthless".
const FRESHNESS_MAX = 0.15
const FRESHNESS_TAU_HOURS = 24

// Subsidises under-measured items. Tune this together with the exposure floor
// in the selector: they encode the same incentive, once in the score and once
// as a constraint, so raising both at once compounds.
const UNCERTAINTY_MAX = 0.10
const UNCERTAINTY_K = 50

// Beta prior strength for every smoothed rate, in units of pseudo-observations.
const PRIOR_WEIGHT = 20

// Half-saturation constant for `explicit`: the engagement-per-impression ratio
// that maps to 0.5. Calibrate from the global median once Phase 2 supplies real
// impression denominators; changing it is a VIDEO_SCORER_VERSION bump.
const EXPLICIT_SATURATION_K = 0.5

/**
 * Shrinkage targets per duration bucket.
 *
 * Phase 1 seeds every bucket with the SAME value on purpose. Completion is
 * strongly duration-dependent, so per-bucket targets are the right long-term
 * shape — but with no observations yet, every posterior collapses onto its
 * prior, and differing priors would rank short videos above long ones purely
 * for being short. That is exactly the bias the buckets exist to remove. Phase
 * 2 replaces these with measured per-bucket means, at which point the structure
 * is already in place and the change is a constants edit.
 */
const COMPLETION_PRIOR: Record<VideoDurationBucket, number> = {
  lt_10s: 0.30,
  "10_30s": 0.30,
  "30_60s": 0.30,
  gt_60s: 0.30,
}

const LONG_WATCH_PRIOR: Record<VideoDurationBucket, number> = {
  lt_10s: 0.35,
  "10_30s": 0.35,
  "30_60s": 0.35,
  gt_60s: 0.35,
}

const REPLAY_PRIOR = 0.06
const NEGATIVE_PRIOR = 0.35

export function videoDurationBucket(durationSeconds: number | null): VideoDurationBucket {
  // Unknown duration takes the short-form bucket rather than a bucket of its
  // own: it is the modal case for this surface, and an unknown-duration bucket
  // would become a dumping ground whose prior means nothing.
  if (durationSeconds == null || !Number.isFinite(durationSeconds)) return "10_30s"
  if (durationSeconds < 10) return "lt_10s"
  if (durationSeconds < 30) return "10_30s"
  if (durationSeconds < 60) return "30_60s"
  return "gt_60s"
}

/**
 * Beta-smoothed rate. Counts are never used directly: a count rewards traffic,
 * and traffic is a function of past ranking, which is the loop that ossifies a
 * feed.
 */
export function posteriorRate(
  successes: number,
  trials: number,
  priorMean: number,
  priorWeight: number = PRIOR_WEIGHT,
): number {
  const safeTrials = Math.max(0, trials)
  const safeSuccesses = Math.min(Math.max(0, successes), safeTrials)
  return (safeSuccesses + priorMean * priorWeight) / (safeTrials + priorWeight)
}

/**
 * Votes and comments are read from the projection counters and are not
 * impression-attributed, so no denominator bounds them: a posterior rate here
 * can exceed 1 whenever engagement outruns impressions. Saturating the raw
 * ratio maps [0, inf) to [0, 1) monotonically instead.
 *
 * Clamping to 1 was rejected — it discards ordering among exactly the
 * most-engaged items in the corpus, the opposite of what the term is for.
 */
export function explicitEngagement(input: {
  upvotes: number
  comments: number
  validImpressions: number
}): number {
  const points = Math.max(0, input.upvotes) + 2 * Math.max(0, input.comments)
  const ratio = points / (Math.max(0, input.validImpressions) + PRIOR_WEIGHT)
  return ratio / (ratio + EXPLICIT_SATURATION_K)
}

export function freshnessBonus(ageHours: number): number {
  return FRESHNESS_MAX * Math.exp(-Math.max(0, ageHours) / FRESHNESS_TAU_HOURS)
}

export function uncertaintyBonus(validImpressions: number): number {
  const impressions = Math.max(0, validImpressions)
  return UNCERTAINTY_MAX * (1 - impressions / (impressions + UNCERTAINTY_K))
}

export function videoScorerFeatures(
  candidate: VideoCandidateInput,
  nowMs: number,
): VideoScorerFeatures {
  const bucket = videoDurationBucket(candidate.durationSeconds)
  const stats = candidate.stats
  const validPlays = stats?.validPlays ?? 0
  const validImpressions = stats?.validImpressions ?? 0
  const ageHours = Math.max(0, (nowMs - candidate.createdAtMs) / 3_600_000)

  return {
    completion: posteriorRate(stats?.completions ?? 0, validPlays, COMPLETION_PRIOR[bucket]),
    longWatch: posteriorRate(stats?.longWatches ?? 0, validPlays, LONG_WATCH_PRIOR[bucket]),
    replay: posteriorRate(stats?.replays ?? 0, validPlays, REPLAY_PRIOR),
    negative: posteriorRate(stats?.fastSkips ?? 0, validImpressions, NEGATIVE_PRIOR),
    explicit: explicitEngagement({
      comments: candidate.comments,
      upvotes: candidate.upvotes,
      validImpressions,
    }),
    freshness: freshnessBonus(ageHours) / FRESHNESS_MAX,
    uncertainty: uncertaintyBonus(validImpressions) / UNCERTAINTY_MAX,
  }
}

/**
 * Until Phase 2 supplies behavioral denominators every candidate carries
 * `stats: null`, so completion/longWatch/replay/negative all collapse onto
 * their shared priors and contribute an identical constant to every score.
 * Ranking in Phase 1 is therefore driven by `explicit` and `freshness` — which
 * is precisely the decayed-engagement ordering this phase is meant to deliver.
 * The behavioral terms start discriminating on their own the moment real
 * denominators arrive, with no interface change.
 */
export function scoreVideoCandidate(
  candidate: VideoCandidateInput,
  nowMs: number,
): ScoredVideoCandidate {
  const features = videoScorerFeatures(candidate, nowMs)
  const quality = WEIGHT_COMPLETION * features.completion
    + WEIGHT_LONG_WATCH * features.longWatch
    + WEIGHT_REPLAY * features.replay
    + WEIGHT_EXPLICIT * features.explicit
    - WEIGHT_NEGATIVE * features.negative
  const score = quality
    + FRESHNESS_MAX * features.freshness
    + UNCERTAINTY_MAX * features.uncertainty
  return { candidate, features, score }
}

export function scoreVideoCandidates(
  candidates: readonly VideoCandidateInput[],
  nowMs: number,
): ScoredVideoCandidate[] {
  return candidates
    .map((candidate) => scoreVideoCandidate(candidate, nowMs))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      // Total order, so a page is reproducible for a fixed candidate set and
      // clock even when scores tie exactly.
      if (right.candidate.createdAtMs !== left.candidate.createdAtMs) {
        return right.candidate.createdAtMs - left.candidate.createdAtMs
      }
      return right.candidate.postId.localeCompare(left.candidate.postId)
    })
}
