import { describe, expect, test } from "bun:test"
import { assertGenericEmergencyControlsClear } from "./generic-asset-emergency-controls"

describe("generic asset emergency controls", () => {
  test("matches the ordinary not-found path when an active scoped control exists", async () => {
    const client = {
      execute: async () => ({ rows: [{ control_id: "ctl_1" }] }),
    }
    await expect(assertGenericEmergencyControlsClear({
      client,
      context: {
        assetId: "ast_1",
        contentHash: "0xabc",
        uploaderUserId: "usr_1",
        communityId: "com_1",
        validationProfile: "download_file_v1",
      },
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })
  })

  test("allows a clear context and emits all matching scopes", async () => {
    const captured: { statement: { sql: string; args?: unknown[] } | null } = { statement: null }
    const client = {
      execute: async (input: { sql: string; args?: unknown[] }) => {
        captured.statement = input
        return { rows: [] }
      },
    }
    await assertGenericEmergencyControlsClear({
      client,
      context: { assetId: "ast_1", communityId: "com_1" },
      notFoundMessage: "Asset not found",
    })
    expect(captured.statement?.sql).toContain("generic_asset_emergency_controls")
    expect(captured.statement?.args).toEqual(["all", null, "asset", "ast_1", "community", "com_1"])
  })
})
