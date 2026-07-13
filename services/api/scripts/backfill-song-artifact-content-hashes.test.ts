import { describe, expect, test } from "bun:test"
import type { Client } from "../src/lib/sql-client"
import {
  listContentHashBackfillCandidates,
  type ContentHashBackfillCandidate,
  hashContentResponse,
  publicSongArtifactUploadIdFromStored,
  verifyContentHashBackfillCandidate,
} from "./backfill-song-artifact-content-hashes"

const candidate: ContentHashBackfillCandidate = {
  communityId: "cmt_1",
  songArtifactUploadId: "sau_upload_1",
  storageObjectKey: "songs/cmt_1/upload_1/audio.mp3",
  expectedContentHash: "0x2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  declaredSizeBytes: 5,
}

describe("song artifact content hash backfill", () => {
  test("converts a stored upload key to the public id expected by the repository marker", () => {
    expect(publicSongArtifactUploadIdFromStored("sau_upload_1")).toBe("sau_sau_upload_1")
  })

  test("hashes the source response incrementally", async () => {
    await expect(hashContentResponse(new Response("hello"))).resolves.toEqual({
      computedContentHash: candidate.expectedContentHash,
      actualSizeBytes: 5,
    })
  })

  test("selects only unverified uploaded multipart primary audio with a resumable cursor", async () => {
    let query: { sql: string; args?: unknown[] } | null = null
    const client = {
      execute: async (input: { sql: string; args?: unknown[] }) => {
        query = input
        return {
          rows: [{
            community_id: candidate.communityId,
            song_artifact_upload_id: candidate.songArtifactUploadId,
            storage_object_key: candidate.storageObjectKey,
            content_hash: candidate.expectedContentHash,
            size_bytes: candidate.declaredSizeBytes,
          }],
          rowsAffected: 0,
        }
      },
    } as unknown as Client

    await expect(listContentHashBackfillCandidates({
      client,
      communityId: "cmt_1",
      uploadId: null,
      afterCommunityId: "cmt_0",
      afterUploadId: "sau_sau_upload_0",
      limit: 25,
    })).resolves.toEqual([candidate])

    expect(query).not.toBeNull()
    expect(query!.sql).toContain("upload.content_hash_verified_at IS NULL")
    expect(query!.sql).toContain("session.upload_mode = 'direct_multipart'")
    expect(query!.sql).toContain("session.status = 'uploaded'")
    expect(query!.sql).toContain("upload.song_artifact_upload_id > ?3")
    expect(query!.args).toEqual(["cmt_1", "cmt_0", "sau_upload_0", 25])
  })

  test("accepts both stored and public upload ids without stripping the stored prefix", async () => {
    const queryArgs: unknown[][] = []
    const client = {
      execute: async (input: { args?: unknown[] }) => {
        queryArgs.push(input.args ?? [])
        return { rows: [], rowsAffected: 0 }
      },
    } as unknown as Client

    for (const uploadId of ["sau_upload_1", "sau_sau_upload_1"]) {
      await listContentHashBackfillCandidates({
        client,
        communityId: null,
        uploadId,
        afterCommunityId: null,
        afterUploadId: null,
        limit: 1,
      })
    }

    expect(queryArgs).toEqual([
      ["sau_upload_1", 1],
      ["sau_upload_1", 1],
    ])
  })

  test("measures matching bytes without mutating in dry-run mode", async () => {
    let markCalls = 0
    const outcome = await verifyContentHashBackfillCandidate({
      candidate,
      execute: false,
      loadDigest: async () => ({
        computedContentHash: candidate.expectedContentHash,
        actualSizeBytes: 5,
      }),
      markVerified: async () => {
        markCalls += 1
        return true
      },
    })

    expect(outcome).toEqual({
      status: "matched",
      computedContentHash: candidate.expectedContentHash,
      actualSizeBytes: 5,
    })
    expect(markCalls).toBe(0)
  })

  test("records exact matches in execute mode", async () => {
    const marked: string[] = []
    const outcome = await verifyContentHashBackfillCandidate({
      candidate,
      execute: true,
      loadDigest: async () => ({
        computedContentHash: candidate.expectedContentHash,
        actualSizeBytes: 5,
      }),
      markVerified: async (_candidate, computedContentHash) => {
        marked.push(computedContentHash)
        return true
      },
    })

    expect(outcome.status).toBe("updated")
    expect(marked).toEqual([candidate.expectedContentHash])
  })

  test("reports mismatches and never marks them verified", async () => {
    let marked = false
    const outcome = await verifyContentHashBackfillCandidate({
      candidate,
      execute: true,
      loadDigest: async () => ({
        computedContentHash: "0x9d6f965ac832e40a5df6c06afe983e3b136cae3a1795f76b3fb188c67d1ce4d9",
        actualSizeBytes: 9,
      }),
      markVerified: async () => {
        marked = true
        return true
      },
    })

    expect(outcome.status).toBe("mismatched")
    expect(outcome.computedContentHash).not.toBe(candidate.expectedContentHash)
    expect(marked).toBeFalse()
  })

  test("fails when the upload changes before the atomic verification mark", async () => {
    await expect(verifyContentHashBackfillCandidate({
      candidate,
      execute: true,
      loadDigest: async () => ({
        computedContentHash: candidate.expectedContentHash,
        actualSizeBytes: 5,
      }),
      markVerified: async () => false,
    })).rejects.toThrow("Upload changed before the verified hash could be recorded")
  })
})
