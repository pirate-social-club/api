#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { validateGatePolicy } from "../src/lib/communities/membership/gate-policy-validation"
import type { CommunityRepository } from "../src/lib/communities/community-repository-types"
import type { CommunityRow } from "../src/lib/auth/auth-db-rows"
import type { DocumentProofProvider, GateExpression, GatePolicy } from "../src/lib/communities/membership/gate-types"
import type { Env } from "../src/env"

const DOCUMENT_GATE_TYPES = ["nationality", "minimum_age", "gender"] as const
const DEFAULT_ACCEPTED_PROVIDERS: DocumentProofProvider[] = ["self", "zkpassport"]

type DocumentGateType = typeof DOCUMENT_GATE_TYPES[number]

type Mode = "dry-run" | "apply" | "rollback"

type Options = {
  mode: Mode
  databaseUrlEnv: string
  communities: string[]
  allEligible: boolean
  allSnapshot: boolean
  includeSelfOnly: boolean
  snapshotPath: string | null
}

type CommunityPolicyRow = {
  version: number
  expression_json: unknown
}

export type DocumentProviderMigrationResult = {
  changed: boolean
  gateTypes: DocumentGateType[]
  policy: GatePolicy
}

type EligiblePolicy = {
  communityId: string
  displayName: string
  routeSlug: string | null
  previousPolicy: GatePolicy
  nextPolicy: GatePolicy
  gateTypes: DocumentGateType[]
  previousHash: string
  nextHash: string
}

type SnapshotEntry = {
  migration: "community-document-providers-v1"
  migrated_at: string
  community_id: string
  display_name: string
  route_slug: string | null
  scope: "membership"
  gate_types: DocumentGateType[]
  previous_policy_hash: string
  next_policy_hash: string
  previous_expression_json: GatePolicy
  next_expression_json: GatePolicy
}

function usage(exitCode = 1): never {
  console.error(`Usage:
  bun scripts/community-document-providers-migration.ts --database-url-env ENV_NAME --dry-run [--community cmt_...]
  bun scripts/community-document-providers-migration.ts --database-url-env ENV_NAME --apply --community cmt_... [--snapshot FILE]
  bun scripts/community-document-providers-migration.ts --database-url-env ENV_NAME --apply --all-eligible [--snapshot FILE]
  bun scripts/community-document-providers-migration.ts --database-url-env ENV_NAME --rollback --snapshot FILE --community cmt_...
  bun scripts/community-document-providers-migration.ts --database-url-env ENV_NAME --rollback --snapshot FILE --all-snapshot

Adds accepted_providers ["self", "zkpassport"] to membership document gates.
By default only gates with missing accepted_providers are changed. Use --include-self-only to also
upgrade explicit accepted_providers ["self"].`)
  process.exit(exitCode)
}

function parseArgs(argv: string[]): Options {
  let mode: Mode | null = null
  let databaseUrlEnv = "CONTROL_PLANE_DATABASE_URL"
  const communities: string[] = []
  let allEligible = false
  let allSnapshot = false
  let includeSelfOnly = false
  let snapshotPath: string | null = null

  for (let index = 0; index < argv.length;) {
    const arg = argv[index]
    switch (arg) {
      case "--dry-run":
        mode = selectMode(mode, "dry-run")
        index += 1
        break
      case "--apply":
        mode = selectMode(mode, "apply")
        index += 1
        break
      case "--rollback":
        mode = selectMode(mode, "rollback")
        index += 1
        break
      case "--database-url-env":
        databaseUrlEnv = argv[index + 1] ?? ""
        index += 2
        break
      case "--community":
        for (const ref of (argv[index + 1] ?? "").split(",")) {
          const community = normalizeCommunityRef(ref)
          if (community) communities.push(community)
        }
        index += 2
        break
      case "--all-eligible":
        allEligible = true
        index += 1
        break
      case "--all-snapshot":
        allSnapshot = true
        index += 1
        break
      case "--include-self-only":
        includeSelfOnly = true
        index += 1
        break
      case "--snapshot":
        snapshotPath = resolve(argv[index + 1] ?? "")
        index += 2
        break
      case "-h":
      case "--help":
        usage(0)
        break
      default:
        console.error(`unknown argument: ${arg}`)
        usage()
    }
  }

  if (!mode || !databaseUrlEnv) usage()
  if (mode === "apply" && communities.length === 0 && !allEligible) {
    console.error("--apply without --community requires --all-eligible")
    usage()
  }
  if (mode === "rollback" && !snapshotPath) {
    console.error("--rollback requires --snapshot")
    usage()
  }
  if (mode === "rollback" && communities.length === 0 && !allSnapshot) {
    console.error("--rollback without --community requires --all-snapshot")
    usage()
  }
  if (allEligible && communities.length > 0) {
    console.error("--all-eligible cannot be combined with --community")
    usage()
  }
  if (allSnapshot && communities.length > 0) {
    console.error("--all-snapshot cannot be combined with --community")
    usage()
  }

  return {
    mode,
    databaseUrlEnv,
    communities: Array.from(new Set(communities)),
    allEligible,
    allSnapshot,
    includeSelfOnly,
    snapshotPath,
  }
}

