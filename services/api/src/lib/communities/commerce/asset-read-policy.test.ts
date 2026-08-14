import { describe, expect, test } from "bun:test"
import type { InStatement, QueryResult, QueryResultRow } from "../../sql-client"
import type { AssetRow } from "./row-types"
import {
  assertAssetDeliveryAllowed,
  resolveAssetPayloadDescriptor,
} from "./asset-read-policy"

function asset(assetKind: AssetRow["asset_kind"]): AssetRow {
  return {
    asset_id: "asset_1",
    asset_kind: assetKind,
  } as AssetRow
}

function executor(rowsByTable: {
  payload?: QueryResultRow
  enforcement?: QueryResultRow
  emergency?: QueryResultRow
  postStatus?: string
}) {
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const sql = typeof statement === "string" ? statement : statement.sql
      if (sql.includes("FROM asset_payloads")) {
        return { rows: rowsByTable.payload ? [rowsByTable.payload] : [] }
      }
      if (sql.includes("FROM asset_enforcement")) {
        return { rows: rowsByTable.enforcement ? [rowsByTable.enforcement] : [] }
      }
      if (sql.includes("FROM generic_asset_emergency_controls")) {
        return { rows: rowsByTable.emergency ? [rowsByTable.emergency] : [] }
      }
      if (sql.includes("FROM posts")) {
        return { rows: [{ status: rowsByTable.postStatus ?? "published" }] }
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
  }
}

const activeEnforcement = {
  asset_id: "asset_1",
  enforcement_state: "active",
  reason_code: null,
  authority_kind: "asset_create",
  authority_ref: "asset_1",
  moderation_action_id: null,
  actor_role: "system",
  evidence_ref: null,
  decided_at: "2026-08-13T00:00:00.000Z",
  updated_at: "2026-08-13T00:00:00.000Z",
}

describe("generic asset read policy", () => {
  test("does not query 1158 tables for legacy kinds", async () => {
    const client = executor({})
    await expect(assertAssetDeliveryAllowed({
      client,
      asset: asset("song_audio"),
      notFoundMessage: "Asset not found",
    })).resolves.toBeUndefined()
    await expect(resolveAssetPayloadDescriptor({
      client,
      asset: asset("video_file"),
      notFoundMessage: "Asset not found",
    })).resolves.toBeNull()
  })

  test("fails closed when generic enforcement is missing or non-active", async () => {
    await expect(assertAssetDeliveryAllowed({
      client: executor({}),
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })

    await expect(assertAssetDeliveryAllowed({
      client: executor({ enforcement: { ...activeEnforcement, enforcement_state: "quarantined", reason_code: "malware" } }),
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })
  })

  test("returns only authoritative active payload metadata", async () => {
    const client = executor({
      enforcement: activeEnforcement,
      payload: {
        asset_payload_id: "apld_1",
        asset_id: "asset_1",
        role: "primary",
        payload_version: 1,
        status: "active",
        content_blob_ref: "cbl_1",
        payload_format: "opaque_file_v1",
        delivery_behavior: "download",
        display_filename: "data.csv",
        mime_type: "text/csv",
        size_bytes: 12,
        content_hash: "sha256:payload",
        created_at: "2026-08-13T00:00:00.000Z",
        updated_at: "2026-08-13T00:00:00.000Z",
      },
    })
    await expect(assertAssetDeliveryAllowed({
      client,
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
    })).resolves.toBeUndefined()
    await expect(resolveAssetPayloadDescriptor({
      client,
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
    })).resolves.toEqual({
      delivery_behavior: "download",
      display_filename: "data.csv",
      mime_type: "text/csv",
      size_bytes: 12,
      content_hash: "sha256:payload",
      payload_format: "opaque_file_v1",
    })
  })

  test("masks a missing payload with the caller's ordinary not-found response", async () => {
    await expect(resolveAssetPayloadDescriptor({
      client: executor({}),
      asset: asset("download_file"),
      notFoundMessage: "Asset content not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset content not found" })
  })

  test("does not expose assets while the source post is still processing", async () => {
    await expect(assertAssetDeliveryAllowed({
      client: executor({
        enforcement: activeEnforcement,
        payload: {
          asset_payload_id: "apld_1",
          asset_id: "asset_1",
          role: "primary",
          payload_version: 1,
          status: "active",
          content_blob_ref: "cbl_1",
          payload_format: "opaque_file_v1",
          delivery_behavior: "download",
          display_filename: "data.csv",
          mime_type: "text/csv",
          size_bytes: 12,
          content_hash: "sha256:payload",
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        },
        postStatus: "processing",
      }),
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })

    await expect(assertAssetDeliveryAllowed({
      client: executor({
        enforcement: activeEnforcement,
        payload: {
          asset_payload_id: "apld_1",
          asset_id: "asset_1",
          role: "primary",
          payload_version: 1,
          status: "active",
          content_blob_ref: "cbl_1",
          payload_format: "opaque_file_v1",
          delivery_behavior: "download",
          display_filename: "data.csv",
          mime_type: "text/csv",
          size_bytes: 12,
          content_hash: "sha256:payload",
          created_at: "2026-08-13T00:00:00.000Z",
          updated_at: "2026-08-13T00:00:00.000Z",
        },
        postStatus: "processing",
      }),
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
      allowProcessingPost: true,
    })).resolves.toBeUndefined()
  })

  test("fails closed for dormant deck kinds instead of treating them as downloadable files", async () => {
    await expect(assertAssetDeliveryAllowed({
      client: executor({ enforcement: activeEnforcement }),
      asset: asset("learning_deck"),
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })
    await expect(resolveAssetPayloadDescriptor({
      client: executor({}),
      asset: asset("learning_deck"),
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })
  })

  test("masks an active emergency control with the ordinary not-found response", async () => {
    await expect(assertAssetDeliveryAllowed({
      client: executor({
        enforcement: activeEnforcement,
        emergency: { emergency_control_id: "aec_1", scope_kind: "asset", scope_value: "asset_1" },
      }),
      asset: asset("download_file"),
      notFoundMessage: "Asset not found",
    })).rejects.toMatchObject({ status: 404, message: "Asset not found" })
  })
})
