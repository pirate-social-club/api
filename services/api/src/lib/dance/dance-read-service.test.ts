import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  getDanceAttemptForUser,
  serializeDanceAttempt,
  serializeDanceSession,
} from "./dance-read-service"

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    dance_attempt_session_id: "dse_1",
    dance_attempt_id: "dat_1",
    subject_user_id: "usr_1",
    community_id: "cmty_1",
    host_post_id: "post_1",
    referenced_song_post_id: "post_song",
    dance_choreography_id: "dch_1",
    dance_choreography_revision_id: "dcr_1",
    status: "grading",
    upload_object_key: "dance/attempt-media/dse_1/video.mp4",
    maximum_bytes: 1024,
    observed_size_bytes: 1024,
    observed_etag: "etag",
    observed_content_sha256: "a".repeat(64),
    terminal_reason: null,
    score_bps: null,
    calibration_admitted: null,
    expires_at: "2026-08-10T00:30:00.000Z",
    submitted_at: "2026-08-10T00:01:00.000Z",
    finalized_at: null,
    created_at: "2026-08-10T00:00:00.000Z",
    ...overrides,
  }
}

function controlClient(row: Record<string, unknown>) {
  return {
    execute: async (query: { args?: unknown[] }) => ({
      rows: query.args?.[1] === row.subject_user_id ? [row] : [],
    }),
  } as never
}

describe("dance read service", () => {
  test("returns an owned in-flight attempt without touching its community shard", async () => {
    let shardOpened = false
    const record = await getDanceAttemptForUser({
      env: {} as Env,
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      controlClient: controlClient(sessionRow({ calibration_admitted: 1 })),
      openCommunityRead: async () => {
        shardOpened = true
        throw new Error("must not open shard")
      },
    })

    expect(shardOpened).toBe(false)
    expect(record).toMatchObject({
      attemptId: "dat_1",
      status: "grading",
      scoreBps: null,
      rankEligible: null,
    })
    expect(serializeDanceAttempt(record!)).toMatchObject({
      id: "dat_1",
      object: "dance_attempt",
      completed_at: null,
    })
  })

  test("hides attempts owned by another user", async () => {
    const record = await getDanceAttemptForUser({
      env: {} as Env,
      attemptId: "dat_1",
      subjectUserId: "usr_other",
      controlClient: controlClient(sessionRow()),
    })
    expect(record).toBeNull()
  })

  test("returns a cancelled attempt without requiring shard evidence", async () => {
    let shardOpened = false
    const record = await getDanceAttemptForUser({
      env: {} as Env,
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      controlClient: controlClient(sessionRow({
        status: "cancelled",
        terminal_reason: "cancelled",
        finalized_at: "2026-08-10T00:02:00.000Z",
      })),
      openCommunityRead: async () => {
        shardOpened = true
        throw new Error("must not open shard")
      },
    })

    expect(shardOpened).toBe(false)
    expect(record).toMatchObject({
      status: "cancelled",
      scoreBps: null,
      rankEligible: null,
      reason: "cancelled",
    })
  })

  test("reads bounded terminal evidence from the owning community shard", async () => {
    let closed = false
    const record = await getDanceAttemptForUser({
      env: {} as Env,
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      controlClient: controlClient(sessionRow({
        status: "finalized",
        score_bps: 8800,
        calibration_admitted: 1,
        finalized_at: "2026-08-10T00:02:00.000Z",
      })),
      openCommunityRead: async (communityId) => {
        expect(communityId).toBe("cmty_1")
        return {
          client: {
            execute: async () => ({ rows: [{
              status: "passed",
              score_bps: 8800,
              rank_eligible: 1,
              reason_code: null,
              coverage_bps: 9400,
              pose_detection_bps: 9600,
              duration_ratio_bps: 10_000,
              completed_at: "2026-08-10T00:02:00.000Z",
            }] }),
          } as never,
          close: () => {
            closed = true
          },
        }
      },
    })

    expect(closed).toBe(true)
    expect(record).toMatchObject({
      status: "passed",
      scoreBps: 8800,
      rankEligible: true,
      coverageBps: 9400,
    })
  })

  test("serializes session timestamps and omits private storage facts", () => {
    const serialized = serializeDanceSession({
      sessionId: "dse_1",
      attemptId: "dat_1",
      subjectUserId: "usr_1",
      communityId: "cmty_1",
      hostPostId: "1",
      referencedSongPostId: "post_song",
      choreographyId: "dch_1",
      choreographyRevisionId: "dcr_1",
      status: "uploading",
      uploadObjectKey: "private/object.mp4",
      maximumBytes: 1024,
      observedSizeBytes: null,
      observedEtag: null,
      observedContentSha256: null,
      terminalReason: null,
      scoreBps: null,
      calibrationAdmitted: null,
      consentPolicyVersion: "dance_recording_v1",
      consentedAt: "2026-08-10T00:00:00.000Z",
      consentSource: "api",
      expiresAt: "2026-08-10T00:30:00.000Z",
      submittedAt: null,
      finalizedAt: null,
      createdAt: "2026-08-10T00:00:00.000Z",
    })
    expect(serialized).toEqual({
      id: "dse_1",
      object: "dance_session",
      attempt: "dat_1",
      post: "post_1",
      choreography: "dch_1",
      choreography_revision: "dcr_1",
      status: "uploading",
      max_bytes: 1024,
      expires_at: 1_786_321_800,
      created: 1_786_320_000,
      consent_policy_version: "dance_recording_v1",
      consented_at: 1_786_320_000,
      start_cue: null,
    })
    expect(JSON.stringify(serialized)).not.toContain("private/object.mp4")
  })
})