function selectMode(current: Mode | null, next: Mode): Mode {
  if (current && current !== next) {
    console.error("choose exactly one mode: --dry-run, --apply, or --rollback")
    usage()
  }
  return next
}

function normalizeCommunityRef(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith("com_cmt_") ? trimmed.slice("com_".length) : trimmed
}

function stablePolicyHash(policy: GatePolicy): string {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex")
}

function parsePolicy(value: unknown): GatePolicy {
  const parsed = typeof value === "string" ? JSON.parse(value) : value
  validateGatePolicy(parsed)
  return parsed as GatePolicy
}

function hasDocumentGateType(value: unknown): value is DocumentGateType {
  return DOCUMENT_GATE_TYPES.includes(value as DocumentGateType)
}

function shouldAddAcceptedProviders(gate: Record<string, unknown>, includeSelfOnly: boolean): boolean {
  if (!("accepted_providers" in gate) || gate.accepted_providers == null) {
    return true
  }
  return includeSelfOnly
    && Array.isArray(gate.accepted_providers)
    && gate.accepted_providers.length === 1
    && gate.accepted_providers[0] === "self"
}

function transformExpression(
  expression: GateExpression,
  gateTypes: Set<DocumentGateType>,
  includeSelfOnly: boolean,
): { expression: GateExpression; changed: boolean } {
  if (expression.op === "and" || expression.op === "or") {
    let changed = false
    const children = expression.children.map((child) => {
      const result = transformExpression(child, gateTypes, includeSelfOnly)
      changed ||= result.changed
      return result.expression
    })
    return changed ? { expression: { ...expression, children }, changed } : { expression, changed: false }
  }

  const gate = expression.gate as Record<string, unknown>
  if (
    hasDocumentGateType(gate.type)
    && gate.provider === "self"
    && shouldAddAcceptedProviders(gate, includeSelfOnly)
  ) {
    gateTypes.add(gate.type)
    return {
      expression: {
        op: "gate",
        gate: {
          ...expression.gate,
          accepted_providers: DEFAULT_ACCEPTED_PROVIDERS,
        },
      },
      changed: true,
    }
  }
  return { expression, changed: false }
}

export function addZkPassportAcceptedProviders(
  input: GatePolicy,
  options: { includeSelfOnly?: boolean } = {},
): DocumentProviderMigrationResult {
  validateGatePolicy(input)
  const gateTypes = new Set<DocumentGateType>()
  const result = transformExpression(input.expression, gateTypes, options.includeSelfOnly === true)
  if (!result.changed) {
    return { changed: false, gateTypes: [], policy: input }
  }
  const nextPolicy = { version: input.version, expression: result.expression } satisfies GatePolicy
  validateGatePolicy(nextPolicy)
  return {
    changed: true,
    gateTypes: Array.from(gateTypes).sort((left, right) => left.localeCompare(right)),
    policy: nextPolicy,
  }
}

function formatGateTypes(gateTypes: DocumentGateType[]): string {
  return gateTypes.join(",")
}

function formatCommunityRef(item: Pick<EligiblePolicy, "communityId" | "routeSlug">): string {
  return item.routeSlug ? `${item.communityId} (/c/${item.routeSlug})` : item.communityId
}

