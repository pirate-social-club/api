import { describe, expect, test } from "bun:test"
import { shardVersionInfo } from "./version"

describe("shard version attestation", () => {
  test("surfaces native Worker version metadata even without deploy-time defines", () => {
    expect(shardVersionInfo({
      CF_VERSION_METADATA: {
        id: "worker-version-id",
        tag: "api-commit-sha",
        timestamp: "2026-07-23T10:00:00.000Z",
      },
    })).toEqual({
      build: {
        gitRef: null,
        gitSha: null,
        timestamp: null,
        sourceVersion: null,
      },
      workerVersion: {
        id: "worker-version-id",
        tag: "api-commit-sha",
        timestamp: "2026-07-23T10:00:00.000Z",
      },
    })
  })
})
