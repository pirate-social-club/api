import { describe, expect, test } from "bun:test"
import type { Client, InStatement, Transaction } from "../sql-client"
import {
  returnCommittedVerificationAfterRace,
  VerificationAttestationConflictError,
  VerificationSessionClaimLostError,
  writeVerificationBatchWithNullifierRetry,
} from "./verification-session-write"

const identityNullifier = {
  provider: "self" as const,
  mechanism: "zk-nullifier" as const,
  nullifierHash: "a".repeat(64),
}

const committedSession = { id: "vs_vs_race", status: "verified" }

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
          batch: async () => {
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
      execute: async () => ({ rows: [] }),
    } as unknown as Client

    const finalizeLikeProduction = async () => {
      try {
        await writeVerificationBatchWithNullifierRetry({
          client,
          userId: "usr_race",
          identityNullifier,
          activeNullifier: null,
          buildBatchStatements: (): InStatement[] => [{ sql: "UPDATE verification_sessions" }],
          sessionClaimStatementIndex: 0,
        })
        return committedSession
      } catch (error) {
        if (error instanceof VerificationSessionClaimLostError || error instanceof VerificationAttestationConflictError) {
          return returnCommittedVerificationAfterRace({
            getSession: async () => committedSession,
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

    expect(first.status).toBe("verified")
    expect(second.status).toBe("verified")
    expect(first.id).toBe("vs_vs_race")
    expect(second.id).toBe(first.id)
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
      execute: async () => ({ rows: [] }),
    } as unknown as Client

    const finalizeLikeProduction = async () => {
      try {
        await writeVerificationBatchWithNullifierRetry({
          client,
          userId: "usr_race",
          identityNullifier,
          activeNullifier: null,
          buildBatchStatements: (): InStatement[] => [{ sql: "INSERT INTO user_attestations" }],
          sessionClaimStatementIndex: 0,
        })
        return committedSession
      } catch (error) {
        if (error instanceof VerificationSessionClaimLostError || error instanceof VerificationAttestationConflictError) {
          return returnCommittedVerificationAfterRace({
            getSession: async () => committedSession,
            error,
          })
        }
        throw error
      }
    }

    const winner = await finalizeLikeProduction()
    const loser = await finalizeLikeProduction()
    expect(batchCalls).toBe(2)
    expect(winner.status).toBe("verified")
    expect(loser.status).toBe("verified")
    expect(loser.id).toBe(winner.id)
  })
})
