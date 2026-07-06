import { describe, expect, mock, test } from "bun:test"

import type { Post } from "../../../types"
import type { AssetRow } from "./row-types"

let registrationMode: "success" | "failure" = "success"
const maybeRegisterStoryRoyaltyForAsset = mock(async () => {
  if (registrationMode === "failure") {
    throw new Error("story_rpc_unavailable")
  }
  return {
    storyDerivativeParentIpIds: null,
    storyDerivativeRegisteredAt: null,
    storyIpId: "0x1111111111111111111111111111111111111111",
    storyIpNftContract: "0x2222222222222222222222222222222222222222",
    storyIpNftTokenId: "17",
    ipRoyaltyVault: "0x7777777777777777777777777777777777777777",
    storyLicenseTemplate: "0x3333333333333333333333333333333333333333",
    storyLicenseTermsId: "42",
    storyRevenueToken: "0x4444444444444444444444444444444444444444",
    storyRoyaltyPolicy: "0x5555555555555555555555555555555555555555",
    storyRoyaltyRegistrationStatus: "registered",
  }
})

mock.module("../../story/story-royalty-registration-service", () => ({
  isStoryRoyaltyRegistrationConfigured: mock(() => true),
  maybeRegisterStoryRoyaltyForAsset,
}))

const { createAssetForPost } = await import("./service")

const COMMUNITY_ID = "cmty_async"
const POST_ID = "post_song"
const ASSET_ID = "asset_song"

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    access_mode: "public",
    asset_id: ASSET_ID,
    asset_kind: "song_audio",
    commercial_rev_share_pct: null,
    community_id: COMMUNITY_ID,
    created_at: "2026-07-05T00:00:00.000Z",
    creator_user_id: "usr_artist",
    display_title: "Existing song",
    license_preset: null,
    locked_delivery_error: null,
    locked_delivery_ref: null,
    locked_delivery_secret_json: null,
    locked_delivery_status: "none",
    locked_delivery_storage_ref: null,
    primary_content_hash: "0xabc",
    primary_content_ref: "r2://song.wav",
    publication_status: "draft",
    rights_basis: "original",
    song_artifact_bundle_id: "bundle_1",
    source_post_id: POST_ID,
    story_asset_version_id: null,
    story_cdr_vault_uuid: null,
    story_derivative_parent_ip_ids_json: null,
    story_derivative_registered_at: null,
    story_entitlement_token_id: null,
    story_error: "royalty_registration_failed:story_rpc_unavailable",
    story_ip_id: null,
    story_ip_nft_contract: null,
    story_ip_nft_token_id: null,
    ip_royalty_vault: null,
    story_license_template: null,
    story_license_terms_id: null,
    story_namespace: null,
    story_publish_model: "pirate_v1",
    story_publish_tx_ref: null,
    story_read_condition: null,
    story_revenue_token: null,
    story_royalty_policy: null,
    story_royalty_policy_id: null,
    story_royalty_registration_status: "failed",
    story_status: "failed",
    story_write_condition: null,
    updated_at: "2026-07-05T00:00:00.000Z",
    ...overrides,
  }
}

function post(): Post {
  return {
    access_mode: "public",
    age_gate_policy: "none",
    analysis_state: "allow",
    anonymous_label: null,
    anonymous_scope: null,
    asset_id: ASSET_ID,
    author_user_id: "usr_artist",
    authorship_mode: "human_direct",
    body: null,
    caption: null,
    comments_locked: false,
    community_id: COMMUNITY_ID,
    content_safety_state: "safe",
    created_at: "2026-07-05T00:00:00.000Z",
    idempotency_key: "idem",
    identity_mode: "public",
    lyrics: "lyrics",
    media_refs: [],
    post_id: POST_ID,
    post_type: "song",
    rights_basis: "original",
    song_artifact_bundle_id: "bundle_1",
    song_mode: "original",
    status: "processing",
    title: "Existing song",
    updated_at: "2026-07-05T00:00:00.000Z",
    upstream_asset_refs: [],
    visibility: "public",
  } as Post
}