function printPlan(items: EligiblePolicy[], mode: "dry-run" | "apply"): void {
  if (items.length === 0) {
    console.log("No eligible membership document gates found.")
    return
  }
  console.log("community_id | display_name | gate_types | action")
  for (const item of items) {
    console.log([
      formatCommunityRef(item),
      item.displayName,
      formatGateTypes(item.gateTypes),
      mode === "apply" ? "apply accepted_providers self,zkpassport" : "would add accepted_providers self,zkpassport",
    ].join(" | "))
  }
  console.log("")
  console.log(`${items.length} ${items.length === 1 ? "row" : "rows"} ${mode === "apply" ? "eligible" : "would be affected"}.`)
}

function makeSnapshotPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/gu, "-")
  return resolve(`community-document-providers-migration-${timestamp}.jsonl`)
}

function snapshotLine(item: EligiblePolicy, migratedAt: string): string {
  const entry: SnapshotEntry = {
    migration: "community-document-providers-v1",
    migrated_at: migratedAt,
    community_id: item.communityId,
    display_name: item.displayName,
    route_slug: item.routeSlug,
    scope: "membership",
    gate_types: item.gateTypes,
    previous_policy_hash: item.previousHash,
    next_policy_hash: item.nextHash,
    previous_expression_json: item.previousPolicy,
    next_expression_json: item.nextPolicy,
  }
  return JSON.stringify(entry)
}

async function readSnapshot(path: string): Promise<SnapshotEntry[]> {
  const raw = await readFile(path, "utf8")
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = JSON.parse(line) as SnapshotEntry
      if (parsed.migration !== "community-document-providers-v1") {
        throw new Error(`unsupported snapshot entry migration: ${parsed.migration}`)
      }
      return parsed
    })
}

async function resolveCommunities(
  repository: CommunityRepository,
  refs: string[],
): Promise<CommunityRow[]> {
  if (refs.length === 0) {
    return repository.listActiveCommunities({ limit: 10_000 })
  }
  const communities: CommunityRow[] = []
  for (const ref of refs) {
    const community = await repository.getCommunityById(ref)
      ?? await repository.getCommunityByRouteSlug(ref)
    if (!community) {
      throw new Error(`community not found: ${ref}`)
    }
    communities.push(community)
  }
  return communities
}

const NO_REMOTE_PREFLIGHTS = {
  ensureRemoteMembershipStateIndexes: async () => undefined,
  ensureRemoteThreadCommentLockColumns: async () => undefined,
  ensureRemoteCommentGuestAuthorship: async () => undefined,
  ensureRemoteLiveRoomTables: async () => undefined,
  ensureRemotePostSongTitleColumn: async () => undefined,
}

async function fetchCommunityPolicy(input: {
  env: Env
  repository: CommunityRepository
  communityId: string
}): Promise<CommunityPolicyRow | null> {
  const db = await openCommunityDb(input.env, input.repository, input.communityId, NO_REMOTE_PREFLIGHTS)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT version, expression_json
        FROM community_gate_policies
        WHERE community_id = ?1
          AND scope = 'membership'
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    return row
      ? {
          version: Number(row.version),
          expression_json: row.expression_json,
        }
      : null
  } finally {
    db.close()
  }
}

async function fetchEligiblePolicies(
  env: Env,
  repository: CommunityRepository,
  options: Options,
): Promise<EligiblePolicy[]> {
  const rows = await resolveCommunities(repository, options.communities)
  const eligible: EligiblePolicy[] = []
  for (const community of rows) {
    const row = await fetchCommunityPolicy({
      env,
      repository,
      communityId: community.community_id,
    })
    if (!row) {
      continue
    }
    if (row.version !== 1) {
      throw new Error(`community ${community.community_id} has unsupported gate policy version ${row.version}`)
    }
    const previousPolicy = parsePolicy(row.expression_json)
    const result = addZkPassportAcceptedProviders(previousPolicy, { includeSelfOnly: options.includeSelfOnly })
    if (!result.changed) {
      continue
    }
    eligible.push({
      communityId: community.community_id,
      displayName: community.display_name,
      routeSlug: community.route_slug,
      previousPolicy,
      nextPolicy: result.policy,
      gateTypes: result.gateTypes,
      previousHash: stablePolicyHash(previousPolicy),
      nextHash: stablePolicyHash(result.policy),
    })
  }
  return eligible
}

