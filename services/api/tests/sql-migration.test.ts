import { describe, expect, test } from "bun:test"
import { splitSqlStatements, toSqliteCompatibleStatement, toSqliteCompatibleStatements } from "../shared/sql-migration"

describe("sql migration helpers", () => {
  test("keeps dollar-quoted DO blocks intact so they can be skipped later", () => {
    const sql = `
      CREATE TABLE example (id TEXT PRIMARY KEY);

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'example_id_fkey'
        ) THEN
          ALTER TABLE example
            ADD CONSTRAINT example_id_fkey
            FOREIGN KEY (id) REFERENCES other(id);
        END IF;
      END $$;
    `

    expect(splitSqlStatements(sql)).toEqual([
      "CREATE TABLE example (id TEXT PRIMARY KEY);",
      `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'example_id_fkey'
        ) THEN
          ALTER TABLE example
            ADD CONSTRAINT example_id_fkey
            FOREIGN KEY (id) REFERENCES other(id);
        END IF;
      END $$;`,
    ])
  })

  test("rewrites postgres defaults and skips DO blocks for sqlite", () => {
    expect(toSqliteCompatibleStatement(
      "CREATE TABLE linked_handles (created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    )).toBe("CREATE TABLE linked_handles (created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);")

    expect(toSqliteCompatibleStatement(
      "ALTER TABLE verification_sessions ADD COLUMN verification_requirements_json JSONB NOT NULL DEFAULT '[]'::jsonb;",
    )).toBe("ALTER TABLE verification_sessions ADD COLUMN verification_requirements_json TEXT NOT NULL DEFAULT '[]';")

    expect(toSqliteCompatibleStatement("DO $$ BEGIN SELECT 1; END $$;")).toBeNull()
  })

  test("ignores comment-only migrations", () => {
    const sql = `
      -- Retired before runtime wiring.
      -- No schema changes remain.
    `

    expect(splitSqlStatements(sql)).toEqual([])
    expect(toSqliteCompatibleStatement(sql)).toBeNull()
  })

  test("expands namespace Spaces root label checks into sqlite triggers", () => {
    const statements = toSqliteCompatibleStatements(`
      ALTER TABLE namespace_verifications
        ADD CONSTRAINT namespace_verifications_spaces_root_label_ascii_check
        CHECK (
          family <> 'spaces'
          OR normalized_root_label ~ '^[a-z0-9-]+$'
        );
    `)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("BEFORE INSERT ON namespace_verifications")
    expect(statements[1]).toContain("BEFORE UPDATE OF family, normalized_root_label ON namespace_verifications")
  })

  test("keeps sqlite-compatible evolving verification checks at their latest accepted values", () => {
    expect(toSqliteCompatibleStatement(`
      ALTER TABLE verification_sessions
        ADD COLUMN IF NOT EXISTS provider_mode TEXT CHECK (
          provider_mode IS NULL OR provider_mode IN ('qr_deeplink', 'widget', 'native_sdk')
        );
    `)).toContain("provider_mode IN ('qr_deeplink', 'widget', 'native_sdk', 'web_sdk')")

    const identityNullifiers = toSqliteCompatibleStatement(`
      CREATE TABLE identity_nullifiers (
        identity_nullifier_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (
          provider IN ('self', 'very')
        ),
        mechanism TEXT NOT NULL CHECK (
          mechanism IN ('zk-nullifier', 'palm-nullifier')
        )
      );
    `)

    expect(identityNullifiers).toContain("provider IN ('self', 'very', 'zkpassport')")
    expect(identityNullifiers).toContain("mechanism IN ('zk-nullifier', 'palm-nullifier', 'zkpassport-unique-identifier')")
  })

  test("builds the sqlite reward ledger with campaign enum expansions", () => {
    const rewardEvents = toSqliteCompatibleStatement(`
      CREATE TABLE reward_events (
        reward_kind TEXT NOT NULL CHECK (reward_kind IN (
          'study_streak_day', 'study_streak_milestone_7', 'study_streak_milestone_30'
        )),
        source TEXT NOT NULL CHECK (source IN ('song_engagement_reconciler'))
      );
    `)
    expect(rewardEvents).toContain("'campaign_practice_day'")
    expect(rewardEvents).toContain("'campaign_milestone_30'")
    expect(rewardEvents).toContain("'reward_campaign_reconciler'")
  })

  test("a ';' inside a line comment does not split the statement (regression: migration 0122)", () => {
    // The leading comment block has an embedded ';' AND an apostrophe — neither may split the
    // statement or toggle quote state. Matches migration 0122's "(superuser); the ..." comment.
    const sql = `-- Repair: must run as the owner; the apply script uses that role.
-- The migrator's grants are corrected here.
ALTER TABLE booking_profiles OWNER TO control_plane_migrator;
GRANT SELECT ON booking_profiles TO control_plane_api_rw;`
    expect(splitSqlStatements(sql)).toEqual([
      `-- Repair: must run as the owner; the apply script uses that role.
-- The migrator's grants are corrected here.
ALTER TABLE booking_profiles OWNER TO control_plane_migrator;`,
      "GRANT SELECT ON booking_profiles TO control_plane_api_rw;",
    ])
  })

  test("ignores trailing comment-only fragments with semicolons", () => {
    const sql = `CREATE TABLE example (id TEXT PRIMARY KEY);
-- Historical duplicate detector:
--   GROUP BY community_id, effect_key HAVING c > 1;`

    expect(splitSqlStatements(sql)).toEqual(["CREATE TABLE example (id TEXT PRIMARY KEY);"])
  })

  test("skips postgres-only ownership/grant statements for the sqlite mirror", () => {
    expect(toSqliteCompatibleStatement("ALTER TABLE booking_profiles OWNER TO control_plane_migrator;")).toBeNull()
    expect(toSqliteCompatibleStatement("GRANT SELECT ON booking_profiles TO control_plane_api_rw;")).toBeNull()
    expect(toSqliteCompatibleStatement("REVOKE ALL ON TABLE operator_credentials FROM control_plane_api_rw;")).toBeNull()
    // ...even when a leading comment block is glued onto the statement by the splitter.
    expect(toSqliteCompatibleStatement(`-- ownership repair
ALTER TABLE booking_profiles OWNER TO control_plane_migrator;`)).toBeNull()
  })

  test("a ';' inside a block comment does not split the statement", () => {
    const sql = `/* note: run as owner; then grant */ CREATE TABLE t (id TEXT);`
    expect(splitSqlStatements(sql)).toEqual([sql])
  })
})
