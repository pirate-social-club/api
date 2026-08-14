import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import type { DbExecutor } from "../src/lib/db-helpers"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/jobs/store"
import {
  computeLyricsLanguageSourceHash,
  hasSufficientLyricsForLanguageDetection,
  LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR,
} from "../src/lib/localization/lyrics-language-detection-materializer"
import { lyricsLanguageConfidenceFloor } from "../src/lib/localization/lyrics-language-detection-provider"
import { hasStudyClozeSchema, hasStudyLyricsLanguageSchema } from "../src/lib/posts/post-study-cloze-service"
import { decodePublicCommunityId } from "../src/lib/public-ids"
import { nowIso } from "../src/lib/helpers"
import { withRequestControlPlaneClients } from "../src/lib/runtime-deps"

// Despite the historical script name, this pass intentionally materializes only
// the lyrics-language family used by Study fill-blank. Post title/body/caption
// language remains a separate provenance domain and is never used here.

type Candidate = {
  post_id: string
  post_type: string
  lyrics: string | null
  lyrics_language: string | null
  lyrics_language_confidence: number | null
  lyrics_language_reliable: boolean
  lyrics_language_detector: string | null
  lyrics_language_source_hash: string | null
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index < 0 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function positiveLimit(): number | null {
  const value = Number(arg("--limit") ?? "")
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function listCandidates(client: Pick<DbExecutor, "execute">, limit: number | null): Promise<Candidate[]> {
  const result = await client.execute({
    sql: `
      SELECT post_id, post_type, lyrics, lyrics_language, lyrics_language_confidence,
             lyrics_language_reliable, lyrics_language_detector, lyrics_language_source_hash
      FROM posts
      WHERE post_type = 'song'
        AND lyrics IS NOT NULL
        AND trim(lyrics) <> ''
      ORDER BY created_at ASC, post_id ASC
      ${limit ? `LIMIT ${limit}` : ""}
    `,
  })
  return result.rows.map((row) => {
    const value = row as Record<string, unknown>
    return {
      lyrics: stringOrNull(value.lyrics),
      lyrics_language: stringOrNull(value.lyrics_language),
      lyrics_language_confidence: typeof value.lyrics_language_confidence === "number"
        ? value.lyrics_language_confidence
        : null,
      lyrics_language_reliable: Number(value.lyrics_language_reliable ?? 0) === 1,
      lyrics_language_detector: stringOrNull(value.lyrics_language_detector),
      lyrics_language_source_hash: stringOrNull(value.lyrics_language_source_hash),
      post_id: String(value.post_id ?? ""),
      post_type: String(value.post_type ?? ""),
    }
  }).filter((candidate) => candidate.post_id && candidate.post_type === "song" && candidate.lyrics)
}

async function backfillCommunity(input: {
  communityId: string
  dryRun: boolean
  cleanup: boolean
  env: Env
  repository: ReturnType<typeof getCommunityRepository>
  limit: number | null
}): Promise<{
  candidates: number
  enqueued: number
  unchanged: number
  cleaned: number
  orphanReviewStates: number
  shortLyrics: number
  languages: Record<string, number>
  confidenceBuckets: Record<string, number>
  skipped: string
}> {
  const db = await openCommunityDb(input.env, input.repository, input.communityId)
  try {
    const lyricsLanguageSchemaReady = await hasStudyLyricsLanguageSchema(db.client)
    if (!lyricsLanguageSchemaReady) {
      return {
        candidates: 0,
        enqueued: 0,
        unchanged: 0,
        cleaned: 0,
        orphanReviewStates: 0,
        shortLyrics: 0,
        languages: {},
        confidenceBuckets: {},
        skipped: "missing_1143",
      }
    }
    const candidates = await listCandidates(db.client, input.limit)
    let enqueued = 0
    let unchanged = 0
    let shortLyrics = 0
    const languages: Record<string, number> = {}
    const confidenceBuckets: Record<string, number> = {}
    const confidenceFloor = lyricsLanguageConfidenceFloor(input.env)
    for (const candidate of candidates) {
      const sufficient = hasSufficientLyricsForLanguageDetection(candidate.lyrics ?? "", input.env)
      if (!sufficient) shortLyrics += 1
      const language = candidate.lyrics_language ?? "<none>"
      languages[language] = (languages[language] ?? 0) + 1
      const confidence = candidate.lyrics_language_confidence
      const confidenceBucket = confidence === null
        ? "none"
        : confidence < confidenceFloor ? `<${confidenceFloor.toFixed(2)}`
          : confidence < 0.9 ? `${confidenceFloor.toFixed(2)}-0.89`
            : "0.90-1.00"
      confidenceBuckets[confidenceBucket] = (confidenceBuckets[confidenceBucket] ?? 0) + 1
      const sourceHash = await computeLyricsLanguageSourceHash(candidate.lyrics)
      const shortPolicyApplied = candidate.lyrics_language_detector === LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR
      if (!sourceHash || candidate.lyrics_language_source_hash !== sourceHash || !candidate.lyrics_language_detector
        || (!sufficient && !shortPolicyApplied)) {
        if (!input.dryRun) {
          await enqueueCommunityJob({
            client: db.client,
            communityId: input.communityId,
            jobType: "post_lyrics_language_detection_materialize",
            subjectType: "post_lyrics_language_detection",
            subjectId: `${candidate.post_id}:${sourceHash}`,
            payloadJson: JSON.stringify({ post_id: candidate.post_id, source_hash: sourceHash }),
            createdAt: nowIso(),
            reuseTerminalFailure: true,
          })
        }
        enqueued += 1
      } else {
        unchanged += 1
      }
    }

    let cleaned = 0
    if (input.cleanup && await hasStudyClozeSchema(db.client) && lyricsLanguageSchemaReady) {
      if (input.dryRun) {
        const rows = await db.client.execute({
          sql: `
            SELECT COUNT(*) AS count
            FROM song_study_unit_cloze c
            JOIN song_study_unit u ON u.id = c.unit_id
            JOIN posts p ON p.post_id = u.post_id
            WHERE p.post_type = 'song' AND p.lyrics_language_reliable <> 1
          `,
        })
        cleaned = Number((rows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0)
      } else {
        const result = await db.client.execute({
          sql: `
            DELETE FROM song_study_unit_cloze
            WHERE unit_id IN (
              SELECT u.id
              FROM song_study_unit u
              JOIN posts p ON p.post_id = u.post_id
              WHERE p.post_type = 'song' AND p.lyrics_language_reliable <> 1
            )
          `,
        })
        cleaned = Number(result.rowsAffected ?? 0)
      }
    }
    const orphanRows = await db.client.execute({
      sql: "SELECT COUNT(*) AS count FROM song_study_review_state WHERE exercise_type = 'fill_blank'",
    }).catch(() => ({ rows: [{ count: 0 }] }))
    const orphanReviewStates = Number((orphanRows.rows[0] as Record<string, unknown> | undefined)?.count ?? 0)
    return {
      candidates: candidates.length,
      confidenceBuckets,
      enqueued,
      languages,
      unchanged,
      cleaned,
      orphanReviewStates,
      shortLyrics,
      skipped: "",
    }
  } finally {
    db.close()
  }
}

async function run(env: Env): Promise<void> {
  const dryRun = !hasFlag("--execute")
  const cleanup = hasFlag("--cleanup-stale-cloze")
  const communityArg = arg("--community-id")
  const repository = getCommunityRepository(env)
  const communities = communityArg
    ? [{ community_id: communityArg.startsWith("cmt_") ? communityArg : decodePublicCommunityId(communityArg) }]
    : await repository.listActiveCommunities()
  let totals = {
    candidates: 0,
    enqueued: 0,
    unchanged: 0,
    cleaned: 0,
    orphanReviewStates: 0,
    shortLyrics: 0,
    languages: {} as Record<string, number>,
    confidenceBuckets: {} as Record<string, number>,
  }
  for (const community of communities) {
    const result = await backfillCommunity({
      communityId: community.community_id,
      cleanup,
      dryRun,
      env,
      limit: positiveLimit(),
      repository,
    })
    totals = {
      candidates: totals.candidates + result.candidates,
      enqueued: totals.enqueued + result.enqueued,
      unchanged: totals.unchanged + result.unchanged,
      cleaned: totals.cleaned + result.cleaned,
      orphanReviewStates: totals.orphanReviewStates + result.orphanReviewStates,
      shortLyrics: totals.shortLyrics + result.shortLyrics,
      languages: mergeCounts(totals.languages, result.languages),
      confidenceBuckets: mergeCounts(totals.confidenceBuckets, result.confidenceBuckets),
    }
    console.log(`${community.community_id}: candidates=${result.candidates} ${dryRun ? "would_enqueue" : "enqueued"}=${result.enqueued} unchanged=${result.unchanged} short=${result.shortLyrics} orphan_fill_blank_review_state=${result.orphanReviewStates} languages=${JSON.stringify(result.languages)} confidence=${JSON.stringify(result.confidenceBuckets)} ${cleanup ? `${dryRun ? "would_clean" : "cleaned"}=${result.cleaned}` : ""} ${result.skipped ? `skipped=${result.skipped}` : ""}`)
  }
  await repository.close?.()
  console.log(`summary: mode=${dryRun ? "dry-run" : "execute"} communities=${communities.length} candidates=${totals.candidates} ${dryRun ? "would_enqueue" : "enqueued"}=${totals.enqueued} unchanged=${totals.unchanged} short=${totals.shortLyrics} orphan_fill_blank_review_state=${totals.orphanReviewStates} languages=${JSON.stringify(totals.languages)} confidence=${JSON.stringify(totals.confidenceBuckets)} ${cleanup ? `${dryRun ? "would_clean" : "cleaned"}=${totals.cleaned}` : ""}`)
}

function mergeCounts(left: Record<string, number>, right: Record<string, number>): Record<string, number> {
  const merged = { ...left }
  for (const [key, value] of Object.entries(right)) merged[key] = (merged[key] ?? 0) + value
  return merged
}

const env = { ...readDevVarsFromCwd(), ...process.env } as unknown as Env
withRequestControlPlaneClients(() => run(env)).catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
