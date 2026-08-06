import { describe, expect, test } from "bun:test"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { activateHnsRootRouting } from "./activation"

const NOW = "2026-08-06T18:00:00.000Z"

function healthyObservation(index: number) {
  return {
    parent_observation_id: `hrp_${index}`,
    outcome: "succeeded",
    observed_delegation_security: "secure",
    parent_ds_matches_live_dnskey: 1,
    authoritative_dnssec_valid: 1,
    earliest_rrsig_expires_at: "2026-08-06T20:00:00.000Z",
    observed_at: `2026-08-06T17:${String(59 - index * 5).padStart(2, "0")}:00.000Z`,
  }
}

class ActivationClient implements Client, Transaction {
  statements: InStatement[] = []
  committed = false
  rolledBack = false
  state = { canonical_routing_eligible: 0, routing_hard_denied: 0 }
  observations: Record<string, unknown>[] = [healthyObservation(0), healthyObservation(1), healthyObservation(2)]

  async execute(statement: InStatement | string): Promise<QueryResult> {
    if (typeof statement === "string") throw new Error("expected structured SQL")
    this.statements.push(statement)
    if (statement.sql.includes("FROM hns_root_delegation_state")) return { rows: [this.state] }
    if (statement.sql.includes("FROM hns_root_parent_observations")) return { rows: this.observations }
    if (statement.sql.includes("UPDATE hns_root_delegation_state")) {
      if (this.state.canonical_routing_eligible === 1 || this.state.routing_hard_denied === 1) {
        return { rows: [], rowsAffected: 0 }
      }
      this.state.canonical_routing_eligible = 1
      return { rows: [], rowsAffected: 1 }
    }
    if (statement.sql.includes("INSERT INTO audit_log")) return { rows: [], rowsAffected: 1 }
    throw new Error(`unexpected SQL: ${statement.sql}`)
  }

  async batch(): Promise<QueryResult[]> { throw new Error("batch not implemented") }
  async transaction(): Promise<Transaction> { return this }
  async commit(): Promise<void> { this.committed = true }
  async rollback(): Promise<void> { this.rolledBack = true }
  close(): void {}
}

describe("activateHnsRootRouting", () => {
  test("activates and audits a root backed by three fresh secure cycles", async () => {
    const client = new ActivationClient()
    const result = await activateHnsRootRouting(client, {
      rootLabel: "XN--POKMON-DVA",
      operatorActorId: "operator_hns",
      reason: "three-cycle production activation",
      now: NOW,
    })

    expect(result).toEqual({
      normalizedRootLabel: "xn--pokmon-dva",
      activated: true,
      alreadyActive: false,
      evidenceObservationIds: ["hrp_0", "hrp_1", "hrp_2"],
    })
    const audit = client.statements.find((statement) => statement.sql.includes("INSERT INTO audit_log"))
    expect(audit?.args).toContain("hns_root.routing_activate")
    expect(audit?.args).toContain("operator_hns")
    expect(client.committed).toBe(true)
  })

  test("fails when any of the latest three attempts is unhealthy", async () => {
    const client = new ActivationClient()
    client.observations[1] = { ...healthyObservation(1), outcome: "failed", observed_delegation_security: null }

    await expect(activateHnsRootRouting(client, {
      rootLabel: "xn--pokmon-dva",
      operatorActorId: "operator_hns",
      reason: "test",
      now: NOW,
    })).rejects.toThrow("latest three HNS observations must all be secure")
    expect(client.rolledBack).toBe(true)
  })

  test("rejects three healthy observations produced by a retry burst", async () => {
    const client = new ActivationClient()
    client.observations = [0, 1, 2].map((index) => ({
      ...healthyObservation(index),
      observed_at: `2026-08-06T17:59:${String(index * 10).padStart(2, "0")}.000Z`,
    }))

    await expect(activateHnsRootRouting(client, {
      rootLabel: "xn--pokmon-dva",
      operatorActorId: "operator_hns",
      reason: "test",
      now: NOW,
    })).rejects.toThrow("must span at least ten minutes")
    expect(client.rolledBack).toBe(true)
  })

  test("fails closed when the root is hard-denied", async () => {
    const client = new ActivationClient()
    client.state.routing_hard_denied = 1

    await expect(activateHnsRootRouting(client, {
      rootLabel: "xn--pokmon-dva",
      operatorActorId: "operator_hns",
      reason: "test",
      now: NOW,
    })).rejects.toMatchObject({ status: 409, code: "conflict" })
  })

  test("is idempotent without writing a second audit event", async () => {
    const client = new ActivationClient()
    client.state.canonical_routing_eligible = 1
    const result = await activateHnsRootRouting(client, {
      rootLabel: "xn--pokmon-dva",
      operatorActorId: "operator_hns",
      reason: "test",
      now: NOW,
    })

    expect(result.alreadyActive).toBe(true)
    expect(client.statements.some((statement) => statement.sql.includes("INSERT INTO audit_log"))).toBe(false)
  })
})
