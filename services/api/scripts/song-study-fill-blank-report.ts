#!/usr/bin/env bun

import { JSONC, sleep } from "bun"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

import { sha256Hex } from "../src/lib/crypto"
import type { InStatement, QueryResult } from "../src/lib/sql-client"
import {
  generatePublishedSongFillBlankShardReport,
  type PublishedSongFillBlankReport,
  type StudyFillBlankReportServingContext,
} from "../src/lib/posts/post-study-fill-blank-report"
import { STUDY_CLOZE_GENERATION_VERSION } from "../src/lib/posts/post-study-cloze-service"
import { parseStudyFillBlankReservedSlots } from "../src/lib/posts/post-study-session-service"

const CONFIRMATION = "AUDIT FILL BLANK TO STAGING"
const MAX_CONCURRENCY = 8

type D1Binding = {
  binding: string
  database_id: string
  database_name: string
}

type RunnerOptions = {
  accountId: string
  concurrency: number
  outputPath: string
  servingContext: StudyFillBlankReportServingContext
  token: string
}

export type FillBlankRolloutConfig = {
  enabled: boolean
  reservedSlots: number
}

type D1Error = { code?: number; message?: string }

type D1QueryPayload = {
  errors?: D1Error[]
  result?: Array<{
    errors?: D1Error[]
    results?: Array<Record<string, unknown>>
    success?: boolean
  }>
  success?: boolean
}

type StagingReportArtifact = {
  allocated_database_count: number
  complete: boolean
  database_errors: Array<{
    binding: string
    database_id: string
    error: string
  }>
  format_version: 1
  generator_version: typeof STUDY_CLOZE_GENERATION_VERSION
  observed_at: string
  read_only: true
  report_digest: string
  scanned_database_count: number
  serving_context: StudyFillBlankReportServingContext & {
    mode: "first_learn_without_review_state"
  }
  song_count: number
  songs: Array<PublishedSongFillBlankReport & { database_binding: string }>
  target: "staging"
}

type ShardReportOutcome =
  | { binding: D1Binding; kind: "error"; error: string }
  | { binding: D1Binding; kind: "report"; report: Awaited<ReturnType<typeof generatePublishedSongFillBlankShardReport>> }

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index < 0 ? undefined : argv[index + 1]?.trim()
}

function requiredOption(argv: string[], name: string): string {
  const value = option(argv, name)
  if (!value) throw new Error(`missing required option ${name}`)
  return value
}

