#!/usr/bin/env bun

import { spawn } from "bun"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import type { Env } from "../src/env"
import {
  isPostgresControlPlaneUrl,
  withStandaloneControlPlaneClient,
} from "../src/lib/runtime-deps"
import {
  classifyReclamationCandidate,
  parseBindingAllowlist,
  poolDatabaseIdFromConfig,
  resolveReclamationInventoryScope,
  type CandidateDecision,
  type ReclamationInventoryScope,
  type SignatureEvidence,
} from "./_lib/staging-d1-reclamation-inventory"
import { isMachineGeneratedStagingSmokeName } from "../src/lib/communities/staging-smoke-signatures"

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]?.trim()
}

async function poolDatabaseId(environment: "staging" | "prod"): Promise<string> {
  const configPath = resolve(import.meta.dir, "../../community-d1-shard/wrangler.jsonc")
  return poolDatabaseIdFromConfig(await readFile(configPath, "utf8"), environment)
}

async function queryPoolRows(scope: ReclamationInventoryScope): Promise<Array<Record<string, unknown>>> {
  const label = scope.environment
  const poolDatabaseName = scope.environment === "prod"
    ? "community-d1-shard-pool-prod"
    : "community-d1-shard-pool-staging"
  const accountId = String(process.env.CLOUDFLARE_ACCOUNT_ID ?? "").trim()
  const token = String(process.env.CLOUDFLARE_D1_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN ?? "").trim()
  const sql = "SELECT binding_name, community_id, version, allocated_at, last_loaded_at, last_error, released_at FROM d1_pool ORDER BY binding_name"
  if (!accountId || !token) {
    const shardDir = resolve(import.meta.dir, "../../community-d1-shard")
    const child = spawn([
      "bunx",
      "wrangler",
      "d1",
      "execute",
      poolDatabaseName,
      "--remote",
      "--json",
      "--command",
      sql,
    ], { cwd: shardDir, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`${label} D1_POOL Wrangler read failed: ${stderr.trim()}`)
    const payload = JSON.parse(stdout) as Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>
    if (payload[0]?.success !== true) throw new Error(`${label} D1_POOL Wrangler read did not report success`)
    return payload[0].results ?? []
  }
  const databaseId = await poolDatabaseId(scope.environment)
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sql }),
    },
  )
  const payload = await response.json() as {
    success?: boolean
    errors?: unknown[]
    result?: Array<{ success?: boolean; results?: Array<Record<string, unknown>> }>
  }
  if (!response.ok || payload.success !== true || payload.result?.[0]?.success !== true) {
    throw new Error(`${label} D1_POOL read failed: HTTP ${response.status} ${JSON.stringify(payload.errors ?? [])}`)
  }
  return payload.result[0]?.results ?? []
}

