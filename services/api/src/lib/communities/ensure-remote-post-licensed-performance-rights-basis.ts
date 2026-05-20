import type { Client } from "@libsql/client"

const LICENSED_PERFORMANCE_RIGHTS_BASIS_MIGRATION_NAME = "1084_licensed_performance_rights_basis.sql"
const LICENSED_PERFORMANCE_RIGHTS_BASIS_MIGRATION_CHECKSUM = "cfe0bfa3e50685559ff4d2f9b0526ea8c1c7d675666ef98e5330d6c8366c40eb"

const POST_COLUMNS = [
  "post_id",
  "community_id",
  "author_user_id",
  "identity_mode",
  "anonymous_scope",
  "anonymous_label",
  "disclosed_qualifiers_json",
  "label_id",
  "post_type",
  "status",
  "comments_locked",
  "comments_locked_at",
  "comments_locked_by_user_id",
  "comments_lock_reason",
  "song_mode",
  "title",
  "song_title",
  "song_annotations_url",
  "song_cover_art_ref",
  "song_duration_ms",
  "body",
  "caption",
  "lyrics",
  "visibility",
  "link_url",
  "link_og_image_url",
  "link_og_title",
  "link_enrichment_snapshot_json",
  "link_enrichment_synced_at",
  "embeds_json",
  "media_refs_json",
  "song_artifact_bundle_id",
  "source_language",
  "translation_policy",
  "rights_basis",
  "access_mode",
  "asset_id",
  "parent_post_id",
  "crosspost_source_json",
  "upstream_asset_refs_json",
  "source_start_ms",
  "source_duration_ms",
  "sync_offset_ms",
  "analysis_state",
  "analysis_result_ref",
  "content_safety_state",
  "age_gate_policy",
  "created_at",
  "updated_at",
  "idempotency_key",
  "flair_id",
  "comment_count",
  "top_level_comment_count",
  "last_comment_at",
  "authorship_mode",
  "agent_id",
  "agent_ownership_record_id",
  "agent_display_name_snapshot",
  "agent_owner_handle_snapshot",
  "agent_ownership_provider_snapshot",
  "label_assignment_status",
  "label_assigned_by",
  "label_assigned_at",
  "label_ai_confidence",
  "label_assignment_error",
  "label_assignment_model",
  "label_assignment_result_json",
  "agent_handle_snapshot",
] as const

const ASSET_COLUMNS = [
  "asset_id",
  "community_id",
  "source_post_id",
  "song_artifact_bundle_id",
  "creator_user_id",
  "asset_kind",
  "rights_basis",
  "access_mode",
  "primary_content_ref",
  "primary_content_hash",
  "preview_audio_json",
  "cover_art_json",
  "canvas_video_json",
  "publication_status",
  "story_status",
  "story_error",
  "story_ip_id",
  "story_publish_tx_ref",
  "story_asset_version_id",
  "story_cdr_vault_uuid",
  "story_namespace",
  "story_entitlement_token_id",
  "story_read_condition",
  "story_write_condition",
  "story_ip_nft_contract",
  "story_ip_nft_token_id",
  "story_publish_model",
  "story_license_terms_id",
  "story_license_template",
  "story_royalty_policy",
  "story_derivative_registered_at",
  "story_revenue_token",
  "story_cdr_encrypted_cid",
  "story_cdr_allocate_tx_ref",
  "story_cdr_write_tx_ref",
  "story_royalty_policy_id",
  "story_derivative_parent_ip_ids_json",
  "story_royalty_registration_status",
  "license_preset",
  "commercial_rev_share_pct",
  "locked_delivery_status",
  "locked_delivery_ref",
  "locked_delivery_error",
  "locked_delivery_payload_json",
  "locked_delivery_storage_ref",
  "locked_delivery_secret_json",
  "display_title",
  "created_at",
  "updated_at",
] as const

const COLUMN_DEFAULT_SELECT: Record<string, string> = {
  comments_locked: "0",
  idempotency_key: "''",
  comment_count: "0",
  top_level_comment_count: "0",
  visibility: "'public'",
  authorship_mode: "'human_direct'",
  analysis_state: "'pending'",
  content_safety_state: "'pending'",
  age_gate_policy: "'none'",
  rights_basis: "'none'",
  publication_status: "'draft'",
  story_status: "'none'",
  story_publish_model: "'pirate_v1'",
  story_royalty_registration_status: "'none'",
  locked_delivery_status: "'none'",
}

