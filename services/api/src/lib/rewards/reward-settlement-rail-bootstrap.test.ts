import { describe, expect, test } from "bun:test"

import {
  describeDatabaseTarget,
  planSettlementRailBootstrap,
  SettlementRailBootstrapError,
} from "./reward-settlement-rail-bootstrap"

const VALID = {
  environment: "staging",
  backend: "eoa_vault",
  chainId: "84532",
  tokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  treasuryAddress: `0x${"A".repeat(40)}`,
  operatorAddress: `0x${"b".repeat(40)}`,
  vaultAddress: `0x${"A".repeat(40)}`,
  randomHex: "deadbeef",
}

function expectRejected(input: Record<string, unknown>, field: string): void {
  let caught: unknown
  try {
    planSettlementRailBootstrap({ ...VALID, ...input } as Parameters<typeof planSettlementRailBootstrap>[0])
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(SettlementRailBootstrapError)
  expect((caught as SettlementRailBootstrapError).reason).toBe("invalid_input")
  expect((caught as SettlementRailBootstrapError).details).toMatchObject({ field })
}

describe("planSettlementRailBootstrap", () => {
  test("normalizes addresses to lowercase and derives a traceable rail id", () => {
    const plan = planSettlementRailBootstrap(VALID)
    expect(plan.tokenAddress).toBe("0x036cbd53842c5426634e7929541ec2318f3dcf7e")
    expect(plan.treasuryAddress).toBe(`0x${"a".repeat(40)}`)
    expect(plan.vaultAddress).toBe(`0x${"a".repeat(40)}`)
    expect(plan.policyVersion).toBe("v1")
    expect(plan.railId).toBe("rail_staging_84532_036cbd53_deadbeef")
  })

  test("local backend must not carry a vault; vault backends must", () => {
    const local = planSettlementRailBootstrap({ ...VALID, backend: "local", vaultAddress: null })
    expect(local.vaultAddress).toBeNull()
    expectRejected({ backend: "local" }, "vault-address")
    expectRejected({ backend: "lit_vault", vaultAddress: "" }, "vault-address")
  })

  test("rejects malformed inputs field by field", () => {
    expectRejected({ environment: "prod" }, "environment")
    expectRejected({ backend: "eoa" }, "backend")
    expectRejected({ chainId: "0" }, "chain-id")
    expectRejected({ chainId: "84532.5" }, "chain-id")
    expectRejected({ tokenAddress: "0x123" }, "token-address")
    expectRejected({ treasuryAddress: "not-an-address" }, "treasury-address")
    expectRejected({ operatorAddress: `0x${"g".repeat(40)}` }, "operator-address")
    expectRejected({ policyVersion: "" }, "policy-version")
    expectRejected({ policyVersion: "x".repeat(101) }, "policy-version")
    expectRejected({ randomHex: "DEADBEEF" }, "randomHex")
  })
})

describe("describeDatabaseTarget", () => {
  test("never includes credentials", () => {
    const described = describeDatabaseTarget("postgres://admin:sup3r-secret@db.internal:5432/control_plane")
    expect(described).toBe("db.internal/control_plane")
    expect(described).not.toContain("secret")
    expect(described).not.toContain("admin")
  })

  test("degrades safely on unparseable urls", () => {
    expect(describeDatabaseTarget("not a url")).toBe("unparseable-database-url")
  })
})
