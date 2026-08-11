import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  buildStampedWranglerDeployArgs,
  resolveBuildVersionMetadata,
} from "./deploy-version-args"

describe("deploy version stamping", () => {
  test("routes the package deploy script through the guarded wrapper", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, "../package.json"), "utf8"),
    ) as { scripts?: Record<string, string> }

    expect(packageJson.scripts?.deploy).toBe("bun run scripts/deploy-with-version.ts")
  })

  test("resolves metadata from CI env before git fallbacks", () => {
    const githubSha = "a".repeat(40)
    const metadata = resolveBuildVersionMetadata({
      GITHUB_SHA: githubSha,
      GITHUB_REF_NAME: "main",
    }, (_command, args) => {
      if (args[0] === "status") return ""
      if (args[1] === "HEAD:services/community-d1-shard") return "shard-tree"
      if (args[1] === "HEAD:services/shared") return "shared-tree"
      throw new Error(`unexpected git fallback: ${args.join(" ")}`)
    }, () => new Date("2026-07-06T12:00:00.000Z"))

    expect(metadata).toEqual({
      gitSha: githubSha,
      gitRef: "main",
      timestamp: "2026-07-06T12:00:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
      releaseId: null,
      buildId: null,
      webSha: null,
      apiSha: githubSha,
      coreSha: null,
      sourceState: "clean",
      hotfixReasonSlug: null,
      patchSha256: null,
    })
  })

  test("uses explicit build env before GitHub env", () => {
    const explicitSha = "b".repeat(40)
    const metadata = resolveBuildVersionMetadata({
      BUILD_GIT_SHA: explicitSha,
      PIRATE_BUILD_GIT_REF: "release/api",
      GITHUB_SHA: "c".repeat(40),
      GITHUB_REF_NAME: "main",
      BUILD_TIMESTAMP: "2026-07-06T12:01:00.000Z",
    }, (_command, args) => {
      if (args[0] === "status") return ""
      if (args[1] === "HEAD:services/community-d1-shard") return "shard-tree"
      if (args[1] === "HEAD:services/shared") return "shared-tree"
      return "git-output"
    })

    expect(metadata).toEqual({
      gitSha: explicitSha,
      gitRef: "release/api",
      timestamp: "2026-07-06T12:01:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
      releaseId: null,
      buildId: null,
      webSha: null,
      apiSha: explicitSha,
      coreSha: null,
      sourceState: "clean",
      hotfixReasonSlug: null,
      patchSha256: null,
    })
  })

  test("refuses to label dirty source without content-addressed hotfix provenance", () => {
    expect(() =>
      resolveBuildVersionMetadata({
        BUILD_GIT_SHA: "a".repeat(40),
        BUILD_GIT_REF: "main",
        BUILD_TIMESTAMP: "2026-08-11T11:23:15Z",
      }, (_command, args) => {
        if (args[0] === "status") {
          return " M services/community-d1-shard/src/index.ts\n"
        }
        if (args[1] === "HEAD:services/community-d1-shard") return "shard-tree"
        if (args[1] === "HEAD:services/shared") return "shared-tree"
        throw new Error(`unexpected git command: ${args.join(" ")}`)
      })
    ).toThrow("Dirty deploys require a normalized hotfix reason")
  })

  test("rejects abbreviated or uppercase release SHAs", () => {
    const runText = (_command: string, args: string[]) => {
      if (args[0] === "status") return ""
      if (args[1] === "HEAD:services/community-d1-shard") return "shard-tree"
      if (args[1] === "HEAD:services/shared") return "shared-tree"
      throw new Error(`unexpected git command: ${args.join(" ")}`)
    }

    expect(() => resolveBuildVersionMetadata({
      BUILD_GIT_SHA: "abc1234",
      BUILD_GIT_REF: "main",
      BUILD_TIMESTAMP: "2026-08-11T11:23:15Z",
    }, runText)).toThrow("BUILD_GIT_SHA must be an exact lowercase 40-character Git SHA")

    expect(() => resolveBuildVersionMetadata({
      BUILD_GIT_SHA: "a".repeat(40),
      BUILD_GIT_REF: "main",
      BUILD_TIMESTAMP: "2026-08-11T11:23:15Z",
      BUILD_CORE_SHA: "F".repeat(40),
    }, runText)).toThrow("BUILD_CORE_SHA must be an exact lowercase 40-character Git SHA")
  })

  test("builds wrangler deploy args with compile-time defines after passthrough args", () => {
    const apiSha = "a".repeat(40)
    const webSha = "b".repeat(40)
    const coreSha = "c".repeat(40)
    expect(buildStampedWranglerDeployArgs(["--env", "production"], {
      gitSha: apiSha,
      gitRef: "main",
      timestamp: "2026-07-06T12:02:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
      releaseId: "release-123",
      buildId: "build-123",
      webSha,
      apiSha,
      coreSha,
      sourceState: "dirty",
      hotfixReasonSlug: "urgent-repair",
      patchSha256: "f".repeat(64),
    })).toEqual([
      "deploy",
      "--env",
      "production",
      "--define",
      `__PIRATE_BUILD_GIT_SHA__:\"${apiSha}\"`,
      "--define",
      "__PIRATE_BUILD_GIT_REF__:\"main\"",
      "--define",
      "__PIRATE_BUILD_TIMESTAMP__:\"2026-07-06T12:02:00.000Z\"",
      "--define",
      "__PIRATE_BUILD_SOURCE_STATE__:\"dirty\"",
      "--define",
      "__PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__:\"shard-tree.shared-tree\"",
      "--define",
      "__PIRATE_BUILD_RELEASE_ID__:\"release-123\"",
      "--define",
      "__PIRATE_BUILD_ID__:\"build-123\"",
      "--define",
      `__PIRATE_BUILD_WEB_SHA__:\"${webSha}\"`,
      "--define",
      `__PIRATE_BUILD_API_SHA__:\"${apiSha}\"`,
      "--define",
      `__PIRATE_BUILD_CORE_SHA__:\"${coreSha}\"`,
      "--define",
      "__PIRATE_BUILD_HOTFIX_REASON_SLUG__:\"urgent-repair\"",
      "--define",
      `__PIRATE_BUILD_PATCH_SHA256__:\"${"f".repeat(64)}\"`,
      "--tag",
      apiSha,
    ])
  })
})
