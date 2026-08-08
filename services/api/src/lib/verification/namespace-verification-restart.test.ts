import { afterEach, describe, expect, test } from "bun:test"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { mockFetch } from "../../test-helpers/fetch"
import { restartNamespaceVerificationChallenge } from "./namespace-verification-restart"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

class RestartClient implements Client {
  statements: InStatement[] = []

  async execute(statement: InStatement | string): Promise<QueryResult> {
    if (typeof statement === "string") throw new Error("expected structured SQL")
    this.statements.push(statement)
    if (statement.sql.includes("INSERT INTO hns_import_session_locks")) {
      return {
        rows: [{ namespace_verification_session_id: "nvs_restart" }],
        rowsAffected: 1,
      }
    }
    if (statement.sql.includes("SET restart_attempt_token = ?3")) {
      return {
        rows: [{
          restart_attempt_token: statement.args?.[2],
          restart_challenge_txt_value: statement.args?.[3],
        }],
        rowsAffected: 1,
      }
    }
    return { rows: [], rowsAffected: 1 }
  }

  async batch(): Promise<QueryResult[]> {
    throw new Error("batch not implemented")
  }

  async transaction(): Promise<Transaction> {
    return {
      execute: (statement) => this.execute(statement),
      batch: async () => { throw new Error("batch not implemented") },
      commit: async () => {},
      rollback: async () => {},
      close: () => {},
    }
  }
}

function restartRow(status: NamespaceVerificationSessionRow["status"]): NamespaceVerificationSessionRow {
  return {
    family: "hns",
    status,
    user_id: "usr_restart",
    normalized_root_label: "restartroot",
    submitted_root_label: "restartroot",
  } as NamespaceVerificationSessionRow
}

