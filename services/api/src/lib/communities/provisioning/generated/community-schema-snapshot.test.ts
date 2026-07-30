import { describe, expect, test } from "bun:test"
import { isBootstrapAllowedStatement } from "@pirate/api-shared"
import { COMMUNITY_SCHEMA_STATEMENTS } from "./community-schema-snapshot"

/**
 * Regression pin: every statement in the COMMITTED community schema snapshot
 * must pass the shard bootstrap guard. Migration 1147 added CREATE TRIGGERs
 * (body semicolons inside BEGIN ... END) that the guard rejected, taking down
 * d1_native provisioning in production while every CI check stayed green —
 * the snapshot freshness gate never validated guard compatibility and no test
 * imported this artifact. The generator now asserts the same contract at
 * build time; this test pins the committed file, so a hand-edited, stale, or
 * bypass-generated snapshot fails too.
 */
describe("COMMUNITY_SCHEMA_STATEMENTS vs the shard bootstrap guard", () => {
  test("every generated statement passes isBootstrapAllowedStatement", () => {
    const rejected = COMMUNITY_SCHEMA_STATEMENTS.filter(
      (sql) => !isBootstrapAllowedStatement(sql),
    )
    expect(rejected).toEqual([])
  })

  test("the snapshot still contains CREATE TRIGGER objects (guard-drift canary)", () => {
    // The 1147 triggers are what exercise the guard's trigger handling. If a
    // future schema change legitimately removes all triggers, delete this
    // canary — its only job is to prove the guard and the real snapshot shape
    // cannot silently part ways again.
    expect(
      COMMUNITY_SCHEMA_STATEMENTS.some((sql) => /^CREATE TRIGGER\b/i.test(sql)),
    ).toBe(true)
  })
})
