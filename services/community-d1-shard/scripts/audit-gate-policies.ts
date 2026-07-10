/**
 * Read-only inventory of membership gate policies stored in community D1 shards.
 *
 * The default target is staging. Production requires --allow-production-read so
 * reviewing/running the staging command cannot accidentally cross environments.
 */

export const POOL_SQL = `SELECT binding_name, community_id
FROM d1_pool
WHERE community_id IS NOT NULL
ORDER BY binding_name`

export const SCHEMA_SQL = `SELECT name
FROM sqlite_master
WHERE type = 'table' AND name = 'community_gate_policies'`

export const POLICY_SQL = `SELECT scope, expression_json
FROM community_gate_policies
WHERE scope = 'membership'
ORDER BY scope
LIMIT 20`

type Environment = "staging" | "production"

type Options = {
  environment: Environment
  concurrency: number
  timeoutMs: number
  allowProductionRead: boolean
}

type PoolRow = { binding_name: string; community_id: string }
type PolicyRow = { scope: string; expression_json: unknown }

type Atom = { type?: unknown }
type Expression =
  | { op: "gate"; gate: Atom }
  | { op: "and" | "or"; children: Expression[] }

export type PolicyFinding = {
  community_id: string
  binding_name: string
  database_name: string
  schema_present: boolean
  policy_count: number
  gate_types: string[]
  erc721_holding: boolean
  erc721_inventory_match: boolean
  mixed_operators: boolean
  pow_only: boolean
  captcha_alone_admits: boolean
  single_child_operator: boolean
  invalid_expression: boolean
}

export type ShardFailure = {
  community_id: string
  binding_name: string
  database_name: string
  stage: "schema" | "policy"
  error_code: "timeout" | "wrangler_exit" | "invalid_json" | "d1_query_failed" | "unexpected_error"
}

class InventoryError extends Error {
  constructor(readonly code: ShardFailure["error_code"], message: string) {
    super(message)
  }
}

type D1Result = { results?: unknown[]; success?: boolean; error?: string }

export function databaseNameForBinding(bindingName: string, environment: Environment): string {
  const suffix = environment === "production" ? "prod" : "staging"
  if (bindingName === "DB_CMTY_PILOT" && environment === "staging") return "cmty-pilot-staging"
  if (bindingName === "DB_CMTY_FIXTURE" && environment === "staging") return "cmty-d1-fixture-staging"
  const match = /^DB_CMTY_(\d{4})$/u.exec(bindingName)
  if (!match) throw new Error(`unsupported shard binding name: ${bindingName}`)
  return `community-d1-pool-${match[1]}-${suffix}`
}

function readExpression(value: unknown): Expression | null {
  let parsed: unknown = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const candidate = record.expression && typeof record.expression === "object"
    ? record.expression
    : parsed
  return isExpression(candidate) ? candidate : null
}

function isExpression(value: unknown): value is Expression {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.op === "gate") {
    return Boolean(record.gate && typeof record.gate === "object" && !Array.isArray(record.gate))
  }
  if (record.op !== "and" && record.op !== "or") return false
  return Array.isArray(record.children) && record.children.every(isExpression)
}

function collectExpression(expression: Expression, state: {
  gateTypes: Set<string>
  operators: Set<"and" | "or">
  singleChildOperator: boolean
}): void {
  if (expression.op === "gate") {
    if (typeof expression.gate.type === "string") state.gateTypes.add(expression.gate.type)
    return
  }
  state.operators.add(expression.op)
  if (expression.children.length === 1) state.singleChildOperator = true
  for (const child of expression.children) collectExpression(child, state)
}

export function evaluateCaptchaAlone(expression: Expression): boolean {
  if (expression.op === "gate") return expression.gate.type === "altcha_pow"
  if (expression.op === "and") return expression.children.every(evaluateCaptchaAlone)
  return expression.children.some(evaluateCaptchaAlone)
}

export function analyzePolicies(input: {
  communityId: string
  bindingName: string
  databaseName: string
  rows: PolicyRow[]
  schemaPresent?: boolean
}): PolicyFinding {
  const gateTypes = new Set<string>()
  const operators = new Set<"and" | "or">()
  let singleChildOperator = false
  let invalidExpression = false
  let captchaAloneAdmits = false

  for (const row of input.rows) {
    const expression = readExpression(row.expression_json)
    if (!expression) {
      invalidExpression = true
      continue
    }
    const state = { gateTypes, operators, singleChildOperator }
    collectExpression(expression, state)
    singleChildOperator ||= state.singleChildOperator
    captchaAloneAdmits ||= evaluateCaptchaAlone(expression)
  }

  const sortedGateTypes = Array.from(gateTypes).sort()
  return {
    community_id: input.communityId,
    binding_name: input.bindingName,
    database_name: input.databaseName,
    schema_present: input.schemaPresent ?? true,
    policy_count: input.rows.length,
    gate_types: sortedGateTypes,
    erc721_holding: gateTypes.has("erc721_holding"),
    erc721_inventory_match: gateTypes.has("erc721_inventory_match"),
    mixed_operators: operators.has("and") && operators.has("or"),
    pow_only: sortedGateTypes.length === 1 && sortedGateTypes[0] === "altcha_pow" && captchaAloneAdmits,
    captcha_alone_admits: captchaAloneAdmits,
    single_child_operator: singleChildOperator,
    invalid_expression: invalidExpression,
  }
}

