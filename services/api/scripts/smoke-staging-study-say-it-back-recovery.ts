/**
 * Manual staging smoke for the Study say-it-back recovery loop.
 *
 * Proves, against a real deployed API + community D1 shard:
 *   1. a say_it_back exercise can be served,
 *   2. a near-miss transcript is incorrect and schedules `again`,
 *   3. forcing that review row due re-serves the same exercise,
 *   4. a correct transcript with attempt_number=1 and a fresh idempotency key
 *      succeeds with no replay/409 regression,
 *   5. the engagement-day write records activity_timezone.
 *
 * This script mutates the target staging community shard to avoid waiting the
 * real 10-minute recovery interval. It defaults to staging and refuses prod
 * force-due unless explicitly opted in.
 *
 * Typical run:
 *   infisical run --project-config-dir ../../core --env staging --path /services/api -- \
 *     bun services/api/scripts/smoke-staging-study-say-it-back-recovery.ts \
 *       --community com_... --post post_pst_...
 *
 * If you already have a user token:
 *   bun services/api/scripts/smoke-staging-study-say-it-back-recovery.ts \
 *     --token ... --community com_... --post post_pst_...
 */

import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { SQL } from "bun"
import {
  asObject,
  asString,
  fail,
  mintSmokeAccessToken,
  requestJson,
  type Json,
} from "./staging-smoke-support"

const prefix = "study-say-it-back-smoke"
const scriptDir = dirname(fileURLToPath(import.meta.url))
const serviceRoot = resolve(scriptDir, "..")
const repoRoot = resolve(scriptDir, "../../..")
const shardWranglerConfig = resolve(repoRoot, "services/community-d1-shard/wrangler.jsonc")
const wranglerBin = resolve(serviceRoot, "node_modules/.bin/wrangler")

type StudyExercise = {
  id: string
  line_id: string
  max_attempts: number
  reference_text?: string | null
  target_language?: string | null
  type: string
}

type StudyPayload = {
  access?: string
  exercises?: unknown[]
  target_language?: string | null
}

type RoutingRow = {
  binding_name: string
  shard_worker_id: string
}

type AttemptRow = {
  user_id: string
  post_id: string
  exercise_id: string
  line_id: string
  exercise_type: string
  target_language: string
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return undefined
  return process.argv[index + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function publicId(value: string, prefixValue: string): string {
  return value.startsWith(`${prefixValue}_`) ? value : `${prefixValue}_${value}`
}

function bareId(value: string, prefixValue: string): string {
  return value.startsWith(`${prefixValue}_`) ? value.slice(prefixValue.length + 1) : value
}

function assertStagingOrAllowed(apiBase: string): void {
  const host = new URL(apiBase).hostname
  if (host.includes("staging") || hasFlag("--allow-prod")) return
  fail(prefix, `refusing to run against non-staging host ${host}; pass --allow-prod explicitly`)
}

function sqlUrl(): string {
  const value = process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL?.trim()
  if (!value) fail(prefix, "CONTROL_PLANE_MIGRATOR_DATABASE_URL is required for D1 force-due")
  const parsed = new URL(value as string)
  parsed.searchParams.delete("sslrootcert")
  return parsed.toString()
}

function stripJsonComments(input: string): string {
  let result = ""
  let inString = false
  let quote = "\""
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (char === quote) inString = false
      continue
    }

    if (char === "\"" || char === "'") {
      inString = true
      quote = char
      result += char
      continue
    }

    if (char === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") index += 1
      if (index < input.length) result += "\n"
      continue
    }

    if (char === "/" && next === "*") {
      index += 2
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index += 1
      }
      index += 1
      continue
    }

    result += char
  }

  return result
}

function shardEnvironment(apiBase: string): "staging" | "production" {
  return new URL(apiBase).hostname.includes("staging") ? "staging" : "production"
}

function databaseNameForBinding(input: {
  bindingName: string
  environment: "staging" | "production"
}): string {
  const raw = readFileSync(shardWranglerConfig, "utf8")
  const config = JSON.parse(stripJsonComments(raw)) as {
    d1_databases?: Array<{ binding?: string; database_name?: string }>
    env?: Record<string, { d1_databases?: Array<{ binding?: string; database_name?: string }> }>
  }
  const databases = input.environment === "production"
    ? config.env?.production?.d1_databases
    : config.d1_databases
  const match = databases?.find((entry) => entry.binding === input.bindingName)
  if (!match?.database_name) {
    fail(prefix, `no D1 database_name found for ${input.bindingName} in ${input.environment} shard config`)
  }
  return match!.database_name!
}

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