function userRepository() {
  return {
    getUserById: async () => ({
      primary_wallet_attachment_id: "wallet_1",
      verification_capabilities: {
        unique_human: { state: "verified" },
      },
    }),
    getWalletAttachmentsByUserId: async () => [
      {
        is_primary: true,
        wallet_address: "0x6666666666666666666666666666666666666666",
        wallet_attachment: "wallet_1",
      },
    ],
  }
}

function fakeClient(initial: AssetRow) {
  let row = initial
  return {
    get row() {
      return row
    },
    client: {
      execute: async (statement: { sql: string; args?: unknown[] }) => {
        if (statement.sql.includes("SELECT a.asset_id")) {
          return { rows: [] }
        }
        if (statement.sql.includes("UPDATE assets") && statement.args && statement.args.length >= 28) {
          row = {
            ...row,
            commercial_rev_share_pct: statement.args[26] as AssetRow["commercial_rev_share_pct"],
            license_preset: statement.args[25] as AssetRow["license_preset"],
            publication_status: statement.args[2] as AssetRow["publication_status"],
            story_asset_version_id: statement.args[19] as AssetRow["story_asset_version_id"],
            story_cdr_vault_uuid: statement.args[20] as AssetRow["story_cdr_vault_uuid"],
            story_derivative_parent_ip_ids_json: statement.args[14] as AssetRow["story_derivative_parent_ip_ids_json"],
            story_derivative_registered_at: statement.args[15] as AssetRow["story_derivative_registered_at"],
            story_entitlement_token_id: statement.args[22] as AssetRow["story_entitlement_token_id"],
            story_error: statement.args[4] as AssetRow["story_error"],
            story_ip_id: statement.args[5] as AssetRow["story_ip_id"],
            story_ip_nft_contract: statement.args[6] as AssetRow["story_ip_nft_contract"],
            story_ip_nft_token_id: statement.args[7] as AssetRow["story_ip_nft_token_id"],
            ip_royalty_vault: statement.args[8] as AssetRow["ip_royalty_vault"],
            story_license_template: statement.args[11] as AssetRow["story_license_template"],
            story_license_terms_id: statement.args[10] as AssetRow["story_license_terms_id"],
            story_namespace: statement.args[21] as AssetRow["story_namespace"],
            story_publish_model: statement.args[9] as AssetRow["story_publish_model"],
            story_publish_tx_ref: statement.args[18] as AssetRow["story_publish_tx_ref"],
            story_read_condition: statement.args[23] as AssetRow["story_read_condition"],
            story_revenue_token: statement.args[16] as AssetRow["story_revenue_token"],
            story_royalty_policy: statement.args[12] as AssetRow["story_royalty_policy"],
            story_royalty_policy_id: statement.args[13] as AssetRow["story_royalty_policy_id"],
            story_royalty_registration_status: statement.args[17] as AssetRow["story_royalty_registration_status"],
            story_status: statement.args[3] as AssetRow["story_status"],
            story_write_condition: statement.args[24] as AssetRow["story_write_condition"],
            updated_at: statement.args[27] as AssetRow["updated_at"],
          }
          return { rows: [] }
        }
        if (statement.sql.includes("UPDATE assets") && statement.args && statement.args.length === 4) {
          row = {
            ...row,
            story_error: statement.args[2] as AssetRow["story_error"],
            story_royalty_registration_status: "failed",
            story_status: "failed",
            updated_at: statement.args[3] as AssetRow["updated_at"],
          }
          return { rows: [] }
        }
        return { rows: [row] }
      },
      transaction: async () => {
        throw new Error("transaction should not run")
      },
    },
  }
}

