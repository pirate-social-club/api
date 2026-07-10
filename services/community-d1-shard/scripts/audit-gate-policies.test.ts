import { describe, expect, test } from "bun:test"

import {
  analyzePolicies,
  databaseNameForBinding,
  evaluateCaptchaAlone,
  parseWranglerRows,
  parseOptions,
  POLICY_SQL,
  POOL_SQL,
  SCHEMA_SQL,
} from "./audit-gate-policies"

describe("gate policy shard audit", () => {
  test("uses SELECT-only SQL against policy and schema tables", () => {
    for (const sql of [POOL_SQL, SCHEMA_SQL, POLICY_SQL]) {
      expect(sql.trim().toUpperCase().startsWith("SELECT")).toBe(true)
      expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|PRAGMA)\b/iu)
    }
  })

  test("maps staging and production pool bindings without consulting member data", () => {
    expect(databaseNameForBinding("DB_CMTY_0007", "staging")).toBe("community-d1-pool-0007-staging")
    expect(databaseNameForBinding("DB_CMTY_0007", "production")).toBe("community-d1-pool-0007-prod")
    expect(databaseNameForBinding("DB_CMTY_PILOT", "staging")).toBe("cmty-pilot-staging")
  })

  test("requires an explicit production-read acknowledgement", () => {
    expect(() => parseOptions(["--environment", "production"])).toThrow(
      "production inventory requires --allow-production-read",
    )
    expect(parseOptions(["--environment", "production", "--allow-production-read"]).environment).toBe("production")
  })

  test("parses Wrangler D1 JSON envelopes", () => {
    expect(parseWranglerRows<{ id: string }>(JSON.stringify([
      { success: true, results: [{ id: "one" }] },
    ]))).toEqual([{ id: "one" }])
    expect(() => parseWranglerRows("not-json")).toThrow("wrangler returned invalid JSON")
  })

  test("implements the authoritative captcha-alone assignment", () => {
    expect(evaluateCaptchaAlone({
      op: "and",
      children: [
        { op: "gate", gate: { type: "altcha_pow" } },
        { op: "or", children: [
          { op: "gate", gate: { type: "unique_human" } },
          { op: "gate", gate: { type: "erc721_holding" } },
        ] },
      ],
    })).toBe(false)
    expect(evaluateCaptchaAlone({
      op: "or",
      children: [
        { op: "gate", gate: { type: "unique_human" } },
        { op: "gate", gate: { type: "altcha_pow" } },
      ],
    })).toBe(true)
  })

  test("reports mixed operators, token gates, and single-child wrappers", () => {
    const finding = analyzePolicies({
      communityId: "cmt_test",
      bindingName: "DB_CMTY_0001",
      databaseName: "community-d1-pool-0001-staging",
      rows: [{
        scope: "membership",
        expression_json: JSON.stringify({
          version: 1,
          expression: {
            op: "and",
            children: [{
              op: "or",
              children: [
                { op: "gate", gate: { type: "altcha_pow" } },
                { op: "gate", gate: { type: "erc721_holding" } },
              ],
            }],
          },
        }),
      }],
    })

    expect(finding).toMatchObject({
      erc721_holding: true,
      mixed_operators: true,
      captcha_alone_admits: true,
      single_child_operator: true,
      invalid_expression: false,
    })
  })
})
