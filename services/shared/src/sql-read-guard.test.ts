import { describe, expect, test } from "bun:test"
import {
  isBootstrapAllowedStatement,
  isReadOnlyStatement,
  isWriteAllowedStatement,
} from "./sql-read-guard"

/**
 * Direct unit tests for the lexical SQL guards. Until now these were only
 * exercised indirectly through shard-read tests with synthetic statements,
 * which is how the generated snapshot's CREATE TRIGGERs (real, committed
 * schema) shipped to production without a single guard test ever seeing them.
 *
 * This is the production trigger shape from community-template migration 1147
 * (dance_attempt_upload_invalid_reason) that the bootstrap guard rejected.
 */
const PRODUCTION_TRIGGER = `CREATE TRIGGER dance_attempt_segment_fingerprints_insert
BEFORE INSERT ON dance_attempt
WHEN NEW.segment_fingerprint_hmac_json IS NOT NULL
 AND EXISTS (
    SELECT 1
    FROM json_each(NEW.segment_fingerprint_hmac_json)
    WHERE type <> 'text'
       OR length(value) <> 64
       OR value GLOB '*[^0-9a-f]*'
 )
BEGIN
    SELECT RAISE(ABORT, 'invalid dance segment fingerprint');
END;`

describe("isBootstrapAllowedStatement", () => {
  test("allows the CREATE TABLE / INDEX / INSERT shapes the snapshot is built from", () => {
    expect(isBootstrapAllowedStatement("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY);")).toBe(true)
    expect(isBootstrapAllowedStatement("CREATE INDEX idx_t_id ON t (id);")).toBe(true)
    expect(isBootstrapAllowedStatement("INSERT INTO t (id) VALUES (?1)")).toBe(true)
  })

  test("allows a single CREATE TRIGGER with body semicolons inside BEGIN ... END", () => {
    expect(isBootstrapAllowedStatement(PRODUCTION_TRIGGER)).toBe(true)
    // Without the trailing semicolon (sqlite_master stores it that way).
    expect(isBootstrapAllowedStatement(PRODUCTION_TRIGGER.trim().replace(/;$/, ""))).toBe(true)
  })

  test("rejects a second statement smuggled after the trigger body", () => {
    expect(isBootstrapAllowedStatement(`${PRODUCTION_TRIGGER} DELETE FROM dance_attempt`)).toBe(false)
    expect(isBootstrapAllowedStatement(`${PRODUCTION_TRIGGER} ${PRODUCTION_TRIGGER}`)).toBe(false)
  })

  test("rejects destructive verbs and PRAGMA inside a trigger body", () => {
    expect(
      isBootstrapAllowedStatement("CREATE TRIGGER t AFTER INSERT ON x BEGIN DROP TABLE x; END;"),
    ).toBe(false)
    expect(
      isBootstrapAllowedStatement("CREATE TRIGGER t AFTER INSERT ON x BEGIN ALTER TABLE x ADD COLUMN c TEXT; END;"),
    ).toBe(false)
    expect(
      isBootstrapAllowedStatement("CREATE TRIGGER t AFTER INSERT ON x BEGIN PRAGMA user_version = 2; END;"),
    ).toBe(false)
  })

  test("rejects batching outside the trigger shape", () => {
    expect(isBootstrapAllowedStatement("CREATE TABLE a (x); CREATE TABLE b (y)")).toBe(false)
    expect(isBootstrapAllowedStatement("INSERT INTO t VALUES (1); DELETE FROM t")).toBe(false)
  })

  test("rejects reads, destructive DDL, and PRAGMA", () => {
    expect(isBootstrapAllowedStatement("SELECT 1")).toBe(false)
    expect(isBootstrapAllowedStatement("DROP TABLE t")).toBe(false)
    expect(isBootstrapAllowedStatement("ALTER TABLE t ADD COLUMN c TEXT")).toBe(false)
    expect(isBootstrapAllowedStatement("PRAGMA user_version")).toBe(false)
    expect(isBootstrapAllowedStatement("PRAGMA user_version = 1")).toBe(false)
  })
})

describe("trigger DDL on the other guards (must NOT leak onto read/write paths)", () => {
  test("a CREATE TRIGGER is not a read-only statement", () => {
    expect(isReadOnlyStatement(PRODUCTION_TRIGGER)).toBe(false)
  })

  test("a CREATE TRIGGER is not a runtime write statement", () => {
    expect(isWriteAllowedStatement(PRODUCTION_TRIGGER)).toBe(false)
  })
})

describe("isReadOnlyStatement", () => {
  test("allows plain reads and rejects writes, DDL, and batching", () => {
    expect(isReadOnlyStatement("SELECT 1")).toBe(true)
    expect(isReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true)
    expect(isReadOnlyStatement("PRAGMA table_info(t)")).toBe(true)
    expect(isReadOnlyStatement("INSERT INTO t VALUES (1)")).toBe(false)
    expect(isReadOnlyStatement("SELECT 1; DROP TABLE t")).toBe(false)
    expect(isReadOnlyStatement("PRAGMA user_version = 1")).toBe(false)
  })
})

describe("isWriteAllowedStatement", () => {
  test("allows DML and rejects DDL, reads, and batching", () => {
    expect(isWriteAllowedStatement("INSERT INTO t VALUES (?1)")).toBe(true)
    expect(isWriteAllowedStatement("UPDATE t SET a = ?1 WHERE id = ?2")).toBe(true)
    expect(isWriteAllowedStatement("DELETE FROM t WHERE id = ?1")).toBe(true)
    expect(isWriteAllowedStatement("CREATE TABLE t (id INTEGER)")).toBe(false)
    expect(isWriteAllowedStatement("SELECT 1")).toBe(false)
    expect(isWriteAllowedStatement("INSERT INTO t VALUES (1); DELETE FROM t")).toBe(false)
  })
})
