import { describe, expect, mock, test } from "bun:test"
import type { Client, QueryResult, Transaction } from "./sql-client"
import { withTransaction } from "./transactions"

function fakeTransaction() {
  const calls: string[] = []
  const tx: Transaction = {
    execute: async (): Promise<QueryResult> => ({ rows: [] }),
    batch: async (): Promise<QueryResult[]> => [],
    commit: mock(async () => {
      calls.push("commit")
    }),
    rollback: mock(async () => {
      calls.push("rollback")
    }),
    close: mock(() => {
      calls.push("close")
    }),
  }
  return { tx, calls }
}

function fakeClient(tx: Transaction): Pick<Client, "transaction"> {
  return { transaction: async () => tx }
}

describe("withTransaction", () => {
  test("commits and closes on success, returning the callback result", async () => {
    const { tx, calls } = fakeTransaction()
    const result = await withTransaction(fakeClient(tx), "write", async () => "ok")

    expect(result).toBe("ok")
    expect(calls).toEqual(["commit", "close"])
    expect(tx.rollback).not.toHaveBeenCalled()
  })

  test("rolls back, closes, and rethrows on error", async () => {
    const { tx, calls } = fakeTransaction()
    const boom = new Error("boom")

    await expect(
      withTransaction(fakeClient(tx), "write", async () => {
        throw boom
      }),
    ).rejects.toBe(boom)

    expect(calls).toEqual(["rollback", "close"])
    expect(tx.commit).not.toHaveBeenCalled()
  })

  test("still closes when rollback itself throws", async () => {
    const { tx, calls } = fakeTransaction()
    tx.rollback = mock(async () => {
      throw new Error("rollback failed")
    })

    await expect(
      withTransaction(fakeClient(tx), "write", async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(calls).toContain("close")
  })
})
