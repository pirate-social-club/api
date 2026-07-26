import { describe, expect, test } from "bun:test"

import type { Client } from "../sql-client"
import { getRewardBackendFlipReadiness } from "./reward-backend-flip-readiness"

function clientWithRow(row: Record<string, unknown>): Client {
  return { execute: async () => ({ rows: [row] }) } as unknown as Client
}

describe("reward backend flip readiness", () => {
  test("requires every settlement mirror to be drained", async () => {
    expect(await getRewardBackendFlipReadiness(clientWithRow({
      non_terminal_cashouts: "0",
      non_terminal_refunds: "0",
      reconciliation_required: "0",
    }))).toEqual({
      ready: true,
      non_terminal_cashouts: 0,
      non_terminal_refunds: 0,
      reconciliation_required: 0,
    })

    expect(await getRewardBackendFlipReadiness(clientWithRow({
      non_terminal_cashouts: "2",
      non_terminal_refunds: "1",
      reconciliation_required: "1",
    }))).toMatchObject({
      ready: false,
      non_terminal_cashouts: 2,
      non_terminal_refunds: 1,
      reconciliation_required: 1,
    })
  })
})
