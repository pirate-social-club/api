// Real-Postgres coverage for the dual-engine helper-language migration. Runs only when
// CONTROL_PLANE_MIGRATIONS_TEST_ADMIN_URL is set and uses a scratch database per run.
import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { splitSqlStatements } from "../../../shared/sql-migration"

const ADMIN_URL = process.env.CONTROL_PLANE_MIGRATIONS_TEST_ADMIN_URL
if (process.env.CONTROL_PLANE_MIGRATIONS_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("CONTROL_PLANE_MIGRATIONS_TEST_ADMIN_URL is required for control-plane migration PostgreSQL CI")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = `study_preferences_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`
const MIGRATIONS_DIR = resolve(import.meta.dir, "../../../test-fixtures/db/control-plane/migrations")

function urlFor(database?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (database) url.pathname = `/${database}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(database?: string): SQL {
  return new SQL({
    url: urlFor(database),
    tls: false,
    max: 1,
    connectionTimeout: 5,
  } as Record<string, unknown>)
}

async function applyMigrationFile(db: SQL, fileName: string): Promise<void> {
  const sql = await readFile(resolve(MIGRATIONS_DIR, fileName), "utf8")
  for (const statement of splitSqlStatements(sql)) {
    await db.unsafe(statement)
  }
}

describe.skipIf(!RUN)("user study preference migration (real Postgres)", () => {
  let db: SQL

  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    db = connect(TEST_DB)
    for (const role of ["control_plane_api_ro", "control_plane_api_rw", "control_plane_migrator", "control_plane_ops_ro"]) {
      await db.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
          CREATE ROLE ${role} NOLOGIN;
        END IF;
      END $$`)
    }

    const migrationFiles = (await readdir(MIGRATIONS_DIR))
      .filter((fileName) => fileName.endsWith(".sql") && fileName <= "0180_control_plane_user_study_preferences.sql")
      .sort()
    for (const fileName of migrationFiles) {
      await applyMigrationFile(db, fileName)
    }
    // Migrations 0181-0193 do not touch user_study_preferences, so this focused
    // upgrade contract deliberately jumps from its creating migration to 0194.
  }, 120_000)

  afterAll(async () => {
    if (db) await db.end()
    if (!ADMIN_URL) return
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    await root.end()
  })

  test("preserves existing rows while accepting Russian and rejecting unsupported languages", async () => {
    for (const language of ["en", "zh", "ar", "ka"]) {
      await db.unsafe(`
        INSERT INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES ($1, 'unverified', '[]', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')
      `, [`usr_${language}`])
      await db.unsafe(`
        INSERT INTO user_study_preferences (
          user_id, helper_language, delivery_mode, created_at, updated_at
        ) VALUES ($1, $2, 'both', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')
      `, [`usr_${language}`, language])
    }

    await applyMigrationFile(db, "0194_control_plane_user_study_preferences_russian.sql")

    const preserved = await db.unsafe(`
      SELECT user_id, helper_language, delivery_mode,
             created_at::text AS created_at, updated_at::text AS updated_at
      FROM user_study_preferences
      ORDER BY user_id
    `) as Array<Record<string, unknown>>
    expect(preserved.map(({ user_id, helper_language, delivery_mode }) => ({
      user_id,
      helper_language,
      delivery_mode,
    }))).toEqual([
      { user_id: "usr_ar", helper_language: "ar", delivery_mode: "both" },
      { user_id: "usr_en", helper_language: "en", delivery_mode: "both" },
      { user_id: "usr_ka", helper_language: "ka", delivery_mode: "both" },
      { user_id: "usr_zh", helper_language: "zh", delivery_mode: "both" },
    ])

    await db.unsafe(`
      INSERT INTO users (
        user_id, verification_state, verification_capabilities_json, created_at, updated_at
      ) VALUES ('usr_ru', 'unverified', '[]', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')
    `)
    await db.unsafe(`
      INSERT INTO user_study_preferences (
        user_id, helper_language, delivery_mode, created_at, updated_at
      ) VALUES ('usr_ru', 'ru', 'text', '2026-08-06T00:00:00.000Z', '2026-08-06T00:00:00.000Z')
    `)
    await db.unsafe("UPDATE user_study_preferences SET helper_language = 'ru' WHERE user_id = 'usr_en'")
    expect(await db.unsafe("SELECT helper_language FROM user_study_preferences WHERE user_id = 'usr_en'"))
      .toEqual([{ helper_language: "ru" }])
    let unsupportedLanguageError: unknown = null
    try {
      await db.unsafe("UPDATE user_study_preferences SET helper_language = 'xx' WHERE user_id = 'usr_en'")
    } catch (error) {
      unsupportedLanguageError = error
    }
    expect(unsupportedLanguageError).toMatchObject({ code: "23514" })
    expect(String(unsupportedLanguageError)).toMatch(/helper_language_check/u)
  }, 120_000)
})
