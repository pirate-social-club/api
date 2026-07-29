import { describe, expect, test } from "bun:test"

import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import type { DanceReferenceReadyFacts } from "./choreography-reference-contract"
import {
  finalizeDanceChoreographyReference,
  seedOperatorDanceChoreography,
} from "./choreography-reference-repository"

const readyFacts: DanceReferenceReadyFacts = {
  outcome: "ready",
  referenceFeatureSha256: "a".repeat(64),
  referenceFeatureSizeBytes: 2048,
  durationMs: 10_000,
  width: 576,
  height: 1024,
  fpsMillihertz: 30_000,
  poseModelVersion: "pose-v1",
  poseModelSha256: "b".repeat(64),
  poseRuntimeVersion: "runtime-v1",
  featureSchemaVersion: "features-v1",
  scorerVersion: "scorer-v1",
  artifactVersion: "artifact-v1",
}

function row(status: "processing" | "ready" | "failed", failureCode: string | null = null) {
  return {
    dance_choreography_id: "dch_1",
    community_id: "com_1",
    host_post_id: "post_dance",
    referenced_song_post_id: "post_song",
    song_artifact_bundle_id: "sab_1",
    creator_user_id: "usr_1",
    official: 0,
    choreography_status: status === "processing" ? "processing" : status,
    dance_choreography_revision_id: "dcr_1",
    revision_status: status,
    failure_code: failureCode,
    reference_storage_ref: "references/dcr_1.mp4",
    reference_content_sha256: "c".repeat(64),
    reference_mime_type: "video/mp4",
    reference_size_bytes: 4096,
    mirror_policy: "allowed",
    reference_feature_ref: status === "ready" ? "features/dcr_1.json" : null,
    reference_feature_sha256: status === "ready" ? readyFacts.referenceFeatureSha256 : null,
    reference_feature_size_bytes: status === "ready" ? readyFacts.referenceFeatureSizeBytes : null,
    reference_duration_ms: status === "ready" ? readyFacts.durationMs : null,
    reference_width: status === "ready" ? readyFacts.width : null,
    reference_height: status === "ready" ? readyFacts.height : null,
    reference_fps_millihertz: status === "ready" ? readyFacts.fpsMillihertz : null,
    pose_model_version: status === "ready" ? readyFacts.poseModelVersion : null,
    pose_model_sha256: status === "ready" ? readyFacts.poseModelSha256 : null,
    pose_runtime_version: status === "ready" ? readyFacts.poseRuntimeVersion : null,
    feature_schema_version: status === "ready" ? readyFacts.featureSchemaVersion : null,
    scorer_version: status === "ready" ? readyFacts.scorerVersion : null,
    artifact_version: status === "ready" ? readyFacts.artifactVersion : null,
  }
}

function clientForRows(rows: unknown[], statements: InStatement[]): Client {
  let selectIndex = 0
  const tx: Transaction = {
    async execute(statement): Promise<QueryResult> {
      const normalized = typeof statement === "string" ? { sql: statement } : statement
      statements.push(normalized)
      if (normalized.sql.includes("SELECT")) {
        const selected = rows[selectIndex++]
        return { rows: selected ? [selected as Record<string, unknown>] : [] }
      }
      return { rows: [], rowsAffected: 1 }
    },
    async batch() {
      return []
    },
    async commit() {},
    async rollback() {},
    close() {},
  }
  return {
    async execute() {
      throw new Error("outside-transaction execute")
    },
    async batch() {
      return []
    },
    async transaction() {
      return tx
    },
  }
}

describe("dance choreography reference repository", () => {
  test("rejects an operator seed replay whose immutable facts changed", async () => {
    const client = clientForRows([row("processing")], [])

    await expect(seedOperatorDanceChoreography({
      client,
      seed: {
        danceChoreographyId: "dch_1",
        danceChoreographyRevisionId: "dcr_1",
        communityId: "com_1",
        hostPostId: "post_dance",
        referencedSongPostId: "post_song",
        songArtifactBundleId: "sab_1",
        creatorUserId: "usr_1",
        official: false,
        referenceStorageRef: "references/dcr_1.mp4",
        referenceContentSha256: "c".repeat(64),
        referenceMimeType: "video/mp4",
        referenceSizeBytes: 4097,
        mirrorPolicy: "allowed",
        now: "2026-07-29T00:00:00.000Z",
      },
    })).rejects.toThrow("different facts")
  })

  test("publishes a ready revision and activates it in one transaction", async () => {
    const statements: InStatement[] = []
    const client = clientForRows([row("processing"), row("ready")], statements)

    const result = await finalizeDanceChoreographyReference({
      client,
      danceChoreographyRevisionId: "dcr_1",
      facts: readyFacts,
      referenceFeatureRef: "features/dcr_1.json",
      now: "2026-07-29T00:00:00.000Z",
    })

    expect(result.kind).toBe("finalized")
    expect(statements.some(({ sql }) =>
      sql.includes("UPDATE dance_choreography_revisions")
      && sql.includes("reference_feature_sha256")
    )).toBe(true)
    expect(statements.some(({ sql }) =>
      sql.includes("active_revision_id = ?2")
    )).toBe(true)
  })

  test("leaves a retryable grader failure processing for redispatch", async () => {
    const statements: InStatement[] = []
    const client = clientForRows([row("processing")], statements)

    const result = await finalizeDanceChoreographyReference({
      client,
      danceChoreographyRevisionId: "dcr_1",
      facts: { outcome: "failed", reason: "scoring_unavailable" },
      now: "2026-07-29T00:00:00.000Z",
    })

    expect(result.kind).toBe("retryable_failure")
    expect(statements.filter(({ sql }) => sql.trimStart().startsWith("UPDATE"))).toHaveLength(0)
  })

  test("accepts identical ready callback replay", async () => {
    const statements: InStatement[] = []
    const client = clientForRows([row("ready")], statements)

    const result = await finalizeDanceChoreographyReference({
      client,
      danceChoreographyRevisionId: "dcr_1",
      facts: readyFacts,
      referenceFeatureRef: "features/dcr_1.json",
      now: "2026-07-29T00:00:00.000Z",
    })

    expect(result.kind).toBe("idempotent")
    expect(statements.filter(({ sql }) => sql.trimStart().startsWith("UPDATE"))).toHaveLength(0)
  })

  test("rejects callback replay with changed terminal facts", async () => {
    const client = clientForRows([row("ready")], [])

    await expect(finalizeDanceChoreographyReference({
      client,
      danceChoreographyRevisionId: "dcr_1",
      facts: { ...readyFacts, scorerVersion: "changed" },
      referenceFeatureRef: "features/dcr_1.json",
      now: "2026-07-29T00:00:00.000Z",
    })).rejects.toThrow("different terminal facts")
  })
})