type D1ExecuteResult = {
  meta: Json
  rows: Json[]
}

function parseWranglerResult(stdout: string): D1ExecuteResult {
  const parsed = JSON.parse(stdout) as unknown
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (!first || typeof first !== "object") {
    fail(prefix, `wrangler d1 execute returned an unexpected payload: ${stdout.slice(0, 500)}`)
  }
  const result = first as { meta?: unknown; results?: unknown; success?: unknown }
  if (result.success === false) {
    fail(prefix, `wrangler d1 execute failed: ${stdout.slice(0, 1000)}`)
  }
  return {
    meta: result.meta && typeof result.meta === "object" && !Array.isArray(result.meta) ? result.meta as Json : {},
    rows: Array.isArray(result.results) ? result.results as Json[] : [],
  }
}

function runD1(input: {
  command: string
  databaseName: string
  environment: "staging" | "production"
}): D1ExecuteResult {
  const args = [
    "--config",
    shardWranglerConfig,
    "d1",
    "execute",
    input.databaseName,
    "--remote",
    "--command",
    input.command,
    "--json",
  ]
  if (input.environment === "production") {
    args.push("--env", "production")
  }
  const result = spawnSync(wranglerBin, args, {
    cwd: serviceRoot,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    fail(prefix, `wrangler d1 execute failed (${result.status}): ${result.stderr || result.stdout}`)
  }
  return parseWranglerResult(result.stdout)
}

async function getRoutingRow(communityId: string): Promise<RoutingRow> {
  const sql = new SQL(sqlUrl())
  try {
    const rows = await sql`
      SELECT binding_name, shard_worker_id
      FROM community_database_routing
      WHERE community_id = ${communityId}
      LIMIT 1
    `
    const row = rows[0] as Record<string, unknown> | undefined
    if (!row) fail(prefix, `missing community_database_routing row for ${communityId}`)
    const safeRow = row as Record<string, unknown>
    const bindingName = asString(safeRow.binding_name, "routing.binding_name", prefix)
    const shardWorkerId = asString(safeRow.shard_worker_id, "routing.shard_worker_id", prefix)
    return { binding_name: bindingName, shard_worker_id: shardWorkerId }
  } finally {
    await sql.close()
  }
}

function asStudyPayload(value: Json): StudyPayload {
  return value as StudyPayload
}

function findSayItBackExercise(payload: StudyPayload, exerciseId?: string): StudyExercise {
  if (payload.access !== "ready") {
    fail(prefix, `study payload access=${String(payload.access)}; expected ready`)
  }
  const exercises = Array.isArray(payload.exercises) ? payload.exercises : []
  const candidates = exercises
    .filter((exercise): exercise is StudyExercise =>
      Boolean(exercise)
      && typeof exercise === "object"
      && (exercise as { type?: unknown }).type === "say_it_back"
      && typeof (exercise as { id?: unknown }).id === "string"
      && typeof (exercise as { line_id?: unknown }).line_id === "string")
  const selected = exerciseId
    ? candidates.find((exercise) => exercise.id === exerciseId)
    : candidates[0]
  if (!selected) {
    fail(prefix, exerciseId
      ? `study pack did not include say_it_back exercise ${exerciseId}`
      : "study pack did not include any say_it_back exercise; seed/choose a post whose say_it_back_status is ready")
  }
  const safeSelected = selected as StudyExercise
  if (!safeSelected.reference_text?.trim()) {
    fail(prefix, `say_it_back exercise ${safeSelected.id} has no reference_text`)
  }
  return safeSelected
}

function nearMissFor(reference: string): string {
  const words = reference.trim().split(/\s+/u)
  if (words.length <= 1) return `${reference} smoke`
  return [...words.slice(0, -1), "smoke"].join(" ")
}

async function submitSayItBack(input: {
  apiBase: string
  publicCommunityId: string
  publicPostId: string
  token: string
  exercise: StudyExercise
  transcript: string
  targetLanguage?: string | null
  suffix: string
}): Promise<Json> {
  return await requestJson({
    url: `${input.apiBase}/communities/${encodeURIComponent(input.publicCommunityId)}/posts/${encodeURIComponent(input.publicPostId)}/study/attempts`,
    token: input.token,
    prefix,
    body: {
      exercise_id: input.exercise.id,
      idempotency_key: `study-say-it-back-smoke:${input.exercise.id}:${input.suffix}`,
      attempt_number: 1,
      target_language: input.targetLanguage ?? null,
      transcript: input.transcript,
      type: "say_it_back",
    },
  })
}

function latestAttempt(input: {
  databaseName: string
  environment: "staging" | "production"
  idempotencyKey: string
}): AttemptRow {
  const { rows } = runD1({
    databaseName: input.databaseName,
    environment: input.environment,
    command: `
      SELECT user_id, post_id, exercise_id, line_id, exercise_type, target_language
      FROM song_study_attempt
      WHERE idempotency_key = ${quoteSql(input.idempotencyKey)}
      LIMIT 1
    `,
  })
  const row = rows[0] as Partial<AttemptRow> | undefined
  if (!row) fail(prefix, `could not find attempt row for ${input.idempotencyKey}`)
  const safeRow = row as Partial<AttemptRow>
  for (const key of ["user_id", "post_id", "exercise_id", "line_id", "exercise_type", "target_language"] as const) {
    if (typeof safeRow[key] !== "string" || !safeRow[key]) {
      fail(prefix, `attempt row missing ${key}: ${JSON.stringify(safeRow)}`)
    }
  }
  return safeRow as AttemptRow
}

function forceReviewDue(input: {
  attempt: AttemptRow
  databaseName: string
  environment: "staging" | "production"
}): void {
  const now = new Date()
  const dueAt = new Date(now.getTime() - 60_000).toISOString()
  const updatedAt = now.toISOString()
  const result = runD1({
    databaseName: input.databaseName,
    environment: input.environment,
    command: `
      UPDATE song_study_review_state
      SET due_at = ${quoteSql(dueAt)}, updated_at = ${quoteSql(updatedAt)}
      WHERE user_id = ${quoteSql(input.attempt.user_id)}
        AND post_id = ${quoteSql(input.attempt.post_id)}
        AND line_id = ${quoteSql(input.attempt.line_id)}
        AND exercise_type = 'say_it_back'
        AND target_language = ${quoteSql(input.attempt.target_language)}
    `,
  })
  if (Number(result.meta.changes ?? 0) === 0) {
    fail(prefix, `force-due update touched 0 rows for ${JSON.stringify(input.attempt)}`)
  }
}

function assertActivityTimezone(input: {
  attempt: AttemptRow
  databaseName: string
  environment: "staging" | "production"
}): string {
  const { rows } = runD1({
    databaseName: input.databaseName,
    environment: input.environment,
    command: `
      SELECT activity_timezone
      FROM song_engagement_days
      WHERE user_id = ${quoteSql(input.attempt.user_id)}
        AND post_id = ${quoteSql(input.attempt.post_id)}
      ORDER BY updated_at DESC
      LIMIT 1
    `,
  })
  const timezone = rows[0]?.activity_timezone
  if (typeof timezone !== "string" || !timezone.includes("/")) {
    fail(prefix, `expected non-null IANA activity_timezone, got ${JSON.stringify(rows[0] ?? null)}`)
  }
  return timezone
}

const apiBase = (
  arg("api-base")
  ?? process.env.PIRATE_SMOKE_API_BASE_URL
  ?? process.env.PIRATE_API_BASE_URL
  ?? "https://api-staging.pirate.sc"
).replace(/\/$/u, "")
assertStagingOrAllowed(apiBase)

const environment = shardEnvironment(apiBase)
const publicCommunityId = publicId(asString(arg("community"), "--community", prefix), "com")
const communityId = bareId(publicCommunityId, "com")
const publicPostId = publicId(asString(arg("post"), "--post", prefix), "post")
const exerciseId = arg("exercise")
const runId = Date.now().toString(36)
const subject = arg("subject") ?? process.env.PIRATE_SMOKE_SUBJECT ?? `study-say-it-back-smoke-${runId}`
const token = arg("token") ?? await mintSmokeAccessToken({ apiBase, subject, prefix })

if (environment === "production" && !hasFlag("--allow-prod-force-due")) {
  fail(prefix, "refusing prod D1 force-due; pass --allow-prod --allow-prod-force-due explicitly")
}

console.log(`[${prefix}] target`, { apiBase, publicCommunityId, publicPostId, subject })

const routing = await getRoutingRow(communityId)
const databaseName = databaseNameForBinding({ bindingName: routing.binding_name, environment })
console.log(`[${prefix}] shard`, {
  bindingName: routing.binding_name,
  databaseName,
  shardWorkerId: routing.shard_worker_id,
})

const initialStudy = asStudyPayload(await requestJson({
  method: "GET",
  url: `${apiBase}/communities/${encodeURIComponent(publicCommunityId)}/posts/${encodeURIComponent(publicPostId)}/study`,
  token,
  prefix,
}))
const firstExercise = findSayItBackExercise(initialStudy, exerciseId)
const reference = firstExercise.reference_text!.trim()
const nearMiss = arg("near-miss") ?? nearMissFor(reference)
const correctTranscript = arg("correct") ?? reference
const targetLanguage = firstExercise.target_language ?? initialStudy.target_language ?? null
const firstIdempotencyKey = `study-say-it-back-smoke:${firstExercise.id}:near:${runId}`
console.log(`[${prefix}] exercise`, { exerciseId: firstExercise.id, lineId: firstExercise.line_id, targetLanguage })

const firstAttempt = await requestJson({
  url: `${apiBase}/communities/${encodeURIComponent(publicCommunityId)}/posts/${encodeURIComponent(publicPostId)}/study/attempts`,
  token,
  prefix,
  body: {
    exercise_id: firstExercise.id,
    idempotency_key: firstIdempotencyKey,
    attempt_number: 1,
    target_language: targetLanguage,
    transcript: nearMiss,
    type: "say_it_back",
  },
})
if (firstAttempt.outcome !== "incorrect" || firstAttempt.next_review_hint !== "again") {
  fail(prefix, `near-miss expected incorrect/again, got ${JSON.stringify(firstAttempt)}`)
}
console.log(`[${prefix}] near-miss accepted as recovery`, {
  outcome: firstAttempt.outcome,
  nextReviewHint: firstAttempt.next_review_hint,
})

const attemptRow = latestAttempt({ databaseName, environment, idempotencyKey: firstIdempotencyKey })
forceReviewDue({ attempt: attemptRow, databaseName, environment })
console.log(`[${prefix}] forced review due`, { exerciseId: attemptRow.exercise_id, lineId: attemptRow.line_id })

const dueStudy = asStudyPayload(await requestJson({
  method: "GET",
  url: `${apiBase}/communities/${encodeURIComponent(publicCommunityId)}/posts/${encodeURIComponent(publicPostId)}/study`,
  token,
  prefix,
}))
const dueExercise = findSayItBackExercise(dueStudy, firstExercise.id)
if (dueExercise.id !== firstExercise.id) {
  fail(prefix, `expected re-served exercise ${firstExercise.id}, got ${dueExercise.id}`)
}
console.log(`[${prefix}] exercise re-served`, { exerciseId: dueExercise.id })

const secondAttempt = await submitSayItBack({
  apiBase,
  publicCommunityId,
  publicPostId,
  token,
  exercise: dueExercise,
  transcript: correctTranscript,
  targetLanguage,
  suffix: `correct:${runId}`,
})
if (secondAttempt.outcome !== "correct") {
  fail(prefix, `correct recovery attempt expected correct, got ${JSON.stringify(secondAttempt)}`)
}
console.log(`[${prefix}] recovery attempt succeeded`, {
  outcome: secondAttempt.outcome,
  qualifiedToday: asObject(secondAttempt.study_progress, "study_progress", prefix).qualified_today ?? null,
})

const activityTimezone = assertActivityTimezone({ attempt: attemptRow, databaseName, environment })
console.log(`[${prefix}] activity timezone recorded`, { activityTimezone })
console.log(`[${prefix}] PASS`, {
  exerciseId: firstExercise.id,
  databaseName,
  activityTimezone,
})
