import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createClient } from "@libsql/client"
import type { Client, Transaction } from "@libsql/client"
import { internalError } from "../errors"

export type LocalCommunityBootstrapInput = {
  rootDir: string
  communityId: string
  createdByUserId: string
  displayName: string
  description: string | null
  namespaceVerificationId: string
  namespaceLabel: string
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
  now: string
}

export type LocalCommunitySnapshot = {
  community_id: string
  display_name: string
  description: string | null
  status: "draft" | "active" | "frozen" | "archived" | "deleted"
  membership_mode: "open" | "request" | "gated"
  default_age_gate_policy: "none" | "18_plus"
  allow_anonymous_identity: boolean
  anonymous_identity_scope: "community_stable" | "thread_stable" | "post_ephemeral" | null
  donation_partner_id: string | null
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donation_partner_status: "unconfigured" | "active" | "inactive"
  governance_mode: "centralized" | "multisig" | "majeur"
  cached_member_count: number | null
  cached_qualified_member_count: number | null
  created_by_user_id: string
  created_at: string
  updated_at: string
}

export type LocalCommunityUpdateInput = {
  databaseUrl: string
  communityId: string
  displayName?: string
  description?: string | null
  descriptionSet?: boolean
  membershipMode?: "open" | "request" | "gated"
  defaultAgeGatePolicy?: "none" | "18_plus"
  allowAnonymousIdentity?: boolean
  anonymousIdentityScope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  anonymousIdentityScopeSet?: boolean
  updatedAt: string
}

export type LocalCommunityDonationPolicyUpdateInput = {
  databaseUrl: string
  communityId: string
  donationPartnerId: string | null
  donationPolicyMode: "none" | "optional_creator_sidecar" | "fundraiser_default"
  donationPartnerStatus: "unconfigured" | "active" | "inactive"
  updatedAt: string
}

export type LocalCommunityProfileSnapshot = {
  rules: Array<{
    rule_id: string
    title: string
    body: string
    position: number
    status: "active" | "archived"
  }>
  resource_links: Array<{
    resource_link_id: string
    label: string
    url: string
    resource_kind: "link" | "playlist" | "document" | "discord" | "website" | "other"
    position: number
    status: "active" | "archived"
  }>
}

export type LocalCommunityReferenceLinkSnapshot = {
  community_reference_link_id: string
  community_id: string
  platform: "musicbrainz" | "genius" | "spotify" | "apple_music" | "wikipedia" | "instagram" | "tiktok" | "x" | "official_website" | "youtube" | "bandcamp" | "soundcloud" | "other"
  url: string
  normalized_url: string
  external_id: string | null
  label: string | null
  link_status: "active" | "archived"
  verification_applicability: "eligible" | "not_applicable"
  verification_state: "unverified" | "pending" | "verified" | "rejected" | "revoked" | null
  verification_method: "bio_code" | "dns_txt" | "website_meta" | "website_file" | "manual_review" | null
  verified_at: string | null
  last_verification_checked_at: string | null
  active_proof_id: string | null
  metadata: Record<string, unknown>
  position: number
  created_at: string
  updated_at: string
}

export type LocalCommunityContentAuthenticityPolicySnapshot = {
  community_id: string
  policy_origin: "default" | "explicit"
  authenticity_stance: "human_only" | "human_first" | "ai_allowed_with_disclosure" | "ai_allowed"
  text_policy: {
    allow_ai_assisted_editing: boolean
    allow_ai_generated: boolean
  }
  image_policy: {
    allow_ai_upscale: boolean
    allow_ai_restoration: boolean
    allow_generative_editing: boolean
    allow_ai_generated: boolean
  }
  video_policy: {
    allow_ai_upscale: boolean
    allow_ai_restoration: boolean
    allow_ai_frame_interpolation: boolean
    allow_generative_editing: boolean
    allow_ai_generated: boolean
  }
  song_policy: {
    allow_ai_assisted_mastering: boolean
    allow_ai_stem_separation: boolean
    allow_ai_generated_instrumentals: boolean
    allow_ai_generated_lyrics: boolean
    allow_ai_generated_vocals: boolean
  }
  updated_at: string
}

export type LocalCommunitySourcePolicySnapshot = {
  community_id: string
  policy_origin: "default" | "explicit"
  identified_person_media_scope: "subject_only" | "subject_or_authorized" | "public_source_allowed"
  require_source_url_for_reposts: boolean
  allow_human_made_fan_art_of_real_people: boolean
  require_fan_art_disclosure: boolean
  updated_at: string
}

