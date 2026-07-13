/**
 * Operator script: pre-allocate a pool of D1 databases for D1-native provisioning
 * (workstream step 6, design §3 / §6 prerequisite).
 *
 * D1 has no runtime "create database" API — databases are created out-of-band via
 * `wrangler d1 create` and bound statically. This script creates N pool D1s, emits
 * the `d1_databases` entries to add to the shard's wrangler.jsonc, and the
 * `d1_pool` INSERTs that register them as FREE bindings (community_id NULL).
 *
 * SAFE ORDER (enforced by --apply being a two-phase, operator-gated flow):
 *   1. `wrangler d1 create` × N            (irreversible — creates Cloudflare resources)
 *   2. add the d1_databases entries to wrangler.jsonc + `wrangler deploy` the shard
 *   3. INSERT the free rows into d1_pool    (only AFTER the bindings are deployed, so
 *                                            allocation never picks an unbound binding)
 *
 * Default is DRY-RUN: it prints the plan (names + SQL + config entries) without
 * creating anything. Pass `--apply` to actually run `wrangler d1 create`.
 *
 * The pure helpers below are unit-tested; the live resource creation needs an
 * explicit operator run.
 */

export type PoolBindingPlan = {
  index: number
  /** env binding name on the shard (uppercase identifier). */
  bindingName: string
  /** Cloudflare D1 database name. */
  databaseName: string
}

export type WranglerD1Entry = {
  binding: string
  database_name: string
  database_id: string
}

/** Zero-padded 4-digit pool index → DB_CMTY_0001 / community-d1-pool-0001-staging. */
export function poolBindingName(index: number): string {
  return `DB_CMTY_${String(index).padStart(4, "0")}`
}

export function poolDatabaseName(index: number, envSuffix = "staging"): string {
  return `community-d1-pool-${String(index).padStart(4, "0")}-${envSuffix}`
}

/** Plan `count` pool slots starting at `startIndex` (1-based, contiguous). */
export function planPoolBindings(startIndex: number, count: number, envSuffix = "staging"): PoolBindingPlan[] {
  if (!Number.isInteger(startIndex) || startIndex < 1) throw new Error("startIndex must be a positive integer")
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer")
  return Array.from({ length: count }, (_, i) => {
    const index = startIndex + i
    return { index, bindingName: poolBindingName(index), databaseName: poolDatabaseName(index, envSuffix) }
  })
}

/**
 * Extract the database_id (uuid) from `wrangler d1 create` output. Wrangler prints
 * a config snippet containing `"database_id": "<uuid>"`; we parse defensively
 * rather than rely on a --json flag that varies across wrangler versions.
 */
export function parseD1CreateDatabaseId(output: string): string {
  const byField = output.match(/"database_id"\s*:\s*"([0-9a-f-]{36})"/i)
  if (byField) return byField[1]
  // Fallback: a bare uuid anywhere in the output (created_at lines also carry one;
  // prefer the database_id field above, this is last resort).
  const bareUuid = output.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i)
  if (bareUuid) return bareUuid[0]
  throw new Error("could not parse database_id from wrangler d1 create output")
}

export function buildWranglerD1Entry(plan: PoolBindingPlan, databaseId: string): WranglerD1Entry {
  return { binding: plan.bindingName, database_name: plan.databaseName, database_id: databaseId }
}

/**
 * INSERT OR IGNORE the free pool rows (community_id NULL). Idempotent — re-running
 * with the same bindings is a no-op, so a partial run is safe to retry.
 */
export function buildPoolInsertSql(bindingNames: string[]): string {
  const values = bindingNames.map((b) => `('${b}', NULL, 0)`).join(", ")
  return `INSERT OR IGNORE INTO d1_pool (binding_name, community_id, version) VALUES ${values};`
}

export type AllocatePoolDeps = {
  count: number
  startIndex: number
  envSuffix?: string
  /** Runs `wrangler d1 create <name>` and returns stdout. Injected for testing. */
  runWranglerCreate: (databaseName: string) => Promise<string>
  log: (msg: string) => void
}

export type AllocatePoolResult = {
  created: WranglerD1Entry[]
  poolInsertSql: string
}

/**
 * Create the pool D1s and produce the wrangler.jsonc entries + the d1_pool INSERT.
 * Does NOT patch wrangler.jsonc or run the INSERT itself — it returns them so the
 * operator applies them deliberately (then deploys the shard, then runs the INSERT
 * against the pool D1). Phase 1 (create) is the only side effect here.
 */
export async function allocateD1Pool(deps: AllocatePoolDeps): Promise<AllocatePoolResult> {
  const plans = planPoolBindings(deps.startIndex, deps.count, deps.envSuffix)
  const created: WranglerD1Entry[] = []
  for (const plan of plans) {
    deps.log(`creating ${plan.databaseName} (${plan.bindingName})...`)
    const out = await deps.runWranglerCreate(plan.databaseName)
    const databaseId = parseD1CreateDatabaseId(out)
    created.push(buildWranglerD1Entry(plan, databaseId))
  }
  return { created, poolInsertSql: buildPoolInsertSql(created.map((c) => c.binding)) }
}

// --- CLI entry (operator run) -----------------------------------------------

function parseArgs(argv: string[]): { count: number; start: number; apply: boolean; envSuffix: string } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    count: Number(get("--count") ?? "0"),
    start: Number(get("--start") ?? "0"),
    apply: argv.includes("--apply"),
    envSuffix: get("--env-suffix") ?? "staging",
  }
}

async function runWranglerCreate(databaseName: string): Promise<string> {
  const proc = Bun.spawn(["bunx", "wrangler", "d1", "create", databaseName], { stdout: "pipe", stderr: "pipe" })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  if (proc.exitCode !== 0) throw new Error(`wrangler d1 create ${databaseName} failed: ${err}`)
  return out + err
}

async function main(): Promise<void> {
  const args = parseArgs(Bun.argv.slice(2))
  if (!args.count || !args.start) {
    console.error("usage: bun run scripts/allocate-d1-pool.ts --count N --start M [--apply] [--env-suffix staging]")
    console.error("  --start = next free pool index (1 above the highest DB_CMTY_NNNN already in d1_pool)")
    process.exit(1)
  }

  const plans = planPoolBindings(args.start, args.count, args.envSuffix)

  if (!args.apply) {
    console.log(`DRY-RUN: would create ${args.count} pool D1s (DB_CMTY_${String(args.start).padStart(4, "0")}…):`)
    for (const p of plans) console.log(`  ${p.bindingName}  ←  ${p.databaseName}`)
    console.log("\nPass --apply to create them. After creating + adding the d1_databases entries to")
    console.log("wrangler.jsonc + `wrangler deploy`, run this INSERT against the pool D1:")
    console.log(`  ${buildPoolInsertSql(plans.map((p) => p.bindingName))}`)
    return
  }

  const result = await allocateD1Pool({
    count: args.count,
    startIndex: args.start,
    envSuffix: args.envSuffix,
    runWranglerCreate,
    log: (m) => console.log(m),
  })

  console.log("\n✅ Created. Add these to wrangler.jsonc d1_databases, then `wrangler deploy`:")
  console.log(JSON.stringify(result.created, null, 2))
  console.log("\nTHEN — only after the bindings are deployed — run against the pool D1:")
  console.log(`  bunx wrangler d1 execute community-d1-shard-pool-staging --remote --command "${result.poolInsertSql}"`)
}

if (import.meta.main) {
  await main()
}
