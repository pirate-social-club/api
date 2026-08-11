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
    const metadata = resolveBuildVersionMetadata({
      GITHUB_SHA: "sha-from-github",
      GITHUB_REF_NAME: "main",
    }, (_command, args) => {
      if (args[0] === "status") return ""
      if (args[1] === "HEAD:services/community-d1-shard") return "shard-tree"
      if (args[1] === "HEAD:services/shared") return "shared-tree"
      throw new Error(`unexpected git fallback: ${args.join(" ")}`)
    }, () => new Date("2026-07-06T12:00:00.000Z"))

    expect(metadata).toEqual({
      gitSha: "sha-from-github",
      gitRef: "main",
      timestamp: "2026-07-06T12:00:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
      releaseId: null,
      buildId: null,
      webSha: null,
      apiSha: "sha-from-github",
      coreSha: null,
    })
  })

  test("uses explicit build env before GitHub env", () => {
    const metadata = resolveBuildVersionMetadata({
      BUILD_GIT_SHA: "explicit-sha",
      PIRATE_BUILD_GIT_REF: "release/api",
      GITHUB_SHA: "github-sha",
      GITHUB_REF_NAME: "main",
      BUILD_TIMESTAMP: "2026-07-06T12:01:00.000Z",
    }, (_command, args) => {
      if (args[0] === "status") return ""
      if (args[1] === "HEAD:services/community-d1-shard") return "shard-tree"
      if (args[1] === "HEAD:services/shared") return "shared-tree"
      return "git-output"
    })

    expect(metadata).toEqual({
      gitSha: "explicit-sha",
      gitRef: "release/api",
      timestamp: "2026-07-06T12:01:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
      releaseId: null,
      buildId: null,
      webSha: null,
      apiSha: "explicit-sha",
      coreSha: null,
    })
  })

  test("refuses to stamp dirty shard sources", () => {
    expect(() =>
      resolveBuildVersionMetadata({}, (_command, args) => {
        if (args[0] === "status") {
          return " M services/community-d1-shard/src/index.ts\n"
        }
        throw new Error(`unexpected command after dirty-tree check: ${args.join(" ")}`)
      })
    ).toThrow("dirty community-d1-shard/shared sources")
  })

  test("builds wrangler deploy args with compile-time defines after passthrough args", () => {
    expect(buildStampedWranglerDeployArgs(["--env", "production"], {
      gitSha: "abc123",
      gitRef: "main",
      timestamp: "2026-07-06T12:02:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
      releaseId: "release-123",
      buildId: "build-123",
      webSha: "web-123",
      apiSha: "api-123",
      coreSha: "core-123",
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
      "--define",
      "__PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__:\"shard-tree.shared-tree\"",
      "--define",
      "__PIRATE_BUILD_RELEASE_ID__:\"release-123\"",
      "--define",
      "__PIRATE_BUILD_ID__:\"build-123\"",
      "--define",
      "__PIRATE_BUILD_WEB_SHA__:\"web-123\"",
      "--define",
      "__PIRATE_BUILD_API_SHA__:\"api-123\"",
      "--define",
      "__PIRATE_BUILD_CORE_SHA__:\"core-123\"",
      "--tag",
      "abc123",
    ])
  })
})
