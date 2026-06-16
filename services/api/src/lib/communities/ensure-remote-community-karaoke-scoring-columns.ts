import type { Client } from "@libsql/client"
import { logPipelineInfo } from "../observability/pipeline-log"

const MIGRATION_NAME = "1098_community_karaoke_scoring_policy.sql"
const MIGRATION_CHECKSUM = "runtime-self-heal-1098"

const COLUMNS = [
  {
    name: "karaoke_scoring_enabled",
    sql: "ALTER TABLE communities ADD COLUMN karaoke_scoring_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_scoring_enabled IN (0, 1))",
  },
  {
    name: "karaoke_stt_provider",
    sql: "ALTER TABLE communities ADD COLUMN karaoke_stt_provider TEXT NOT NULL DEFAULT 'assistant' CHECK (karaoke_stt_provider IN ('assistant', 'elevenlabs', 'mistral', 'openai', 'none'))",
  },
  {
    name: "karaoke_stt_model",
    sql: "ALTER TABLE communities ADD COLUMN karaoke_stt_model TEXT NOT NULL DEFAULT ''",
  },
  {
    name: "karaoke_voice_coach_enabled",
    sql: "ALTER TABLE communities ADD COLUMN karaoke_voice_coach_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_voice_coach_enabled IN (0, 1))",
  },
  {
    name: "karaoke_audio_retention",
    sql: "ALTER TABLE communities ADD COLUMN karaoke_audio_retention TEXT NOT NULL DEFAULT 'not_stored' CHECK (karaoke_audio_retention = 'not_stored')",
  },
] as const

export async function ensureRemoteCommunityKaraokeScoringColumns(
  client: Client,
  context: { communityId?: string | null } = {},
): Promise<void> {
  const info = await client.execute("PRAGMA table_info(communities)")
  const existing = new Set(info.rows.map((row) => String(row.name)))
  const added: string[] = []
  for (const column of COLUMNS) {
    if (existing.has(column.name)) continue
    try {
      await client.execute(column.sql)
      added.push(column.name)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes("duplicate column")) throw error
    }
  }

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
      args: [MIGRATION_NAME, MIGRATION_CHECKSUM],
    },
  ], "write")

  if (added.length > 0) {
    logPipelineInfo("[community-db-factory] remote community karaoke scoring schema self-healed", {
      community_id: context.communityId ?? null,
      migration_name: MIGRATION_NAME,
      columns: added,
    })
  }
}