export type LocalCommunityMarketContextPolicySnapshot = {
  community_id: string
  policy_origin: "default" | "explicit"
  mode: "off" | "on"
  enabled_post_types: Array<"link" | "image" | "video">
  max_markets_per_post: number
  provider_set: "platform_default" | "approved_profile"
  market_context_profile_id: string | null
  resolved_profile: {
    market_context_profile_id: string
    profile_key: string
    provider_keys: string[]
    status: "active" | "archived"
  }
  updated_at: string
}

export type LocalCommunityContentAuthenticityDetectionPolicySnapshot = {
  community_id: string
  policy_origin: "default" | "explicit"
  selection_mode: "platform_default" | "approved_profile"
  authenticity_detection_profile_id: string | null
  resolved_profile: {
    authenticity_detection_profile_id: string
    profile_key: string
    provider_key: string
    supported_capabilities: Array<"image_authenticity" | "video_authenticity" | "audio_authenticity" | "deepfake_detection">
    status: "active" | "archived"
  }
  updated_at: string
}

export type LocalCommunityFlairPolicySnapshot = {
  flair_enabled: boolean
  require_flair_on_top_level_posts: boolean
  definitions: Array<{
    flair_id: string
    label: string
    description: string | null
    color_token: string | null
    status: "active" | "archived"
    position: number
    allowed_post_types: Array<"text" | "image" | "video" | "song"> | null
  }>
}

type StoredCommunitySettings = {
  community_profile?: LocalCommunityProfileSnapshot
  community_reference_links?: LocalCommunityReferenceLinkSnapshot[]
  community_content_authenticity_policy?: LocalCommunityContentAuthenticityPolicySnapshot
  community_content_authenticity_detection_policy?: LocalCommunityContentAuthenticityDetectionPolicySnapshot
  community_source_policy?: LocalCommunitySourcePolicySnapshot
  community_market_context_policy?: LocalCommunityMarketContextPolicySnapshot
  community_flair_policy?: LocalCommunityFlairPolicySnapshot
} | null

type SqlExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

function toLocalCommunitySnapshot(row: Record<string, unknown>): LocalCommunitySnapshot {
  return {
    community_id: String(row.community_id),
    display_name: String(row.display_name),
    description: row.description == null ? null : String(row.description),
    status: String(row.status) as LocalCommunitySnapshot["status"],
    membership_mode: String(row.membership_mode) as LocalCommunitySnapshot["membership_mode"],
    default_age_gate_policy: String(row.default_age_gate_policy) as LocalCommunitySnapshot["default_age_gate_policy"],
    allow_anonymous_identity: Boolean(Number(row.allow_anonymous_identity ?? 0)),
    anonymous_identity_scope: row.anonymous_identity_scope == null
      ? null
      : (String(row.anonymous_identity_scope) as LocalCommunitySnapshot["anonymous_identity_scope"]),
    donation_partner_id: row.donation_partner_id == null ? null : String(row.donation_partner_id),
    donation_policy_mode: String(row.donation_policy_mode) as LocalCommunitySnapshot["donation_policy_mode"],
    donation_partner_status: String(row.donation_partner_status) as LocalCommunitySnapshot["donation_partner_status"],
    governance_mode: String(row.governance_mode) as LocalCommunitySnapshot["governance_mode"],
    cached_member_count: row.cached_member_count == null ? null : Number(row.cached_member_count),
    cached_qualified_member_count: row.cached_qualified_member_count == null ? null : Number(row.cached_qualified_member_count),
    created_by_user_id: String(row.created_by_user_id),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }
}