function fakeCreateClient() {
  let row: AssetRow | null = null
  const assetInsertStatements: Array<{ sql: string; args?: unknown[] }> = []
  const allocationInsertStatements: Array<{ sql: string; args?: unknown[] }> = []
  const execute = async (statement: { sql: string; args?: unknown[] }) => {
    if (statement.sql.includes("JOIN initial_royalty_allocations")) {
      return { rows: [] }
    }
    if (statement.sql.includes("SELECT") && statement.sql.includes("FROM assets")) {
      return { rows: row ? [row] : [] }
    }
    return { rows: [] }
  }
  return {
    get assetInsertStatements() {
      return assetInsertStatements
    },
    get allocationInsertStatements() {
      return allocationInsertStatements
    },
    client: {
      execute,
      transaction: async () => ({
        execute: async (statement: { sql: string; args?: unknown[] }) => {
          if (statement.sql.includes("INSERT INTO assets")) {
            assetInsertStatements.push(statement)
            const args = statement.args ?? []
            row = assetRow({
              asset_id: args[0] as string,
              community_id: args[1] as string,
              source_post_id: args[2] as string,
              display_title: args[3] as string | null,
              song_artifact_bundle_id: args[4] as string | null,
              creator_user_id: args[5] as string,
              asset_kind: args[6] as AssetRow["asset_kind"],
              rights_basis: args[7] as AssetRow["rights_basis"],
              access_mode: args[8] as AssetRow["access_mode"],
              license_preset: args[9] as AssetRow["license_preset"],
              commercial_rev_share_pct: args[10] as AssetRow["commercial_rev_share_pct"],
              primary_content_ref: args[11] as string,
              primary_content_hash: args[12] as string | null,
              publication_status: args[13] as AssetRow["publication_status"],
              story_status: args[14] as AssetRow["story_status"],
              story_error: args[15] as AssetRow["story_error"],
              story_ip_id: args[16] as AssetRow["story_ip_id"],
              story_ip_nft_contract: args[17] as AssetRow["story_ip_nft_contract"],
              story_ip_nft_token_id: args[18] as AssetRow["story_ip_nft_token_id"],
              ip_royalty_vault: args[19] as AssetRow["ip_royalty_vault"],
              story_publish_model: args[20] as AssetRow["story_publish_model"],
              story_license_terms_id: args[21] as AssetRow["story_license_terms_id"],
              story_license_template: args[22] as AssetRow["story_license_template"],
              story_royalty_policy: args[23] as AssetRow["story_royalty_policy"],
              story_royalty_policy_id: args[24] as AssetRow["story_royalty_policy_id"],
              story_derivative_parent_ip_ids_json: args[25] as AssetRow["story_derivative_parent_ip_ids_json"],
              story_derivative_registered_at: args[26] as AssetRow["story_derivative_registered_at"],
              story_revenue_token: args[27] as AssetRow["story_revenue_token"],
              story_royalty_registration_status: args[28] as AssetRow["story_royalty_registration_status"],
              locked_delivery_status: args[29] as AssetRow["locked_delivery_status"],
              locked_delivery_ref: args[30] as AssetRow["locked_delivery_ref"],
              locked_delivery_error: args[31] as AssetRow["locked_delivery_error"],
              created_at: args[32] as string,
              updated_at: args[32] as string,
              story_publish_tx_ref: args[33] as AssetRow["story_publish_tx_ref"],
              story_asset_version_id: args[34] as AssetRow["story_asset_version_id"],
              story_cdr_vault_uuid: args[35] as AssetRow["story_cdr_vault_uuid"],
              story_namespace: args[36] as AssetRow["story_namespace"],
              story_entitlement_token_id: args[37] as AssetRow["story_entitlement_token_id"],
              story_read_condition: args[38] as AssetRow["story_read_condition"],
              story_write_condition: args[39] as AssetRow["story_write_condition"],
              locked_delivery_storage_ref: args[40] as AssetRow["locked_delivery_storage_ref"],
              locked_delivery_secret_json: args[41] as AssetRow["locked_delivery_secret_json"],
            })
          } else if (statement.sql.includes("INSERT INTO initial_royalty_allocations")) {
            allocationInsertStatements.push(statement)
          }
          return { rows: [] }
        },
        batch: async () => [],
        commit: async () => {},
        rollback: async () => {},
        close: () => {},
      }),
    },
  }
}

