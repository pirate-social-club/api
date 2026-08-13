import { describe, expect, mock, test } from "bun:test"
import type { Client, InStatement, Transaction } from "../sql-client"

// Keep this concurrency test runnable in the focused fresh worktree. The
// finalizer module imports provider SDKs at module load time, but this test
// exercises the shared finalization/CAS boundary without contacting them.
mock.module("@pirate/api-shared", () => ({
  makeId: (prefix: string) => `${prefix}_test`,
  nowIso: () => "2026-01-01T00:00:00.000Z",
}))
mock.module("@zkpassport/sdk", () => ({ ZKPassport: class {} }))
mock.module("@libsql/client", () => ({
  createClient: () => ({}),
}))
mock.module("pg", () => ({ Client: class {} }))
mock.module("jose", () => ({
  createRemoteJWKSet: () => {},
  jwtVerify: async () => ({ payload: {} }),
}))
mock.module("../errors", () => ({
  badRequestError: (message: string) => new Error(message),
  conflictError: (message: string) => new Error(message),
  eligibilityFailed: (message: string) => new Error(message),
  HttpError: class HttpError extends Error {},
  internalError: (message: string) => new Error(message),
  providerUnavailable: (message: string) => new Error(message),
}))
mock.module("../helpers", () => ({
  isProductionEnv: () => false,
  makeId: (prefix: string) => `${prefix}_test`,
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
mock.module("./verification-shared", () => ({
  getAttestationsBySourceSessionId: async () => [attestationRow],
  getVerificationSessionRow: async () => null,
  getVerificationSessionRowForUser: async () => sessionRow,
}))

const {
  VerificationAttestationConflictError,
  VerificationSessionClaimLostError,
  getVerificationSession,
  returnCommittedVerificationAfterRace,
  writeVerificationBatchWithNullifierRetry,
} = await import("./verification-session-service")

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
        await writeVerificationBatchWithNullifierRetry({
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
        return await getVerificationSession(client, "vs_race", "usr_race")
      } catch (error) {
        if (error instanceof VerificationSessionClaimLostError || error instanceof VerificationAttestationConflictError) {
          return returnCommittedVerificationAfterRace({
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
        await writeVerificationBatchWithNullifierRetry({
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
        return await getVerificationSession(client, "vs_race", "usr_race")
      } catch (error) {
        if (error instanceof VerificationSessionClaimLostError || error instanceof VerificationAttestationConflictError) {
          return returnCommittedVerificationAfterRace({
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
