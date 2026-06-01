import { readDevVarsFromCwd } from "./_lib/dev-vars"
import type { Env } from "../src/env"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob, type CommunityJobType } from "../src/lib/communities/jobs/store"
import { CONTENT_TRANSLATION_PREWARM_LOCALES, DEFAULT_CONTENT_LOCALE } from "../src/lib/localization/content-locale"
import { decodePublicCommunityId } from "../src/lib/public-ids"
import { nowIso } from "../src/lib/helpers"
import type { DbExecutor } from "../src/lib/db-helpers"

type BackfillStats = {
  communities: number
  skippedMissingColumns: number
  postDetectionCandidates: number
  postDetectionJobs: number
  commentDetectionCandidates: number
  commentDetectionJobs: number
  communityTextDetectionCandidates: number
  communityTextDetectionJobs: number
  postRepairCandidates: number
  postRepairJobs: number
  commentRepairCandidates: number
  commentRepairJobs: number
  communityTextRepairCandidates: number
  communityTextRepairJobs: number
  failed: number
}

type ScriptOptions = {
  dryRun: boolean
  communityId: string | null
  limit: number | null
  detection: boolean
  repairTranslations: boolean
  repairDetectedSince: string | null
}

type Candidate = {
  id: string
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function parsePositiveInt(value: string | null): number | null {
  if (!value) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseCommunityId(value: string | null): string | null {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return null
  return trimmed.startsWith("cmt_") ? trimmed : decodePublicCommunityId(trimmed)
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/backfill-source-language-detection.ts [--execute] [--community-id ID] [--limit N] [--repair-translations] [--repair-detected-since ISO]

Dry-run is the default. The first pass enqueues provider-backed source-language detection jobs for
posts/comments whose canonical language is not reliable yet, plus a default-locale community text
materialization job when community text metadata is still unreliable.

Use --repair-translations after detection jobs have run to enqueue translation materialization jobs
for provider-detected content and community text. This intentionally does not delete existing
content_translations rows; materializers reconcile same-language sentinels and stale translations.
`)
}

async function tableHasColumns(input: {
  client: DbExecutor
  tableName: string
  columns: string[]
}): Promise<boolean> {
  const result = await input.client.execute(`PRAGMA table_info(${input.tableName})`)
  const names = new Set(result.rows.map((row) => String(row.name ?? "")))
  return input.columns.every((column) => names.has(column))
}

function limitClause(limit: number | null): string {
  return limit ? `LIMIT ${limit}` : ""
}

async function listPostDetectionCandidates(client: DbExecutor, limit: number | null): Promise<Candidate[]> {
  const result = await client.execute({
    sql: `
      SELECT post_id AS id
      FROM posts
      WHERE status = 'published'
        AND (
          COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(body), ''), NULLIF(TRIM(caption), '')) IS NOT NULL
        )
        AND COALESCE(source_language_reliable, 0) = 0
      ORDER BY created_at ASC, post_id ASC
      ${limitClause(limit)}
    `,
    args: [],
  })
  return result.rows.map((row) => ({ id: String(row.id) }))
}

async function listCommentDetectionCandidates(client: DbExecutor, limit: number | null): Promise<Candidate[]> {
  const result = await client.execute({
    sql: `
      SELECT comment_id AS id
      FROM comments
      WHERE status = 'published'
        AND NULLIF(TRIM(body), '') IS NOT NULL
        AND COALESCE(source_language_reliable, 0) = 0
      ORDER BY created_at ASC, comment_id ASC
      ${limitClause(limit)}
    `,
    args: [],
  })
  return result.rows.map((row) => ({ id: String(row.id) }))
}

async function listCommunityTextDetectionCandidates(client: DbExecutor, limit: number | null): Promise<Candidate[]> {
  const result = await client.execute({
    sql: `
      SELECT field_key AS id
      FROM community_localization_meta
      WHERE translation_policy NOT IN ('none', 'human_only')
        AND COALESCE(source_language_reliable, 0) = 0
      ORDER BY updated_at ASC, field_key ASC
      ${limitClause(limit)}
    `,
    args: [],
  })
  return result.rows.map((row) => ({ id: String(row.id) }))
}

async function listPostRepairCandidates(input: {
  client: DbExecutor
  limit: number | null
  detectedSince: string | null
}): Promise<Candidate[]> {
  const result = await input.client.execute({
    sql: `
      SELECT post_id AS id
      FROM posts
      WHERE status = 'published'
        AND translation_policy IN ('machine_allowed', 'hybrid')
        AND (
          COALESCE(NULLIF(TRIM(title), ''), NULLIF(TRIM(body), ''), NULLIF(TRIM(caption), '')) IS NOT NULL
        )
        AND COALESCE(source_language_reliable, 0) = 1
        AND (?1 IS NULL OR source_language_detected_at >= ?1)
      ORDER BY source_language_detected_at ASC, post_id ASC
      ${limitClause(input.limit)}
    `,
    args: [input.detectedSince],
  })
  return result.rows.map((row) => ({ id: String(row.id) }))
}

async function listCommentRepairCandidates(input: {
  client: DbExecutor
  limit: number | null
  detectedSince: string | null
}): Promise<Candidate[]> {
  const result = await input.client.execute({
    sql: `
      SELECT comment_id AS id
      FROM comments
      WHERE status = 'published'
        AND NULLIF(TRIM(body), '') IS NOT NULL
        AND COALESCE(source_language_reliable, 0) = 1
        AND (?1 IS NULL OR source_language_detected_at >= ?1)
      ORDER BY source_language_detected_at ASC, comment_id ASC
      ${limitClause(input.limit)}
    `,
    args: [input.detectedSince],
  })
  return result.rows.map((row) => ({ id: String(row.id) }))
}

async function listCommunityTextRepairCandidates(input: {
  client: DbExecutor
  limit: number | null
  detectedSince: string | null
}): Promise<Candidate[]> {
  const result = await input.client.execute({
    sql: `
      SELECT field_key AS id
      FROM community_localization_meta
      WHERE translation_policy NOT IN ('none', 'human_only')
        AND (?1 IS NULL OR source_language_detected_at >= ?1)
      ORDER BY updated_at ASC, field_key ASC
      ${limitClause(input.limit)}
    `,
    args: [input.detectedSince],
  })
  return result.rows.map((row) => ({ id: String(row.id) }))
}

async function maybeEnqueue(input: {
  client: DbExecutor
  communityId: string
  jobType: CommunityJobType
  subjectType: string
  subjectId: string
  payload: Record<string, unknown>
  dryRun: boolean
  createdAt: string
}): Promise<void> {
  if (input.dryRun) {
    return
  }
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: input.jobType,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    payloadJson: JSON.stringify(input.payload),
    createdAt: input.createdAt,
  })
}

async function enqueuePostDetectionJobs(input: {
  client: DbExecutor
  communityId: string
  candidates: Candidate[]
  options: ScriptOptions
  createdAt: string
}): Promise<number> {
  for (const candidate of input.candidates) {
    await maybeEnqueue({
      client: input.client,
      communityId: input.communityId,
      jobType: "post_language_detection_materialize",
      subjectType: "post_language_detection",
      subjectId: candidate.id,
      payload: { post_id: candidate.id },
      dryRun: input.options.dryRun,
      createdAt: input.createdAt,
    })
  }
  return input.candidates.length
}

async function enqueueCommentDetectionJobs(input: {
  client: DbExecutor
  communityId: string
  candidates: Candidate[]
  options: ScriptOptions
  createdAt: string
}): Promise<number> {
  for (const candidate of input.candidates) {
    await maybeEnqueue({
      client: input.client,
      communityId: input.communityId,
      jobType: "comment_language_detection_materialize",
      subjectType: "comment_language_detection",
      subjectId: candidate.id,
      payload: { comment_id: candidate.id },
      dryRun: input.options.dryRun,
      createdAt: input.createdAt,
    })
  }
  return input.candidates.length
}

async function enqueueCommunityTextDetectionJob(input: {
  client: DbExecutor
  communityId: string
  candidates: Candidate[]
  options: ScriptOptions
  createdAt: string
}): Promise<number> {
  if (input.candidates.length === 0) {
    return 0
  }
  await maybeEnqueue({
    client: input.client,
    communityId: input.communityId,
    jobType: "community_text_translation_materialize",
    subjectType: "community_text_translation",
    subjectId: `${input.communityId}:${DEFAULT_CONTENT_LOCALE}`,
    payload: { locale: DEFAULT_CONTENT_LOCALE },
    dryRun: input.options.dryRun,
    createdAt: input.createdAt,
  })
  return 1
}

async function enqueuePostRepairJobs(input: {
  client: DbExecutor
  communityId: string
  candidates: Candidate[]
  options: ScriptOptions
  createdAt: string
}): Promise<number> {
  let jobs = 0
  for (const candidate of input.candidates) {
    for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
      await maybeEnqueue({
        client: input.client,
        communityId: input.communityId,
        jobType: "post_translation_materialize",
        subjectType: "post_translation",
        subjectId: `${candidate.id}:${locale}`,
        payload: { post_id: candidate.id, locale },
        dryRun: input.options.dryRun,
        createdAt: input.createdAt,
      })
      jobs += 1
    }
  }
  return jobs
}

async function enqueueCommentRepairJobs(input: {
  client: DbExecutor
  communityId: string
  candidates: Candidate[]
  options: ScriptOptions
  createdAt: string
}): Promise<number> {
  let jobs = 0
  for (const candidate of input.candidates) {
    for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
      await maybeEnqueue({
        client: input.client,
        communityId: input.communityId,
        jobType: "comment_translation_materialize",
        subjectType: "comment_translation",
        subjectId: `${candidate.id}:${locale}`,
        payload: { comment_id: candidate.id, locale },
        dryRun: input.options.dryRun,
        createdAt: input.createdAt,
      })
      jobs += 1
    }
  }
  return jobs
}

async function enqueueCommunityTextRepairJobs(input: {
  client: DbExecutor
  communityId: string
  candidates: Candidate[]
  options: ScriptOptions
  createdAt: string
}): Promise<number> {
  if (input.candidates.length === 0) {
    return 0
  }
  let jobs = 0
  for (const locale of CONTENT_TRANSLATION_PREWARM_LOCALES) {
    await maybeEnqueue({
      client: input.client,
      communityId: input.communityId,
      jobType: "community_text_translation_materialize",
      subjectType: "community_text_translation",
      subjectId: `${input.communityId}:${locale}`,
      payload: { locale },
      dryRun: input.options.dryRun,
      createdAt: input.createdAt,
    })
    jobs += 1
  }
  return jobs
}

async function backfillCommunity(input: {
  communityId: string
  env: Env
  repository: ReturnType<typeof getCommunityRepository>
  options: ScriptOptions
}): Promise<Omit<BackfillStats, "communities" | "failed">> {
  const db = await openCommunityDb(input.env, input.repository, input.communityId)
  try {
    const hasPostColumns = await tableHasColumns({
      client: db.client,
      tableName: "posts",
      columns: [
        "source_language_reliable",
        "source_language_detected_at",
        "source_language_source_hash",
      ],
    })
    const hasCommentColumns = await tableHasColumns({
      client: db.client,
      tableName: "comments",
      columns: [
        "source_language_reliable",
        "source_language_detected_at",
        "source_language_source_hash",
      ],
    })
    const hasCommunityTextColumns = await tableHasColumns({
      client: db.client,
      tableName: "community_localization_meta",
      columns: [
        "source_language_reliable",
        "source_language_detected_at",
      ],
    })

    if (!hasPostColumns || !hasCommentColumns || !hasCommunityTextColumns) {
      return {
        skippedMissingColumns: 1,
        postDetectionCandidates: 0,
        postDetectionJobs: 0,
        commentDetectionCandidates: 0,
        commentDetectionJobs: 0,
        communityTextDetectionCandidates: 0,
        communityTextDetectionJobs: 0,
        postRepairCandidates: 0,
        postRepairJobs: 0,
        commentRepairCandidates: 0,
        commentRepairJobs: 0,
        communityTextRepairCandidates: 0,
        communityTextRepairJobs: 0,
      }
    }

    const createdAt = nowIso()
    const stats = {
      skippedMissingColumns: 0,
      postDetectionCandidates: 0,
      postDetectionJobs: 0,
      commentDetectionCandidates: 0,
      commentDetectionJobs: 0,
      communityTextDetectionCandidates: 0,
      communityTextDetectionJobs: 0,
      postRepairCandidates: 0,
      postRepairJobs: 0,
      commentRepairCandidates: 0,
      commentRepairJobs: 0,
      communityTextRepairCandidates: 0,
      communityTextRepairJobs: 0,
    }

    if (input.options.detection) {
      const postCandidates = await listPostDetectionCandidates(db.client, input.options.limit)
      const commentCandidates = await listCommentDetectionCandidates(db.client, input.options.limit)
      const communityTextCandidates = await listCommunityTextDetectionCandidates(db.client, input.options.limit)
      stats.postDetectionCandidates = postCandidates.length
      stats.commentDetectionCandidates = commentCandidates.length
      stats.communityTextDetectionCandidates = communityTextCandidates.length
      stats.postDetectionJobs = await enqueuePostDetectionJobs({
        client: db.client,
        communityId: input.communityId,
        candidates: postCandidates,
        options: input.options,
        createdAt,
      })
      stats.commentDetectionJobs = await enqueueCommentDetectionJobs({
        client: db.client,
        communityId: input.communityId,
        candidates: commentCandidates,
        options: input.options,
        createdAt,
      })
      stats.communityTextDetectionJobs = await enqueueCommunityTextDetectionJob({
        client: db.client,
        communityId: input.communityId,
        candidates: communityTextCandidates,
        options: input.options,
        createdAt,
      })
    }

    if (input.options.repairTranslations) {
      const postCandidates = await listPostRepairCandidates({
        client: db.client,
        limit: input.options.limit,
        detectedSince: input.options.repairDetectedSince,
      })
      const commentCandidates = await listCommentRepairCandidates({
        client: db.client,
        limit: input.options.limit,
        detectedSince: input.options.repairDetectedSince,
      })
      const communityTextCandidates = await listCommunityTextRepairCandidates({
        client: db.client,
        limit: input.options.limit,
        detectedSince: input.options.repairDetectedSince,
      })
      stats.postRepairCandidates = postCandidates.length
      stats.commentRepairCandidates = commentCandidates.length
      stats.communityTextRepairCandidates = communityTextCandidates.length
      stats.postRepairJobs = await enqueuePostRepairJobs({
        client: db.client,
        communityId: input.communityId,
        candidates: postCandidates,
        options: input.options,
        createdAt,
      })
      stats.commentRepairJobs = await enqueueCommentRepairJobs({
        client: db.client,
        communityId: input.communityId,
        candidates: commentCandidates,
        options: input.options,
        createdAt,
      })
      stats.communityTextRepairJobs = await enqueueCommunityTextRepairJobs({
        client: db.client,
        communityId: input.communityId,
        candidates: communityTextCandidates,
        options: input.options,
        createdAt,
      })
    }

    return stats
  } finally {
    db.close()
  }
}

function parseOptions(): ScriptOptions {
  if (hasFlag("--help") || hasFlag("-h")) {
    printUsage()
    process.exit(0)
  }

  return {
    dryRun: !hasFlag("--execute"),
    communityId: parseCommunityId(readArg("--community-id")),
    limit: parsePositiveInt(readArg("--limit")),
    detection: !hasFlag("--repair-translations-only"),
    repairTranslations: hasFlag("--repair-translations") || hasFlag("--repair-translations-only"),
    repairDetectedSince: readArg("--repair-detected-since"),
  }
}

async function main(): Promise<void> {
  const options = parseOptions()
  const env = {
    ...readDevVarsFromCwd(),
    ...process.env,
  } as unknown as Env
  const repository = getCommunityRepository(env)
  const communities = options.communityId
    ? [await repository.getCommunityById(options.communityId)].filter((community): community is NonNullable<typeof community> => community !== null)
    : await repository.listActiveCommunities()
  const stats: BackfillStats = {
    communities: 0,
    skippedMissingColumns: 0,
    postDetectionCandidates: 0,
    postDetectionJobs: 0,
    commentDetectionCandidates: 0,
    commentDetectionJobs: 0,
    communityTextDetectionCandidates: 0,
    communityTextDetectionJobs: 0,
    postRepairCandidates: 0,
    postRepairJobs: 0,
    commentRepairCandidates: 0,
    commentRepairJobs: 0,
    communityTextRepairCandidates: 0,
    communityTextRepairJobs: 0,
    failed: 0,
  }

  for (const community of communities) {
    const communityId = community.community_id
    stats.communities += 1
    try {
      const communityStats = await backfillCommunity({
        communityId,
        env,
        repository,
        options,
      })
      stats.skippedMissingColumns += communityStats.skippedMissingColumns
      stats.postDetectionCandidates += communityStats.postDetectionCandidates
      stats.postDetectionJobs += communityStats.postDetectionJobs
      stats.commentDetectionCandidates += communityStats.commentDetectionCandidates
      stats.commentDetectionJobs += communityStats.commentDetectionJobs
      stats.communityTextDetectionCandidates += communityStats.communityTextDetectionCandidates
      stats.communityTextDetectionJobs += communityStats.communityTextDetectionJobs
      stats.postRepairCandidates += communityStats.postRepairCandidates
      stats.postRepairJobs += communityStats.postRepairJobs
      stats.commentRepairCandidates += communityStats.commentRepairCandidates
      stats.commentRepairJobs += communityStats.commentRepairJobs
      stats.communityTextRepairCandidates += communityStats.communityTextRepairCandidates
      stats.communityTextRepairJobs += communityStats.communityTextRepairJobs
      console.log([
        `${communityId}:`,
        `post_detection=${communityStats.postDetectionCandidates}/${communityStats.postDetectionJobs}`,
        `comment_detection=${communityStats.commentDetectionCandidates}/${communityStats.commentDetectionJobs}`,
        `community_text_detection=${communityStats.communityTextDetectionCandidates}/${communityStats.communityTextDetectionJobs}`,
        `post_repair=${communityStats.postRepairCandidates}/${communityStats.postRepairJobs}`,
        `comment_repair=${communityStats.commentRepairCandidates}/${communityStats.commentRepairJobs}`,
        `community_text_repair=${communityStats.communityTextRepairCandidates}/${communityStats.communityTextRepairJobs}`,
        communityStats.skippedMissingColumns ? "skipped_missing_columns" : "",
      ].filter(Boolean).join(" "))
    } catch (error) {
      stats.failed += 1
      const message = error instanceof Error ? error.message : String(error)
      console.error(`${communityId}: failed ${message}`)
    }
  }

  await repository.close?.()
  console.log([
    `summary: mode=${options.dryRun ? "dry-run" : "execute"}`,
    `communities=${stats.communities}`,
    `skipped_missing_columns=${stats.skippedMissingColumns}`,
    `post_detection=${stats.postDetectionCandidates}/${stats.postDetectionJobs}`,
    `comment_detection=${stats.commentDetectionCandidates}/${stats.commentDetectionJobs}`,
    `community_text_detection=${stats.communityTextDetectionCandidates}/${stats.communityTextDetectionJobs}`,
    `post_repair=${stats.postRepairCandidates}/${stats.postRepairJobs}`,
    `comment_repair=${stats.commentRepairCandidates}/${stats.commentRepairJobs}`,
    `community_text_repair=${stats.communityTextRepairCandidates}/${stats.communityTextRepairJobs}`,
    `failed=${stats.failed}`,
  ].join(" "))

  if (stats.failed > 0) {
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
