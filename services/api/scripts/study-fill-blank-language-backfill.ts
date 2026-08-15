#!/usr/bin/env bun

import { sleep } from "bun"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { sha256Hex } from "../src/lib/crypto"
import { makeId, nowIso } from "../src/lib/helpers"
import type { Env } from "../src/env"
import {
  computeLyricsLanguageSourceHash,
  hasSufficientLyricsForLanguageDetection,
  LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR,
} from "../src/lib/localization/lyrics-language-detection-materializer"
import {
  parseFillBlankRolloutConfig,
  parseStagingD1Bindings,
  type FillBlankRolloutConfig,
} from "./song-study-fill-blank-report"

const CONFIRMATION = "AUDIT FILL BLANK LANGUAGE BACKFILL TO STAGING"
const MAX_CONCURRENCY = 8
const JOB_TYPE = "post_lyrics_language_detection_materialize"
const SUBJECT_TYPE = "post_lyrics_language_detection"

type D1Binding = {
  binding: string
  database_id: string
  database_name: string
}

type D1Error = { code?: number; message?: string }

type D1QueryPayload = {
  errors?: D1Error[]
  result?: Array<{
    errors?: D1Error[]
    meta?: { changes?: number }
    results?: Array<Record<string, unknown>>
    success?: boolean
  }>
  success?: boolean
}

export type D1QueryResult = {
  rows: Array<Record<string, unknown>>
  rowsAffected?: number
}

type FrozenReportSong = {
  database_binding: string
  detected_language?: {
    source_hash?: string | null
  }
  post: {
    community_id: string
    post_id: string
    song_title?: string | null
  }
  source_fingerprint: string
  total_lines: number
}

export type FrozenFillBlankReport = {
  complete: true
  format_version: 1
  generator_version: number
  observed_at: string
  report_digest: string
  scanned_database_count: number
  allocated_database_count: number
  read_only: true
  serving_context: {
    fill_blank_enabled: boolean
    fill_blank_reserved_slots: number
  }
  songs: FrozenReportSong[]
  target: "staging"
}

export type BackfillMode = "dry-run" | "execute"

export type BackfillRunnerOptions = {
  accountId: string
  concurrency: number
  execute: boolean
  outputPath: string
  reportPath: string
  token: string
}

type PostRow = {
  community_id: string
  lyrics: string | null
  lyrics_language_detector: string | null
  lyrics_language_source_hash: string | null
  post_id: string
  post_type: string
  status: string
}

export type BackfillSongPlan = {
  binding: string
  community_id: string
  current_source_hash: string | null
  post_id: string
  report_source_fingerprint: string
  song_title: string | null
  action: "enqueue" | "unchanged" | "error"
  reason?: string
  subject_id?: string
}

export type BackfillArtifact = {
  complete: boolean
  errors: Array<{
    binding: string
    community_id: string
    error: string
    post_id: string
  }>
  format_version: 1
  generated_at: string
  generator_version: number
  inserted_job_count: number
  mode: BackfillMode
  planned_job_count: number
  read_only: boolean
  report_digest: string
  report_observed_at: string
  reserved_slots: number
  selected_song_count: number
  songs: BackfillSongPlan[]
  target: "staging"
  unchanged_song_count: number
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]?.trim()
}

function requiredOption(argv: string[], name: string): string {
  const value = option(argv, name)
  if (!value) throw new Error(`missing required option ${name}`)
  return value
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name)
}

export function assertReadOnlyBackfillSql(statement: string): void {
  const sql = statement
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "")
    .trimStart()
  if (sql.includes(";")) throw new Error("fill_blank_backfill_rejected_multiple_statements")
  if (!/^(?:SELECT|PRAGMA\s+table_info\s*\()/iu.test(sql)) {
    throw new Error("fill_blank_backfill_rejected_non_read_query")
  }
}

