import { describe, expect, test } from "bun:test"
import type { InStatement, QueryResult } from "../../sql-client"
import {
  getActiveEntitlementForBuyer,
  getActiveEntitlementForBuyerIdentity,
} from "./queries"

type TestEntitlementRow = {
  purchase_entitlement_id: string
  purchase_id: string
  community_id: string
  buyer_kind: "user" | "wallet"
  buyer_user_id: string | null
  buyer_wallet_address: string | null
  buyer_wallet_address_normalized: string | null
  buyer_chain_ref: string | null
  entitlement_kind: "asset_access" | "live_room_access" | "replay_access" | "license"
  target_ref: string
  status: "active"
  granted_at: string
  revoked_at: string | null
  created_at: string
  updated_at: string
}

const entitlementRow: TestEntitlementRow = {
  purchase_entitlement_id: "pent_1",
  purchase_id: "pur_1",
  community_id: "cmt_1",
  buyer_kind: "user",
  buyer_user_id: "usr_1",
  buyer_wallet_address: null,
  buyer_wallet_address_normalized: null,
  buyer_chain_ref: null,
  entitlement_kind: "replay_access",
  target_ref: "lra_1",
  status: "active",
  granted_at: "2026-06-30T00:00:00.000Z",
  revoked_at: null,
  created_at: "2026-06-30T00:00:00.000Z",
  updated_at: "2026-06-30T00:00:00.000Z",
}

function entitlementExecutor(row: TestEntitlementRow) {
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const args = typeof statement === "string" ? [] : statement.args ?? []
      const expectedKind = args.length >= 5 ? args[4] : args[3]
      return {
        rows: expectedKind === row.entitlement_kind ? [row] : [],
      }
    },
  }
}

describe("commerce entitlement queries", () => {
  test("filters user entitlements by entitlement kind when provided", async () => {
    const client = entitlementExecutor(entitlementRow)

    await expect(
      getActiveEntitlementForBuyer(client, "cmt_1", "usr_1", "lra_1", "live_room_access"),
    ).resolves.toBeNull()

    await expect(
      getActiveEntitlementForBuyer(client, "cmt_1", "usr_1", "lra_1", "replay_access"),
    ).resolves.toMatchObject({
      purchase_entitlement_id: "pent_1",
      entitlement_kind: "replay_access",
      target_ref: "lra_1",
    })
  })

  test("filters wallet entitlements by entitlement kind when provided", async () => {
    const client = entitlementExecutor({
      ...entitlementRow,
      buyer_kind: "wallet",
      buyer_user_id: null,
      buyer_wallet_address: "0x7200000000000000000000000000000000000007",
      buyer_wallet_address_normalized: "0x7200000000000000000000000000000000000007",
      buyer_chain_ref: "eip155:84532",
    })

    await expect(
      getActiveEntitlementForBuyerIdentity(
        client,
        "cmt_1",
        {
          kind: "wallet",
          chainRef: "eip155:84532",
          walletAddress: "0x7200000000000000000000000000000000000007",
          walletAddressNormalized: "0x7200000000000000000000000000000000000007",
        },
        "lra_1",
        "live_room_access",
      ),
    ).resolves.toBeNull()

    await expect(
      getActiveEntitlementForBuyerIdentity(
        client,
        "cmt_1",
        {
          kind: "wallet",
          chainRef: "eip155:84532",
          walletAddress: "0x7200000000000000000000000000000000000007",
          walletAddressNormalized: "0x7200000000000000000000000000000000000007",
        },
        "lra_1",
        "replay_access",
      ),
    ).resolves.toMatchObject({
      purchase_entitlement_id: "pent_1",
      entitlement_kind: "replay_access",
      target_ref: "lra_1",
    })
  })
})