describe("restartNamespaceVerificationChallenge", () => {
  test("rejects non-restartable states before acquiring a lock or calling the verifier", async () => {
    const client = new RestartClient()
    let fetchCalled = false
    globalThis.fetch = mockFetch(async () => {
      fetchCalled = true
      throw new Error("unexpected verifier call")
    })

    await expect(restartNamespaceVerificationChallenge({
      client,
      env: { HNS_VERIFIER_BASE_URL: "https://verifier.test" },
      row: restartRow("challenge_pending"),
      namespaceVerificationSessionId: "nvs_restart",
      now: new Date("2026-08-08T00:00:00.000Z"),
      updatedAt: "2026-08-08T00:00:00.000Z",
    })).rejects.toMatchObject({ status: 409, code: "conflict" })

    expect(fetchCalled).toBe(false)
    expect(client.statements).toHaveLength(0)
  })

  test("keeps the session row untouched when the verifier omits raw_records", async () => {
    const client = new RestartClient()
    let publishCalled = false
    globalThis.fetch = mockFetch(async (input) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/inspect-public?")) {
        return Response.json({
          root_exists: true,
          expiry_horizon_sufficient: true,
          observation_provider: "web3dns_json_doh",
        })
      }
      if (url.includes("/observe-root-parent?")) {
        return Response.json({
          root_label: "restartroot",
          zone_name: "restartroot.",
          provider: "hsd_json_rpc",
          observed_at: "2026-08-08T00:00:00.000Z",
          chain_anchor: {
            network: "main",
            height: 1_000,
            block_hash: "ab".repeat(32),
            median_time: 1_700_000_000,
          },
          parent: { nameservers: [], ds_records: [], glue4: [], glue6: [] },
        })
      }
      if (url.endsWith("/publish-txt")) publishCalled = true
      throw new Error(`unexpected verifier call ${url}`)
    })

    await expect(restartNamespaceVerificationChallenge({
      client,
      env: { HNS_VERIFIER_BASE_URL: "https://verifier.test" },
      row: restartRow("expired"),
      namespaceVerificationSessionId: "nvs_restart",
      now: new Date("2026-08-08T00:00:00.000Z"),
      updatedAt: "2026-08-08T00:00:00.000Z",
    })).rejects.toMatchObject({ status: 503, code: "verifier_contract_incompatible" })

    expect(publishCalled).toBe(false)
    expect(client.statements.some((statement) => statement.sql.includes("UPDATE namespace_verification_sessions"))).toBe(false)
  })

  test("rolls back session recovery when attempt finalization fails", async () => {
    const state = {
      committedChallenge: "pirate-verification=nch_old",
      attemptToken: null as string | null,
      commits: 0,
      rollbacks: 0,
    }
    class AtomicFailureClient implements Client {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        if (typeof statement === "string") throw new Error("expected structured SQL")
        if (statement.sql.includes("INSERT INTO hns_import_session_locks")) {
          return { rows: [{ namespace_verification_session_id: "nvs_restart" }], rowsAffected: 1 }
        }
        if (statement.sql.includes("SET restart_attempt_token = ?3")) {
          state.attemptToken = String(statement.args?.[2])
          return {
            rows: [{
              restart_attempt_token: state.attemptToken,
              restart_challenge_txt_value: statement.args?.[3],
            }],
            rowsAffected: 1,
          }
        }
        throw new Error(`unexpected SQL: ${statement.sql}`)
      }

      async batch(): Promise<QueryResult[]> {
        throw new Error("batch not implemented")
      }

      async transaction(): Promise<Transaction> {
        let stagedChallenge = state.committedChallenge
        return {
          execute: async (statement) => {
            if (typeof statement === "string") throw new Error("expected structured SQL")
            if (statement.sql.includes("UPDATE namespace_verification_sessions")) {
              stagedChallenge = String(statement.args?.[3])
              return { rows: [], rowsAffected: 1 }
            }
            if (statement.sql.includes("restart_attempt_token = NULL")) {
              throw new Error("injected lock finalization failure")
            }
            throw new Error(`unexpected transaction SQL: ${statement.sql}`)
          },
          batch: async () => { throw new Error("batch not implemented") },
          commit: async () => {
            state.commits += 1
            state.committedChallenge = stagedChallenge
          },
          rollback: async () => { state.rollbacks += 1 },
          close: () => {},
        }
      }
    }

    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/inspect-public?")) {
        return Response.json({
          root_exists: true,
          expiry_horizon_sufficient: true,
          observation_provider: "web3dns_json_doh",
        })
      }
      if (url.includes("/observe-root-parent?")) {
        return Response.json({
          root_label: "restartroot",
          zone_name: "restartroot.",
          provider: "hsd_json_rpc",
          observed_at: "2026-08-08T00:00:00.000Z",
          chain_anchor: {
            network: "main",
            height: 1_234,
            block_hash: "cd".repeat(32),
            median_time: 1_700_000_000,
          },
          parent: {
            raw_records: [],
            nameservers: [],
            ds_records: [],
            glue4: [],
            glue6: [],
          },
        })
      }
      if (url.endsWith("/publish-txt") && init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        return Response.json({
          root_label: "restartroot",
          zone_name: "restartroot.",
          challenge_name: "_pirate.restartroot.",
          challenge_txt_value: body.challenge_txt_value,
          zone_created: false,
          nameservers: ["ns1.pirate.", "ns2.pirate."],
          ds_records: [
            `56075 13 2 ${"05".repeat(32)}`,
            `56075 13 4 ${"15".repeat(48)}`,
          ],
          observation_provider: "powerdns_api",
        })
      }
      throw new Error(`unexpected verifier call ${url}`)
    })

    await expect(restartNamespaceVerificationChallenge({
      client: new AtomicFailureClient(),
      env: { HNS_VERIFIER_BASE_URL: "https://verifier.test" },
      row: restartRow("expired"),
      namespaceVerificationSessionId: "nvs_restart",
      now: new Date("2026-08-08T00:00:00.000Z"),
      updatedAt: "2026-08-08T00:00:00.000Z",
    })).rejects.toThrow("injected lock finalization failure")

    expect(state.committedChallenge).toBe("pirate-verification=nch_old")
    expect(state.commits).toBe(0)
    expect(state.rollbacks).toBe(1)
    expect(state.attemptToken).toMatch(/^hra_/u)
  })

  test("fences an expired concurrent attempt while keeping the published nonce consistent", async () => {
    let releaseInspection!: () => void
    let inspectionStarted!: () => void
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve })
    const inspectionSignal = new Promise<void>((resolve) => { inspectionStarted = resolve })
    const shared = {
      attemptToken: null as string | null,
      attemptChallenge: null as string | null,
      attemptExpired: false,
      lockSessionId: "nvs_restart",
      persisted: null as null | {
        anchorBlockHash: string
        anchorHeight: number
        challengeTxtValue: string
        payload: Record<string, any>
      },
    }

    class ConcurrentRestartClient implements Client {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        if (typeof statement === "string") throw new Error("expected structured SQL")
        if (statement.sql.includes("INSERT INTO hns_import_session_locks")) {
          return { rows: [{ namespace_verification_session_id: shared.lockSessionId }], rowsAffected: 1 }
        }
        if (statement.sql.includes("SET restart_attempt_token = ?3")) {
          if (shared.attemptToken !== null && !shared.attemptExpired) return { rows: [], rowsAffected: 0 }
          shared.attemptToken = String(statement.args?.[2])
          shared.attemptChallenge ??= String(statement.args?.[3])
          shared.attemptExpired = false
          return {
            rows: [{
              restart_attempt_token: shared.attemptToken,
              restart_challenge_txt_value: shared.attemptChallenge,
            }],
            rowsAffected: 1,
          }
        }
        if (statement.sql.includes("UPDATE namespace_verification_sessions")) {
          if (statement.args?.[22] !== shared.attemptToken) return { rows: [], rowsAffected: 0 }
          shared.persisted = {
            payload: JSON.parse(String(statement.args?.[1])),
            challengeTxtValue: String(statement.args?.[3]),
            anchorHeight: Number(statement.args?.[17]),
            anchorBlockHash: String(statement.args?.[18]),
          }
          return { rows: [], rowsAffected: 1 }
        }
        if (statement.sql.includes("restart_attempt_token = NULL")) {
          if (statement.args?.[2] === shared.attemptToken) shared.attemptToken = null
          return { rows: [], rowsAffected: 1 }
        }
        throw new Error(`unexpected SQL: ${statement.sql}`)
      }

      async batch(): Promise<QueryResult[]> {
        throw new Error("batch not implemented")
      }

      async transaction(): Promise<Transaction> {
        let pendingPersisted = shared.persisted
        let shouldFinalize = false
        return {
          execute: async (statement) => {
            if (typeof statement === "string") throw new Error("expected structured SQL")
            if (statement.sql.includes("UPDATE namespace_verification_sessions")) {
              if (statement.args?.[22] !== shared.attemptToken) return { rows: [], rowsAffected: 0 }
              pendingPersisted = {
                payload: JSON.parse(String(statement.args?.[1])),
                challengeTxtValue: String(statement.args?.[3]),
                anchorHeight: Number(statement.args?.[17]),
                anchorBlockHash: String(statement.args?.[18]),
              }
              return { rows: [], rowsAffected: 1 }
            }
            if (statement.sql.includes("restart_attempt_token = NULL")) {
              const owned = statement.args?.[2] === shared.attemptToken
              shouldFinalize = owned
              return { rows: [], rowsAffected: owned ? 1 : 0 }
            }
            throw new Error(`unexpected transaction SQL: ${statement.sql}`)
          },
          batch: async () => { throw new Error("batch not implemented") },
          commit: async () => {
            shared.persisted = pendingPersisted
            if (shouldFinalize) shared.attemptToken = null
          },
          rollback: async () => {},
          close: () => {},
        }
      }
    }

    const publishedChallenges: string[] = []
    let inspectionCount = 0
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.includes("/inspect-public?")) {
        inspectionCount += 1
        if (inspectionCount === 1) {
          inspectionStarted()
          await inspectionGate
        }
        return Response.json({
          root_exists: true,
          expiry_horizon_sufficient: true,
          observation_provider: "web3dns_json_doh",
        })
      }
      if (url.includes("/observe-root-parent?")) {
        return Response.json({
          root_label: "restartroot",
          zone_name: "restartroot.",
          provider: "hsd_json_rpc",
          observed_at: "2026-08-08T00:00:00.000Z",
          chain_anchor: {
            network: "main",
            height: 1_234,
            block_hash: "cd".repeat(32),
            median_time: 1_700_000_000,
          },
          parent: {
            raw_records: [{ type: "TXT", txt: ["existing=", "record"] }],
            nameservers: [],
            ds_records: [],
            glue4: [],
            glue6: [],
          },
        })
      }
      if (url.endsWith("/publish-txt") && init?.method === "POST") {
        const body = JSON.parse(String(init.body))
        publishedChallenges.push(body.challenge_txt_value)
        return Response.json({
          root_label: "restartroot",
          zone_name: "restartroot.",
          challenge_name: "_pirate.restartroot.",
          challenge_txt_value: body.challenge_txt_value,
          zone_created: false,
          nameservers: ["ns1.pirate.", "ns2.pirate."],
          ds_records: [
            `56075 13 2 ${"05".repeat(32)}`,
            `56075 13 4 ${"15".repeat(48)}`,
          ],
          observation_provider: "powerdns_api",
        })
      }
      throw new Error(`unexpected verifier call ${url}`)
    })

    const first = restartNamespaceVerificationChallenge({
      client: new ConcurrentRestartClient(),
      env: { HNS_VERIFIER_BASE_URL: "https://verifier.test" },
      row: restartRow("expired"),
      namespaceVerificationSessionId: "nvs_restart",
      now: new Date("2026-08-08T00:00:00.000Z"),
      updatedAt: "2026-08-08T00:00:00.000Z",
    })
    await inspectionSignal
    shared.attemptExpired = true

    await restartNamespaceVerificationChallenge({
      client: new ConcurrentRestartClient(),
      env: { HNS_VERIFIER_BASE_URL: "https://verifier.test" },
      row: restartRow("expired"),
      namespaceVerificationSessionId: "nvs_restart",
      now: new Date("2026-08-08T00:00:01.000Z"),
      updatedAt: "2026-08-08T00:00:01.000Z",
    })

    releaseInspection()
    await expect(first).rejects.toMatchObject({ status: 409, code: "conflict" })

    expect(publishedChallenges).toHaveLength(2)
    expect(new Set(publishedChallenges).size).toBe(1)
    expect(shared.persisted?.challengeTxtValue).toBe(publishedChallenges[1])
    expect(shared.persisted?.payload).toMatchObject({
      observed_chain_anchor: {
        height: 1_234,
        block_hash: "cd".repeat(32),
      },
      publish_plan: {
        replacement_records: expect.arrayContaining([
          { type: "TXT", txt: [publishedChallenges[1]] },
        ]),
      },
    })
    expect(shared.persisted?.anchorHeight).toBe(1_234)
    expect(shared.persisted?.anchorBlockHash).toBe("cd".repeat(32))
    expect(shared.lockSessionId).toBe("nvs_restart")
    expect(shared.attemptToken).toBeNull()
  })
})