async function readCurrentMembershipPolicy(input: {
  env: Env
  repository: CommunityRepository
  communityId: string
}): Promise<{ policy: GatePolicy; close: () => void; client: Awaited<ReturnType<typeof openCommunityDb>>["client"] }> {
  const db = await openCommunityDb(input.env, input.repository, input.communityId, NO_REMOTE_PREFLIGHTS)
  try {
    const result = await db.client.execute({
      sql: `
        SELECT expression_json
        FROM community_gate_policies
        WHERE community_id = ?1
          AND scope = 'membership'
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const raw = result.rows[0]?.expression_json
    if (raw == null) {
      throw new Error(`community ${input.communityId} has no membership gate policy`)
    }
    return {
      policy: parsePolicy(raw),
      client: db.client,
      close: db.close,
    }
  } catch (error) {
    db.close()
    throw error
  }
}

async function updateMembershipPolicy(input: {
  env: Env
  repository: CommunityRepository
  communityId: string
  expectedHash: string
  nextPolicy: GatePolicy
}): Promise<void> {
  const current = await readCurrentMembershipPolicy(input)
  try {
    if (stablePolicyHash(current.policy) !== input.expectedHash) {
      throw new Error(`community ${input.communityId} policy changed before update`)
    }
    const result = await current.client.execute({
      sql: `
        UPDATE community_gate_policies
        SET expression_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
          AND scope = 'membership'
      `,
      args: [input.communityId, JSON.stringify(input.nextPolicy), new Date().toISOString()],
    })
    if (result.rowsAffected !== 1) {
      throw new Error(`community ${input.communityId} update affected ${result.rowsAffected ?? 0} rows`)
    }
  } finally {
    current.close()
  }
}

async function applyEligiblePolicies(
  env: Env,
  repository: CommunityRepository,
  items: EligiblePolicy[],
  snapshotPath: string,
): Promise<void> {
  const migratedAt = new Date().toISOString()
  const snapshot = `${items.map((item) => snapshotLine(item, migratedAt)).join("\n")}\n`
  await writeFile(snapshotPath, snapshot, { flag: "wx" })

  for (const item of items) {
    try {
      await updateMembershipPolicy({
        env,
        repository,
        communityId: item.communityId,
        expectedHash: item.previousHash,
        nextPolicy: item.nextPolicy,
      })
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; snapshot retained at ${snapshotPath}`)
    }
  }
}

async function rollbackSnapshot(
  env: Env,
  repository: CommunityRepository,
  entries: SnapshotEntry[],
  communities: string[],
): Promise<void> {
  const filter = new Set(communities)
  const selected = entries.filter((entry) => filter.size === 0 || filter.has(entry.community_id))
  if (selected.length === 0) {
    throw new Error("snapshot contains no entries matching the requested communities")
  }

  console.log("community_id | display_name | gate_types | action")
  for (const entry of selected) {
    console.log([
      entry.route_slug ? `${entry.community_id} (/c/${entry.route_slug})` : entry.community_id,
      entry.display_name,
      formatGateTypes(entry.gate_types),
      "rollback accepted_providers migration",
    ].join(" | "))
  }

  for (const entry of selected) {
    await updateMembershipPolicy({
      env,
      repository,
      communityId: entry.community_id,
      expectedHash: entry.next_policy_hash,
      nextPolicy: entry.previous_expression_json,
    }).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback stopped`)
    })
  }
  console.log("")
  console.log(`${selected.length} ${selected.length === 1 ? "row" : "rows"} rolled back.`)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  if (!process.env[options.databaseUrlEnv]?.trim()) {
    throw new Error(`missing database url env var: ${options.databaseUrlEnv}`)
  }
  if (options.databaseUrlEnv !== "CONTROL_PLANE_DATABASE_URL") {
    process.env.CONTROL_PLANE_DATABASE_URL = process.env[options.databaseUrlEnv]
  }

  const env = process.env as unknown as Env
  const repository = getCommunityRepository(env)
  try {
    if (options.mode === "rollback") {
      await rollbackSnapshot(env, repository, await readSnapshot(options.snapshotPath as string), options.communities)
      return
    }

    const eligible = await fetchEligiblePolicies(env, repository, options)
    printPlan(eligible, options.mode)
    if (options.mode === "dry-run" || eligible.length === 0) {
      return
    }

    const snapshotPath = options.snapshotPath ?? makeSnapshotPath()
    await applyEligiblePolicies(env, repository, eligible, snapshotPath)
    console.log("")
    console.log(`${eligible.length} ${eligible.length === 1 ? "row" : "rows"} updated.`)
    console.log(`snapshot: ${snapshotPath}`)
  } finally {
    await repository.close?.()
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