export function assertCommunityJobInsertSql(statement: string): void {
  const sql = statement
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "")
    .trimStart()
  if (sql.includes(";")) throw new Error("fill_blank_backfill_rejected_multiple_statements")
  if (!/^INSERT\s+OR\s+IGNORE\s+INTO\s+community_jobs\s*\(/iu.test(sql)) {
    throw new Error("fill_blank_backfill_rejected_non_community_job_insert")
  }
  if (/\b(?:SELECT|RETURNING|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE)\b/iu.test(sql)) {
    throw new Error("fill_blank_backfill_rejected_non_insert_write")
  }
  if (!/\bVALUES\s*\(/iu.test(sql)) {
    throw new Error("fill_blank_backfill_rejected_unparameterized_insert")
  }
}

function errorSummary(payload: D1QueryPayload, status: number): string {
  const errors = [
    ...(payload.errors ?? []),
    ...(payload.result?.flatMap((result) => result.errors ?? []) ?? []),
  ]
  const details = errors
    .map((error) => `${error.code ?? "unknown"}:${error.message ?? "unknown"}`)
    .join(", ")
  return `HTTP ${status}${details ? ` ${details}` : ""}`
}

function retryable(payload: D1QueryPayload, status: number): boolean {
  const codes = [
    ...(payload.errors ?? []),
    ...(payload.result?.flatMap((result) => result.errors ?? []) ?? []),
  ].map((error) => Number(error.code ?? 0))
  return status === 429 || status >= 500 || codes.includes(7429)
}

class D1RestClient {
  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly token: string,
  ) {}

  async read(sql: string, args: unknown[] = []): Promise<D1QueryResult> {
    assertReadOnlyBackfillSql(sql)
    return this.execute(sql, args)
  }

  async insertCommunityJob(sql: string, args: unknown[]): Promise<D1QueryResult> {
    assertCommunityJobInsertSql(sql)
    return this.execute(sql, args)
  }

  private async execute(sql: string, params: unknown[]): Promise<D1QueryResult> {
    let lastError = "unknown D1 query failure"
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
        {
          body: JSON.stringify({ params, sql }),
          headers: {
            authorization: `Bearer ${this.token}`,
            "content-type": "application/json",
          },
          method: "POST",
        },
      )
      const payload = await response.json() as D1QueryPayload
      const query = payload.result?.[0]
      if (response.ok && payload.success === true && query?.success === true) {
        return {
          rows: query.results ?? [],
          rowsAffected: query.meta?.changes,
        }
      }
      lastError = errorSummary(payload, response.status)
      if (!retryable(payload, response.status) || attempt === 4) break
      await sleep(attempt * 250)
    }
    throw new Error(lastError)
  }
}