describe("createAssetForPost existing asset resume", () => {
  test("retries Story registration for an existing failed asset and returns the registered asset", async () => {
    registrationMode = "success"
    maybeRegisterStoryRoyaltyForAsset.mockClear()
    const existing = assetRow()
    const { client } = fakeClient(existing)

    const asset = await createAssetForPost({
      assetKind: "song_audio",
      artifactKind: "primary_audio",
      bundle: { id: "sab_bundle_1" } as never,
      bundleId: "bundle_1",
      client,
      commercialRevSharePct: null,
      communityId: COMMUNITY_ID,
      contentHash: "0xabc",
      displayTitle: "Existing song",
      env: {} as never,
      licensePreset: null,
      mimeType: "audio/wav",
      post: post(),
      requireStoryRoyaltyRegistration: true,
      royaltyAllocations: null,
      storageRef: "r2://song.wav",
      userRepository: userRepository() as never,
    })

    expect(maybeRegisterStoryRoyaltyForAsset).toHaveBeenCalledTimes(1)
    expect(asset.story_royalty_registration_status).toBe("registered")
    expect(asset.story_ip).toBe("0x1111111111111111111111111111111111111111")
    expect(asset.story_license_terms).toBe("42")
  })

  test("keeps an existing asset retryable when the Story registration reattempt fails", async () => {
    registrationMode = "failure"
    maybeRegisterStoryRoyaltyForAsset.mockClear()
    const existing = assetRow()
    const { client } = fakeClient(existing)

    await expect(createAssetForPost({
      assetKind: "song_audio",
      artifactKind: "primary_audio",
      bundle: { id: "sab_bundle_1" } as never,
      bundleId: "bundle_1",
      client,
      commercialRevSharePct: null,
      communityId: COMMUNITY_ID,
      contentHash: "0xabc",
      displayTitle: "Existing song",
      env: {} as never,
      licensePreset: null,
      mimeType: "audio/wav",
      post: post(),
      requireStoryRoyaltyRegistration: true,
      royaltyAllocations: null,
      storageRef: "r2://song.wav",
      userRepository: userRepository() as never,
    })).rejects.toMatchObject({
      code: "provider_unavailable",
      details: {
        reason: "story_royalty_registration_failed",
        story_error_class: "transient",
      },
      retryable: true,
    })
    expect(maybeRegisterStoryRoyaltyForAsset).toHaveBeenCalledTimes(1)
  })
})

describe("createAssetForPost allocation projection state", () => {
  test("creates allocation-backed assets as projection-unsynced until control-plane sync succeeds", async () => {
    registrationMode = "success"
    maybeRegisterStoryRoyaltyForAsset.mockClear()
    const fake = fakeCreateClient()

    await createAssetForPost({
      assetKind: "song_audio",
      artifactKind: "primary_audio",
      bundle: { id: "sab_bundle_1" } as never,
      bundleId: "bundle_1",
      client: fake.client,
      commercialRevSharePct: null,
      communityId: COMMUNITY_ID,
      contentHash: "0xabc",
      displayTitle: "New split song",
      env: {} as never,
      licensePreset: null,
      mimeType: "audio/wav",
      post: { ...post(), title: "New split song" },
      requireStoryRoyaltyRegistration: true,
      royaltyAllocations: [
        {
          recipient_kind: "creator",
          wallet_address: "0x6666666666666666666666666666666666666666",
          share_bps: 10000,
        },
      ],
      storageRef: "r2://song.wav",
      userRepository: userRepository() as never,
    })

    expect(fake.assetInsertStatements).toHaveLength(1)
    expect(fake.allocationInsertStatements).toHaveLength(1)
    const assetInsert = fake.assetInsertStatements[0]
    expect(assetInsert.sql).toContain("royalty_allocation_projection_synced")
    expect(assetInsert.args?.at(-1)).toBe(0)
  })
})
