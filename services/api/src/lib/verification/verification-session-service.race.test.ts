import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test"
import type { Client, InStatement, Transaction } from "../sql-client"

type VerificationSessionService = typeof import("./verification-session-service")
let service: VerificationSessionService

beforeAll(async () => {
  // Register these only after the suite has loaded its other modules. Bun's
  // mock.module is process-global, so top-level registration can contaminate
  // unrelated tests that happen to import the same dependencies.
  mock.module("@pirate/api-shared", () => ({
    makeId: (prefix: string) => `${prefix}_test`,
    nowIso: () => "2026-01-01T00:00:00.000Z",
  }))
  mock.module("../crypto", () => ({ sha256Hex: async () => "hash_test" }))
  mock.module("../auth/auth-db-user-queries", () => ({ getUserRow: async () => null }))
  mock.module("../auth/auth-serializers", () => ({
    parseVerificationCapabilities: () => ({}),
    serializeVerificationSession: ({ row, attestationRows }: { row: typeof sessionRow; attestationRows: Array<{ user_attestation_id: string }> }) => ({
      id: `vs_${row.verification_session_id}`,
      status: row.status,
      attestation: attestationRows[0]?.user_attestation_id ?? null,
    }),
  }))
  mock.module("./very-provider", () => ({
    assertVeryNativeOAuthConfigured: () => {},
    buildVerySessionBinding: () => ({}),
    getVeryProvider: () => ({}),
    VERY_UNIQUE_HUMAN_DOMAIN: "test-domain",
  }))
  mock.module("./self-provider", () => ({
    canonicalizeRequestedCapabilities: (capabilities: unknown) => capabilities,
    getSelfProvider: () => ({}),
    normalizeVerificationRequirements: (requirements: unknown) => requirements,
  }))
  mock.module("./zkpassport-provider", () => ({ getZkPassportProvider: () => ({}) }))
  mock.module("./verification-logging", () => ({ logVerificationDebug: () => {} }))
  mock.module("../telegram/onboarding-service", () => ({ approvePendingTelegramJoinGrantsForUser: async () => {} }))
  mock.module("./verification-capabilities", () => ({ interactiveVerificationExpiresAt: () => "2026-01-02T00:00:00.000Z" }))
  service = await import("./verification-session-service")
})

afterAll(() => mock.restore())

const sessionRow = {
  verification_session_id: "vs_race",
  user_id: "usr_race",
  provider: "self",
  provider_mode: "qr_deeplink",
  requested_capabilities_json: JSON.stringify(["unique_human"]),
  verification_requirements_json: null,
  status: "verified",
  upstream_session_ref: null,
  result_ref: "proof_race",
  failure_code: null,
  wallet_attachment_id: null,
  verification_intent: "community_join",
  policy_id: null,
  completed_at: "2026-01-01T00:00:02.000Z",
  expires_at: "2026-01-02T00:00:00.000Z",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:02.000Z",
}

const attestationRow = {
  user_attestation_id: "att_race",
  capability_key: "unique_human",
  status: "accepted",
  verified_at: "2026-01-01T00:00:02.000Z",
  expires_at: "2026-01-02T00:00:00.000Z",
}

describe("verification finalization race recovery", () => {
  test("returns the committed winner session to the losing finalizer", async () => {
    let claimTaken = false
    let releaseWinnerCommit: (() => void) | null = null
    const winnerCommitted = new Promise<void>((resolve) => {
      releaseWinnerCommit = resolve
    })

    const client = {
      transaction: async () => {
        const transaction: Transaction = {
          execute: async () => ({ rows: [] }),
          batch: async (_statements: InStatement[]) => {
            if (!claimTaken) {
              claimTaken = true
              return [{ rows: [], rowsAffected: 1 }]
            }
            await winnerCommitted
            return [{ rows: [], rowsAffected: 0 }]
          },
          commit: async () => {
            releaseWinnerCommit?.()
          },
          rollback: async () => {},
          close: () => {},
        }
        return transaction
      },
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM verification_sessions")) return { rows: [sessionRow] }
        if (sql.includes("FROM user_attestations")) return { rows: [attestationRow] }
        return { rows: [] }
      },
    } as unknown as Client

    const finalizeLikeProduction = async () => {
      try {
        await service.writeVerificationBatchWithNullifierRetry({
          client,
          userId: "usr_race",
          identityNullifier: {
            provider: "self",
            mechanism: "zk-nullifier",
            nullifierHash: "a".repeat(64),
          },
          activeNullifier: null,
          buildBatchStatements: (): InStatement[] => [{ sql: "UPDATE verification_sessions" }],
          sessionClaimStatementIndex: 0,
        })
        return await service.getVerificationSession(client, "vs_race", "usr_race")
      } catch (error) {
        if (error instanceof service.VerificationSessionClaimLostError || error instanceof service.VerificationAttestationConflictError) {
          return service.returnCommittedVerificationAfterRace({
            client,
            verificationSessionId: "vs_race",
            userId: "usr_race",
            error,
          })
        }
        throw error
      }
    }

    const [first, second] = await Promise.all([
      finalizeLikeProduction(),
      finalizeLikeProduction(),
    ])

    expect(first?.status).toBe("verified")
    expect(second?.status).toBe("verified")
    expect(first?.id).toBe("vs_vs_race")
    expect(second?.id).toBe(first?.id)
  })

  test("turns an attestation session-index 23505 into the committed winner session", async () => {
    let batchCalls = 0
    const client = {
      transaction: async () => ({
        batch: async () => {
          batchCalls += 1
          if (batchCalls === 1) return [{ rows: [], rowsAffected: 1 }]
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "idx_user_attestations_accepted_session",
          })
        },
        commit: async () => {},
        rollback: async () => {},
        close: () => {},
      } as unknown as Transaction),
      execute: async (statement: InStatement | string) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM verification_sessions")) return { rows: [sessionRow] }
        if (sql.includes("FROM user_attestations")) return { rows: [attestationRow] }
        return { rows: [] }
      },
    } as unknown as Client

    const finalizeLikeProduction = async () => {
      try {
        await service.writeVerificationBatchWithNullifierRetry({
          client,
          userId: "usr_race",
          identityNullifier: {
            provider: "self",
            mechanism: "zk-nullifier",
            nullifierHash: "a".repeat(64),
          },
          activeNullifier: null,
          buildBatchStatements: (): InStatement[] => [{ sql: "INSERT INTO user_attestations" }],
          sessionClaimStatementIndex: 0,
        })
        return await service.getVerificationSession(client, "vs_race", "usr_race")
      } catch (error) {
        if (error instanceof service.VerificationSessionClaimLostError || error instanceof service.VerificationAttestationConflictError) {
          return service.returnCommittedVerificationAfterRace({
            client,
            verificationSessionId: "vs_race",
            userId: "usr_race",
            error,
          })
        }
        throw error
      }
    }

    const winner = await finalizeLikeProduction()
    const loser = await finalizeLikeProduction()
    expect(batchCalls).toBe(2)
    expect(winner?.status).toBe("verified")
    expect(loser?.status).toBe("verified")
    expect(loser?.id).toBe(winner?.id)
  })
})