function booleanOption(argv: string[], name: string): boolean {
  const value = requiredOption(argv, name)
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${name} must be true or false`)
}

export function resolveReportRunnerOptions(
  argv: string[],
  env: Record<string, string | undefined>,
  configuredRollout: FillBlankRolloutConfig,
): RunnerOptions {
  if (String(env.ENVIRONMENT ?? "").trim().toLowerCase() !== "staging") {
    throw new Error("refusing_fill_blank_report_outside_staging")
  }
  if (requiredOption(argv, "--confirmation") !== CONFIRMATION) {
    throw new Error("fill_blank_report_confirmation_mismatch")
  }
  const accountId = String(env.CLOUDFLARE_ACCOUNT_ID ?? "").trim()
  const token = String(env.CLOUDFLARE_D1_API_TOKEN ?? "").trim()
  if (!accountId) throw new Error("CLOUDFLARE_ACCOUNT_ID is required")
  if (!token) throw new Error("CLOUDFLARE_D1_API_TOKEN is required")
  if (!configuredRollout.enabled) throw new Error("fill_blank_report_feature_disabled")
  const runtimeEnabled = env.SONG_STUDY_FILL_BLANK_ENABLED?.trim()
  if (runtimeEnabled !== undefined
    && (runtimeEnabled !== "true" && runtimeEnabled !== "false"
      || (runtimeEnabled === "true") !== configuredRollout.enabled)) {
    throw new Error("fill_blank_report_existence_config_mismatch")
  }
  const runtimeReservation = env.SONG_STUDY_FILL_BLANK_RESERVED_SLOTS?.trim()
  if (runtimeReservation !== undefined
    && parseStudyFillBlankReservedSlots(runtimeReservation) !== configuredRollout.reservedSlots) {
    throw new Error("fill_blank_report_reservation_config_mismatch")
  }
  const concurrency = Number(option(argv, "--concurrency") ?? "2")
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new Error(`--concurrency must be an integer from 1 to ${MAX_CONCURRENCY}`)
  }
  return {
    accountId,
    concurrency,
    outputPath: resolve(requiredOption(argv, "--output")),
    servingContext: {
      fill_blank_enabled: configuredRollout.enabled,
      fill_blank_reserved_slots: configuredRollout.reservedSlots,
      include_say_it_back: booleanOption(argv, "--include-say-it-back"),
      include_translation: booleanOption(argv, "--include-translation"),
      target_language: requiredOption(argv, "--target-language"),
    },
    token,
  }
}

export function parseFillBlankRolloutConfig(
  configText: string,
  target: "production" | "staging",
): FillBlankRolloutConfig {
  const parsed = JSONC.parse(configText) as {
    env?: { production?: { vars?: Record<string, unknown> }; staging?: { vars?: Record<string, unknown> } }
    vars?: Record<string, unknown>
  }
  const vars = target === "production"
    ? parsed.env?.production?.vars
    : parsed.env?.staging?.vars ?? parsed.vars
  const enabled = vars?.SONG_STUDY_FILL_BLANK_ENABLED
  const reserved = vars?.SONG_STUDY_FILL_BLANK_RESERVED_SLOTS
  if (enabled !== "true" && enabled !== "false") {
    throw new Error(`fill-blank existence flag is missing for ${target}`)
  }
  if (typeof reserved !== "string"
    || !/^\d+$/u.test(reserved)
    || parseStudyFillBlankReservedSlots(reserved) !== Number(reserved)) {
    throw new Error(`fill-blank reservation is missing or invalid for ${target}`)
  }
  return { enabled: enabled === "true", reservedSlots: Number(reserved) }
}

export function parseStagingD1Bindings(configText: string): D1Binding[] {
  const parsed = JSONC.parse(configText) as { d1_databases?: unknown }
  if (!Array.isArray(parsed.d1_databases)) throw new Error("staging D1 bindings are missing")
  return parsed.d1_databases.map((entry): D1Binding => {
    if (!entry || typeof entry !== "object") throw new Error("staging D1 binding is malformed")
    const record = entry as Record<string, unknown>
    const binding = String(record.binding ?? "").trim()
    const databaseId = String(record.database_id ?? "").trim()
    const databaseName = String(record.database_name ?? "").trim()
    if (!binding || !databaseId || !databaseName) throw new Error("staging D1 binding is incomplete")
    return { binding, database_id: databaseId, database_name: databaseName }
  })
}

export function assertReadOnlyReportSql(statement: InStatement | string): void {
  const sql = (typeof statement === "string" ? statement : statement.sql)
    .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "")
    .trimStart()
  if (sql.includes(";")) {
    throw new Error("fill_blank_report_rejected_multiple_statements")
  }
  if (!/^(?:SELECT|PRAGMA\s+table_info\s*\()/iu.test(sql)) {
    throw new Error("fill_blank_report_rejected_non_read_query")
  }
}

function errorSummary(payload: D1QueryPayload, status: number): string {
  const errors = [...(payload.errors ?? []), ...(payload.result?.flatMap((result) => result.errors ?? []) ?? [])]
  const details = errors.map((error) => `${error.code ?? "unknown"}:${error.message ?? "unknown"}`).join(", ")
  return `HTTP ${status}${details ? ` ${details}` : ""}`
}

function retryable(payload: D1QueryPayload, status: number): boolean {
  const codes = [...(payload.errors ?? []), ...(payload.result?.flatMap((result) => result.errors ?? []) ?? [])]
    .map((error) => Number(error.code ?? 0))
  return status === 429 || status >= 500 || codes.includes(7429)
}

class D1RestReadClient {
  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly token: string,
  ) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    assertReadOnlyReportSql(statement)
    const sql = typeof statement === "string" ? statement : statement.sql
    const params = typeof statement === "string" ? [] : statement.args ?? []
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
        return { rows: query.results ?? [] }
      }
      lastError = errorSummary(payload, response.status)
      if (!retryable(payload, response.status) || attempt === 4) break
      await sleep(attempt * 250)
    }
    throw new Error(lastError)
  }
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, task: (value: T) => Promise<R>): Promise<R[]> {
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

export async function runStagingFillBlankReport(input: {
  bindings: D1Binding[]
  options: RunnerOptions
  observedAt: string
}): Promise<StagingReportArtifact> {
  const pool = input.bindings.find((binding) => binding.binding === "D1_POOL")
  if (!pool) throw new Error("staging D1_POOL binding is missing")
  const poolClient = new D1RestReadClient(input.options.accountId, pool.database_id, input.options.token)
  const allocationRows = await poolClient.execute(
    "SELECT binding_name, community_id FROM d1_pool WHERE community_id IS NOT NULL ORDER BY binding_name",
  )
  const bindingByName = new Map(input.bindings.map((binding) => [binding.binding, binding]))
  const allocated = allocationRows.rows.map((row) => {
    const bindingName = String(row.binding_name ?? "").trim()
    const binding = bindingByName.get(bindingName)
    if (!binding) throw new Error(`allocated staging binding is absent from config: ${bindingName}`)
    return binding
  })
  const outcomes = await mapConcurrent<D1Binding, ShardReportOutcome>(
    allocated,
    input.options.concurrency,
    async (binding) => {
      try {
        const report = await generatePublishedSongFillBlankShardReport({
          client: new D1RestReadClient(input.options.accountId, binding.database_id, input.options.token),
          observedAt: input.observedAt,
          servingContext: input.options.servingContext,
        })
        return { binding, kind: "report", report }
      } catch (error) {
        return { binding, error: error instanceof Error ? error.message : String(error), kind: "error" }
      }
    },
  )
  const databaseErrors = outcomes.flatMap((outcome) => outcome.kind === "error" ? [{
    binding: outcome.binding.binding,
    database_id: outcome.binding.database_id,
    error: outcome.error,
  }] : [])
  const songs = outcomes.flatMap((outcome) => outcome.kind === "report"
    ? outcome.report.songs.map((song) => ({ ...song, database_binding: outcome.binding.binding }))
    : [])
  const reportDigest = await sha256Hex(JSON.stringify(songs))
  const scannedDatabaseCount = outcomes.length - databaseErrors.length
  return {
    allocated_database_count: allocated.length,
    complete: allocated.length > 0
      && databaseErrors.length === 0
      && scannedDatabaseCount === allocated.length,
    database_errors: databaseErrors,
    format_version: 1,
    generator_version: STUDY_CLOZE_GENERATION_VERSION,
    observed_at: input.observedAt,
    read_only: true,
    report_digest: reportDigest,
    scanned_database_count: scannedDatabaseCount,
    serving_context: {
      ...input.options.servingContext,
      mode: "first_learn_without_review_state",
    },
    song_count: songs.length,
    songs,
    target: "staging",
  }
}

async function main(): Promise<void> {
  const apiConfigText = await readFile(resolve(import.meta.dir, "../wrangler.jsonc"), "utf8")
  const configuredRollout = parseFillBlankRolloutConfig(apiConfigText, "staging")
  const options = resolveReportRunnerOptions(process.argv.slice(2), process.env, configuredRollout)
  const configPath = resolve(import.meta.dir, "../../community-d1-shard/wrangler.jsonc")
  const bindings = parseStagingD1Bindings(await readFile(configPath, "utf8"))
  const artifact = await runStagingFillBlankReport({
    bindings,
    observedAt: new Date().toISOString(),
    options,
  })
  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 })
  console.log(JSON.stringify({
    allocated_database_count: artifact.allocated_database_count,
    complete: artifact.complete,
    output: options.outputPath,
    scanned_database_count: artifact.scanned_database_count,
    song_count: artifact.song_count,
  }))
  if (!artifact.complete) process.exitCode = 1
}

if (import.meta.main) await main()
