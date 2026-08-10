import { describe, expect, test } from "bun:test"

import {
  bindDanceAttemptUploadIntent,
  cancelDanceAttemptSession,
  createDanceAttemptSession,
  submitDanceAttemptSession,
} from "./attempt-session-repository"

function fakeClient() {
  let session: Record<string, unknown> | null = null
  const revision = {
    community_id: "cmty_1",
    host_post_id: "post_1",
    referenced_song_post_id: "post_song",
    song_artifact_bundle_id: "sab_1",
    dance_choreography_id: "dch_1",
    dance_choreography_revision_id: "dcr_1",
    reference_content_sha256: "a".repeat(64),
    reference_feature_ref: "dance/reference-features/dcr_1.json",
    reference_feature_sha256: "b".repeat(64),
    reference_feature_size_bytes: 1234,
    pose_model_version: "pose_landmarker_full_float16_v1",
    pose_model_sha256: "c".repeat(64),
    feature_schema_version: "dance_pose_2d_gate0_v1",
    scorer_version: "dance_scorer_gate0_v1",
    artifact_version: "dance_reference_artifact_v1",
    mirror_policy: "allowed",
  }
  const execute = async (query: string | { sql: string; args?: unknown[] }) => {
    const sql = typeof query === "string" ? query : query.sql
    const args = typeof query === "string" ? [] : (query.args ?? [])
    if (sql.includes("FROM dance_choreography_revisions")) {
      return { rows: [revision] }
    }
    if (sql.includes("INSERT INTO dance_attempt_sessions")) {
      if (session) return { rows: [] }
      session = {
        dance_attempt_session_id: args[0],
        dance_attempt_id: args[1],
        subject_user_id: args[2],
        community_id: revision.community_id,
        host_post_id: revision.host_post_id,
        referenced_song_post_id: revision.referenced_song_post_id,
        dance_choreography_id: revision.dance_choreography_id,
        dance_choreography_revision_id:
          revision.dance_choreography_revision_id,
        status: "initialized",
        upload_object_key: args[26],
        maximum_bytes: args[27],
        observed_size_bytes: null,
        observed_etag: null,
        observed_content_sha256: null,
        terminal_reason: null,
        score_bps: null,
        calibration_admitted: null,
        expires_at: args[28],
        submitted_at: null,
        finalized_at: null,
        created_at: args[29],
      }
      return { rows: [{ dance_attempt_session_id: args[0] }] }
    }
    if (sql.includes("SET status = 'uploading'")) {
      session = {
        ...session,
        status: "uploading",
        upload_object_key: args[1],
        maximum_bytes: args[2],
      }
      return { rows: [] }
    }
    if (sql.includes("SET status = 'submitted'")) {
      session = {
        ...session,
        status: "submitted",
        observed_size_bytes: args[1],
        observed_etag: args[2],
        observed_content_sha256: args[3],
        submitted_at: args[4],
      }
      return { rows: [] }
    }
    if (sql.includes("SET status = 'cancelled'")) {
      session = {
        ...session,
        status: "cancelled",
        terminal_reason: "cancelled",
        finalized_at: args[1],
        cleanup_status: args[2],
        cleanup_next_attempt_at: args[3],
      }
      return { rows: [] }
    }
    if (sql.includes("FROM dance_attempt_sessions")) {
      return { rows: session ? [session] : [] }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }
  const transaction = async () => ({
    execute,
    commit: async () => {},
    rollback: async () => {},
    close: () => {},
  })
  return {
    client: { execute, transaction } as never,
    getSession: () => session,
    setStatus: (status: string, terminalReason: string | null) => {
      session = { ...session, status, terminal_reason: terminalReason }
    },
  }
}

describe("dance attempt durable session repository", () => {
  test("pins a ready revision and moves through hash-bound upload submission", async () => {
    const { client } = fakeClient()
    const created = await createDanceAttemptSession({
      client,
      value: {
        sessionId: "dse_1",
        attemptId: "dat_1",
        subjectUserId: "usr_1",
        hostPostId: "post_1",
        creationIdempotencyKey: "idem_1",
        activityDate: "2026-07-30",
        activityTimezone: "UTC",
        now: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })
    expect(created.record).toMatchObject({
      status: "initialized",
      choreographyRevisionId: "dcr_1",
      hostPostId: "post_1",
    })

    const objectKey = `dance/attempt-media/dse_1/${"d".repeat(64)}.mp4`
    const bound = await bindDanceAttemptUploadIntent({
      client,
      sessionId: "dse_1",
      subjectUserId: "usr_1",
      objectKey,
      sizeBytes: 2048,
      now: "2026-07-30T00:01:00.000Z",
    })
    expect(bound.record).toMatchObject({
      status: "uploading",
      uploadObjectKey: objectKey,
      maximumBytes: 2048,
    })

    const submitted = await submitDanceAttemptSession({
      client,
      sessionId: "dse_1",
      subjectUserId: "usr_1",
      contentSha256: "d".repeat(64),
      sizeBytes: 2048,
      etag: "\"etag\"",
      now: "2026-07-30T00:02:00.000Z",
    })
    expect(submitted.record).toMatchObject({
      status: "submitted",
      observedContentSha256: "d".repeat(64),
      observedSizeBytes: 2048,
    })
  })

  test("cancels an owned unsubmitted session idempotently", async () => {
    const { client, getSession } = fakeClient()
    await createDanceAttemptSession({
      client,
      value: {
        sessionId: "dse_cancel",
        attemptId: "dat_cancel",
        subjectUserId: "usr_1",
        hostPostId: "post_1",
        creationIdempotencyKey: "idem_cancel",
        activityDate: "2026-07-30",
        activityTimezone: "UTC",
        now: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })

    const cancelled = await cancelDanceAttemptSession({
      client,
      sessionId: "dse_cancel",
      subjectUserId: "usr_1",
      now: "2026-07-30T00:01:00.000Z",
    })
    expect(cancelled).toMatchObject({
      kind: "cancelled",
      record: { status: "cancelled", terminalReason: "cancelled" },
    })
    expect(getSession()).toMatchObject({
      cleanup_status: "not_required",
      cleanup_next_attempt_at: null,
    })

    const replay = await cancelDanceAttemptSession({
      client,
      sessionId: "dse_cancel",
      subjectUserId: "usr_1",
      now: "2026-07-30T00:02:00.000Z",
    })
    expect(replay.kind).toBe("idempotent")
  })

  test("queues cleanup when cancelling a bound real upload key", async () => {
    const { client, getSession } = fakeClient()
    await createDanceAttemptSession({
      client,
      value: {
        sessionId: "dse_cancel_bound",
        attemptId: "dat_cancel_bound",
        subjectUserId: "usr_1",
        hostPostId: "post_1",
        creationIdempotencyKey: "idem_cancel_bound",
        activityDate: "2026-07-30",
        activityTimezone: "UTC",
        now: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })
    await bindDanceAttemptUploadIntent({
      client,
      sessionId: "dse_cancel_bound",
      subjectUserId: "usr_1",
      objectKey: `dance/attempt-media/dse_cancel_bound/${"d".repeat(64)}.mp4`,
      sizeBytes: 2048,
      now: "2026-07-30T00:01:00.000Z",
    })

    const cancelled = await cancelDanceAttemptSession({
      client,
      sessionId: "dse_cancel_bound",
      subjectUserId: "usr_1",
      now: "2026-07-30T00:02:00.000Z",
    })

    expect(cancelled.kind).toBe("cancelled")
    expect(getSession()).toMatchObject({
      status: "cancelled",
      cleanup_status: "pending",
      cleanup_next_attempt_at: "2026-07-30T00:02:00.000Z",
    })
  })

  test("treats an already-terminal rejection as an idempotent cancellation", async () => {
    const { client, setStatus } = fakeClient()
    await createDanceAttemptSession({
      client,
      value: {
        sessionId: "dse_rejected",
        attemptId: "dat_rejected",
        subjectUserId: "usr_1",
        hostPostId: "post_1",
        creationIdempotencyKey: "idem_rejected",
        activityDate: "2026-07-30",
        activityTimezone: "UTC",
        now: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })
    setStatus("rejected", "video_invalid")

    const result = await cancelDanceAttemptSession({
      client,
      sessionId: "dse_rejected",
      subjectUserId: "usr_1",
      now: "2026-07-30T00:01:00.000Z",
    })
    expect(result).toMatchObject({
      kind: "idempotent",
      record: { status: "rejected", terminalReason: "video_invalid" },
    })
  })

  test("hides ownership and refuses cancellation after submission", async () => {
    const { client } = fakeClient()
    await createDanceAttemptSession({
      client,
      value: {
        sessionId: "dse_owned",
        attemptId: "dat_owned",
        subjectUserId: "usr_1",
        hostPostId: "post_1",
        creationIdempotencyKey: "idem_owned",
        activityDate: "2026-07-30",
        activityTimezone: "UTC",
        now: "2026-07-30T00:00:00.000Z",
        expiresAt: "2026-07-30T00:30:00.000Z",
      },
    })
    await expect(cancelDanceAttemptSession({
      client,
      sessionId: "dse_owned",
      subjectUserId: "usr_other",
      now: "2026-07-30T00:01:00.000Z",
    })).rejects.toMatchObject({ status: 404 })

    const objectKey = `dance/attempt-media/dse_owned/${"d".repeat(64)}.mp4`
    await bindDanceAttemptUploadIntent({
      client,
      sessionId: "dse_owned",
      subjectUserId: "usr_1",
      objectKey,
      sizeBytes: 2048,
      now: "2026-07-30T00:01:00.000Z",
    })
    await submitDanceAttemptSession({
      client,
      sessionId: "dse_owned",
      subjectUserId: "usr_1",
      contentSha256: "d".repeat(64),
      sizeBytes: 2048,
      etag: "etag",
      now: "2026-07-30T00:02:00.000Z",
    })
    await expect(cancelDanceAttemptSession({
      client,
      sessionId: "dse_owned",
      subjectUserId: "usr_1",
      now: "2026-07-30T00:03:00.000Z",
    })).rejects.toMatchObject({ status: 409 })
  })
})
