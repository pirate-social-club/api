import { describe, expect, test } from "bun:test"
import {
  buildStampedWranglerDeployArgs,
  resolveBuildVersionMetadata,
  validateSiblingWebCheckout,
} from "./deploy-version-args"

describe("deploy version stamping", () => {
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

  test("accepts a clean sibling Web checkout at the pinned SHA", () => {
    expect(() =>
      validateSiblingWebCheckout("/workspace/web", "web-sha\n", (_command, args) => {
        if (args.includes("status")) return ""
        if (args.includes("rev-parse")) return "web-sha"
        throw new Error(`unexpected command: ${args.join(" ")}`)
      })
    ).not.toThrow()
  })

  test("refuses a dirty sibling Web checkout", () => {
    expect(() =>
      validateSiblingWebCheckout("/workspace/web", "web-sha", (_command, args) => {
        if (args.includes("status")) return " M packages/karaoke-runtime/src/index.ts"
        throw new Error(`unexpected command after dirty-tree check: ${args.join(" ")}`)
      })
    ).toThrow("dirty sibling Web checkout")
  })

  test("refuses a sibling Web checkout that does not match the pin", () => {
    expect(() =>
      validateSiblingWebCheckout("/workspace/web", "expected-web-sha", (_command, args) => {
        if (args.includes("status")) return ""
        if (args.includes("rev-parse")) return "stale-web-sha"
        throw new Error(`unexpected command: ${args.join(" ")}`)
      })
    ).toThrow("expected pinned SHA expected-web-sha")
  })

  test("builds wrangler deploy args with compile-time defines after passthrough args", () => {
    expect(buildStampedWranglerDeployArgs(["--env", "production"], {
      gitSha: "abc123",
      gitRef: "main",
      timestamp: "2026-07-06T12:02:00.000Z",
      communityD1ShardSourceVersion: "shard-tree.shared-tree",
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
      "--tag",
      "abc123",
    ])
  })
})
