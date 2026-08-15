import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { splitSqlStatements, toSqliteCompatibleStatement, toSqliteCompatibleStatements } from "../shared/sql-migration"

describe("sql migration helpers", () => {
  test("maps the community health watermark upsert to SQLite insert-or-ignore", () => {
    const [statement] = toSqliteCompatibleStatements(`
      INSERT INTO community_health_sync_state (
        projection_key, next_date, reset_required, updated_at
      ) VALUES (
        'tinybird_community_health_daily', CURRENT_DATE, 1, CURRENT_TIMESTAMP
      )
      ON CONFLICT (projection_key) DO NOTHING;
    `)

    expect(statement).toContain("INSERT OR IGNORE INTO community_health_sync_state")
    expect(statement).not.toContain("ON CONFLICT")

    const database = new Database(":memory:")
    try {
      database.exec(`
        CREATE TABLE community_health_sync_state (
          projection_key TEXT PRIMARY KEY,
          next_date TEXT NOT NULL,
          reset_required INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        );
      `)
      database.exec(statement!)
      database.exec(statement!)
      expect(database.query("SELECT COUNT(*) AS count FROM community_health_sync_state").get()).toEqual({ count: 1 })
    } finally {
      database.close()
    }
  })

  test("keeps rehearsal fixture funding distinct while reconciling campaign counters", async () => {
    const database = new Database(":memory:")
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE reward_campaigns (
        reward_campaign_id TEXT PRIMARY KEY,
        funded_cents INTEGER NOT NULL,
        reserved_cents INTEGER NOT NULL,
        credited_cents INTEGER NOT NULL,
        refunded_cents INTEGER NOT NULL
      );
      CREATE TABLE reward_campaign_funding_effects (
        reward_campaign_id TEXT NOT NULL,
        status TEXT NOT NULL,
        failure_reason TEXT,
        expected_amount_cents INTEGER NOT NULL
      );
      CREATE TABLE reward_campaign_reservations (
        reward_campaign_id TEXT NOT NULL,
        status TEXT NOT NULL,
        amount_cents INTEGER NOT NULL
      );
      CREATE VIEW reward_campaign_accounting_reconciliation AS
      SELECT reward_campaign_id, 0 AS counters_match FROM reward_campaigns;
    `)
    const sql = await readFile(resolve(
      import.meta.dir,
      "../test-fixtures/db/control-plane/migrations/0202_control_plane_reward_rehearsal_fixture_audit.sql",
    ), "utf8")
    for (const statement of splitSqlStatements(sql)) {
      for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
        database.exec(sqliteStatement)
      }
    }

    try {
      database.exec(`
        INSERT INTO reward_campaigns VALUES ('rcp_fixture', 50, 0, 50, 0);
        INSERT INTO reward_campaign_reservations VALUES ('rcp_fixture', 'credited', 50);
        INSERT INTO reward_campaign_fixture_funding_effects (
          reward_campaign_fixture_funding_effect_id, reward_campaign_id,
          fixture_kind, amount_cents, recorded_by, recorded_at, evidence_json
        ) VALUES (
          'rff_fixture', 'rcp_fixture', 'rewards_vault_rehearsal_baseline',
          50, 'staging_fixture_test', '2026-08-10T00:00:00Z', '{}'
        );
      `)
      expect(database.query(`
        SELECT stored_funded_cents, computed_funded_cents, counters_match
        FROM reward_campaign_accounting_reconciliation
        WHERE reward_campaign_id = 'rcp_fixture'
      `).get()).toEqual({
        stored_funded_cents: 50,
        computed_funded_cents: 50,
        counters_match: 1,
      })
      expect(database.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'reward_campaign_fixture_archives'
      `).get()).toEqual({ name: "reward_campaign_fixture_archives" })
    } finally {
      database.close()
    }
  })

  test("widens HNS import challenge kinds in the SQLite control-plane mirror", async () => {
    const database = new Database(":memory:")
    const applyFixture = async (fileName: string) => {
      const sql = await readFile(resolve(
        import.meta.dir,
        "../test-fixtures/db/control-plane/migrations",
        fileName,
      ), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          database.exec(sqliteStatement)
        }
      }
    }

    try {
      await applyFixture("0000_control_plane_baseline_postgres.sql")
      await applyFixture("0138_control_plane_hns_verification_assertion_split.sql")
      database.run(`
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id,
          user_id,
          family,
          submitted_root_label,
          status,
          challenge_kind,
          ownership_source,
          authority_health_verified,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, 'hns', 'existing-root', 'expired', 'dns_txt', ?, 1, ?, ?, ?)
      `, [
        "nvs_existing_fixture",
        "usr_fixture",
        "hns_parent_chain_txt",
        "2026-08-09T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
      ])
      await applyFixture("0198_control_plane_hns_import_challenge_kind.sql")
      database.run(`
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id,
          user_id,
          family,
          submitted_root_label,
          status,
          challenge_kind,
          expires_at,
          created_at,
          updated_at
        ) VALUES (?, ?, 'hns', 'fixture-root', 'expired', 'hns_import', ?, ?, ?)
      `, [
        "nvs_hns_import_fixture",
        "usr_fixture",
        "2026-08-09T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
        "2026-08-08T00:00:00.000Z",
      ])
      expect(database.query(`
        SELECT challenge_kind, ownership_source, authority_health_verified
        FROM namespace_verification_sessions
        WHERE namespace_verification_session_id = 'nvs_existing_fixture'
      `).get()).toEqual({
        challenge_kind: "dns_txt",
        ownership_source: "hns_parent_chain_txt",
        authority_health_verified: 1,
      })
      expect(database.query(`
        SELECT challenge_kind
        FROM namespace_verification_sessions
        WHERE namespace_verification_session_id = 'nvs_hns_import_fixture'
      `).get()).toEqual({ challenge_kind: "hns_import" })
      expect(() => database.run(`
        UPDATE namespace_verification_sessions
        SET challenge_kind = 'unsupported'
        WHERE namespace_verification_session_id = 'nvs_hns_import_fixture'
      `)).toThrow(/CHECK constraint failed/u)
    } finally {
      database.close()
    }
  })

  test("adds durable HNS restart-attempt fencing fields to the SQLite mirror", async () => {
    const database = new Database(":memory:")
    const applyFixture = async (fileName: string) => {
      const sql = await readFile(resolve(
        import.meta.dir,
        "../test-fixtures/db/control-plane/migrations",
        fileName,
      ), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          database.exec(sqliteStatement)
        }
      }
    }

    try {
      database.exec("CREATE TABLE users (user_id TEXT PRIMARY KEY);")
      await applyFixture("0197_control_plane_hns_import_session_locks.sql")
      await applyFixture("0199_control_plane_hns_import_restart_attempts.sql")

      expect(database.query("PRAGMA table_info(hns_import_session_locks)").all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "restart_attempt_token", type: "TEXT" }),
          expect.objectContaining({ name: "restart_challenge_txt_value", type: "TEXT" }),
          expect.objectContaining({ name: "restart_attempt_expires_at", type: "TEXT" }),
        ]))
      expect(database.query("PRAGMA index_list(hns_import_session_locks)").all())
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ name: "idx_hns_import_session_locks_restart_attempt_expires_at" }),
        ]))
    } finally {
      database.close()
    }
  })

  test("widens helper languages without losing existing SQLite preferences", async () => {
    const database = new Database(":memory:")
    const applyFixture = async (fileName: string) => {
      const sql = await readFile(resolve(
        import.meta.dir,
        "../test-fixtures/db/control-plane/migrations",
        fileName,
      ), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          database.exec(sqliteStatement)
        }
      }
    }

    try {
      database.exec("PRAGMA foreign_keys = ON; CREATE TABLE users (user_id TEXT PRIMARY KEY);")
      await applyFixture("0180_control_plane_user_study_preferences.sql")
      for (const language of ["en", "zh", "ar", "ka"]) {
        database.run("INSERT INTO users (user_id) VALUES (?)", [`usr_${language}`])
        database.run(`
          INSERT INTO user_study_preferences (
            user_id, helper_language, delivery_mode, created_at, updated_at
          ) VALUES (?, ?, 'both', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')
        `, [`usr_${language}`, language])
      }

      await applyFixture("0194_control_plane_user_study_preferences_russian.sql")

      expect(database.query(`
        SELECT user_id, helper_language, delivery_mode, created_at, updated_at
        FROM user_study_preferences
        ORDER BY user_id
      `).all()).toEqual([
        { user_id: "usr_ar", helper_language: "ar", delivery_mode: "both", created_at: "2026-08-06T00:00:00.000Z", updated_at: "2026-08-06T00:00:00.000Z" },
        { user_id: "usr_en", helper_language: "en", delivery_mode: "both", created_at: "2026-08-06T00:00:00.000Z", updated_at: "2026-08-06T00:00:00.000Z" },
        { user_id: "usr_ka", helper_language: "ka", delivery_mode: "both", created_at: "2026-08-06T00:00:00.000Z", updated_at: "2026-08-06T00:00:00.000Z" },
        { user_id: "usr_zh", helper_language: "zh", delivery_mode: "both", created_at: "2026-08-06T00:00:00.000Z", updated_at: "2026-08-06T00:00:00.000Z" },
      ])

      database.run("INSERT INTO users (user_id) VALUES ('usr_ru')")
      database.run(`
        INSERT INTO user_study_preferences (
          user_id, helper_language, delivery_mode, created_at, updated_at
        ) VALUES ('usr_ru', 'ru', 'text', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')
      `)
      database.run("UPDATE user_study_preferences SET helper_language = 'ru' WHERE user_id = 'usr_en'")
      expect(database.query("SELECT helper_language FROM user_study_preferences WHERE user_id = 'usr_en'").get())
        .toEqual({ helper_language: "ru" })
      expect(() => database.run("UPDATE user_study_preferences SET helper_language = 'xx' WHERE user_id = 'usr_en'"))
        .toThrow(/CHECK constraint failed.*helper_language/u)
    } finally {
      database.close()
    }
  })

  test("skips PostgreSQL column nullability changes for sqlite", () => {
    expect(toSqliteCompatibleStatements(`
      ALTER TABLE reward_campaign_monitor_state
        ALTER COLUMN first_attempted_scan_at SET NOT NULL;
    `)).toEqual([])
    expect(toSqliteCompatibleStatements(`
      ALTER TABLE reward_campaign_monitor_state
        ALTER COLUMN last_successful_scan_at DROP NOT NULL;
    `)).toEqual([])
  })

  test("rebuilds scanner releases when migration 0222 broadens revocation", () => {
    const statements = toSqliteCompatibleStatements(`
      ALTER TABLE content_security_scanner_releases
        ADD CONSTRAINT content_security_scanner_release_lifecycle_check CHECK (
          (status = 'staged' AND activated_at IS NULL AND retired_at IS NULL)
          OR (status = 'active' AND activated_at IS NOT NULL AND retired_at IS NULL)
          OR (status = 'retired' AND activated_at IS NOT NULL AND retired_at IS NOT NULL)
          OR (status = 'revoked' AND retired_at IS NOT NULL)
        );
    `)

    expect(statements).toHaveLength(5)
    expect(statements.join("\n")).toContain("status = 'revoked' AND retired_at IS NOT NULL")
    expect(statements.join("\n")).toContain("idx_content_security_scanner_releases_active_profile")
  })

  test("adds migration 0223 format evidence columns to the sqlite mirror", () => {
    const statements = toSqliteCompatibleStatements(`
      ALTER TABLE content_security_scan_results
        ADD COLUMN content_format_policy_version TEXT,
        ADD COLUMN content_format_outcome TEXT,
        ADD COLUMN detected_mime_type TEXT,
        ADD COLUMN content_format_finding_code TEXT,
        ADD COLUMN content_format_error_code TEXT,
        ADD CONSTRAINT content_security_scan_results_format_evidence_check CHECK (
          content_format_outcome IN ('allow', 'reject', 'error')
        );
    `)

    expect(statements).toEqual([
      "ALTER TABLE content_security_scan_results ADD COLUMN content_format_policy_version TEXT;",
      "ALTER TABLE content_security_scan_results ADD COLUMN content_format_outcome TEXT;",
      "ALTER TABLE content_security_scan_results ADD COLUMN detected_mime_type TEXT;",
      "ALTER TABLE content_security_scan_results ADD COLUMN content_format_finding_code TEXT;",
      "ALTER TABLE content_security_scan_results ADD COLUMN content_format_error_code TEXT;",
    ])
  })

  test("skips PostgreSQL function-backed triggers for sqlite", () => {
    expect(toSqliteCompatibleStatements(`
      CREATE FUNCTION reject_term_changes()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
    `)).toEqual([])
    expect(toSqliteCompatibleStatements(`
      CREATE TRIGGER immutable_terms BEFORE UPDATE ON campaigns
      FOR EACH ROW EXECUTE FUNCTION reject_term_changes();
    `)).toEqual([])
    expect(toSqliteCompatibleStatements(`
      CREATE OR REPLACE FUNCTION enforce_projection_coverage()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$;
    `)).toEqual([])
    expect(toSqliteCompatibleStatements(`
      CREATE CONSTRAINT TRIGGER projection_coverage
      AFTER UPDATE ON projection_state
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION enforce_projection_coverage();
    `)).toEqual([])
    expect(toSqliteCompatibleStatements(`
      DROP TRIGGER dance_attempt_session_start_cue_immutable ON dance_attempt_sessions;
    `)).toEqual([])
  })

  test("keeps sqlite triggers intact when a leading comment precedes CREATE TRIGGER", () => {
    const statements = splitSqlStatements(`
      -- Published rows are immutable.
      CREATE TRIGGER published_row_guard
      BEFORE UPDATE ON published_rows
      WHEN OLD.status = 'published'
      BEGIN
        SELECT RAISE(ABORT, 'published rows are immutable');
      END;
    `)

    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain("CREATE TRIGGER published_row_guard")
    expect(statements[0]).toContain("END;")
  })

  test("rewrites the PostgreSQL dance cue hash backfill for sqlite", () => {
    const [statement] = toSqliteCompatibleStatements(`
      UPDATE dance_attempt_sessions
      SET start_cue_policy_version = 'dance_start_cue_gross_body_v1',
          start_cue_kind = CASE (get_byte(decode(md5(dance_attempt_session_id), 'hex'), 0) % 3)
            WHEN 0 THEN 'hands_on_head'
            WHEN 1 THEN 'arms_t'
            ELSE 'hands_on_hips'
          END,
          updated_at = NOW()
      WHERE status IN ('initialized', 'uploading', 'submitted', 'grading')
        AND start_cue_policy_version IS NULL;
    `)

    expect(statement).toContain("length(dance_attempt_session_id) % 3")
    expect(statement).toContain("updated_at = CURRENT_TIMESTAMP")
    expect(statement).not.toContain("md5")
  })

  test("splits dance cue columns from PostgreSQL table constraints for sqlite", () => {
    expect(toSqliteCompatibleStatements(`
      ALTER TABLE dance_attempt_sessions
        ADD COLUMN start_cue_policy_version TEXT,
        ADD COLUMN start_cue_kind TEXT,
        ADD COLUMN start_cue_minimum_hold_ms INTEGER,
        ADD COLUMN start_cue_observation_window_ms INTEGER,
        ADD COLUMN start_cue_outcome TEXT,
        ADD COLUMN scored_window_start_ms INTEGER,
        ADD CONSTRAINT dance_attempt_session_start_cue_assignment_check CHECK (
          start_cue_policy_version IS NULL OR start_cue_kind IS NOT NULL
        );
    `)).toHaveLength(6)
  })

  test("splits PostgreSQL multi-column projection state changes for sqlite", () => {
    expect(toSqliteCompatibleStatements(`
      ALTER TABLE efp_follow_projection_state
        ADD COLUMN last_reconciled_at TIMESTAMPTZ,
        ADD COLUMN last_reconciliation_error TEXT;
    `)).toEqual([
      "ALTER TABLE efp_follow_projection_state ADD COLUMN last_reconciled_at TEXT;",
      "ALTER TABLE efp_follow_projection_state ADD COLUMN last_reconciliation_error TEXT;",
    ])
  })

  test("splits generic nullable multi-column additions for sqlite", () => {
    expect(toSqliteCompatibleStatements(`
      -- Versioned consent is stored before upload authorization.
      ALTER TABLE dance_attempt_sessions
        ADD COLUMN consent_policy_version TEXT,
        ADD COLUMN consented_at TIMESTAMPTZ,
        ADD COLUMN consent_source TEXT;
    `)).toEqual([
      "ALTER TABLE dance_attempt_sessions ADD COLUMN consent_policy_version TEXT;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN consented_at TEXT;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN consent_source TEXT;",
    ])
  })

  test("preserves dance cue columns when SQLite skips PostgreSQL constraints", () => {
    expect(toSqliteCompatibleStatements(`
      ALTER TABLE dance_attempt_sessions
        ADD COLUMN start_cue_policy_version TEXT,
        ADD COLUMN start_cue_kind TEXT,
        ADD COLUMN start_cue_minimum_hold_ms INTEGER,
        ADD COLUMN start_cue_observation_window_ms INTEGER,
        ADD COLUMN start_cue_outcome TEXT,
        ADD COLUMN scored_window_start_ms INTEGER,
        ADD CONSTRAINT dance_attempt_session_start_cue_assignment_check CHECK (start_cue_kind IS NULL);
    `)).toEqual([
      "ALTER TABLE dance_attempt_sessions ADD COLUMN start_cue_policy_version TEXT;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN start_cue_kind TEXT;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN start_cue_minimum_hold_ms INTEGER;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN start_cue_observation_window_ms INTEGER;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN start_cue_outcome TEXT;",
      "ALTER TABLE dance_attempt_sessions ADD COLUMN scored_window_start_ms INTEGER;",
    ])
    expect(toSqliteCompatibleStatements("DROP TRIGGER dance_attempt_session_start_cue_immutable ON dance_attempt_sessions;")).toEqual([])
    expect(toSqliteCompatibleStatement(`
      UPDATE dance_attempt_sessions
      SET start_cue_kind = CASE (get_byte(decode(md5(dance_attempt_session_id), 'hex'), 0) % 3)
      WHERE start_cue_policy_version IS NULL;
    `)).toContain("length(dance_attempt_session_id) % 3")
  })

  test("translates EFP recovery state and review deadlines for sqlite", () => {
    expect(toSqliteCompatibleStatements(`
      ALTER TABLE efp_follow_write_intents
        ADD COLUMN semantic_attempt_key TEXT,
        ADD COLUMN sponsorship_budget_date DATE,
        ADD COLUMN sponsorship_review_after TIMESTAMPTZ;
    `)).toEqual([
      "ALTER TABLE efp_follow_write_intents ADD COLUMN semantic_attempt_key TEXT;",
      "ALTER TABLE efp_follow_write_intents ADD COLUMN sponsorship_budget_date TEXT;",
      "ALTER TABLE efp_follow_write_intents ADD COLUMN sponsorship_review_after TEXT;",
    ])

    expect(toSqliteCompatibleStatement(`
      UPDATE efp_follow_write_intents
      SET sponsorship_budget_date = CAST(updated_at AS DATE),
          sponsorship_review_after = updated_at + INTERVAL '24 hours'
      WHERE sponsorship_reserved_transaction_count > 0;
    `)).toContain("sponsorship_review_after = datetime(updated_at, '+24 hours')")
  })

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

  test("rewrites fixed-length PostgreSQL hex regex checks for sqlite", () => {
    const statement = toSqliteCompatibleStatement(`
      CREATE TABLE observed_funding_receipts (
        token_address TEXT NOT NULL CHECK (token_address ~ '^0x[0-9a-f]{40}$'),
        tx_hash TEXT NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
        content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        runtime_lock_sha256 TEXT NOT NULL CHECK (runtime_lock_sha256 ~ '^[a-f0-9]{64}$'),
        image_digest TEXT NOT NULL CHECK (image_digest ~ '^sha256:[a-f0-9]{64}$'),
        expected_content_hash TEXT NOT NULL CHECK (expected_content_hash ~ '^0x[a-f0-9]{64}$')
      );
    `)

    expect(statement).toContain("length(token_address) = 42")
    expect(statement).toContain("substr(token_address, 3) NOT GLOB '*[^0-9a-f]*'")
    expect(statement).toContain("length(tx_hash) = 66")
    expect(statement).toContain("length(content_sha256) = 64")
    expect(statement).toContain("content_sha256 NOT GLOB '*[^0-9a-f]*'")
    expect(statement).toContain("length(runtime_lock_sha256) = 64")
    expect(statement).toContain("runtime_lock_sha256 NOT GLOB '*[^0-9a-f]*'")
    expect(statement).toContain("length(image_digest) = 71")
    expect(statement).toContain("substr(image_digest, 1, 7) = 'sha256:'")
    expect(statement).toContain("substr(image_digest, 8) NOT GLOB '*[^0-9a-f]*'")
    expect(statement).toContain("length(expected_content_hash) = 66")
    expect(statement).not.toContain(" ~ ")
  })

  test("rewrites mixed-case fixed-length hex regex checks for sqlite", () => {
    const statement = toSqliteCompatibleStatement(`
      CREATE TABLE reward_ticket_pools (
        jackpot_address TEXT NOT NULL CHECK (jackpot_address ~ '^0x[0-9a-fA-F]{40}$'),
        terms_hash TEXT NOT NULL CHECK (terms_hash ~ '^[0-9a-f]{64}$')
      );
    `)

    expect(statement).toContain("length(jackpot_address) = 42")
    expect(statement).toContain("substr(jackpot_address, 1, 2) = '0x'")
    expect(statement).toContain("substr(jackpot_address, 3) NOT GLOB '*[^0-9a-fA-F]*'")
    expect(statement).toContain("length(terms_hash) = 64")
    expect(statement).not.toContain(" ~ ")
  })

  test("rewrites variable-length PostgreSQL hex regex checks for sqlite", () => {
    const statement = toSqliteCompatibleStatement(`
      CREATE TABLE reward_ticket_evm_submissions (
        signed_transaction TEXT NOT NULL CHECK (signed_transaction ~ '^0x[0-9a-fA-F]+$')
      );
    `)

    expect(statement).toContain("length(signed_transaction) > 2")
    expect(statement).toContain("substr(signed_transaction, 1, 2) = '0x'")
    expect(statement).toContain("substr(signed_transaction, 3) NOT GLOB '*[^0-9a-fA-F]*'")
    expect(statement).not.toContain(" ~ ")
  })

  test("rewrites PostgreSQL JSON object checks for sqlite", () => {
    expect(toSqliteCompatibleStatement(
      "CREATE TABLE evidence (payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'));",
    )).toContain("payload TEXT NOT NULL CHECK (json_type(payload) = 'object')")
  })

  test("builds the local reward funding mirror with the refund-pending custody state", () => {
    const statement = toSqliteCompatibleStatement(`
      CREATE TABLE reward_campaign_funding_effects (
        status TEXT NOT NULL CHECK (status IN (
          'quoted', 'confirming', 'confirmed', 'failed', 'refunded'
        )),
        received_amount_atomic TEXT,
        confirmed_at TIMESTAMPTZ,
        CHECK (received_amount_atomic IS NULL OR status IN ('confirmed', 'refunded')),
        CHECK (confirmed_at IS NULL OR status IN ('confirmed', 'refunded'))
      );
    `)

    expect(statement).toContain("'failed', 'refund_pending', 'refunded'")
    expect(statement?.match(/'confirmed', 'refund_pending', 'refunded'/g)).toHaveLength(2)
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

  test("skips postgres-only ALTER COLUMN nullability changes for the sqlite mirror", () => {
    expect(toSqliteCompatibleStatement(
      "ALTER TABLE reward_campaign_monitor_state ALTER COLUMN first_attempted_scan_at SET NOT NULL;",
    )).toBeNull()
    expect(toSqliteCompatibleStatement(
      "ALTER TABLE reward_campaign_monitor_state ALTER COLUMN last_successful_scan_at DROP NOT NULL;",
    )).toBeNull()
  })

  test("applies the dance choreography fixture with ready-revision completeness", async () => {
    const database = new Database(":memory:")
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (user_id TEXT PRIMARY KEY);
      CREATE TABLE communities (community_id TEXT PRIMARY KEY);
      CREATE TABLE song_artifact_bundles (song_artifact_bundle_id TEXT PRIMARY KEY);
      INSERT INTO users VALUES ('usr_creator');
      INSERT INTO communities VALUES ('cmty_test');
      INSERT INTO song_artifact_bundles VALUES ('sab_song');
    `)
    for (const fileName of [
      "0168_control_plane_dance_choreographies.sql",
      "0169_control_plane_dance_reference_dispatch.sql",
    ]) {
      const sql = await readFile(resolve(
        import.meta.dir,
        "../test-fixtures/db/control-plane/migrations",
        fileName,
      ), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          database.exec(sqliteStatement)
        }
      }
    }

    try {
      database.exec(`
        INSERT INTO dance_choreographies (
          dance_choreography_id, community_id, host_post_id, referenced_song_post_id,
          song_artifact_bundle_id, creator_user_id, status
        ) VALUES (
          'dch_incomplete', 'cmty_test', 'post_incomplete', 'post_song',
          'sab_song', 'usr_creator', 'ready'
        );
      `)
      expect(database.query(`
        SELECT COUNT(*) AS count
        FROM dance_choreographies
        WHERE dance_choreography_id = 'dch_incomplete'
      `).get()).toEqual({ count: 0 })
      database.exec(`
        INSERT INTO dance_choreographies (
          dance_choreography_id, community_id, host_post_id, referenced_song_post_id,
          song_artifact_bundle_id, creator_user_id, status
        ) VALUES (
          'dch_test', 'cmty_test', 'post_dance', 'post_song',
          'sab_song', 'usr_creator', 'processing'
        );
      `)
      database.exec(`
        INSERT INTO dance_choreography_revisions (
          dance_choreography_revision_id, dance_choreography_id, revision_number,
          reference_storage_ref, reference_content_sha256, reference_mime_type,
          reference_size_bytes, status, ready_at
        ) VALUES (
          'dcr_incomplete', 'dch_test', 1,
          'r2://references/ref.mp4', '${"a".repeat(64)}',
          'video/mp4', 1024, 'ready', '2026-07-29T00:00:00Z'
        );
      `)
      expect(database.query(`
        SELECT COUNT(*) AS count
        FROM dance_choreography_revisions
        WHERE dance_choreography_revision_id = 'dcr_incomplete'
      `).get()).toEqual({ count: 0 })
      database.exec(`
        INSERT INTO dance_choreography_revisions (
          dance_choreography_revision_id, dance_choreography_id, revision_number,
          reference_storage_ref, reference_content_sha256, reference_mime_type,
          reference_size_bytes, reference_duration_ms, reference_width, reference_height,
          reference_fps_millihertz, reference_feature_ref, reference_feature_sha256,
          reference_feature_size_bytes, pose_model_version, pose_model_sha256,
          pose_runtime_version, feature_schema_version, scorer_version, artifact_version,
          mirror_policy, status, ready_at
        ) VALUES (
          'dcr_ready', 'dch_test', 1,
          'r2://references/ref.mp4', '${"a".repeat(64)}',
          'video/mp4', 1024, 10000, 576, 1024, 30000,
          'r2://features/ref.json', '${"b".repeat(64)}', 2048,
          'pose_v1', '${"c".repeat(64)}', '0.10.35',
          'features_v1', 'scorer_v1', 'artifact_v1',
          'allowed', 'ready', '2026-07-29T00:00:00Z'
        );
      `)
      expect(database.query(`
        SELECT status, mirror_policy, reference_dispatch_attempt_count
        FROM dance_choreography_revisions
        WHERE dance_choreography_revision_id = 'dcr_ready'
      `).get()).toEqual({
        status: "ready",
        mirror_policy: "allowed",
        reference_dispatch_attempt_count: 0,
      })
    } finally {
      database.close()
    }
  })

  test("applies the verbatim 0153/0154 fixtures to sqlite and preserves root-state coherence", async () => {
    const database = new Database(":memory:")
    const applyFixture = async (fileName: string) => {
      const sql = await readFile(resolve(
        import.meta.dir,
        "../test-fixtures/db/control-plane/migrations",
        fileName,
      ), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          database.exec(sqliteStatement)
        }
      }
    }

    try {
      await applyFixture("0152_control_plane_hns_root_delegation_state.sql")
      database.exec(`
        INSERT INTO hns_root_delegation_state (
          normalized_root_label,
          rollover_state,
          state_changed_at,
          created_at,
          updated_at
        ) VALUES ('pirate', 'none', '2026-07-23T00:00:00Z', '2026-07-23T00:00:00Z', '2026-07-23T00:00:00Z')
      `)

      await applyFixture("0153_control_plane_hns_root_authority_redundancy.sql")
      await applyFixture("0154_control_plane_hns_root_redundancy_evidence_provenance.sql")

      const migrated = database.query(`
        SELECT canonical_routing_eligible, routing_hard_denied, authority_redundancy_evidence_class
        FROM hns_root_delegation_state
        WHERE normalized_root_label = 'pirate'
      `).get() as {
        authority_redundancy_evidence_class: string | null;
        canonical_routing_eligible: number;
        routing_hard_denied: number;
      }
      expect(migrated).toEqual({
        authority_redundancy_evidence_class: null,
        canonical_routing_eligible: 0,
        routing_hard_denied: 0,
      })
      expect(database.query(`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN (
            'hns_root_redundancy_vantage_observations',
            'hns_root_redundancy_vantage_authority_observations'
          )
        ORDER BY name
      `).all()).toEqual([
        { name: "hns_root_redundancy_vantage_authority_observations" },
        { name: "hns_root_redundancy_vantage_observations" },
      ])
      expect(() => database.exec(`
        UPDATE hns_root_delegation_state
        SET authority_redundancy_ok = 1
        WHERE normalized_root_label = 'pirate'
      `)).toThrow()
    } finally {
      database.close()
    }
  })

  test("applies verbatim 0153 -> 0154 fixtures with provenance and FK targets intact", async () => {
    const database = new Database(":memory:")
    const applyFixture = async (fileName: string) => {
      const sql = await readFile(resolve(
        import.meta.dir,
        "../test-fixtures/db/control-plane/migrations",
        fileName,
      ), "utf8")
      for (const statement of splitSqlStatements(sql)) {
        for (const sqliteStatement of toSqliteCompatibleStatements(statement)) {
          database.exec(sqliteStatement)
        }
      }
    }

    try {
      await applyFixture("0152_control_plane_hns_root_delegation_state.sql")
      await applyFixture("0153_control_plane_hns_root_authority_redundancy.sql")
      database.exec(`
        INSERT INTO hns_root_redundancy_observations (
          redundancy_observation_id,
          normalized_root_label,
          outcome,
          provider,
          observed_parent_ns_json,
          authority_redundancy_ok,
          observed_at,
          created_at
        ) VALUES (
          'red_local',
          'dankmeme',
          'succeeded',
          'hns_verifier',
          '["ns1.pirate.","ns2.pirate."]',
          1,
          '2026-07-23T00:00:00Z',
          '2026-07-23T00:00:00Z'
        );
        INSERT INTO hns_root_redundancy_authority_observations (
          redundancy_authority_observation_id,
          redundancy_observation_id,
          normalized_root_label,
          nameserver,
          reachable,
          soa_serial,
          serial_in_sync,
          created_at
        ) VALUES (
          'red_authority_local',
          'red_local',
          'dankmeme',
          'ns1.pirate.',
          1,
          '2026072203',
          1,
          '2026-07-23T00:00:00Z'
        );
        INSERT INTO hns_root_delegation_state (
          normalized_root_label,
          rollover_state,
          state_changed_at,
          created_at,
          updated_at,
          authority_redundancy_ok,
          last_redundancy_observation_id,
          last_redundancy_observation_outcome,
          last_redundancy_observation_at
        ) VALUES (
          'dankmeme',
          'none',
          '2026-07-23T00:00:00Z',
          '2026-07-23T00:00:00Z',
          '2026-07-23T00:00:00Z',
          1,
          'red_local',
          'succeeded',
          '2026-07-23T00:00:00Z'
        );
      `)

      await applyFixture("0154_control_plane_hns_root_redundancy_evidence_provenance.sql")

      const migrated = database.query(`
        SELECT
          observation.evidence_class,
          observation.independent_vantage_count,
          observation.independent_asn_count,
          state.authority_redundancy_evidence_class
        FROM hns_root_redundancy_observations AS observation
        JOIN hns_root_delegation_state AS state
          ON state.last_redundancy_observation_id = observation.redundancy_observation_id
        WHERE observation.redundancy_observation_id = 'red_local'
      `).get()
      expect(migrated).toEqual({
        evidence_class: "local_single_vantage",
        independent_vantage_count: 1,
        independent_asn_count: 1,
        authority_redundancy_evidence_class: "local_single_vantage",
      })

      const indexes = database.query(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND tbl_name = 'hns_root_redundancy_observations'
      `).all() as Array<{ name: string }>
      const indexNames = new Set(indexes.map(({ name }) => name))
      expect(indexNames.has("idx_hns_root_redundancy_observations_id_root_outcome")).toBe(true)
      expect(
        indexNames.has("idx_hns_root_redundancy_observations_id_root_outcome_evidence"),
      ).toBe(true)

      expect(() => database.exec(`
        INSERT INTO hns_root_redundancy_observations (
          redundancy_observation_id,
          normalized_root_label,
          outcome,
          provider,
          observed_parent_ns_json,
          authority_redundancy_ok,
          evidence_class,
          quorum_policy_version,
          independent_vantage_count,
          independent_asn_count,
          observed_at,
          created_at
        ) VALUES (
          'red_bad_quorum',
          'dankmeme',
          'succeeded',
          'external_probe',
          '["ns1.pirate.","ns2.pirate."]',
          1,
          'external_multi_vantage',
          'v1',
          2,
          1,
          '2026-07-23T00:00:00Z',
          '2026-07-23T00:00:00Z'
        )
      `)).toThrow()

      database.exec(`
        INSERT INTO hns_root_redundancy_observations (
          redundancy_observation_id,
          normalized_root_label,
          outcome,
          provider,
          observed_parent_ns_json,
          authority_redundancy_ok,
          evidence_class,
          quorum_policy_version,
          independent_vantage_count,
          independent_asn_count,
          observed_at,
          created_at
        ) VALUES (
          'red_multi',
          'dankmeme',
          'succeeded',
          'external_probe',
          '["ns1.pirate.","ns2.pirate."]',
          1,
          'external_multi_vantage',
          'v1',
          2,
          2,
          '2026-07-23T00:00:00Z',
          '2026-07-23T00:00:00Z'
        )
      `)

      // The fixture bootstrap intentionally leaves FK checks off while rebuilding
      // parent tables. Turn them on for the assertion or this test proves nothing.
      database.exec("PRAGMA foreign_keys = ON")
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([])
      expect(() => database.exec(`
        INSERT INTO hns_root_redundancy_vantage_observations (
          redundancy_vantage_observation_id,
          redundancy_observation_id,
          normalized_root_label,
          provider,
          measurement_ref,
          vantage_id,
          vantage_asn,
          observed_at,
          created_at
        ) VALUES (
          'vantage_cross_root',
          'red_multi',
          'otherroot',
          'external_probe',
          'measurement-1',
          'probe-1',
          64500,
          '2026-07-23T00:00:00Z',
          '2026-07-23T00:00:00Z'
        )
      `)).toThrow()
    } finally {
      database.close()
    }
  })

  test("a ';' inside a block comment does not split the statement", () => {
    const sql = `/* note: run as owner; then grant */ CREATE TABLE t (id TEXT);`
    expect(splitSqlStatements(sql)).toEqual([sql])
  })

  test("keeps a trigger preceded by comments as one statement", () => {
    const sql = `-- Preserve immutable published rows.
CREATE TRIGGER published_rows_no_update
BEFORE UPDATE ON published_rows
BEGIN
  SELECT RAISE(ABORT, 'published rows are immutable');
END;`

    expect(splitSqlStatements(sql)).toEqual([sql])
  })
})
