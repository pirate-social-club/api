import { describe, expect, test } from "bun:test"

import type { Post } from "../../../types"
import type { AssetRow } from "./row-types"
import { createAssetForPost } from "./service"

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

describe("createAssetForPost existing asset resume", () => {
  test("does not treat an existing failed Story registration as publishable", async () => {
    const existing = assetRow()
    const client = {
      execute: async () => ({ rows: [existing] }),
      transaction: async () => {
        throw new Error("transaction should not run")
      },
    }

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
      userRepository: {} as never,
    })).rejects.toMatchObject({
      code: "provider_unavailable",
      details: {
        reason: "story_royalty_registration_failed",
        story_error_class: "transient",
      },
      retryable: true,
    })
  })
})
