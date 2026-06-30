import type { Client } from "@libsql/client"

const LIVE_ROOMS_MIGRATION_NAME = "1070_live_rooms.sql"
const LIVE_ROOMS_MIGRATION_CHECKSUM = "47dcdd32d64789c6f93e6162f137b7238c75914532256aa0d186d5a8b68fa179"
const LIVE_ROOM_SETLIST_SOURCE_ASSET_REF_MIGRATION_NAME = "1076_live_room_setlist_source_asset_ref.sql"
const LIVE_ROOM_SETLIST_SOURCE_ASSET_REF_MIGRATION_CHECKSUM = "55f125162ffc23a107556a295b1456a74065100e6a98895a11b2560b2540baab"
const LIVE_ROOM_VIEWER_SESSIONS_MIGRATION_NAME = "1078_live_room_viewer_sessions.sql"
const LIVE_ROOM_VIEWER_SESSIONS_MIGRATION_CHECKSUM = "e56e39e1529e9fcd282795a6df8cc05639529aa59b535ef0c84261336b3ec5bc"
const LIVE_ROOM_RECORDING_ENABLED_MIGRATION_NAME = "1110_live_room_recording_enabled.sql"
const LIVE_ROOM_RECORDING_ENABLED_MIGRATION_CHECKSUM = "f5c9413b994ff0ae278201b45c31510874209b07d699332e99912959146f6ae3"
const LIVE_ROOM_RECORDINGS_MIGRATION_NAME = "1111_live_room_recordings.sql"
const LIVE_ROOM_RECORDINGS_MIGRATION_CHECKSUM = "c57f9e69547141e64d9c2425af4dedae0928fe42ac5350c6ee76855de3d73683"
const LIVE_ROOM_REPLAY_ASSETS_MIGRATION_NAME = "1112_live_room_replay_assets.sql"
const LIVE_ROOM_REPLAY_ASSETS_MIGRATION_CHECKSUM = "3cd34e171f36eb93b508684645782bbee8690fc660108c23e38e934806a01475"
const LIVE_ROOM_REPLAY_LOCKED_DELIVERY_MIGRATION_NAME = "1113_live_room_replay_locked_delivery.sql"
const LIVE_ROOM_REPLAY_LOCKED_DELIVERY_MIGRATION_CHECKSUM = "3b631159e77ed088823ac192f18e4945dc37a43c6f2f0cb2f3a26cf6ab38fb4a"

async function hasColumn(client: Client, tableName: string, columnName: string): Promise<boolean> {
  const result = await client.execute(`PRAGMA table_info(${tableName})`)
  return result.rows.some((row) => String(row.name) === columnName)
}