export function parseBackfillRunnerOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): BackfillRunnerOptions {
  if (String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
    throw new Error("refusing_fill_blank_backfill_outside_staging")
  }
  if (requiredOption(argv, "--confirmation") !== CONFIRMATION) {
    throw new Error("fill_blank_backfill_confirmation_mismatch")
  }
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? "").trim()
  const token = String(env.CLOUDFLARE_D1_API_TOKEN ?? "").trim()
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required")
  if (!token) throw new Error("CLOUDFLARE_D1_API_TOKEN is required")
  const concurrency = Number(option(argv, "--concurrency") ?? "2")
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`)
  }
  return {
    accountId,
    concurrency,
    execute: hasFlag(argv, "--execute"),
    outputPath: resolve(requiredOption(argv, "--output")),
    reportPath: resolve(requiredOption(argv, "--report")),
    token,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`frozen_report_invalid_${field}`)
  return value.trim()
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`frozen_report_invalid_${field}`)
  }
  return Number(value)
}

export async function loadFrozenFillBlankReport(path: string): Promise<FrozenFillBlankReport> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`frozen_report_unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)
    || parsed.complete !== true
    || parsed.format_version !== 1
    || parsed.read_only !== true
    || parsed.target !== "staging") {
    throw new Error("frozen_report_incomplete_or_wrong_target")
  }
  const songsValue = parsed.songs
  if (!Array.isArray(songsValue)) throw new Error("frozen_report_invalid_songs")
  const songs: FrozenReportSong[] = songsValue.map((value) => {
    if (!isRecord(value) || !isRecord(value.post)) throw new Error("frozen_report_invalid_song")
    const detected = isRecord(value.detected_language) ? value.detected_language : undefined
    const post = value.post
    const totalLines = positiveInteger(value.total_lines, "total_lines")
    const sourceFingerprint = nonEmptyString(value.source_fingerprint, "source_fingerprint")
    return {
      database_binding: nonEmptyString(value.database_binding, "database_binding"),
      detected_language: {
        source_hash: detected?.source_hash === null || detected?.source_hash === undefined
          ? null
          : nonEmptyString(detected.source_hash, "detected_language_source_hash"),
      },
      post: {
        community_id: nonEmptyString(post.community_id, "community_id"),
        post_id: nonEmptyString(post.post_id, "post_id"),
        song_title: typeof post.song_title === "string" ? post.song_title : null,
      },
      source_fingerprint: sourceFingerprint,
      total_lines: totalLines,
    }
  })
  if (positiveInteger(parsed.song_count, "song_count") !== songs.length) {
    throw new Error("frozen_report_song_count_mismatch")
  }
  const allocated = positiveInteger(parsed.allocated_database_count, "allocated_database_count")
  const scanned = positiveInteger(parsed.scanned_database_count, "scanned_database_count")
  if (allocated === 0 || allocated !== scanned) throw new Error("frozen_report_database_scan_incomplete")
  const report: FrozenFillBlankReport = {
    allocated_database_count: allocated,
    complete: true,
    format_version: 1,
    generator_version: positiveInteger(parsed.generator_version, "generator_version"),
    observed_at: nonEmptyString(parsed.observed_at, "observed_at"),
    read_only: true,
    report_digest: nonEmptyString(parsed.report_digest, "report_digest"),
    scanned_database_count: scanned,
    serving_context: {
      fill_blank_enabled: parsed.serving_context && isRecord(parsed.serving_context)
        ? parsed.serving_context.fill_blank_enabled === true
        : false,
      fill_blank_reserved_slots: parsed.serving_context && isRecord(parsed.serving_context)
        ? positiveInteger(parsed.serving_context.fill_blank_reserved_slots, "reserved_slots")
        : 0,
    },
    songs,
    target: "staging",
  }
  if (await sha256Hex(JSON.stringify(songsValue)) !== report.report_digest) {
    throw new Error("frozen_report_digest_mismatch")
  }
  if (!report.serving_context.fill_blank_enabled) throw new Error("frozen_report_feature_disabled")
  const seen = new Set<string>()
  for (const song of report.songs) {
    const key = `${song.database_binding}:${song.post.community_id}:${song.post.post_id}`
    if (seen.has(key)) throw new Error(`frozen_report_duplicate_song:${key}`)
    seen.add(key)
  }
  if (!report.songs.some((song) => song.total_lines > 0)) {
    throw new Error("frozen_report_has_no_song_lines")
  }
  return report
}

function rowString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

const INSERT_COMMUNITY_JOB_SQL = `
INSERT OR IGNORE INTO community_jobs (
  job_id, community_id, job_type, subject_type, subject_id, status, payload_json,
  result_ref, error_code, attempt_count, available_at, last_checkpoint, last_checkpoint_at,
  attempt_started_at, attempt_deadline_at, created_at, updated_at
) VALUES (
  ?1, ?2, ?3, ?4, ?5, 'queued', ?6,
  NULL, NULL, 0, NULL, NULL, NULL,
  NULL, NULL, ?7, ?7
)`