function resolveCommunityTemplateMigrationsDir(): string {
  return fileURLToPath(new URL("../../../../../db/community-template/migrations/", import.meta.url))
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
    if (existingChecksum !== checksum) {
      throw internalError(`Migration checksum mismatch for ${migrationName}`)
    }
    return
  }

  const duplicate = await client.execute({
    sql: `
      SELECT migration_name
      FROM schema_migrations
      WHERE checksum = ?1
      LIMIT 1
    `,
    args: [checksum],
  })
  if (duplicate.rows[0]?.migration_name) {
    await client.execute({
      sql: `
        INSERT INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [migrationName, checksum],
    })
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

export async function applyCommunityTemplateMigrations(client: Client): Promise<void> {
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

function parseStoredCommunitySettings(value: unknown): StoredCommunitySettings {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as StoredCommunitySettings
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

export function buildLocalCommunityDbPath(rootDir: string, communityId: string): string {
  const baseDir = resolve(rootDir || "/tmp/pirate-community-dbs")
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
    await applyCommunityTemplateMigrations(client)

    const namespaceId = `ns_${input.communityId}`
    const namespaceHandlePolicyId = `nhp_${input.communityId}`
    const membershipId = `mbr_${input.communityId}_${input.createdByUserId}`
    const roleAssignmentId = `role_${input.communityId}_${input.createdByUserId}_owner`
    const now = input.now

    const tx = await client.transaction("write")
    try {
      await tx.execute({
        sql: `
          INSERT INTO communities (
            community_id, display_name, description, status, artist_identity_id, artist_governance_state,
            membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
            donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
            settings_json, cached_member_count, cached_qualified_member_count, created_by_user_id, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'active', NULL, 'fan_run', ?4, ?5, ?6, ?7,
            NULL, 'none', 'unconfigured', ?8, NULL, 1, 1, ?9, ?10, ?10
          )
          ON CONFLICT(community_id) DO UPDATE SET
            display_name = excluded.display_name,
            description = excluded.description,
            status = excluded.status,
            membership_mode = excluded.membership_mode,
            default_age_gate_policy = excluded.default_age_gate_policy,
            allow_anonymous_identity = excluded.allow_anonymous_identity,
            anonymous_identity_scope = excluded.anonymous_identity_scope,
            donation_policy_mode = excluded.donation_policy_mode,
            donation_partner_status = excluded.donation_partner_status,
            governance_mode = excluded.governance_mode,
            cached_member_count = excluded.cached_member_count,
            cached_qualified_member_count = excluded.cached_qualified_member_count,
            updated_at = excluded.updated_at
        `,
        args: [
          input.communityId,
          input.displayName,
          input.description,
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
      status: "active",
      membership_mode: input.membershipMode,
      default_age_gate_policy: input.defaultAgeGatePolicy,
      allow_anonymous_identity: input.allowAnonymousIdentity,
      anonymous_identity_scope: input.anonymousIdentityScope,
      donation_partner_id: null,
      donation_policy_mode: "none",
      donation_partner_status: "unconfigured",
      governance_mode: input.governanceMode,
      cached_member_count: 1,
      cached_qualified_member_count: 1,
      created_by_user_id: input.createdByUserId,
      created_at: now,
      updated_at: now,
    }
  } finally {
    client.close()
  }
}

export async function readLocalCommunityWithExecutor(
  executor: SqlExecutor,
  communityId: string,
): Promise<LocalCommunitySnapshot | null> {
  const result = await executor.execute({
    sql: `
      SELECT community_id, display_name, description, status, membership_mode, default_age_gate_policy,
             allow_anonymous_identity, anonymous_identity_scope, donation_partner_id, donation_policy_mode, donation_partner_status,
             governance_mode, cached_member_count, cached_qualified_member_count, created_by_user_id, created_at, updated_at
      FROM communities
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [communityId],
  })
  const row = result.rows[0]
  if (!row) {
    return null
  }

  return toLocalCommunitySnapshot(row as Record<string, unknown>)
}

