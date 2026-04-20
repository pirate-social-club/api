import { createHash } from "node:crypto"
import { mkdir, readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createClient } from "@libsql/client"
import type { Client } from "@libsql/client"
import { internalError } from "../errors"

const LOCAL_SQLITE_BUSY_TIMEOUT_MS = 5000
const LEGACY_COMMUNITY_MIGRATION_CHECKSUMS: Record<string, string[]> = {
  "1036_community_post_labels_ai.sql": [
    "35dd1dca31a58d594287c4636486940611fcc9e621ddf1c52d8627719bd18673",
    "b30841d6b60a02fe72d6ea61dbc3e7fb3459d069143b53d8a07fa8a9790f4d01",
  ],
}

export type LocalCommunityBootstrapInput = {
  rootDir: string
  communityId: string
  createdByUserId: string
  displayName: string
  description: string | null
  avatarRef: string | null
  bannerRef: string | null
  namespaceVerificationId: string | null
  namespaceLabel: string | null
  membershipMode: "open" | "request" | "gated"
  defaultAgeGatePolicy: "none" | "18_plus"
  allowAnonymousIdentity: boolean
  anonymousIdentityScope: "community_stable" | "thread_stable" | "post_ephemeral" | null
  governanceMode: "centralized" | "multisig" | "majeur"
  handlePolicyTemplate: "standard" | "premium" | "membership_gated" | "custom"
  pricingModel: "free" | "flat_by_length" | "custom_curve" | "gated_then_flat" | null
  gateRules: Array<{
    scope: "membership" | "viewer" | "posting"
    gateFamily: "identity_proof" | "token_holding"
    gateType: string
    proofRequirementsJson: string | null
    chainNamespace: string | null
    gateConfigJson: string | null
  }>
  rules: Array<LocalCommunityRule>
  now: string
}

export type LocalCommunityRule = {
  rule_id: string
  title: string
  body: string
  report_reason: string
  position: number
  status: "active" | "archived"
}

export type LocalCommunitySnapshot = {
  community_id: string
  display_name: string
  description: string | null
  avatar_ref: string | null
  banner_ref: string | null
  status: "draft" | "active" | "frozen" | "archived" | "deleted"
  membership_mode: "open" | "request" | "gated"
  default_age_gate_policy: "none" | "18_plus"
  allow_anonymous_identity: boolean
  anonymous_identity_scope: "community_stable" | "thread_stable" | "post_ephemeral" | null
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donation_partner_id: string | null
  donation_partner_status: "unconfigured" | "active" | "inactive"
  donation_partner: {
    donation_partner_id: string
    display_name: string
    provider: "endaoment"
    provider_partner_ref: string | null
    image_url: string | null
    review_status: "pending" | "approved" | "rejected"
    status: "active" | "paused" | "retired"
  } | null
  governance_mode: "centralized" | "multisig" | "majeur"
  settings_json: string | null
  gate_rules: Array<{
    gate_rule_id: string
    scope: "membership" | "viewer" | "posting"
    gate_family: "token_holding" | "identity_proof"
    gate_type: string
    proof_requirements: Array<Record<string, unknown>> | null
    chain_namespace: string | null
    gate_config: Record<string, unknown> | null
    status: "active" | "disabled"
    created_at: string
    updated_at: string
  }>
  rules: LocalCommunityRule[]
  created_by_user_id: string
  created_at: string
  updated_at: string
}

function resolveCommunityTemplateMigrationsDir(): string {
  return fileURLToPath(new URL("../../../../../../db/community-template/migrations/", import.meta.url))
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ""
  let inSingleQuote = false

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]
    const next = sql[index + 1]
    current += char

    if (char === "'" && sql[index - 1] !== "\\") {
      if (inSingleQuote && next === "'") {
        current += next
        index += 1
        continue
      }
      inSingleQuote = !inSingleQuote
      continue
    }

    if (char === ";" && !inSingleQuote) {
      const statement = current.trim()
      if (statement) {
        statements.push(statement)
      }
      current = ""
    }
  }

  const trailing = current.trim()
  if (trailing) {
    statements.push(trailing)
  }

  return statements
}

async function ensureSchemaMigrationsTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      migration_label TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `)
}

export async function configureLocalCommunityDbClient(client: Client): Promise<void> {
  await client.execute("PRAGMA journal_mode = WAL")
  await client.execute("PRAGMA synchronous = NORMAL")
  await client.execute(`PRAGMA busy_timeout = ${LOCAL_SQLITE_BUSY_TIMEOUT_MS}`)
}

async function applyMigrationFile(client: Client, migrationFilePath: string): Promise<void> {
  const migrationName = migrationFilePath.split("/").pop()
  if (!migrationName) {
    throw internalError("Invalid migration path")
  }

  const sql = await readFile(migrationFilePath, "utf8")
  const checksum = createHash("sha256").update(sql).digest("hex")
  const existing = await client.execute({
    sql: `
      SELECT checksum
      FROM schema_migrations
      WHERE migration_name = ?1
      LIMIT 1
    `,
    args: [migrationName],
  })
  const existingChecksum = existing.rows[0]?.checksum
  if (typeof existingChecksum === "string") {
    const acceptedChecksums = new Set([
      checksum,
      ...(LEGACY_COMMUNITY_MIGRATION_CHECKSUMS[migrationName] ?? []),
    ])

    if (!acceptedChecksums.has(existingChecksum)) {
      throw internalError(`Migration checksum mismatch for ${migrationName}`)
    }

    if (existingChecksum !== checksum) {
      await client.execute({
        sql: `
          UPDATE schema_migrations
          SET checksum = ?2
          WHERE migration_name = ?1
        `,
        args: [migrationName, checksum],
      })
    }
    return
  }

  const statements = splitSqlStatements(sql)
  const tx = await client.transaction("write")
  try {
    for (const statement of statements) {
      await tx.execute(statement)
    }
    await tx.execute({
      sql: `
        INSERT INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [migrationName, checksum],
    })
    await tx.commit()
  } catch (error) {
    try {
      await tx.rollback()
    } catch {}
    throw error
  } finally {
    tx.close()
  }
}

export async function ensureCommunityDbSchema(client: Client): Promise<void> {
  await ensureSchemaMigrationsTable(client)
  const migrationsDir = resolveCommunityTemplateMigrationsDir()
  const migrationEntries = (await readdir(migrationsDir))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()

  for (const entry of migrationEntries) {
    await applyMigrationFile(client, join(migrationsDir, entry))
  }
}

function boolToSqlite(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

function sanitizeCommunityId(communityId: string): string {
  const trimmed = communityId.trim()
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw internalError("Invalid community id for local database path")
  }
  return trimmed
}

export function buildLocalCommunityDbPath(rootDir: string, communityId: string): string {
  const configuredRootDir = rootDir.trim()
  if (!configuredRootDir) {
    throw internalError("LOCAL_COMMUNITY_DB_ROOT is not configured")
  }
  const baseDir = resolve(configuredRootDir)
  const safeCommunityId = sanitizeCommunityId(communityId)
  return join(baseDir, `community-${safeCommunityId}.db`)
}

export function buildLocalCommunityDbUrl(rootDir: string, communityId: string): string {
  return pathToFileURL(buildLocalCommunityDbPath(rootDir, communityId)).toString()
}