type WriteTransaction = Awaited<ReturnType<Client["transaction"]>>

async function getTableCreateSql(client: Client, tableName: "posts" | "assets"): Promise<string> {
  const result = await client.execute({
    sql: `
      SELECT sql
      FROM sqlite_schema
      WHERE type = 'table'
        AND name = ?1
      LIMIT 1
    `,
    args: [tableName],
  })
  return String(result.rows[0]?.sql ?? "")
}

async function getColumnNames(client: Client, tableName: "posts" | "assets"): Promise<Set<string>> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`)
  return new Set(result.rows.map((row) => String(row.name)))
}

function rightsBasisAllowsLicensedPerformance(createSql: string): boolean {
  return /rights_basis[\s\S]*'licensed_performance'/.test(createSql)
}

function selectColumnsForExistingTable(columns: readonly string[], existingColumns: Set<string>): string {
  return columns
    .map((column) => existingColumns.has(column) ? column : `${COLUMN_DEFAULT_SELECT[column] ?? "NULL"} AS ${column}`)
    .join(", ")
}

async function rebuildPostsRightsBasisConstraint(tx: WriteTransaction, existingColumns: Set<string>): Promise<void> {
  await tx.execute("DROP TABLE IF EXISTS posts_licensed_performance_new")
  await tx.execute(`
    CREATE TABLE posts_licensed_performance_new (
      post_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      author_user_id TEXT,
      identity_mode TEXT NOT NULL CHECK (
        identity_mode IN ('public', 'anonymous')
      ),
      anonymous_scope TEXT CHECK (
        anonymous_scope IS NULL OR anonymous_scope IN ('community_stable', 'thread_stable', 'post_ephemeral')
      ),
      anonymous_label TEXT,
      disclosed_qualifiers_json TEXT,
      label_id TEXT,
      post_type TEXT NOT NULL CHECK (
        post_type IN ('text', 'image', 'video', 'link', 'song', 'crosspost')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
      ),
      comments_locked INTEGER NOT NULL DEFAULT 0 CHECK (comments_locked IN (0, 1)),
      comments_locked_at TEXT,
      comments_locked_by_user_id TEXT,
      comments_lock_reason TEXT,
      song_mode TEXT CHECK (
        song_mode IS NULL OR song_mode IN ('original', 'remix')
      ),
      title TEXT,
      song_title TEXT,
      song_annotations_url TEXT,
      song_cover_art_ref TEXT,
      song_duration_ms INTEGER,
      body TEXT,
      caption TEXT,
      lyrics TEXT,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (
        visibility IN ('public', 'members_only')
      ),
      link_url TEXT,
      link_og_image_url TEXT,
      link_og_title TEXT,
      link_enrichment_snapshot_json TEXT,
      link_enrichment_synced_at TEXT,
      embeds_json TEXT,
      media_refs_json TEXT,
      song_artifact_bundle_id TEXT,
      source_language TEXT,
      translation_policy TEXT CHECK (
        translation_policy IS NULL OR translation_policy IN ('none', 'machine_allowed', 'human_only', 'hybrid')
      ),
      rights_basis TEXT CHECK (
        rights_basis IS NULL OR rights_basis IN ('none', 'original', 'derivative', 'attribution_only', 'licensed_performance')
      ),
      access_mode TEXT CHECK (
        access_mode IS NULL OR access_mode IN ('public', 'locked')
      ),
      asset_id TEXT,
      parent_post_id TEXT,
      crosspost_source_json TEXT,
      upstream_asset_refs_json TEXT,
      source_start_ms INTEGER,
      source_duration_ms INTEGER,
      sync_offset_ms INTEGER,
      analysis_state TEXT NOT NULL CHECK (
        analysis_state IN ('pending', 'allow', 'allow_with_required_reference', 'review_required', 'blocked')
      ),
      analysis_result_ref TEXT,
      content_safety_state TEXT NOT NULL CHECK (
        content_safety_state IN ('pending', 'safe', 'sensitive', 'adult')
      ),
      age_gate_policy TEXT NOT NULL CHECK (
        age_gate_policy IN ('none', '18_plus')
      ),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      idempotency_key TEXT NOT NULL DEFAULT '',
      flair_id TEXT,
      comment_count INTEGER NOT NULL DEFAULT 0,
      top_level_comment_count INTEGER NOT NULL DEFAULT 0,
      last_comment_at TEXT,
      authorship_mode TEXT NOT NULL DEFAULT 'human_direct' CHECK (
        authorship_mode IN ('human_direct', 'user_agent')
      ),
      agent_id TEXT,
      agent_ownership_record_id TEXT,
      agent_display_name_snapshot TEXT,
      agent_owner_handle_snapshot TEXT,
      agent_ownership_provider_snapshot TEXT,
      label_assignment_status TEXT CHECK (
        label_assignment_status IS NULL
        OR label_assignment_status IN ('pending', 'assigned', 'failed', 'skipped')
      ),
      label_assigned_by TEXT CHECK (
        label_assigned_by IS NULL
        OR label_assigned_by IN ('ai', 'moderator')
      ),
      label_assigned_at TEXT,
      label_ai_confidence REAL,
      label_assignment_error TEXT,
      label_assignment_model TEXT,
      label_assignment_result_json TEXT,
      agent_handle_snapshot TEXT,
      FOREIGN KEY (community_id) REFERENCES communities(community_id),
      FOREIGN KEY (label_id) REFERENCES labels(label_id),
      FOREIGN KEY (parent_post_id) REFERENCES posts(post_id)
    )
  `)
  await tx.execute(`
    INSERT INTO posts_licensed_performance_new (${POST_COLUMNS.join(", ")})
    SELECT ${selectColumnsForExistingTable(POST_COLUMNS, existingColumns)}
    FROM posts
  `)
  await tx.execute("DROP TABLE posts")
  await tx.execute("ALTER TABLE posts_licensed_performance_new RENAME TO posts")
  await tx.execute("CREATE INDEX idx_posts_community_created ON posts(community_id, created_at DESC)")
  await tx.execute("CREATE INDEX idx_posts_parent ON posts(parent_post_id, created_at)")
  await tx.execute("CREATE INDEX idx_posts_author ON posts(author_user_id, created_at DESC)")
  await tx.execute(`
    CREATE UNIQUE INDEX idx_posts_author_idempotency
    ON posts(community_id, author_user_id, idempotency_key)
    WHERE author_user_id IS NOT NULL AND idempotency_key <> ''
  `)
  await tx.execute("CREATE INDEX idx_posts_agent_authorship ON posts(authorship_mode, agent_id, created_at DESC)")
}

async function rebuildAssetsRightsBasisConstraint(tx: WriteTransaction, existingColumns: Set<string>): Promise<void> {
  await tx.execute("DROP TABLE IF EXISTS assets_licensed_performance_new")
  await tx.execute(`
    CREATE TABLE assets_licensed_performance_new (
      asset_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      source_post_id TEXT NOT NULL,
      song_artifact_bundle_id TEXT,
      creator_user_id TEXT NOT NULL,
      asset_kind TEXT NOT NULL CHECK (
        asset_kind IN ('song_audio', 'video_file')
      ),
      rights_basis TEXT NOT NULL CHECK (
        rights_basis IN ('none', 'original', 'derivative', 'attribution_only', 'licensed_performance')
      ),
      access_mode TEXT NOT NULL CHECK (
        access_mode IN ('public', 'locked')
      ),
      primary_content_ref TEXT NOT NULL,
      primary_content_hash TEXT,
      preview_audio_json TEXT,
      cover_art_json TEXT,
      canvas_video_json TEXT,
      publication_status TEXT NOT NULL CHECK (
        publication_status IN ('draft', 'story_requested', 'story_published', 'story_failed', 'withdrawn')
      ),
      story_status TEXT NOT NULL CHECK (
        story_status IN ('none', 'requested', 'published', 'failed')
      ),
      story_error TEXT,
      story_ip_id TEXT,
      story_publish_tx_ref TEXT,
      story_asset_version_id TEXT,
      story_cdr_vault_uuid INTEGER,
      story_namespace TEXT,
      story_entitlement_token_id TEXT,
      story_read_condition TEXT,
      story_write_condition TEXT,
      story_ip_nft_contract TEXT,
      story_ip_nft_token_id TEXT,
      story_publish_model TEXT NOT NULL DEFAULT 'pirate_v1'
        CHECK (story_publish_model IN ('pirate_v1', 'story_ip_v1')),
      story_license_terms_id TEXT,
      story_license_template TEXT,
      story_royalty_policy TEXT,
      story_derivative_registered_at TEXT,
      story_revenue_token TEXT,
      story_cdr_encrypted_cid TEXT,
      story_cdr_allocate_tx_ref TEXT,
      story_cdr_write_tx_ref TEXT,
      story_royalty_policy_id TEXT,
      story_derivative_parent_ip_ids_json TEXT,
      story_royalty_registration_status TEXT NOT NULL DEFAULT 'none' CHECK (
        story_royalty_registration_status IN ('none', 'pending', 'registered', 'failed')
      ),
      license_preset TEXT CHECK (
        license_preset IN ('non-commercial', 'commercial-use', 'commercial-remix')
      ),
      commercial_rev_share_pct INTEGER CHECK (
        commercial_rev_share_pct IS NULL
        OR (commercial_rev_share_pct >= 0 AND commercial_rev_share_pct <= 100)
      ),
      locked_delivery_status TEXT NOT NULL CHECK (
        locked_delivery_status IN ('none', 'requested', 'ready', 'failed')
      ),
      locked_delivery_ref TEXT,
      locked_delivery_error TEXT,
      locked_delivery_payload_json TEXT,
      locked_delivery_storage_ref TEXT,
      locked_delivery_secret_json TEXT,
      display_title TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (community_id) REFERENCES communities(community_id),
      FOREIGN KEY (source_post_id) REFERENCES posts(post_id)
    )
  `)
  await tx.execute(`
    INSERT INTO assets_licensed_performance_new (${ASSET_COLUMNS.join(", ")})
    SELECT ${selectColumnsForExistingTable(ASSET_COLUMNS, existingColumns)}
    FROM assets
  `)
  await tx.execute("DROP TABLE assets")
  await tx.execute("ALTER TABLE assets_licensed_performance_new RENAME TO assets")
  await tx.execute("CREATE UNIQUE INDEX idx_assets_source_post ON assets(source_post_id)")
  await tx.execute("CREATE INDEX idx_assets_community_created ON assets(community_id, created_at DESC)")
  await tx.execute("CREATE INDEX idx_assets_story_status ON assets(story_status, created_at DESC)")
  await tx.execute("CREATE INDEX idx_assets_story_asset_version_id ON assets(story_asset_version_id)")
  await tx.execute("CREATE INDEX idx_assets_community_primary_content_hash ON assets(community_id, primary_content_hash)")
  await tx.execute("CREATE INDEX idx_assets_story_publish_model ON assets(story_publish_model, created_at DESC)")
  await tx.execute("CREATE INDEX idx_assets_story_ip_nft ON assets(story_ip_nft_contract, story_ip_nft_token_id)")
}

async function recordMigrationLedger(client: Client): Promise<void> {
  await client.batch([
    {
      sql: `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration_name TEXT PRIMARY KEY,
          migration_label TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `,
      args: [],
    },
    {
      sql: `
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [LICENSED_PERFORMANCE_RIGHTS_BASIS_MIGRATION_NAME, LICENSED_PERFORMANCE_RIGHTS_BASIS_MIGRATION_CHECKSUM],
    },
  ], "write")
}