export async function readLocalCommunity(databaseUrl: string, communityId: string): Promise<LocalCommunitySnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    return await readLocalCommunityWithExecutor(client, communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityMembershipStats(input: {
  databaseUrl: string
  communityId: string
  memberCount: number
  qualifiedMemberCount: number
  updatedAt: string
}): Promise<void> {
  const client = createClient({ url: input.databaseUrl })
  try {
    await client.execute({
      sql: `
        UPDATE communities
        SET cached_member_count = ?2,
            cached_qualified_member_count = ?3,
            updated_at = ?4
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.memberCount, input.qualifiedMemberCount, input.updatedAt],
    })
  } finally {
    client.close()
  }
}

export async function readLocalCommunityProfile(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunityProfileSnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_profile ?? { rules: [], resource_links: [] }
  } finally {
    client.close()
  }
}

export async function readLocalCommunityReferenceLinks(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunityReferenceLinkSnapshot[] | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_reference_links ?? []
  } finally {
    client.close()
  }
}

export async function readLocalCommunityContentAuthenticityPolicy(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunityContentAuthenticityPolicySnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_content_authenticity_policy ?? null
  } finally {
    client.close()
  }
}

export async function readLocalCommunitySourcePolicy(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunitySourcePolicySnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_source_policy ?? null
  } finally {
    client.close()
  }
}

export async function readLocalCommunityMarketContextPolicy(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunityMarketContextPolicySnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_market_context_policy ?? null
  } finally {
    client.close()
  }
}

export async function readLocalCommunityContentAuthenticityDetectionPolicy(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunityContentAuthenticityDetectionPolicySnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_content_authenticity_detection_policy ?? null
  } finally {
    client.close()
  }
}

export async function readLocalCommunityFlairPolicy(
  databaseUrl: string,
  communityId: string,
): Promise<LocalCommunityFlairPolicySnapshot | null> {
  const client = createClient({ url: databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json)
    return parsed?.community_flair_policy ?? { flair_enabled: false, require_flair_on_top_level_posts: false, definitions: [] }
  } finally {
    client.close()
  }
}

export async function updateLocalCommunity(input: LocalCommunityUpdateInput): Promise<LocalCommunitySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    await client.execute({
      sql: `
        UPDATE communities
        SET display_name = COALESCE(?2, display_name),
            description = CASE WHEN ?3 = 1 THEN ?4 ELSE description END,
            membership_mode = COALESCE(?5, membership_mode),
            default_age_gate_policy = COALESCE(?6, default_age_gate_policy),
            allow_anonymous_identity = COALESCE(?7, allow_anonymous_identity),
            anonymous_identity_scope = CASE WHEN ?8 = 1 THEN ?9 ELSE anonymous_identity_scope END,
            updated_at = ?10
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        input.displayName ?? null,
        input.descriptionSet ? 1 : 0,
        input.description ?? null,
        input.membershipMode ?? null,
        input.defaultAgeGatePolicy ?? null,
        input.allowAnonymousIdentity === undefined ? null : boolToSqlite(input.allowAnonymousIdentity),
        input.anonymousIdentityScopeSet ? 1 : 0,
        input.anonymousIdentityScope ?? null,
        input.updatedAt,
      ],
    })

    return readLocalCommunity(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityDonationPolicy(
  input: LocalCommunityDonationPolicyUpdateInput,
): Promise<LocalCommunitySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    await client.execute({
      sql: `
        UPDATE communities
        SET donation_partner_id = ?2,
            donation_policy_mode = ?3,
            donation_partner_status = ?4,
            updated_at = ?5
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        input.donationPartnerId,
        input.donationPolicyMode,
        input.donationPartnerStatus,
        input.updatedAt,
      ],
    })

    return readLocalCommunity(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityProfile(input: {
  databaseUrl: string
  communityId: string
  profile: LocalCommunityProfileSnapshot
  updatedAt: string
}): Promise<LocalCommunityProfileSnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_profile: input.profile,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunityProfile(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityReferenceLinks(input: {
  databaseUrl: string
  communityId: string
  referenceLinks: LocalCommunityReferenceLinkSnapshot[]
  updatedAt: string
}): Promise<LocalCommunityReferenceLinkSnapshot[] | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_reference_links: input.referenceLinks,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunityReferenceLinks(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityContentAuthenticityPolicy(input: {
  databaseUrl: string
  communityId: string
  policy: LocalCommunityContentAuthenticityPolicySnapshot
  updatedAt: string
}): Promise<LocalCommunityContentAuthenticityPolicySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_content_authenticity_policy: input.policy,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunityContentAuthenticityPolicy(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunitySourcePolicy(input: {
  databaseUrl: string
  communityId: string
  policy: LocalCommunitySourcePolicySnapshot
  updatedAt: string
}): Promise<LocalCommunitySourcePolicySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_source_policy: input.policy,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunitySourcePolicy(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityMarketContextPolicy(input: {
  databaseUrl: string
  communityId: string
  policy: LocalCommunityMarketContextPolicySnapshot
  updatedAt: string
}): Promise<LocalCommunityMarketContextPolicySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_market_context_policy: input.policy,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunityMarketContextPolicy(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityContentAuthenticityDetectionPolicy(input: {
  databaseUrl: string
  communityId: string
  policy: LocalCommunityContentAuthenticityDetectionPolicySnapshot
  updatedAt: string
}): Promise<LocalCommunityContentAuthenticityDetectionPolicySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_content_authenticity_detection_policy: input.policy,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunityContentAuthenticityDetectionPolicy(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export async function updateLocalCommunityFlairPolicy(input: {
  databaseUrl: string
  communityId: string
  policy: LocalCommunityFlairPolicySnapshot
  updatedAt: string
}): Promise<LocalCommunityFlairPolicySnapshot | null> {
  const client = createClient({ url: input.databaseUrl })
  try {
    const result = await client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const row = result.rows[0]
    if (!row) {
      return null
    }

    const parsed = parseStoredCommunitySettings(row.settings_json) ?? {}
    const nextSettings = {
      ...parsed,
      community_flair_policy: input.policy,
    }

    await client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [input.communityId, JSON.stringify(nextSettings), input.updatedAt],
    })

    return readLocalCommunityFlairPolicy(input.databaseUrl, input.communityId)
  } finally {
    client.close()
  }
}

export function makeLocalCommunityRuleId(): string {
  return `crl_${randomUUID().replace(/-/g, "")}`
}

export function makeLocalCommunityResourceLinkId(): string {
  return `crk_${randomUUID().replace(/-/g, "")}`
}

export function makeLocalCommunityReferenceLinkId(): string {
  return `crf_${randomUUID().replace(/-/g, "")}`
}

export function makeLocalCommunityFlairId(): string {
  return `flr_${randomUUID().replace(/-/g, "")}`
}
