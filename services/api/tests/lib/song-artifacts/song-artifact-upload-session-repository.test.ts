import { afterEach, describe, expect, test } from "bun:test"
import {
  createSongArtifactUploadIntent,
  markSongArtifactUploadCancelled,
  markSongArtifactUploadUploaded,
} from "../../../src/lib/song-artifacts/song-artifact-repository"
import {
  createSongArtifactUploadSession,
  isSongArtifactUploadContentHashServerVerified,
  listStaleSongArtifactUploadSessions,
  markSongArtifactUploadSessionAborted,
  markSongArtifactUploadSessionUploaded,
  transitionSongArtifactUploadSession,
} from "../../../src/lib/song-artifacts/song-artifact-upload-session-repository"
import { createControlPlaneTestClient } from "../../helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function createSetup() {
  const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanup = setup.cleanup
  const now = "2026-06-05T12:00:00.000Z"

  await setup.client.execute({
    sql: `
      INSERT INTO users (
        user_id, verification_state, verification_capabilities_json, created_at, updated_at
      ) VALUES (?1, 'verified', '{}', ?2, ?2)
    `,
    args: ["usr_session_owner", now],
  })
  await setup.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status,
        provisioning_state, transfer_state, created_at, updated_at
      ) VALUES (?1, ?2, 'Session Test', 'open', 'active', 'active', 'none', ?3, ?3)
    `,
    args: ["cmt_session", "usr_session_owner", now],
  })

  const upload = await createSongArtifactUploadIntent({
    client: setup.client,
    communityId: "cmt_session",
    userId: "usr_session_owner",
    songArtifactUploadId: "sau_session_video",
    storageRef: "https://pirate.test/communities/com_cmt_session/song-artifact-uploads/sau_sau_session_video/content",
    body: {
      artifact_kind: "primary_video",
      mime_type: "video/mp4",
      filename: "clip.mp4",
      size_bytes: 25 * 1024 * 1024,
      content_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    },
    createdAt: now,
  })

  return { ...setup, now, upload }
}

function sessionInput(overrides: Partial<Parameters<typeof createSongArtifactUploadSession>[0]["session"]> = {}) {
  return {
    songArtifactUploadSessionId: "saus_session_1",
    communityId: "cmt_session",
    songArtifactUploadId: "sau_session_video",
    uploaderUserId: "usr_session_owner",
    status: "parts_uploading" as const,
    uploadMode: "direct_multipart" as const,
    objectKey: "song-artifacts/cmt_session/primary_video/sau_session_video.mp4",
    filebaseUploadId: "filebase-upload-1",
    partSizeBytes: 10 * 1024 * 1024,
    totalParts: 3,
    declaredSizeBytes: 25 * 1024 * 1024,
    declaredMimeType: "video/mp4",
    declaredContentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    bucket: "psc-media-bucket",
    storageEndpoint: "https://s3.filebase.com",
    expiresAt: "2026-06-05T13:00:00.000Z",
    createdAt: "2026-06-05T12:00:00.000Z",
    updatedAt: "2026-06-05T12:00:00.000Z",
    ...overrides,
  }
}

describe("song artifact upload session repository", () => {
  test("treats proxy hashes as verified and direct multipart hashes as unverified", async () => {
    const setup = await createSetup()

    expect(await isSongArtifactUploadContentHashServerVerified({
      client: setup.client,
      communityId: "cmt_session",
      songArtifactUploadId: setup.upload.id,
    })).toBe(true)

    await createSongArtifactUploadSession({
      client: setup.client,
      session: sessionInput(),
    })

    expect(await isSongArtifactUploadContentHashServerVerified({
      client: setup.client,
      communityId: "cmt_session",
      songArtifactUploadId: setup.upload.id,
    })).toBe(false)
  })

  test("creates sessions and performs race-safe transitions", async () => {
    const setup = await createSetup()

    const session = await createSongArtifactUploadSession({
      client: setup.client,
      session: sessionInput(),
    })

    expect(session.status).toBe("parts_uploading")
    expect(session.total_parts).toBe(3)
    expect(session.declared_size_bytes).toBe(25 * 1024 * 1024)

    const completing = await transitionSongArtifactUploadSession({
      client: setup.client,
      communityId: "cmt_session",
      sessionId: "saus_session_1",
      fromStatus: "parts_uploading",
      toStatus: "completing",
      updatedAt: "2026-06-05T12:05:00.000Z",
    })
    expect(completing?.status).toBe("completing")

    const lostRace = await transitionSongArtifactUploadSession({
      client: setup.client,
      communityId: "cmt_session",
      sessionId: "saus_session_1",
      fromStatus: "parts_uploading",
      toStatus: "aborting",
      updatedAt: "2026-06-05T12:06:00.000Z",
    })
    expect(lostRace).toBeNull()

    const verifying = await transitionSongArtifactUploadSession({
      client: setup.client,
      communityId: "cmt_session",
      sessionId: "saus_session_1",
      fromStatus: "completing",
      toStatus: "head_verifying",
      updatedAt: "2026-06-05T12:07:00.000Z",
    })
    expect(verifying?.status).toBe("head_verifying")

    const uploaded = await markSongArtifactUploadSessionUploaded({
      client: setup.client,
      communityId: "cmt_session",
      sessionId: "saus_session_1",
      storageProvider: "filebase",
      storageObjectKey: "song-artifacts/cmt_session/primary_video/sau_session_video.mp4",
      storageBucket: "psc-media-bucket",
      gatewayUrl: "https://ipfs.filebase.io/ipfs/QmSession",
      ipfsCid: "QmSession",
      contentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      sizeBytes: 25 * 1024 * 1024,
      completedAt: "2026-06-05T12:08:00.000Z",
      updatedAt: "2026-06-05T12:08:00.000Z",
    })

    expect(uploaded?.status).toBe("uploaded")
    expect(uploaded?.ipfs_cid).toBe("QmSession")
    expect(uploaded?.storage_provider).toBe("filebase")
  })

  test("enforces one active session per canonical upload", async () => {
    const setup = await createSetup()

    await createSongArtifactUploadSession({
      client: setup.client,
      session: sessionInput({ songArtifactUploadSessionId: "saus_active_1" }),
    })

    await expect(createSongArtifactUploadSession({
      client: setup.client,
      session: sessionInput({ songArtifactUploadSessionId: "saus_active_2" }),
    })).rejects.toThrow()

    const aborted = await markSongArtifactUploadSessionAborted({
      client: setup.client,
      communityId: "cmt_session",
      sessionId: "saus_active_1",
      reason: "user_cancelled",
      abortedAt: "2026-06-05T12:10:00.000Z",
      updatedAt: "2026-06-05T12:10:00.000Z",
    })
    expect(aborted?.status).toBe("aborted")

    const replacement = await createSongArtifactUploadSession({
      client: setup.client,
      session: sessionInput({ songArtifactUploadSessionId: "saus_active_2" }),
    })
    expect(replacement.status).toBe("parts_uploading")
  })

  test("lists stale active sessions and cancels the canonical upload", async () => {
    const setup = await createSetup()

    await createSongArtifactUploadSession({
      client: setup.client,
      session: sessionInput({
        songArtifactUploadSessionId: "saus_stale",
        expiresAt: "2026-06-05T11:59:00.000Z",
      }),
    })

    const stale = await listStaleSongArtifactUploadSessions({
      client: setup.client,
      communityId: "cmt_session",
      now: setup.now,
      limit: 10,
    })
    expect(stale.map((session) => session.song_artifact_upload_session_id)).toEqual(["saus_stale"])

    await markSongArtifactUploadSessionAborted({
      client: setup.client,
      communityId: "cmt_session",
      sessionId: "saus_stale",
      reason: "expired",
      abortedAt: setup.now,
      updatedAt: setup.now,
    })
    const cancelled = await markSongArtifactUploadCancelled({
      client: setup.client,
      communityId: "cmt_session",
      songArtifactUploadId: "sau_session_video",
      updatedAt: setup.now,
    })
    expect(cancelled.status).toBe("cancelled")
  })

  test("does not upload a canonical row after it has been cancelled", async () => {
    const setup = await createSetup()

    const cancelled = await markSongArtifactUploadCancelled({
      client: setup.client,
      communityId: "cmt_session",
      songArtifactUploadId: "sau_session_video",
      updatedAt: "2026-06-05T12:10:00.000Z",
    })
    expect(cancelled.status).toBe("cancelled")

    const uploaded = await markSongArtifactUploadUploaded({
      client: setup.client,
      communityId: "cmt_session",
      songArtifactUploadId: "sau_session_video",
      mimeType: "video/mp4",
      sizeBytes: 25 * 1024 * 1024,
      contentHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      storageProvider: "filebase",
      storageBucket: "psc-media-bucket",
      storageObjectKey: "song-artifacts/cmt_session/primary_video/sau_session_video.mp4",
      storageEndpoint: "https://s3.filebase.com",
      gatewayUrl: "https://ipfs.filebase.io/ipfs/QmCancelled",
      ipfsCid: "QmCancelled",
      updatedAt: "2026-06-05T12:11:00.000Z",
    })
    expect(uploaded.status).toBe("cancelled")
    expect(uploaded.storage_provider).toBeNull()
    expect(uploaded.ipfs_cid).toBeNull()
  })
})
