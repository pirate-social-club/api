import { describe, expect, test } from "bun:test"
import {
  LIVE_ROOM_REPLAY_RAW_MAX_BYTES,
  ingestAgoraRecordingToPrivateStorage,
  selectAgoraRecordingObjectKey,
} from "./recording-ingest"

describe("selectAgoraRecordingObjectKey", () => {
  test("prefers MP4 output from nested Agora stop/query responses", () => {
    expect(selectAgoraRecordingObjectKey({
      serverResponse: {
        fileList: [
          { fileName: "prefix/room/index.m3u8" },
          { fileName: "prefix/room/archive.mp4" },
        ],
      },
    })).toBe("prefix/room/archive.mp4")
  })
})

describe("ingestAgoraRecordingToPrivateStorage", () => {
  test("keeps the captured Agora object private and returns a non-IPFS ref", async () => {
    const originalFetch = globalThis.fetch
    const captureBytes = new TextEncoder().encode("recording")
    const requests: string[] = []
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request)
      requests.push(url)
      if (url.startsWith("https://capture.test/")) {
        return new Response(captureBytes, { status: 200, headers: { "content-type": "video/mp4" } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const ref = await ingestAgoraRecordingToPrivateStorage({
        env: {
          AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture.test",
          AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
          AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
          AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
          AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
        },
        communityId: "cmt_music",
        liveRoomId: "lr_room",
        recordingId: "lrr_recording",
        agoraStopResponse: {
          serverResponse: {
            fileList: [{ fileName: "agora/output/replay.mp4" }],
          },
        },
      })

      expect(ref).toMatchObject({
        provider: "agora_capture",
        bucket: "capture-bucket",
        object_key: "agora/output/replay.mp4",
        endpoint: "https://capture.test/",
        ipfs_cid: null,
        mime_type: "video/mp4",
        size_bytes: captureBytes.byteLength,
      })
      expect(ref.content_hash).toMatch(/^0x[a-f0-9]{64}$/)
      expect(requests[0]).toContain("https://capture.test/capture-bucket/agora/output/replay.mp4")
      expect(requests).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("can fetch capture objects from the existing Filebase bucket defaults", async () => {
    const originalFetch = globalThis.fetch
    const captureBytes = new TextEncoder().encode("recording")
    const requests: string[] = []
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request)
      requests.push(url)
      if (url.startsWith("https://s3.filebase.com/")) {
        return new Response(captureBytes, { status: 200, headers: { "content-type": "video/mp4" } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const ref = await ingestAgoraRecordingToPrivateStorage({
        env: {
          FILEBASE_S3_ENDPOINT: "https://s3.filebase.com",
          FILEBASE_S3_REGION: "us-east-1",
          FILEBASE_MEDIA_BUCKET: "psc-media-bucket",
          FILEBASE_S3_ACCESS_KEY: "filebase-access",
          FILEBASE_S3_SECRET_KEY: "filebase-secret",
        },
        communityId: "cmt_music",
        liveRoomId: "lr_room",
        recordingId: "lrr_recording",
        agoraStopResponse: {
          serverResponse: {
            fileList: [{ fileName: "agora/output/replay.mp4" }],
          },
        },
      })

      expect(ref).toMatchObject({
        provider: "agora_capture",
        bucket: "psc-media-bucket",
        object_key: "agora/output/replay.mp4",
        endpoint: "https://s3.filebase.com/",
        ipfs_cid: null,
      })
      expect(requests[0]).toContain("https://s3.filebase.com/psc-media-bucket/agora/output/replay.mp4")
      expect(requests).toHaveLength(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test("rejects captures that exceed the Worker-safe replay raw limit", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request)
      if (url.startsWith("https://capture.test/")) {
        return new Response("", {
          status: 200,
          headers: { "content-length": String(LIVE_ROOM_REPLAY_RAW_MAX_BYTES + 1) },
        })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      await expect(ingestAgoraRecordingToPrivateStorage({
        env: {
          AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture.test",
          AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
          AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
          AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
          AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
        },
        communityId: "cmt_music",
        liveRoomId: "lr_room",
        recordingId: "lrr_recording",
        agoraStopResponse: {
          serverResponse: {
            fileList: [{ fileName: "agora/output/huge.mp4" }],
          },
        },
      })).rejects.toThrow("Replay recording exceeds the 256MB limit")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