export async function ensureRemoteLiveRoomTables(client: Client): Promise<void> {
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
        CREATE TABLE IF NOT EXISTS live_rooms (
          live_room_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          anchor_post_id TEXT NOT NULL,
          host_user_id TEXT NOT NULL,
          guest_user_id TEXT,
          room_kind TEXT NOT NULL CHECK (room_kind IN ('solo', 'duet')),
          status TEXT NOT NULL CHECK (status IN ('scheduled', 'live', 'ended', 'canceled')),
          access_mode TEXT NOT NULL CHECK (access_mode IN ('free', 'gated', 'paid')),
          visibility TEXT NOT NULL CHECK (visibility IN ('public', 'unlisted')),
          title TEXT NOT NULL,
          description TEXT,
          cover_ref TEXT,
          event_start_at INTEGER,
          live_started_at INTEGER,
          ended_at INTEGER,
          canceled_at INTEGER,
          broadcast_ref TEXT,
          recording_enabled INTEGER DEFAULT 0 CHECK (recording_enabled IS NULL OR recording_enabled IN (0, 1)),
          replay_status TEXT NOT NULL CHECK (replay_status IN ('none', 'processing', 'review_pending', 'published', 'failed')),
          replay_asset_id TEXT,
          replay_listing_id TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (community_id) REFERENCES communities(community_id),
          FOREIGN KEY (anchor_post_id) REFERENCES posts(post_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_live_rooms_community_status
          ON live_rooms(community_id, status, created_at DESC)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_recordings (
          recording_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          live_room_id TEXT NOT NULL,
          provider TEXT NOT NULL DEFAULT 'agora' CHECK (provider IN ('agora')),
          provider_resource_id TEXT,
          provider_session_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('starting', 'recording', 'stopping', 'captured', 'ingesting', 'failed')),
          started_at INTEGER,
          stopped_at INTEGER,
          raw_artifact_ref TEXT,
          failure_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_recordings_room
          ON live_room_recordings(live_room_id)
      `,
      args: [],
    },
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_live_room_recordings_community_status
          ON live_room_recordings(community_id, status, updated_at DESC)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_replay_assets (
          replay_asset_id TEXT PRIMARY KEY,
          community_id TEXT NOT NULL,
          live_room_id TEXT NOT NULL,
          source_recording_id TEXT NOT NULL,
          publication_status TEXT NOT NULL CHECK (publication_status IN ('draft', 'published', 'failed')),
          title TEXT NOT NULL,
          caption TEXT,
          duration_ms INTEGER,
          preview_ref TEXT,
          access_mode TEXT NOT NULL CHECK (access_mode IN ('free', 'included_with_ticket', 'paid')),
          primary_content_ref TEXT NOT NULL,
          locked_delivery_status TEXT NOT NULL DEFAULT 'none' CHECK (locked_delivery_status IN ('none', 'requested', 'ready', 'failed')),
          locked_delivery_storage_ref TEXT,
          story_cdr_vault_uuid TEXT,
          published_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id),
          FOREIGN KEY (source_recording_id) REFERENCES live_room_recordings(recording_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_replay_assets_room
          ON live_room_replay_assets(live_room_id)
      `,
      args: [],
    },
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_live_room_replay_assets_community_status
          ON live_room_replay_assets(community_id, publication_status, updated_at DESC)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_replay_allocations (
          allocation_id TEXT PRIMARY KEY,
          replay_asset_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          participant_user_id TEXT,
          external_party_ref TEXT,
          role TEXT NOT NULL,
          share_bps INTEGER NOT NULL CHECK (share_bps >= 0 AND share_bps <= 10000),
          rights_basis TEXT NOT NULL DEFAULT 'performer_default',
          approval_status TEXT NOT NULL DEFAULT 'approved' CHECK (approval_status IN ('pending', 'approved', 'rejected')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (replay_asset_id) REFERENCES live_room_replay_assets(replay_asset_id),
          CHECK (participant_user_id IS NOT NULL OR external_party_ref IS NOT NULL)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_live_room_replay_allocations_asset
          ON live_room_replay_allocations(replay_asset_id)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_performer_allocations (
          allocation_id TEXT PRIMARY KEY,
          live_room_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('host', 'guest')),
          share_bps INTEGER NOT NULL CHECK (share_bps >= 0 AND share_bps <= 10000),
          created_at TEXT NOT NULL,
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_allocations_role
          ON live_room_performer_allocations(live_room_id, role)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_setlists (
          setlist_id TEXT PRIMARY KEY,
          live_room_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'ready', 'locked')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_setlists_room
          ON live_room_setlists(live_room_id)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_setlist_items (
          setlist_item_id TEXT PRIMARY KEY,
          setlist_id TEXT NOT NULL,
          live_room_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          song_artifact_bundle_id TEXT,
          source_asset_ref TEXT,
          title TEXT NOT NULL,
          artist TEXT,
          rights_basis TEXT NOT NULL CHECK (rights_basis IN ('original', 'licensed', 'cover', 'public_domain', 'unknown')),
          license_ref TEXT,
          rights_status TEXT NOT NULL CHECK (rights_status IN ('pending', 'ready', 'blocked')),
          blocking_rights_failure INTEGER NOT NULL DEFAULT 0 CHECK (blocking_rights_failure IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (setlist_id) REFERENCES live_room_setlists(setlist_id),
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_setlist_items_position
          ON live_room_setlist_items(setlist_id, position)
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_guest_invites (
          guest_invite_id TEXT PRIMARY KEY,
          live_room_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          guest_user_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked')),
          accepted_at TEXT,
          revoked_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_guest_invites_active
          ON live_room_guest_invites(live_room_id, guest_user_id)
          WHERE status IN ('pending', 'accepted')
      `,
      args: [],
    },
    {
      sql: `
        CREATE TABLE IF NOT EXISTS live_room_viewer_sessions (
          community_id TEXT NOT NULL,
          live_room_id TEXT NOT NULL,
          viewer_user_id TEXT NOT NULL,
          agora_uid INTEGER NOT NULL CHECK (agora_uid >= 0 AND agora_uid <= 4294967295),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (community_id, live_room_id, viewer_user_id),
          FOREIGN KEY (live_room_id) REFERENCES live_rooms(live_room_id)
        )
      `,
      args: [],
    },
    {
      sql: `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_live_room_viewer_sessions_uid
          ON live_room_viewer_sessions(community_id, live_room_id, agora_uid)
      `,
      args: [],
    },
    {
      sql: `
        CREATE INDEX IF NOT EXISTS idx_live_room_viewer_sessions_viewer
          ON live_room_viewer_sessions(community_id, viewer_user_id, updated_at DESC)
      `,
      args: [],
    },
    {
      sql: `
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [LIVE_ROOMS_MIGRATION_NAME, LIVE_ROOMS_MIGRATION_CHECKSUM],
    },
  ], "write")

  if (!(await hasColumn(client, "live_room_setlist_items", "source_asset_ref"))) {
    await client.execute("ALTER TABLE live_room_setlist_items ADD COLUMN source_asset_ref TEXT")
  }
  if (!(await hasColumn(client, "live_rooms", "recording_enabled"))) {
    await client.execute("ALTER TABLE live_rooms ADD COLUMN recording_enabled INTEGER DEFAULT 0 CHECK (recording_enabled IS NULL OR recording_enabled IN (0, 1))")
  }
  if (!(await hasColumn(client, "live_rooms", "replay_asset_id"))) {
    await client.execute("ALTER TABLE live_rooms ADD COLUMN replay_asset_id TEXT")
  }
  if (!(await hasColumn(client, "live_rooms", "replay_listing_id"))) {
    await client.execute("ALTER TABLE live_rooms ADD COLUMN replay_listing_id TEXT")
  }
  const replayAssetColumns: Array<[string, string]> = [
    ["locked_delivery_secret_json", "TEXT"],
    ["story_namespace", "TEXT"],
    ["story_entitlement_token_id", "TEXT"],
    ["story_read_condition", "TEXT"],
    ["story_write_condition", "TEXT"],
    ["locked_delivery_error", "TEXT"],
  ]
  for (const [columnName, columnType] of replayAssetColumns) {
    if (!(await hasColumn(client, "live_room_replay_assets", columnName))) {
      await client.execute(`ALTER TABLE live_room_replay_assets ADD COLUMN ${columnName} ${columnType}`)
    }
  }
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'community-template', ?2)
    `,
    args: [
      LIVE_ROOM_SETLIST_SOURCE_ASSET_REF_MIGRATION_NAME,
      LIVE_ROOM_SETLIST_SOURCE_ASSET_REF_MIGRATION_CHECKSUM,
    ],
  })
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'community-template', ?2)
    `,
    args: [
      LIVE_ROOM_VIEWER_SESSIONS_MIGRATION_NAME,
      LIVE_ROOM_VIEWER_SESSIONS_MIGRATION_CHECKSUM,
    ],
  })
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'community-template', ?2)
    `,
    args: [
      LIVE_ROOM_RECORDING_ENABLED_MIGRATION_NAME,
      LIVE_ROOM_RECORDING_ENABLED_MIGRATION_CHECKSUM,
    ],
  })
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'community-template', ?2)
    `,
    args: [
      LIVE_ROOM_RECORDINGS_MIGRATION_NAME,
      LIVE_ROOM_RECORDINGS_MIGRATION_CHECKSUM,
    ],
  })
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'community-template', ?2)
    `,
    args: [
      LIVE_ROOM_REPLAY_ASSETS_MIGRATION_NAME,
      LIVE_ROOM_REPLAY_ASSETS_MIGRATION_CHECKSUM,
    ],
  })
  await client.execute({
    sql: `
      INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
      VALUES (?1, 'community-template', ?2)
    `,
    args: [
      LIVE_ROOM_REPLAY_LOCKED_DELIVERY_MIGRATION_NAME,
      LIVE_ROOM_REPLAY_LOCKED_DELIVERY_MIGRATION_CHECKSUM,
    ],
  })
}