export async function ensureRemotePostLicensedPerformanceRightsBasis(client: Client): Promise<void> {
  const postsCreateSql = await getTableCreateSql(client, "posts")
  const assetsCreateSql = await getTableCreateSql(client, "assets")
  const shouldRebuildPosts = !rightsBasisAllowsLicensedPerformance(postsCreateSql)
  const shouldRebuildAssets = !rightsBasisAllowsLicensedPerformance(assetsCreateSql)

  if (shouldRebuildPosts || shouldRebuildAssets) {
    const postColumns = await getColumnNames(client, "posts")
    const assetColumns = await getColumnNames(client, "assets")
    await client.execute("PRAGMA foreign_keys = OFF")
    const tx = await client.transaction("write")
    try {
      if (shouldRebuildPosts) {
        await rebuildPostsRightsBasisConstraint(tx, postColumns)
      }
      if (shouldRebuildAssets) {
        await rebuildAssetsRightsBasisConstraint(tx, assetColumns)
      }
      await tx.commit()
    } catch (error) {
      try {
        await tx.rollback()
      } catch (rollbackError) {
        console.error("[community-db] rollback failed while enabling licensed performance rights basis", rollbackError)
      }
      throw error
    } finally {
      await client.execute("PRAGMA foreign_keys = ON")
    }
  }

  await recordMigrationLedger(client)
}