async function planSong(input: {
  binding: D1Binding
  client: D1RestClient
  song: FrozenReportSong
  env: Record<string, string | undefined>
}): Promise<BackfillSongPlan> {
  const result = await input.client.read(
    `SELECT post_id, community_id, post_type, status, lyrics,
            lyrics_language_detector, lyrics_language_source_hash
     FROM posts
     WHERE post_id = ?1 AND community_id = ?2
     LIMIT 1`,
    [input.song.post.post_id, input.song.post.community_id],
  )
  const row = result.rows[0]
  if (!row) {
    return {
      action: "error",
      binding: input.binding.binding,
      community_id: input.song.post.community_id,
      current_source_hash: null,
      post_id: input.song.post.post_id,
      reason: "report_song_missing_or_community_mismatch",
      report_source_fingerprint: input.song.source_fingerprint,
      song_title: input.song.post.song_title ?? null,
    }
  }
  const post: PostRow = {
    community_id: rowString(row, "community_id") ?? "",
    lyrics: rowString(row, "lyrics"),
    lyrics_language_detector: rowString(row, "lyrics_language_detector"),
    lyrics_language_source_hash: rowString(row, "lyrics_language_source_hash"),
    post_id: rowString(row, "post_id") ?? "",
    post_type: rowString(row, "post_type") ?? "",
    status: rowString(row, "status") ?? "",
  }
  if (post.post_type !== "song" || post.status !== "published") {
    return {
      action: "error",
      binding: input.binding.binding,
      community_id: input.song.post.community_id,
      current_source_hash: null,
      post_id: input.song.post.post_id,
      reason: "report_song_is_not_published_song",
      report_source_fingerprint: input.song.source_fingerprint,
      song_title: input.song.post.song_title ?? null,
    }
  }
  const sourceHash = await computeLyricsLanguageSourceHash(post.lyrics)
  if (!sourceHash) {
    return {
      action: "error",
      binding: input.binding.binding,
      community_id: input.song.post.community_id,
      current_source_hash: null,
      post_id: input.song.post.post_id,
      reason: "report_song_has_no_lyrics",
      report_source_fingerprint: input.song.source_fingerprint,
      song_title: input.song.post.song_title ?? null,
    }
  }
  const reportedSourceHash = input.song.detected_language?.source_hash ?? null
  if (reportedSourceHash && reportedSourceHash !== sourceHash) {
    return {
      action: "error",
      binding: input.binding.binding,
      community_id: input.song.post.community_id,
      current_source_hash: sourceHash,
      post_id: input.song.post.post_id,
      reason: "report_source_hash_is_stale",
      report_source_fingerprint: input.song.source_fingerprint,
      song_title: input.song.post.song_title ?? null,
    }
  }
  const sufficient = hasSufficientLyricsForLanguageDetection(post.lyrics ?? "", input.env as unknown as Env)
  const policyApplied = post.lyrics_language_detector === LYRICS_LANGUAGE_MIN_LENGTH_DETECTOR
  if (post.lyrics_language_source_hash === sourceHash
    && post.lyrics_language_detector
    && (sufficient || policyApplied)) {
    return {
      action: "unchanged",
      binding: input.binding.binding,
      community_id: input.song.post.community_id,
      current_source_hash: sourceHash,
      post_id: input.song.post.post_id,
      report_source_fingerprint: input.song.source_fingerprint,
      song_title: input.song.post.song_title ?? null,
    }
  }
  return {
    action: "enqueue",
    binding: input.binding.binding,
    community_id: input.song.post.community_id,
    current_source_hash: sourceHash,
    post_id: input.song.post.post_id,
    report_source_fingerprint: input.song.source_fingerprint,
    song_title: input.song.post.song_title ?? null,
    subject_id: `${post.post_id}:${sourceHash}`,
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await task(values[index]!)
    }
  }))
  return results
}