export function parseWranglerRows<T>(stdout: string): T[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout) as unknown
  } catch {
    throw new InventoryError("invalid_json", `wrangler returned invalid JSON (${stdout.length} bytes)`)
  }
  const envelopes = Array.isArray(parsed) ? parsed : [parsed]
  const rows: T[] = []
  for (const envelope of envelopes) {
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) continue
    const result = envelope as D1Result
    if (result.success === false) throw new InventoryError("d1_query_failed", "D1 query failed")
    if (Array.isArray(result.results)) rows.push(...result.results as T[])
  }
  return rows
}

async function runWranglerD1(databaseName: string, sql: string, timeoutMs: number): Promise<string> {
  const process = Bun.spawn([
    "bunx",
    "wrangler",
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--command",
    sql,
    "--json",
  ], { stdout: "pipe", stderr: "pipe" })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    process.kill()
  }, timeoutMs)
  const [stdout, , exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]).finally(() => clearTimeout(timer))
  if (timedOut) throw new InventoryError("timeout", `wrangler timed out after ${timeoutMs}ms`)
  if (exitCode !== 0) {
    throw new InventoryError("wrangler_exit", `wrangler exited ${exitCode}`)
  }
  return stdout
}

function errorCode(error: unknown): ShardFailure["error_code"] {
  return error instanceof InventoryError ? error.code : "unexpected_error"
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await task(items[index]!)
    }
  }))
  return results
}

export function parseOptions(argv: string[]): Options {
  const environmentValue = argv.find((_, index) => argv[index - 1] === "--environment") ?? "staging"
  if (environmentValue !== "staging" && environmentValue !== "production") {
    throw new Error("--environment must be staging or production")
  }
  const concurrency = Number(argv.find((_, index) => argv[index - 1] === "--concurrency") ?? "3")
  const timeoutMs = Number(argv.find((_, index) => argv[index - 1] === "--timeout-ms") ?? "15000")
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error("--concurrency must be an integer from 1 to 5")
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) {
    throw new Error("--timeout-ms must be an integer from 1000 to 60000")
  }
  const allowProductionRead = argv.includes("--allow-production-read")
  if (environmentValue === "production" && !allowProductionRead) {
    throw new Error("production inventory requires --allow-production-read after explicit authorization")
  }
  return { environment: environmentValue, concurrency, timeoutMs, allowProductionRead }
}

async function main(): Promise<void> {
  const options = parseOptions(Bun.argv.slice(2))
  const suffix = options.environment === "production" ? "prod" : "staging"
  const poolDatabase = `community-d1-shard-pool-${suffix}`
  const poolRows = parseWranglerRows<PoolRow>(await runWranglerD1(poolDatabase, POOL_SQL, options.timeoutMs))

  const failures: ShardFailure[] = []
  const findings = (await mapConcurrent(poolRows, options.concurrency, async (poolRow) => {
    const databaseName = databaseNameForBinding(poolRow.binding_name, options.environment)
    try {
      const schemaRows = parseWranglerRows<{ name: string }>(
        await runWranglerD1(databaseName, SCHEMA_SQL, options.timeoutMs),
      )
      if (schemaRows.length === 0) {
        return analyzePolicies({
          communityId: poolRow.community_id,
          bindingName: poolRow.binding_name,
          databaseName,
          rows: [],
          schemaPresent: false,
        })
      }
      try {
        const policyRows = parseWranglerRows<PolicyRow>(
          await runWranglerD1(databaseName, POLICY_SQL, options.timeoutMs),
        )
        return analyzePolicies({
          communityId: poolRow.community_id,
          bindingName: poolRow.binding_name,
          databaseName,
          rows: policyRows,
        })
      } catch (error) {
        failures.push({
          community_id: poolRow.community_id,
          binding_name: poolRow.binding_name,
          database_name: databaseName,
          stage: "policy",
          error_code: errorCode(error),
        })
      }
    } catch (error) {
      failures.push({
        community_id: poolRow.community_id,
        binding_name: poolRow.binding_name,
        database_name: databaseName,
        stage: "schema",
        error_code: errorCode(error),
      })
    }
    return null
  })).filter((finding): finding is PolicyFinding => finding !== null)

  const actionable = findings.filter((finding) => (
    finding.erc721_holding
    || finding.erc721_inventory_match
    || finding.mixed_operators
    || finding.pow_only
    || finding.captcha_alone_admits
    || finding.single_child_operator
    || finding.invalid_expression
    || !finding.schema_present
  ))
  console.log(JSON.stringify({
    environment: options.environment,
    read_only: true,
    sql: { pool: POOL_SQL, schema: SCHEMA_SQL, policies: POLICY_SQL },
    request_profile: {
      allocated_shards: poolRows.length,
      max_requests: 1 + (poolRows.length * 2),
      concurrency: options.concurrency,
      timeout_ms: options.timeoutMs,
      retries: 0,
    },
    totals: {
      allocated_shards: poolRows.length,
      queried_shards: findings.length,
      failures: failures.length,
      missing_gate_policy_schema: findings.filter((finding) => !finding.schema_present).length,
      policies: findings.reduce((sum, finding) => sum + finding.policy_count, 0),
      erc721_holding: findings.filter((finding) => finding.erc721_holding).length,
      erc721_inventory_match: findings.filter((finding) => finding.erc721_inventory_match).length,
      mixed_operators: findings.filter((finding) => finding.mixed_operators).length,
      pow_only: findings.filter((finding) => finding.pow_only).length,
      captcha_alone_admits: findings.filter((finding) => finding.captcha_alone_admits).length,
      single_child_operator: findings.filter((finding) => finding.single_child_operator).length,
      invalid_expression: findings.filter((finding) => finding.invalid_expression).length,
    },
    actionable,
    failures,
  }, null, 2))
}

if (import.meta.main) {
  void main()
}
