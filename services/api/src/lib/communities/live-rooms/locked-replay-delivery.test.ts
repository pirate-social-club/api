import { describe, expect, test } from "bun:test"
import { LIVE_ROOM_REPLAY_RAW_MAX_BYTES } from "./recording-ingest"
import { prepareIncludedTicketReplayDelivery } from "./locked-replay-delivery"
import type { LiveRoomReplayAsset } from "./replay-assets"

describe("prepareIncludedTicketReplayDelivery", () => {
  const baseReplayAsset = {
    replay_asset_id: "lra_retry",
    community_id: "cmt_music",
    live_room_id: "lr_retry",
    source_recording_id: "lrr_retry",
    publication_status: "draft",
    title: "Retry replay",
    caption: null,
    duration_ms: null,
    preview_ref: null,
    access_mode: "paid",
    primary_content_ref: "{}",
    locked_delivery_status: "failed",
    locked_delivery_storage_ref: "locked-replays/cmt_music/lr_retry/lra_retry/payload.bin",
    story_cdr_vault_uuid: "7777",
    locked_delivery_secret_json: "{\"mime_type\":\"video/mp4\"}",
    story_namespace: "0x1111111111111111111111111111111111111111111111111111111111111111",
    story_entitlement_token_id: "12345",
    story_read_condition: "0x2222222222222222222222222222222222222222",
    story_write_condition: "0x3333333333333333333333333333333333333333",
    locked_delivery_error: "transient db failure",
    published_at: null,
    created_at: "2026-06-30T00:00:00.000Z",
    updated_at: "2026-06-30T00:00:00.000Z",
  } satisfies LiveRoomReplayAsset

  test("reuses a prepared CDR vault on retry without fetching or minting again", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("unexpected media fetch")
    }) as typeof fetch

    try {
      const replayAsset = baseReplayAsset

      const prepared = await prepareIncludedTicketReplayDelivery({
        env: {},
        communityId: replayAsset.community_id,
        liveRoomId: replayAsset.live_room_id,
        replayAsset,
        rawArtifactRefJson: JSON.stringify({
          provider: "agora_capture",
          bucket: "capture",
          object_key: "recordings/retry.mp4",
          endpoint: "https://capture.test",
          content_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ipfs_cid: null,
          mime_type: "video/mp4",
          size_bytes: 1024,
        }),
      })

      expect(prepared).toMatchObject({
        storyCdrVaultUuid: 7777,
        storyNamespace: replayAsset.story_namespace,
        storyEntitlementTokenId: replayAsset.story_entitlement_token_id,
        storyReadCondition: replayAsset.story_read_condition,
        storyWriteCondition: replayAsset.story_write_condition,
        lockedDeliveryStorageRef: replayAsset.locked_delivery_storage_ref,
        lockedDeliveryMetadataJson: replayAsset.locked_delivery_secret_json,
      })
      expect(prepared.storyAssetVersionId).toMatch(/^0x[a-f0-9]{64}$/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects an oversized raw artifact before fetching it for locked publish", async () => {
    const originalFetch = globalThis.fetch
    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      throw new Error("unexpected media fetch")
    }) as typeof fetch

    try {
      await expect(prepareIncludedTicketReplayDelivery({
        env: {},
        communityId: baseReplayAsset.community_id,
        liveRoomId: baseReplayAsset.live_room_id,
        replayAsset: {
          ...baseReplayAsset,
          locked_delivery_status: "none",
          locked_delivery_storage_ref: null,
          story_cdr_vault_uuid: null,
          locked_delivery_secret_json: null,
          story_namespace: null,
          story_entitlement_token_id: null,
          story_read_condition: null,
          story_write_condition: null,
          locked_delivery_error: null,
        },
        rawArtifactRefJson: JSON.stringify({
          provider: "agora_capture",
          bucket: "capture",
          object_key: "recordings/huge.mp4",
          endpoint: "https://capture.test",
          content_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ipfs_cid: null,
          mime_type: "video/mp4",
          size_bytes: LIVE_ROOM_REPLAY_RAW_MAX_BYTES + 1,
        }),
      })).rejects.toThrow("Replay recording exceeds the 256MB limit")

      expect(fetchCount).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