export async function runStagingLanguageBackfill(input: {
  bindings: D1Binding[]
  env: Record<string, string | undefined>
  options: BackfillRunnerOptions
  report: FrozenFillBlankReport
}): Promise<BackfillArtifact> {
  const bindingByName = new Map(input.bindings.map((binding) => [binding.binding, binding]))
  const songs = input.report.songs.filter((song) => song.total_lines > 0)
  const plans = await mapConcurrent(songs, input.options.concurrency, async (song) => {
    const binding = bindingByName.get(song.database_binding)
    if (!binding) {
      return {
        action: "error" as const,
        binding: song.database_binding,
        community_id: song.post.community_id,
        current_source_hash: null,
        post_id: song.post.post_id,
        reason: "report_binding_missing_from_config",
        report_source_fingerprint: song.source_fingerprint,
        song_title: song.post.song_title ?? null,
      }
    }
    try {
      return await planSong({
        binding,
        client: new D1RestClient(input.options.accountId, binding.database_id, input.options.token),
        env: input.env,
        song,
      })
    } catch (error) {
      return {
        action: "error" as const,
        binding: binding.binding,
        community_id: song.post.community_id,
        current_source_hash: null,
        post_id: song.post.post_id,
        reason: `d1_read_failed:${error instanceof Error ? error.message : String(error)}`,
        report_source_fingerprint: song.source_fingerprint,
        song_title: song.post.song_title ?? null,
      }
    }
  })
  const errors = plans.flatMap((plan) => plan.action === "error" ? [{
    binding: plan.binding,
    community_id: plan.community_id,
    error: plan.reason ?? "unknown_backfill_plan_error",
    post_id: plan.post_id,
  }] : [])
  const enqueuePlans = plans.filter((plan) => plan.action === "enqueue")
  let insertedJobCount = 0
  const writeErrors: BackfillArtifact["errors"] = []
  if (input.options.execute && errors.length === 0) {
    const createdAt = nowIso()
    const writeResults = await mapConcurrent(enqueuePlans, input.options.concurrency, async (plan) => {
      try {
        const binding = bindingByName.get(plan.binding)
        if (!binding || !plan.subject_id) throw new Error(`backfill_plan_binding_missing:${plan.binding}`)
        const client = new D1RestClient(input.options.accountId, binding.database_id, input.options.token)
        const result = await client.insertCommunityJob(INSERT_COMMUNITY_JOB_SQL, [
          makeId("cjb"),
          plan.community_id,
          JOB_TYPE,
          SUBJECT_TYPE,
          plan.subject_id,
          JSON.stringify({ post_id: plan.post_id, source_hash: plan.current_source_hash }),
          createdAt,
        ])
        return { plan, inserted: (result.rowsAffected ?? 0) > 0 }
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          plan,
        }
      }
    })
    for (const result of writeResults) {
      if ("error" in result) {
        writeErrors.push({
          binding: result.plan.binding,
          community_id: result.plan.community_id,
          error: `d1_write_failed:${result.error}`,
          post_id: result.plan.post_id,
        })
      } else if (result.inserted) {
        insertedJobCount += 1
      }
    }
  }
  const allErrors = [...errors, ...writeErrors]
  return {
    complete: allErrors.length === 0,
    errors: allErrors,
    format_version: 1,
    generated_at: nowIso(),
    generator_version: input.report.generator_version,
    inserted_job_count: insertedJobCount,
    mode: input.options.execute ? "execute" : "dry-run",
    planned_job_count: enqueuePlans.length,
    read_only: !input.options.execute,
    report_digest: input.report.report_digest,
    report_observed_at: input.report.observed_at,
    reserved_slots: input.report.serving_context.fill_blank_reserved_slots,
    selected_song_count: songs.length,
    songs: plans,
    target: "staging",
    unchanged_song_count: plans.filter((plan) => plan.action === "unchanged").length,
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const env = process.env as Record<string, string | undefined>
  const configText = await readFile(resolve(import.meta.dir, "../wrangler.jsonc"), "utf8")
  const rollout: FillBlankRolloutConfig = parseFillBlankRolloutConfig(configText, "staging")
  const options = parseBackfillRunnerOptions(argv, env)
  if (env.SONG_STUDY_FILL_BLANK_ENABLED !== undefined
    && env.SONG_STUDY_FILL_BLANK_ENABLED !== String(rollout.enabled)) {
    throw new Error("fill_blank_backfill_existence_config_mismatch")
  }
  if (!rollout.enabled) throw new Error("fill_blank_backfill_feature_disabled")
  const report = await loadFrozenFillBlankReport(options.reportPath)
  const bindings = parseStagingD1Bindings(
    await readFile(resolve(import.meta.dir, "../../community-d1-shard/wrangler.jsonc"), "utf8"),
  )
  const artifact = await runStagingLanguageBackfill({ bindings, env, options, report })
  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({
    complete: artifact.complete,
    inserted_job_count: artifact.inserted_job_count,
    mode: artifact.mode,
    output: options.outputPath,
    planned_job_count: artifact.planned_job_count,
    selected_song_count: artifact.selected_song_count,
  }))
  if (!artifact.complete) process.exitCode = 1
}

if (import.meta.main) await main()
