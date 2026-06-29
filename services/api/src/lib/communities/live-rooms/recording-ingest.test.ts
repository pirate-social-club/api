import { describe, expect, test } from "bun:test"
import { ingestAgoraRecordingToFilebase, selectAgoraRecordingObjectKey } from "./recording-ingest"

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

describe("ingestAgoraRecordingToFilebase", () => {
  test("copies the captured Agora object into Filebase and returns a durable ref", async () => {
    const originalFetch = globalThis.fetch
    const captureBytes = new TextEncoder().encode("recording")
    const requests: string[] = []
    globalThis.fetch = (async (request: RequestInfo | URL) => {
      const url = request instanceof Request ? request.url : String(request)
      requests.push(url)
      if (url.startsWith("https://capture.test/")) {
        return new Response(captureBytes, { status: 200, headers: { "content-type": "video/mp4" } })
      }
      if (url.startsWith("https://filebase.test/")) {
        return new Response("", { status: 200, headers: { "x-amz-meta-cid": "bafy-recording" } })
      }
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    try {
      const ref = await ingestAgoraRecordingToFilebase({
        env: {
          AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT: "https://capture.test",
          AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION: "us-east-1",
          AGORA_CLOUD_RECORDING_STORAGE_BUCKET: "capture-bucket",
          AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY: "capture-access",
          AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY: "capture-secret",
          FILEBASE_S3_ENDPOINT: "https://filebase.test",
          FILEBASE_S3_REGION: "us-east-1",
          FILEBASE_MEDIA_BUCKET: "media",
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
        provider: "filebase",
        bucket: "media",
        object_key: "livestream-recordings/cmt_music/lr_room/lrr_recording/replay.mp4",
        endpoint: "https://filebase.test/",
        ipfs_cid: "bafy-recording",
        mime_type: "video/mp4",
        size_bytes: captureBytes.byteLength,
      })
      expect(requests[0]).toContain("https://capture.test/capture-bucket/agora/output/replay.mp4")
      expect(requests[1]).toContain("https://filebase.test/media/livestream-recordings/cmt_music/lr_room/lrr_recording/replay.mp4")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
