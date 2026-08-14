import { describe, expect, test } from "bun:test"
import {
  reconcileGenericAssetBytes,
  releaseGenericAssetBytes,
  reserveGenericAssetBytes,
} from "./generic-asset-quota-reservation"
import type { DbExecutor } from "../../db-helpers"

function fakeLedger() {
  const rows = new Map<string, Record<string, unknown>>()
  const client = {
    execute: async (statement: { sql: string; args?: unknown[] }) => {
      if (/^\s*SELECT/i.test(statement.sql)) {
        const id = statement.args?.[0] as string
        const key = statement.args?.[1] as string | undefined
        const row = key
          ? [...rows.values()].find((candidate) => candidate.user_id === id && candidate.reservation_key === key)
          : rows.get(id)
        return { rows: row ? [row] : [], rowsAffected: 0 }
      }
      if (/^\s*INSERT/i.test(statement.sql)) {
        const max = statement.args?.[12] as number | null
        const reserved = statement.args?.[6] as number
        const current = [...rows.values()]
          .filter((row) => row.user_id === statement.args?.[2] && row.community_id === statement.args?.[1])
          .reduce((sum, row) => sum + Number(row.status === "reserved" ? row.reserved_bytes : row.actual_bytes ?? 0), 0)
        if (max != null && current + reserved > max) return { rows: [], rowsAffected: 0 }
        const row = {
          reservation_id: statement.args?.[0],
          community_id: statement.args?.[1],
          user_id: statement.args?.[2],
          asset_id: statement.args?.[3] ?? null,
          content_blob_id: statement.args?.[4] ?? null,
          reservation_key: statement.args?.[5],
          status: "reserved",
          reserved_bytes: reserved,
          actual_bytes: null,
          plaintext_bytes: statement.args?.[7] ?? 0,
          ciphertext_bytes: statement.args?.[8] ?? 0,
          package_bytes: statement.args?.[9] ?? 0,
          policy_version: statement.args?.[10],
          failure_code: null,
          created_at: statement.args?.[11],
          updated_at: statement.args?.[11],
          reconciled_at: null,
        }
        rows.set(String(row.reservation_id), row)
        return { rows: [], rowsAffected: 1 }
      }
      if (/^\s*UPDATE/i.test(statement.sql)) {
        const isRelease = statement.sql.includes("status = 'released'")
        const row = rows.get(String(statement.args?.[isRelease ? 2 : 5]))
        if (!row || row.status !== "reserved") return { rows: [], rowsAffected: 0 }
        if (isRelease) {
          row.status = "released"
          row.failure_code = statement.args?.[0]
          row.updated_at = statement.args?.[1]
          return { rows: [], rowsAffected: 1 }
        }
        row.status = "reconciled"
        row.actual_bytes = statement.args?.[0]
        row.plaintext_bytes = statement.args?.[1]
        row.ciphertext_bytes = statement.args?.[2]
        row.package_bytes = statement.args?.[3]
        row.reconciled_at = statement.args?.[4]
        row.updated_at = statement.args?.[4]
        return { rows: [], rowsAffected: 1 }
      }
      throw new Error(`unexpected SQL: ${statement.sql}`)
    },
  } as unknown as DbExecutor
  return { client, rows }
}

describe("generic asset quota reservations", () => {
  test("reserves physical bytes and replays the same key", async () => {
    const ledger = fakeLedger()
    const input = {
      client: ledger.client,
      reservationId: "gar_1",
      communityId: "com_1",
      userId: "usr_1",
      contentBlobId: "cbl_1",
      reservationKey: "post_1",
      reservedBytes: 100,
      policyVersion: "generic_v1",
      createdAt: "2026-08-14T00:00:00.000Z",
      maxAccountedBytes: 1000,
    }
    await reserveGenericAssetBytes(input)
    const replay = await reserveGenericAssetBytes({ ...input, reservationId: "gar_retry" })
    expect(replay.reservation_id).toBe("gar_1")
    expect(replay.status).toBe("reserved")
  })

  test("reconciles reserved bytes to provider-reported physical bytes", async () => {
    const ledger = fakeLedger()
    await reserveGenericAssetBytes({
      client: ledger.client,
      reservationId: "gar_2",
      communityId: "com_1",
      userId: "usr_1",
      reservationKey: "post_2",
      reservedBytes: 100,
      policyVersion: "generic_v1",
      createdAt: "2026-08-14T00:00:00.000Z",
    })
    const reconciled = await reconcileGenericAssetBytes({
      client: ledger.client,
      reservationId: "gar_2",
      actualBytes: 88,
      plaintextBytes: 40,
      ciphertextBytes: 48,
      packageBytes: 0,
      reconciledAt: "2026-08-14T01:00:00.000Z",
    })
    expect(reconciled.status).toBe("reconciled")
    expect(reconciled.actual_bytes).toBe(88)
  })

  test("releases a reservation when shard materialization fails", async () => {
    const ledger = fakeLedger()
    await reserveGenericAssetBytes({
      client: ledger.client,
      reservationId: "gar_3",
      communityId: "com_1",
      userId: "usr_1",
      reservationKey: "post_3",
      reservedBytes: 100,
      policyVersion: "generic_v1",
      createdAt: "2026-08-14T00:00:00.000Z",
    })
    const released = await releaseGenericAssetBytes({
      client: ledger.client,
      reservationId: "gar_3",
      releasedAt: "2026-08-14T01:00:00.000Z",
      failureCode: "asset_materialization_failed",
    })
    expect(released.status).toBe("released")
    expect(released.failure_code).toBe("asset_materialization_failed")
  })
})
