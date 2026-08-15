import { beforeEach, describe, expect, mock, test } from "bun:test"
import { publishGenericAssetClaim } from "./generic-asset-publication"

type CallState = {
  assetReads: number
  claimCalls: number
  releaseClaimCalls: number
  releaseReservationCalls: number
  reserveCalls: number
  sql: string[]
  existingAsset: boolean
  failClaim: boolean
}

const state: CallState = {
  assetReads: 0,
  claimCalls: 0,
  releaseClaimCalls: 0,
  releaseReservationCalls: 0,
  reserveCalls: 0,
  sql: [],
  existingAsset: false,
  failClaim: false,
}

const contentBlob = {
  content_blob_id: "cbl_1",
  status: "ready",
  security_scan_state: "clean",
  verified_content_hash: "0xverified",
  verified_size_bytes: 128,
}

const asset = {
  asset_id: "asset_1",
  community_id: "com_1",
  source_post_id: "post_1",
  creator_user_id: "usr_1",
  asset_kind: "download_file",
  access_mode: "locked",
}

const payload = {
  asset_id: "asset_1",
  content_blob_ref: "cbl_1",
  content_hash: "0xverified",
  size_bytes: 128,
}

const reservation = {
  reservation_id: "gar_1",
  status: "reserved",
}

const tx = {
  execute: mock(async (statement: { sql: string }) => {
    state.sql.push(statement.sql)
    return { rows: [], rowsAffected: 1 }
  }),
}

const dependencies = {
  reserveGenericAssetBytes: mock(async () => {
    state.reserveCalls += 1
    return reservation
  }),
  releaseGenericAssetBytes: mock(async () => {
    state.releaseReservationCalls += 1
    return { ...reservation, status: "released" }
  }),
  reconcileGenericAssetBytes: mock(async () => ({ ...reservation, status: "reconciled" })),
  requireOwnedContentBlob: mock(async () => ({ blob: contentBlob })),
  claimOwnedReadyContentBlob: mock(async () => {
    state.claimCalls += 1
    if (state.failClaim) throw new Error("claim failed")
    return { blob: contentBlob }
  }),
  releaseOwnedContentBlobClaim: mock(async () => {
    state.releaseClaimCalls += 1
  }),
  getAssetRow: mock(async (client: unknown) => {
    state.assetReads += 1
    return client === tx && !state.existingAsset ? null : asset
  }),
  getActivePrimaryAssetPayload: mock(async () => state.existingAsset ? payload : null),
  getAssetEnforcement: mock(async () => state.existingAsset ? { enforcement_state: "active" } : null),
  withTransaction: mock(async (_client: unknown, _mode: unknown, callback: (executor: typeof tx) => Promise<void>) => callback(tx)),
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    env: {
      GENERIC_DIGITAL_GOODS_ENABLED: "true",
      GENERIC_DIGITAL_GOODS_ENABLEMENT_READY: "true",
      CONTENT_SOURCE_BROKER: {},
      CONTENT_SOURCE_BROKER_SHARED_SECRET: "fixture-broker-secret",
    },
    shardClient: {},
    controlPlaneClient: {},
    communityId: "com_1",
    sourcePostId: "post_1",
    assetId: "asset_1",
    creatorUserId: "usr_1",
    contentBlobId: "cbl_1",
    assetKind: "download_file" as const,
    accessMode: "locked" as const,
    rightsBasis: "original" as const,
    displayTitle: "Records",
    displayFilename: "records.csv",
    mimeType: "text/csv",
    contentHash: "0xverified",
    verifiedSizeBytes: 128,
    reservationId: "gar_1",
    reservationKey: "post:post_1:generic_asset",
    reservedBytes: 256,
    quotaPolicyVersion: "generic_assets_v1",
    createdAt: "2026-08-15T00:00:00.000Z",
    dependencies,
    ...overrides,
  } as never
}

beforeEach(() => {
  state.assetReads = 0
  state.claimCalls = 0
  state.releaseClaimCalls = 0
  state.releaseReservationCalls = 0
  state.reserveCalls = 0
  state.sql = []
  state.existingAsset = false
  state.failClaim = false
})

describe("publishGenericAssetClaim", () => {
  test("materializes a file claim and its active enforcement row", async () => {
    const result = await publishGenericAssetClaim(input())

    expect(result).toMatchObject({ assetId: "asset_1", contentBlob: contentBlob, quotaReservation: reservation })
    expect(state.reserveCalls).toBe(1)
    expect(state.claimCalls).toBe(1)
    expect(state.releaseClaimCalls).toBe(0)
    expect(state.sql.filter((sql) => sql.includes("INSERT INTO assets"))).toHaveLength(1)
    expect(state.sql.filter((sql) => sql.includes("INSERT INTO asset_payloads"))).toHaveLength(1)
    expect(state.sql.filter((sql) => sql.includes("INSERT INTO asset_enforcement"))).toHaveLength(1)
  })

  test("replays an existing file claim without inserting a second asset", async () => {
    state.existingAsset = true

    const result = await publishGenericAssetClaim(input({ reservationId: "gar_retry" }))

    expect(result.assetId).toBe("asset_1")
    expect(state.reserveCalls).toBe(1)
    expect(state.claimCalls).toBe(1)
    expect(state.sql.some((sql) => sql.includes("INSERT INTO assets"))).toBe(false)
    expect(state.sql.some((sql) => sql.includes("INSERT INTO asset_payloads"))).toBe(false)
  })

  test("releases both claims when shard materialization fails", async () => {
    state.failClaim = true

    await expect(publishGenericAssetClaim(input())).rejects.toThrow("claim failed")

    expect(state.releaseClaimCalls).toBe(1)
    expect(state.releaseReservationCalls).toBe(1)
  })

  test("resumes a failed publication saga without losing the deterministic asset id", async () => {
    state.failClaim = true
    await expect(publishGenericAssetClaim(input())).rejects.toThrow("claim failed")

    state.failClaim = false
    const resumed = await publishGenericAssetClaim(input({ reservationId: "gar_retry" }))

    expect(resumed.assetId).toBe("asset_1")
    expect(state.reserveCalls).toBe(2)
    expect(state.claimCalls).toBe(2)
    expect(state.releaseClaimCalls).toBe(1)
    expect(state.releaseReservationCalls).toBe(1)
    expect(state.sql.filter((sql) => sql.includes("INSERT INTO assets"))).toHaveLength(1)
  })

  test("keeps the writer disabled even when the caller supplies a valid file", async () => {
    await expect(publishGenericAssetClaim(input({
      env: { GENERIC_DIGITAL_GOODS_ENABLED: "false" },
    }))).rejects.toMatchObject({ status: 404 })

    expect(state.reserveCalls).toBe(0)
    expect(state.claimCalls).toBe(0)
  })
})