export async function bootstrapLocalCommunityDb(input: LocalCommunityBootstrapInput): Promise<LocalCommunitySnapshot> {
  const dbPath = buildLocalCommunityDbPath(input.rootDir, input.communityId)
  await mkdir(dirname(dbPath), { recursive: true })
  const client = createClient({
    url: pathToFileURL(dbPath).toString(),
  })

  try {
    await configureLocalCommunityDbClient(client)
    await ensureCommunityDbSchema(client)

    const membershipId = `mbr_${input.communityId}_${input.createdByUserId}`
    const roleAssignmentId = `role_${input.communityId}_${input.createdByUserId}_owner`
    const now = input.now

    const tx = await client.transaction("write")
    try {
      await tx.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, description, avatar_ref, banner_ref, status, artist_identity_id, artist_governance_state,
            membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
            donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
            settings_json, created_by_user_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, 'active', NULL, 'fan_run', ?6, ?7, ?8, ?9,
            NULL, 'none', 'unconfigured', ?10, NULL, ?11, ?12, ?12
          )
          ON CONFLICT(community_id) DO UPDATE SET
            display_name = excluded.display_name,
            description = excluded.description,
            avatar_ref = excluded.avatar_ref,
            banner_ref = excluded.banner_ref,
            status = excluded.status,
            membership_mode = excluded.membership_mode,
            default_age_gate_policy = excluded.default_age_gate_policy,
            allow_anonymous_identity = excluded.allow_anonymous_identity,
            anonymous_identity_scope = excluded.anonymous_identity_scope,
            donation_policy_mode = excluded.donation_policy_mode,
            donation_partner_status = excluded.donation_partner_status,
            governance_mode = excluded.governance_mode,
            updated_at = excluded.updated_at
        `,
        args: [
          input.communityId,
          input.displayName,
          input.description,
          input.avatarRef,
          input.bannerRef,
          input.membershipMode,
          input.defaultAgeGatePolicy,
          boolToSqlite(input.allowAnonymousIdentity),
          input.anonymousIdentityScope,
          input.governanceMode,
          input.createdByUserId,
          now,
        ],
      })

      await tx.execute({
        sql: `
          INSERT INTO community_memberships (
            membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
          )
          ON CONFLICT(membership_id) DO UPDATE SET
            status = excluded.status,
            joined_at = excluded.joined_at,
            left_at = excluded.left_at,
            banned_at = excluded.banned_at,
            updated_at = excluded.updated_at
        `,
        args: [membershipId, input.communityId, input.createdByUserId, now],
      })

      await tx.execute({
        sql: `
          INSERT INTO community_roles (
            role_assignment_id, community_id, user_id, role, status, granted_by_user_id, granted_at, revoked_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'owner', 'active', ?3, ?4, NULL, ?4, ?4
          )
          ON CONFLICT(role_assignment_id) DO UPDATE SET
            status = excluded.status,
            granted_at = excluded.granted_at,
            revoked_at = excluded.revoked_at,
            updated_at = excluded.updated_at
        `,
        args: [roleAssignmentId, input.communityId, input.createdByUserId, now],
      })

      if (input.namespaceVerificationId && input.namespaceLabel) {
        const namespaceId = `ns_${input.communityId}`
        const namespaceHandlePolicyId = `nhp_${input.communityId}`

        await tx.execute({
          sql: `
            INSERT INTO namespace_bindings (
              namespace_id, community_id, namespace_verification_id, display_label, normalized_label,
              resolver_label, route_family, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, NULL, NULL, 'active', ?6, ?6
            )
            ON CONFLICT(namespace_id) DO UPDATE SET
              namespace_verification_id = excluded.namespace_verification_id,
              display_label = excluded.display_label,
              normalized_label = excluded.normalized_label,
              status = excluded.status,
              updated_at = excluded.updated_at
          `,
          args: [
            namespaceId,
            input.communityId,
            input.namespaceVerificationId,
            input.namespaceLabel,
            input.namespaceLabel.toLowerCase(),
            now,
          ],
        })

        await tx.execute({
          sql: `
            INSERT INTO namespace_handle_policies (
              namespace_handle_policy_id, community_id, namespace_id, policy_template, pricing_model,
              membership_required_for_claim, settings_json, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, 1, NULL, ?6, ?6
            )
            ON CONFLICT(namespace_handle_policy_id) DO UPDATE SET
              policy_template = excluded.policy_template,
              pricing_model = excluded.pricing_model,
              membership_required_for_claim = excluded.membership_required_for_claim,
              updated_at = excluded.updated_at
          `,
          args: [
            namespaceHandlePolicyId,
            input.communityId,
            namespaceId,
            input.handlePolicyTemplate,
            input.pricingModel,
            now,
          ],
        })
      }

      for (const [index, rule] of input.gateRules.entries()) {
        await tx.execute({
          sql: `
            INSERT INTO community_gate_rules (
              gate_rule_id, community_id, scope, gate_family, gate_type, proof_requirements_json,
              chain_namespace, gate_config_json, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6,
              ?7, ?8, 'active', ?9, ?9
            )
          `,
          args: [
            `grl_${input.communityId}_${index}`,
            input.communityId,
            rule.scope,
            rule.gateFamily,
            rule.gateType,
            rule.proofRequirementsJson,
            rule.chainNamespace,
            rule.gateConfigJson,
            now,
          ],
        })
      }

      for (const rule of input.rules) {
        await tx.execute({
          sql: `
            INSERT INTO community_rules (
              rule_id, community_id, title, body, report_reason, position, status, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8
            )
          `,
          args: [
            rule.rule_id,
            input.communityId,
            rule.title,
            rule.body,
            rule.report_reason,
            rule.position,
            rule.status,
            now,
          ],
        })
      }

      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch {}
      throw error
    } finally {
      tx.close()
    }

    return {
      community_id: input.communityId,
      display_name: input.displayName,
      description: input.description,
      avatar_ref: input.avatarRef,
      banner_ref: input.bannerRef,
      status: "active",
      membership_mode: input.membershipMode,
      default_age_gate_policy: input.defaultAgeGatePolicy,
      allow_anonymous_identity: input.allowAnonymousIdentity,
      anonymous_identity_scope: input.anonymousIdentityScope,
      donation_policy_mode: "none",
      donation_partner_id: null,
      donation_partner_status: "unconfigured",
      donation_partner: null,
      governance_mode: input.governanceMode,
      settings_json: null,
      gate_rules: input.gateRules.map((rule, index) => ({
        gate_rule_id: `grl_${input.communityId}_${index}`,
        scope: rule.scope,
        gate_family: rule.gateFamily,
        gate_type: rule.gateType,
        proof_requirements: rule.proofRequirementsJson
          ? JSON.parse(rule.proofRequirementsJson) as Array<Record<string, unknown>>
          : null,
        chain_namespace: rule.chainNamespace,
        gate_config: rule.gateConfigJson
          ? JSON.parse(rule.gateConfigJson) as Record<string, unknown>
          : null,
        status: "active",
        created_at: now,
        updated_at: now,
      })),
      rules: [...input.rules].sort((a, b) => a.position - b.position),
      created_by_user_id: input.createdByUserId,
      created_at: now,
      updated_at: now,
    }
  } finally {
    client.close()
  }
}
