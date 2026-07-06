import { describe, expect, test } from "bun:test"
import {
  buildStampedWranglerDeployArgs,
  resolveBuildVersionMetadata,
} from "./deploy-version-args"

describe("deploy version stamping", () => {
  test("resolves metadata from CI env before git fallbacks", () => {
    const metadata = resolveBuildVersionMetadata({
      GITHUB_SHA: "sha-from-github",
      GITHUB_REF_NAME: "main",
    }, () => {
      throw new Error("git fallback should not run")
    }, () => new Date("2026-07-06T12:00:00.000Z"))

    expect(metadata).toEqual({
      gitSha: "sha-from-github",
      gitRef: "main",
      timestamp: "2026-07-06T12:00:00.000Z",
    })
  })

  test("uses explicit build env before GitHub env", () => {
    const metadata = resolveBuildVersionMetadata({
      BUILD_GIT_SHA: "explicit-sha",
      PIRATE_BUILD_GIT_REF: "release/api",
      GITHUB_SHA: "github-sha",
      GITHUB_REF_NAME: "main",
      BUILD_TIMESTAMP: "2026-07-06T12:01:00.000Z",
    }, () => "git-output")

    expect(metadata).toEqual({
      gitSha: "explicit-sha",
      gitRef: "release/api",
      timestamp: "2026-07-06T12:01:00.000Z",
    })
  })

  test("builds wrangler deploy args with compile-time defines after passthrough args", () => {
    expect(buildStampedWranglerDeployArgs(["--env", "production"], {
      gitSha: "abc123",
      gitRef: "main",
      timestamp: "2026-07-06T12:02:00.000Z",
    })).toEqual([
      "deploy",
      "--env",
      "production",
      "--define",
      "__PIRATE_BUILD_GIT_SHA__:\"abc123\"",
      "--define",
      "__PIRATE_BUILD_GIT_REF__:\"main\"",
      "--define",
      "__PIRATE_BUILD_TIMESTAMP__:\"2026-07-06T12:02:00.000Z\"",
    ])
  })
})