async function main(): Promise<void> {
  // Scoped gate: the --prod allowance is { environment: "prod",
  // mode: "inventory-readonly" } and is consumed ONLY by this read-only
  // inventory below. It is never written to process.env; a future
  // reclaim/release/delete path must define its own guard, not reuse this one.
  const scope = resolveReclamationInventoryScope(process.argv, process.env)
  const allowlistPath = option("--allowlist")
  let evidence: SignatureEvidence = { mode: "staging" }
  if (scope.environment === "prod") {
    console.error("=".repeat(72))
    console.error("PROD RECLAMATION INVENTORY — READ-ONLY")
    console.error("Target: PRODUCTION D1 pool + PRODUCTION control plane.")
    console.error("This run inventories and classifies only; it cannot reclaim,")
    console.error("release, or delete anything. Classification is restricted to the")
    console.error("--allowlist cohort; staging smoke signatures are NOT prod evidence.")
    console.error("=".repeat(72))
    if (!allowlistPath) throw new Error("prod_reclamation_inventory_requires_allowlist")
    evidence = {
      mode: "prod-allowlist",
      allowlist: parseBindingAllowlist(await readFile(resolve(allowlistPath), "utf8")),
    }
  } else if (allowlistPath) {
    throw new Error("reclamation_inventory_allowlist_requires_prod_opt_in")
  }
  const databaseUrl = String(
    process.env.CONTROL_PLANE_MIGRATOR_DATABASE_URL
      ?? process.env.CONTROL_PLANE_DATABASE_URL
      ?? "",
  ).trim()
  if (!isPostgresControlPlaneUrl(databaseUrl)) {
    throw new Error(`${scope.environment}_control_plane_database_url_must_be_postgres`)
  }
  const [poolRows, controlRows] = await Promise.all([
    queryPoolRows(scope),
    withStandaloneControlPlaneClient({
      ...process.env,
      CONTROL_PLANE_DATABASE_URL: databaseUrl,
    } as unknown as Env, async (client) => {
      const result = await client.execute({
        sql: `
          SELECT c.community_id, c.creator_user_id, c.display_name, c.description,
                 c.status AS community_status, c.provisioning_state AS community_provisioning_state,
                 c.created_at AS community_created_at, r.binding_name,
                 r.provisioning_state, r.decommissioned_at,
                 (SELECT COUNT(*) FROM jobs j
                   WHERE j.community_id = c.community_id
                     AND j.status IN ('queued', 'running')) AS active_jobs,
                 (SELECT COUNT(*) FROM community_post_projections p
                   WHERE p.community_id = c.community_id) AS post_count,
                 (SELECT COUNT(*) FROM comment_projections p
                   WHERE p.community_id = c.community_id) AS comment_count,
                 (SELECT COUNT(*) FROM community_membership_projections m
                   WHERE m.community_id = c.community_id AND m.membership_state = 'member'
                     AND m.user_id <> c.creator_user_id) AS non_owner_member_count,
                 (SELECT STRING_AGG(a.provider || ':' || a.provider_subject, ',' ORDER BY a.provider, a.provider_subject)
                   FROM auth_provider_links a
                   WHERE a.user_id = c.creator_user_id AND a.status = 'active') AS creator_auth_subjects
          FROM communities c
          INNER JOIN community_database_routing r ON r.community_id = c.community_id
          ORDER BY c.community_id
        `,
        args: [],
      })
      return result.rows as Array<Record<string, unknown>>
    }),
  ])

  const poolByBinding = new Map(poolRows.map((row) => [String(row.binding_name ?? ""), row]))
  const decisions = controlRows.map((row): CandidateDecision => {
    const bindingName = String(row.binding_name ?? "")
    const pool = poolByBinding.get(bindingName)
    return classifyReclamationCandidate({
      community_id: String(row.community_id ?? ""),
      display_name: String(row.display_name ?? ""),
      description: row.description === null || row.description === undefined ? null : String(row.description),
      community_status: String(row.community_status ?? ""),
      binding_name: bindingName,
      provisioning_state: String(row.provisioning_state ?? ""),
      decommissioned_at: row.decommissioned_at ?? null,
      active_jobs: Number(row.active_jobs ?? 0),
      pool_community_id: pool?.community_id === null || pool?.community_id === undefined
        ? null
        : String(pool.community_id),
      pool_version: pool?.version === null || pool?.version === undefined ? null : Number(pool.version),
      allocated_at: pool?.allocated_at ? String(pool.allocated_at) : null,
      last_loaded_at: pool?.last_loaded_at ? String(pool.last_loaded_at) : null,
      last_error: pool?.last_error ? String(pool.last_error) : null,
      released_at: pool?.released_at ? String(pool.released_at) : null,
    }, evidence)
  })
  const eligible = decisions.filter((row) => row.eligible)
  // Staging: archive inventory is the machine-generated staging smoke names.
  // Prod: staging smoke signatures are not prod evidence, so the inventory is
  // the explicit --allowlist cohort instead.
  const archiveInventory = controlRows
    .filter((row) => evidence.mode === "prod-allowlist"
      ? evidence.allowlist.has(String(row.binding_name ?? ""))
      : isMachineGeneratedStagingSmokeName(String(row.display_name ?? "")))
    .map((row) => ({
      community_id: String(row.community_id ?? ""),
      creator_user_id: String(row.creator_user_id ?? ""),
      creator_auth_subjects: row.creator_auth_subjects === null ? null : String(row.creator_auth_subjects ?? ""),
      display_name: String(row.display_name ?? ""),
      community_status: String(row.community_status ?? ""),
      community_provisioning_state: String(row.community_provisioning_state ?? ""),
      community_created_at: String(row.community_created_at ?? ""),
      binding_name: String(row.binding_name ?? ""),
      active_jobs: Number(row.active_jobs ?? 0),
      post_count: Number(row.post_count ?? 0),
      comment_count: Number(row.comment_count ?? 0),
      non_owner_member_count: Number(row.non_owner_member_count ?? 0),
    }))
  const exclusionCounts: Record<string, number> = {}
  for (const row of decisions) {
    for (const reason of row.exclusions) exclusionCounts[reason] = (exclusionCounts[reason] ?? 0) + 1
  }
  const poolAllocated = poolRows.filter((row) => row.community_id !== null).length
  const poolFree = poolRows.filter((row) => row.community_id === null && !row.released_at).length
  const poolQuarantined = poolRows.filter((row) => row.community_id === null && row.released_at).length
  const artifact = {
    format_version: 1,
    environment: scope.environment,
    ...(scope.environment === "prod"
      ? {
        mode: scope.mode,
        signature_evidence: "prod classification restricted to the --allowlist cohort; staging smoke signatures were not applied as prod evidence",
      }
      : {}),
    observed_at: new Date().toISOString(),
    read_only: true,
    pool: { total: poolRows.length, allocated: poolAllocated, free: poolFree, quarantined: poolQuarantined },
    control_plane_routes: controlRows.length,
    eligible_count: eligible.length,
    archive_inventory_count: archiveInventory.length,
    exclusion_counts: Object.fromEntries(Object.entries(exclusionCounts).sort(([left], [right]) => left.localeCompare(right))),
    archive_inventory: archiveInventory,
    candidates: eligible,
  }
  const output = option("--output")
  if (output) {
    const path = resolve(output)
    await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    await chmod(path, 0o600)
    console.log(JSON.stringify({ ...artifact, archive_inventory: undefined, candidates: undefined, evidence_path: path }, null, 2))
  } else {
    console.log(JSON.stringify(artifact, null, 2))
  }
}

if (import.meta.main) await main()
